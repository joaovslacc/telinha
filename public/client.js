/*
 * telinha — implementação REAL de window.Telinha (ver docs/PROTOCOLO.md).
 * Mesh WebRTC (um RTCPeerConnection por par) com perfect negotiation, sinalização por WebSocket em /ws.
 * Script clássico, sem dependências, sem build.
 *
 * Extras fora do contrato (opcionais, para testes):
 *   Telinha.join({ name, code, iceTransportPolicy: 'relay' })  força TURN
 *   Telinha.server = 'wss://host/ws'                           outro servidor de sinalização
 */
(function () {
  'use strict';

  var ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789'; // sem i, l, o, 0, 1
  var CODE_RE = /^[a-z0-9-]{3,24}$/;
  var MAX_BITRATE = 2500000;        // bps por sender
  var GIVE_UP_MS = 30000;           // sem sinalização por isso → signaling-lost
  var PING_MS = 10000;
  var DEAD_MS = 35000;              // sem nada do servidor por isso → reconecta
  var CONNECT_TIMEOUT_MS = 8000;
  var REMOVE_AFTER_MS = 15000;      // após reconectar, peer sumido da lista é removido se não voltar
  var STATS_MS = 5000;
  var OUTBOX_MAX = 500;
  var FATAL = { 'room-full': 1, 'name-invalid': 1, 'code-invalid': 1, 'signaling-lost': 1 };
  var MESSAGES = {
    'room-full': 'Esta sala atingiu o limite de pessoas.',
    'name-invalid': 'Nome vazio ou com mais de 24 caracteres.',
    'code-invalid': 'Código precisa ter de 3 a 24 letras, números ou hífen.',
    'share-denied': 'O compartilhamento foi cancelado ou negado.',
    'share-unsupported': 'Este navegador não consegue compartilhar a tela.',
    'signaling-lost': 'Não foi possível reconectar ao servidor.'
  };

  var canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  function mkErr(code, message) {
    var e = new Error(message || MESSAGES[code] || code);
    e.code = code;
    return e;
  }

  function randomCode() {
    var buf = new Uint32Array(6);
    crypto.getRandomValues(buf);
    var s = '';
    for (var i = 0; i < 6; i++) s += ALPHA[buf[i] % ALPHA.length];
    return s;
  }

  function normCode(c) { return String(c == null ? '' : c).toLowerCase().replace(/\s+/g, ''); }
  function normName(n) {
    // eslint-disable-next-line no-control-regex
    return String(n == null ? '' : n).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim();
  }
  function defaultUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'; }
  function warn() { try { console.warn.apply(console, ['[telinha]'].concat([].slice.call(arguments))); } catch (e) { /* */ } }

  /* ------------------------------------------------------------------ */

  function Room(opts) {
    this._h = {};
    this.self = { id: null, name: normName(opts.name), sharing: false };
    this.peers = new Map();         // id -> { id, name, sharing, state }  (público)
    this._p = new Map();            // id -> estado interno do par (pc, negociação...)
    this._code = normCode(opts.code);
    this._url = opts.url || Telinha.server || defaultUrl();
    this._policy = opts.iceTransportPolicy === 'relay' ? 'relay' : 'all';
    this._ice = [];
    this._ws = null;
    this._ready = false;            // recebeu welcome no socket atual
    this._everJoined = false;
    this._token = null;
    this._boot = null;
    this._left = false;
    this._dead = false;
    this._outbox = [];
    this._attempt = 0;
    this._lastRx = 0;
    this._timers = {};
    this._removals = new Map();
    this._stream = null;
    this._track = null;
    this._sharing = null;           // Promise de startShare em andamento

    var self = this;
    this._onOnline = function () { if (!self._ready && self._timers.reconnect) { clearTimeout(self._timers.reconnect); self._timers.reconnect = null; self._connect(); } };
    window.addEventListener('online', this._onOnline);

    var n = this.self.name;
    if (!n || n.length > 24) { setTimeout(function () { self._fatal('name-invalid'); }, 0); return; }
    if (!CODE_RE.test(this._code)) { setTimeout(function () { self._fatal('code-invalid'); }, 0); return; }

    this._armGiveUp();
    this._connect();
    this._timers.ping = setInterval(function () { self._tick(); }, PING_MS);
  }

  /* ---------- eventos ---------- */

  Room.prototype.on = function (ev, fn) {
    var set = this._h[ev] || (this._h[ev] = new Set());
    set.add(fn);
    return function () { set.delete(fn); };
  };

  Room.prototype._emit = function (ev, payload) {
    if (this._left) return;
    var set = this._h[ev];
    if (!set) return;
    Array.from(set).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[telinha] handler de "' + ev + '" falhou', e); }
    });
  };

  /* ---------- sinalização ---------- */

  Room.prototype._connect = function () {
    if (this._left || this._dead) return;
    var self = this, ws;
    this._timers.reconnect = null;
    try { ws = new WebSocket(this._url); } catch (e) { return this._wsDown(); }
    this._ws = ws;
    this._ready = false;
    clearTimeout(this._timers.connect);
    this._timers.connect = setTimeout(function () {
      if (self._ws === ws && !self._ready) { self._dropSocket(); self._wsDown(); }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = function () {
      if (self._ws !== ws) return;
      self._lastRx = Date.now();
      var m = { t: 'join', room: self._code, name: self.self.name };
      if (self.self.id && self._token) m.resume = { id: self.self.id, token: self._token };
      ws.send(JSON.stringify(m));
    };
    ws.onmessage = function (ev) {
      if (self._ws !== ws) return;
      self._lastRx = Date.now();
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && typeof m === 'object') self._onMsg(m);
    };
    ws.onclose = function () {
      if (self._ws !== ws) return;
      self._ws = null;
      self._wsDown();
    };
    ws.onerror = function () { /* onclose vem em seguida */ };
  };

  Room.prototype._dropSocket = function () {
    // fecha o socket atual sem disparar onclose; quem chama decide o resto (_wsDown)
    var ws = this._ws;
    this._ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(4000, 'reconnect'); } catch (e) { /* */ }
    }
  };

  Room.prototype._wsDown = function () {
    if (this._left || this._dead) return;
    var wasReady = this._ready;
    this._ready = false;
    clearTimeout(this._timers.connect);
    if (wasReady || (this._everJoined && !this._timers.giveUp)) {
      this._armGiveUp();
      this._emit('reconnecting', {});
    }
    if (this._timers.reconnect) return;
    var delay = Math.min(8000, 500 * Math.pow(2, this._attempt++)) * (0.75 + Math.random() * 0.5);
    var self = this;
    this._timers.reconnect = setTimeout(function () { self._connect(); }, delay);
  };

  Room.prototype._armGiveUp = function () {
    var self = this;
    if (this._timers.giveUp) return;
    this._timers.giveUp = setTimeout(function () {
      self._timers.giveUp = null;
      if (!self._ready) self._fatal('signaling-lost');
    }, GIVE_UP_MS);
  };

  Room.prototype._tick = function () {
    if (!this._ws || this._ws.readyState !== 1) return;
    if (Date.now() - this._lastRx > DEAD_MS) { this._dropSocket(); this._wsDown(); return; }
    this._ws.send('{"t":"ping"}');
  };

  Room.prototype._send = function (msg) {
    if (this._ready && this._ws && this._ws.readyState === 1) {
      this._ws.send(JSON.stringify(msg));
    } else if (msg.t === 'signal' && this._outbox.length < OUTBOX_MAX) {
      this._outbox.push(msg);
    }
  };

  Room.prototype._onMsg = function (m) {
    switch (m.t) {
      case 'welcome': return this._onWelcome(m);
      case 'peer-joined': return this._onPeerJoined(m.id, m.name);
      case 'peer-left': return this._removePeer(m.id);
      case 'signal': return this._onSignal(m.from, m.data);
      case 'share': return this._setRemoteSharing(m.id, !!m.on);
      case 'error':
        if (FATAL[m.code]) return this._fatal(m.code);
        return this._emit('error', { code: m.code, message: MESSAGES[m.code] || m.code });
    }
  };

  Room.prototype._onWelcome = function (m) {
    var self = this;
    var sameId = this._everJoined && m.id === this.self.id;
    var serverRestarted = this._everJoined && this._boot && m.boot !== this._boot;
    // continuidade: mesmo id e (servidor segurou nosso lugar | servidor reiniciou e não sabe de nada)
    var keep = sameId && (m.resumed || serverRestarted);

    clearTimeout(this._timers.connect);
    clearTimeout(this._timers.giveUp);
    this._timers.giveUp = null;
    this._ready = true;
    this._attempt = 0;
    this._token = m.token || null;
    this._boot = m.boot || null;
    this._ice = Array.isArray(m.ice) ? m.ice : [];
    var list = Array.isArray(m.peers) ? m.peers : [];

    if (this._everJoined && !keep) {
      // perdemos a identidade (fomos removidos): recomeça do zero
      Array.from(this.peers.keys()).forEach(function (id) { self._removePeer(id); });
      this._outbox = [];
    }
    this.self.id = m.id;

    var cfg = this._pcConfig();
    this._p.forEach(function (p) { try { p.pc.setConfiguration(cfg); } catch (e) { /* */ } });

    if (!this._everJoined) {
      this._everJoined = true;
      list.forEach(function (x) { self._addPeer(x.id, x.name, !!x.sharing); });
      this._emit('joined', {
        self: { id: this.self.id, name: this.self.name, sharing: this.self.sharing },
        max: m.max || 0,
        peers: list.map(function (x) { return { id: x.id, name: x.name, sharing: !!x.sharing }; })
      });
      list.forEach(function (x) { self._ensurePc(x.id, true); });
    } else {
      var present = new Set();
      list.forEach(function (x) {
        present.add(x.id);
        if (self.peers.has(x.id)) {
          self._cancelRemoval(x.id);
          // servidor reiniciado ainda não sabe quem está compartilhando: só aceita "ligou"
          if (x.sharing || m.resumed) self._setRemoteSharing(x.id, !!x.sharing);
        } else {
          self._addPeer(x.id, x.name, false);
          self._emit('peer-joined', { id: x.id, name: x.name });
          if (x.sharing) self._setRemoteSharing(x.id, true);
          self._ensurePc(x.id, true);
        }
      });
      Array.from(this.peers.keys()).forEach(function (id) { if (!present.has(id)) self._scheduleRemoval(id); });

      var out = this._outbox;
      this._outbox = [];
      out.forEach(function (x) { self._send(x); });
      this._p.forEach(function (p) {
        // servidor reiniciado perdeu sinais em trânsito: reenvia oferta pendente
        if (!m.resumed && p.pc.signalingState === 'have-local-offer' && p.pc.localDescription) {
          self._signal(p.id, { description: p.pc.localDescription });
        }
        var cs = p.pc.connectionState;
        if (cs === 'failed' || cs === 'disconnected') self._restartIce(p);
      });
      this._emit('reconnected', {});
    }
    this._send({ t: 'share', on: this.self.sharing });
  };

  /* ---------- peers ---------- */

  Room.prototype._addPeer = function (id, name, sharing) {
    if (this.peers.has(id)) return false;
    this.peers.set(id, { id: id, name: String(name == null ? '' : name), sharing: sharing, state: 'connecting' });
    return true;
  };

  Room.prototype._onPeerJoined = function (id, name) {
    if (!id || id === this.self.id) return;
    if (this.peers.has(id)) { // voltou depois de reinício do servidor
      this._cancelRemoval(id);
      this.peers.get(id).name = String(name == null ? '' : name);
      return;
    }
    this._addPeer(id, name, false);
    this._emit('peer-joined', { id: id, name: this.peers.get(id).name });
    this._emit('connection', { id: id, state: 'connecting' });
    this._ensurePc(id, false);
  };

  Room.prototype._scheduleRemoval = function (id) {
    var self = this;
    if (this._removals.has(id)) return;
    this._removals.set(id, setTimeout(function () { self._removals.delete(id); self._removePeer(id); }, REMOVE_AFTER_MS));
  };

  Room.prototype._cancelRemoval = function (id) {
    clearTimeout(this._removals.get(id));
    this._removals.delete(id);
  };

  Room.prototype._removePeer = function (id) {
    this._cancelRemoval(id);
    var peer = this.peers.get(id);
    if (!peer) return;
    var p = this._p.get(id);
    if (p) { this._endRemote(p); this._closePc(p); }
    this.peers.delete(id);
    this._emit('peer-left', { id: id, name: peer.name });
  };

  Room.prototype._setRemoteSharing = function (id, on) {
    var peer = this.peers.get(id);
    if (!peer || peer.sharing === on) return;
    peer.sharing = on;
    this._emit('share-changed', { id: id, sharing: on });
    if (!on) { var p = this._p.get(id); if (p) this._endRemote(p); }
  };

  Room.prototype._setState = function (p, state) {
    var peer = this.peers.get(p.id);
    if (!peer || peer.state === state) return;
    peer.state = state;
    this._emit('connection', { id: p.id, state: state });
  };

  /* ---------- WebRTC ---------- */

  Room.prototype._pcConfig = function () {
    return { iceServers: this._ice, iceTransportPolicy: this._policy };
  };

  Room.prototype._signal = function (to, data) {
    this._send({ t: 'signal', to: to, data: data });
  };

  Room.prototype._ensurePc = function (id, initiator) {
    if (this._p.has(id)) return this._p.get(id);
    var self = this;
    var pc = new RTCPeerConnection(this._pcConfig());
    var p = {
      id: id, pc: pc,
      polite: String(this.self.id) < String(id),
      makingOffer: false, ignoreOffer: false,
      q: Promise.resolve(),
      tx: null, remote: null, dc: null,
      restarts: 0, timers: {}
    };
    this._p.set(id, p);

    pc.onnegotiationneeded = function () {
      if (pc.signalingState === 'closed') return;
      p.makingOffer = true;
      pc.setLocalDescription().then(function () {
        self._signal(id, { description: pc.localDescription });
      }).catch(function (e) { warn('offer', id, e); }).then(function () { p.makingOffer = false; });
    };
    pc.onicecandidate = function (e) {
      if (e.candidate) self._signal(id, { candidate: e.candidate });
    };
    pc.ontrack = function (e) { self._onRemoteTrack(p, e); };
    pc.onconnectionstatechange = function () { self._onPcState(p); };
    pc.oniceconnectionstatechange = function () { if (!('connectionState' in pc)) self._onPcState(p); };
    pc.onsignalingstatechange = function () { if (pc.signalingState === 'stable') self._limitBitrate(p); };

    if (initiator) p.dc = pc.createDataChannel('telinha');
    else pc.ondatachannel = function (e) { p.dc = e.channel; };

    if (this._track) this._attachTrack(p);
    return p;
  };

  Room.prototype._closePc = function (p) {
    Object.keys(p.timers).forEach(function (k) { clearTimeout(p.timers[k]); clearInterval(p.timers[k]); });
    p.pc.onnegotiationneeded = p.pc.onicecandidate = p.pc.ontrack = p.pc.onconnectionstatechange =
      p.pc.oniceconnectionstatechange = p.pc.onsignalingstatechange = p.pc.ondatachannel = null;
    try { p.pc.close(); } catch (e) { /* */ }
    this._p.delete(p.id);
  };

  Room.prototype._onSignal = function (from, data) {
    if (!data || typeof data !== 'object' || !this.peers.has(from)) return;
    var p = this._ensurePc(from, false);
    var self = this;
    p.q = p.q.then(function () { return self._handleSignal(p, data); })
      .catch(function (e) { warn('signal', from, e); });
  };

  // perfect negotiation (https://w3c.github.io/webrtc-pc/#perfect-negotiation-example)
  Room.prototype._handleSignal = function (p, data) {
    var pc = p.pc, self = this;
    if (pc.signalingState === 'closed') return;
    if (data.description) {
      var d = data.description;
      var collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      return pc.setRemoteDescription(d).then(function () {
        if (d.type !== 'offer') return;
        return pc.setLocalDescription().then(function () {
          self._signal(p.id, { description: pc.localDescription });
        });
      });
    }
    if (data.candidate) {
      return pc.addIceCandidate(data.candidate).catch(function (e) { if (!p.ignoreOffer) throw e; });
    }
  };

  Room.prototype._onRemoteTrack = function (p, e) {
    if (e.track.kind !== 'video') return;
    var self = this, track = e.track;
    var stream = new MediaStream([track]);
    p.remote = { stream: stream, track: track };
    var ms = e.streams && e.streams[0];
    if (ms) ms.onremovetrack = function (ev) { if (ev.track === track && p.remote && p.remote.stream === stream) self._endRemote(p); };
    track.onended = function () { if (p.remote && p.remote.stream === stream) self._endRemote(p); };
    this._emit('stream', { id: p.id, stream: stream });
  };

  Room.prototype._endRemote = function (p) {
    if (!p.remote) return;
    p.remote = null;
    this._emit('stream-ended', { id: p.id });
  };

  Room.prototype._onPcState = function (p) {
    var pc = p.pc, self = this;
    var cs = pc.connectionState || ({ checking: 'connecting', completed: 'connected' }[pc.iceConnectionState] || pc.iceConnectionState);
    if (cs === 'connected') {
      clearTimeout(p.timers.disc);
      p.restarts = 0;
      this._checkRelay(p);
      if (!p.timers.stats) p.timers.stats = setInterval(function () { self._checkRelay(p); }, STATS_MS);
    } else if (cs === 'disconnected') {
      this._setState(p, 'connecting');
      clearTimeout(p.timers.disc);
      p.timers.disc = setTimeout(function () { if (pc.connectionState === 'disconnected') self._restartIce(p); }, 4000);
    } else if (cs === 'failed') {
      this._setState(p, 'failed');
      this._restartIce(p);
    } else if (cs === 'new' || cs === 'connecting') {
      this._setState(p, 'connecting');
    }
  };

  Room.prototype._restartIce = function (p) {
    var pc = p.pc, self = this;
    if (pc.signalingState === 'closed' || !this._p.has(p.id)) return;
    try { pc.restartIce(); } catch (e) { warn('restartIce', e); }
    clearTimeout(p.timers.restart);
    var wait = Math.min(30000, 5000 * Math.pow(2, p.restarts++));
    p.timers.restart = setTimeout(function () {
      var cs = pc.connectionState;
      if (cs === 'failed' || cs === 'disconnected') self._restartIce(p);
    }, wait);
  };

  Room.prototype._checkRelay = function (p) {
    var pc = p.pc, self = this;
    if (pc.connectionState !== 'connected') return;
    pc.getStats().then(function (stats) {
      var pair = null;
      stats.forEach(function (r) {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId) || pair;
      });
      if (!pair) stats.forEach(function (r) {
        if (!pair && r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r;
      });
      var relay = false;
      if (pair) {
        var l = stats.get(pair.localCandidateId), rc = stats.get(pair.remoteCandidateId);
        relay = !!((l && l.candidateType === 'relay') || (rc && rc.candidateType === 'relay'));
      }
      if (pc.connectionState === 'connected' && self._p.get(p.id) === p) self._setState(p, relay ? 'relay' : 'connected');
    }).catch(function () { /* fechado */ });
  };

  /* ---------- compartilhar tela ---------- */

  Room.prototype._attachTrack = function (p) {
    var track = this._track, stream = this._stream;
    if (!track) return;
    if (p.tx) {
      p.tx.direction = 'sendonly';
      var self = this;
      p.tx.sender.replaceTrack(track).then(function () { self._limitBitrate(p); }).catch(function (e) { warn('replaceTrack', e); });
    } else {
      p.tx = p.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [{ maxBitrate: MAX_BITRATE }] });
      this._limitBitrate(p);
    }
  };

  Room.prototype._detachTrack = function (p) {
    if (!p.tx || p.pc.signalingState === 'closed') return;
    p.tx.sender.replaceTrack(null).catch(function () { /* */ });
    p.tx.direction = 'inactive';
  };

  Room.prototype._limitBitrate = function (p) {
    var s = p.tx && p.tx.sender;
    if (!s || !s.track || p.pc.signalingState === 'closed') return;
    var params = s.getParameters();
    if (!params.encodings || !params.encodings.length) return; // tenta de novo quando a negociação estabilizar
    var changed = false;
    params.encodings.forEach(function (enc) { if (enc.maxBitrate !== MAX_BITRATE) { enc.maxBitrate = MAX_BITRATE; changed = true; } });
    if (changed) s.setParameters(params).catch(function (e) { warn('setParameters', e); });
  };

  Room.prototype.startShare = function () {
    var self = this;
    if (this._left || this._dead) return Promise.reject(mkErr('signaling-lost', 'Você não está numa sala.'));
    if (!canShare) return Promise.reject(mkErr('share-unsupported'));
    if (this._stream) return Promise.resolve(this._stream);
    if (this._sharing) return this._sharing;

    var p;
    try {
      // sem await antes daqui: preserva o gesto do usuário (exigido por alguns navegadores)
      p = navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    } catch (e) {
      p = Promise.reject(e);
    }
    this._sharing = p.then(function (stream) {
      self._sharing = null;
      var track = stream.getVideoTracks()[0];
      if (self._left || self._dead || !track) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        throw track ? mkErr('signaling-lost', 'Você saiu da sala.') : mkErr('share-denied');
      }
      try { track.contentHint = 'detail'; } catch (e) { /* */ }
      track.addEventListener('ended', function () { if (self._track === track) self.stopShare(); });
      self._stream = stream;
      self._track = track;
      self.self.sharing = true;
      self._p.forEach(function (peer) { self._attachTrack(peer); });
      self._send({ t: 'share', on: true });
      self._emit('share-changed', { id: self.self.id, sharing: true });
      return stream;
    }, function (e) {
      self._sharing = null;
      if (e && e.code) throw e;
      var name = e && e.name;
      var code = (name === 'NotSupportedError' || name === 'TypeError' || name === 'NotFoundError') ? 'share-unsupported' : 'share-denied';
      throw mkErr(code);
    });
    return this._sharing;
  };

  Room.prototype.stopShare = function () {
    if (!this._stream) return;
    var self = this, stream = this._stream;
    this._stream = null;
    this._track = null;
    this.self.sharing = false;
    stream.getTracks().forEach(function (t) { t.stop(); });
    this._p.forEach(function (p) { self._detachTrack(p); });
    this._send({ t: 'share', on: false });
    this._emit('share-changed', { id: this.self.id, sharing: false });
  };

  /* ---------- sair ---------- */

  Room.prototype._teardown = function () {
    var self = this;
    window.removeEventListener('online', this._onOnline);
    Object.keys(this._timers).forEach(function (k) { clearTimeout(self._timers[k]); clearInterval(self._timers[k]); });
    this._timers = {};
    this._removals.forEach(function (t) { clearTimeout(t); });
    this._removals.clear();
    if (this._stream) this._stream.getTracks().forEach(function (t) { t.stop(); });
    this._stream = this._track = null;
    this.self.sharing = false;
    Array.from(this._p.values()).forEach(function (p) { self._closePc(p); });
  };

  Room.prototype._fatal = function (code) {
    if (this._dead || this._left) return;
    this._dead = true;
    this._emit('error', { code: code, message: MESSAGES[code] || code });
    var ws = this._ws;
    this._ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(1000, 'leave'); } catch (e) { /* */ } }
    this._teardown();
  };

  Room.prototype.leave = function () {
    if (this._left) return;
    var ws = this._ws;
    this._ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { if (ws.readyState === 1) ws.send('{"t":"leave"}'); ws.close(1000, 'leave'); } catch (e) { /* */ }
    }
    this._teardown();
    this._left = true;
    this.peers.clear();
    this._h = {};
  };

  /* ------------------------------------------------------------------ */

  var Telinha = {
    canShare: canShare,
    randomCode: randomCode,
    join: function (opts) { return new Room(opts || {}); },
    server: null
  };
  window.Telinha = Telinha;
})();
