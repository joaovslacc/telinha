/* telinha — UI. Fala só com window.Telinha (ver docs/PROTOCOLO.md). */
(function () {
  'use strict';

  var API = window.Telinha;
  var LS_NAME = 'telinha-name';
  var CODE_RE = /^[a-z0-9-]{3,24}$/;
  var MAX = 0; // limite de pessoas da sala (vem do servidor; 0 = sem limite)

  function $(id) { return document.getElementById(id); }
  var el = {
    lobby: $('lobby'), room: $('room'), fatal: $('fatal'),
    form: $('join-form'), name: $('f-name'), code: $('f-code'), gen: $('btn-gen'), join: $('btn-join'),
    eName: $('e-name'), eCode: $('e-code'), alert: $('form-alert'), lobbyMobile: $('lobby-mobile'),
    rCode: $('r-code'), copy: $('btn-copy'), count: $('r-count'), banner: $('banner'),
    stage: $('stage'), tiles: $('tiles'), emptyTitle: $('empty-title'), emptyText: $('empty-text'), emptyActions: $('empty-actions'),
    share: $('btn-share'), all: $('btn-all'), fs: $('btn-fs'), leave: $('btn-leave'), shareNote: $('share-note'),
    people: $('people'), preview: $('preview'), previewVideo: $('preview-video'), stop: $('btn-stop'),
    fatalTitle: $('fatal-title'), fatalText: $('fatal-text'), retry: $('btn-retry'), home: $('btn-home'),
    toasts: $('toasts')
  };

  var P = {
    share: '<path d="m9 10 3-3 3 3"/><path d="M12 13V7"/><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M12 17v4"/><path d="M8 21h8"/>',
    stop: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M12 17v4"/><path d="M8 21h8"/><path d="m14.5 7.5-5 5"/><path d="m9.5 7.5 5 5"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    max: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    min: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    userIn: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
    userOut: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    wifi: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>',
    shuffle: '<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-7.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>'
  };
  function icon(n) { return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + P[n] + '</svg>'; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function normCode(c) { return String(c || '').toLowerCase().replace(/\s+/g, ''); }

  var S = {
    room: null, code: '', name: '', joined: false, unsubs: [],
    people: new Map(), order: [], tiles: new Map(), focus: null, local: null, lastErr: {}
  };

  /* ---------------- views ---------------- */
  function currentView() { return [el.lobby, el.room, el.fatal].filter(function (v) { return !v.hidden; })[0]; }
  function show(view, after) {
    var cur = currentView();
    if (cur === view) { if (after) after(); return; }
    function reveal() {
      view.hidden = false;
      view.classList.remove('is-entering'); void view.offsetWidth; view.classList.add('is-entering');
      setTimeout(function () { view.classList.remove('is-entering'); }, 320);
      if (after) after();
    }
    if (!cur) return reveal();
    cur.classList.add('is-leaving');
    setTimeout(function () { cur.hidden = true; cur.classList.remove('is-leaving'); reveal(); }, 150);
  }

  /* ---------------- toasts ---------------- */
  function toast(text, kind, ic, ms) {
    var t = document.createElement('div');
    t.className = 'toast ' + (kind || 'info');
    t.innerHTML = icon(ic || 'check') + '<span>' + esc(text) + '</span>';
    el.toasts.appendChild(t);
    while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
    t.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
    setTimeout(function () { t.classList.add('is-leaving'); setTimeout(function () { t.remove(); }, 160); }, ms || 3500);
  }

  /* ---------------- lobby ---------------- */
  function fieldError(input, box, msg) {
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    box.textContent = msg || '';
    box.hidden = !msg;
  }
  function formAlert(html) {
    if (!html) { el.alert.hidden = true; el.alert.innerHTML = ''; return; }
    el.alert.innerHTML = html;
    el.alert.hidden = false;
  }
  function setBusy(btn, busy, label) {
    btn.disabled = busy;
    btn.classList.toggle('is-busy', busy);
    var l = btn.querySelector('.btn-label');
    if (l && label) l.textContent = label;
  }

  function initLobby() {
    var saved = '';
    try { saved = localStorage.getItem(LS_NAME) || ''; } catch (e) { /* modo privado */ }
    el.name.value = saved;
    var sala = new URLSearchParams(location.search).get('sala');
    if (sala) el.code.value = normCode(sala);
    el.lobbyMobile.hidden = API.canShare;
    if (!matchMedia('(pointer: coarse)').matches) {
      (!el.name.value ? el.name : !el.code.value ? el.code : el.join).focus();
    }
  }

  el.gen.addEventListener('click', function () {
    el.code.value = API.randomCode();
    fieldError(el.code, el.eCode, '');
    formAlert('');
    el.code.focus();
    el.code.select();
  });
  el.name.addEventListener('input', function () { if (el.name.getAttribute('aria-invalid') === 'true') fieldError(el.name, el.eName, ''); });
  el.code.addEventListener('input', function () { if (el.code.getAttribute('aria-invalid') === 'true') fieldError(el.code, el.eCode, ''); formAlert(''); });

  el.form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (S.room) return;
    var name = el.name.value.trim();
    var code = normCode(el.code.value);
    el.code.value = code;
    var bad = null;
    if (!name) { fieldError(el.name, el.eName, 'Digite seu nome para entrar.'); bad = bad || el.name; }
    else if (name.length > 24) { fieldError(el.name, el.eName, 'Use no máximo 24 caracteres.'); bad = bad || el.name; }
    else fieldError(el.name, el.eName, '');
    if (!code) { fieldError(el.code, el.eCode, 'Digite um código ou clique em Gerar.'); bad = bad || el.code; }
    else if (!CODE_RE.test(code)) { fieldError(el.code, el.eCode, 'Use de 3 a 24 letras, números ou hífen (sem acento nem espaço).'); bad = bad || el.code; }
    else fieldError(el.code, el.eCode, '');
    formAlert('');
    if (bad) { bad.focus(); return; }
    try { localStorage.setItem(LS_NAME, name); } catch (e) { /* ok */ }
    doJoin(name, code);
  });

  /* ---------------- sala ---------------- */
  function doJoin(name, code) {
    S.name = name; S.code = code;
    setBusy(el.join, true, 'Entrando');
    var room = S.room = API.join({ name: name, code: code });
    function on(ev, fn) { S.unsubs.push(room.on(ev, fn)); }

    on('joined', function (p) {
      S.joined = true;
      MAX = p.max || 0;
      S.people.clear(); S.order = [];
      addPerson({ id: p.self.id, name: p.self.name || name, sharing: false, state: 'self', self: true });
      (p.peers || []).forEach(function (x) { addPerson({ id: x.id, name: x.name, sharing: !!x.sharing, state: 'connecting' }); });
      var u = new URL(location.href); u.searchParams.set('sala', code); history.replaceState(null, '', u);
      el.rCode.textContent = code;
      el.share.hidden = !API.canShare;
      el.shareNote.hidden = API.canShare;
      setBusy(el.join, false, 'Entrar na sala');
      renderAll();
      show(el.room, function () { el.share.hidden ? el.copy.focus() : el.share.focus(); });
    });
    on('peer-joined', function (p) {
      addPerson({ id: p.id, name: p.name, sharing: false, state: 'connecting' });
      toast(p.name + ' entrou na sala', 'info', 'userIn');
      renderAll();
    });
    on('peer-left', function (p) {
      var who = S.people.get(p.id);
      removeTile(p.id);
      S.people.delete(p.id);
      S.order = S.order.filter(function (i) { return i !== p.id; });
      toast((p.name || (who && who.name) || 'Alguém') + ' saiu da sala', 'info', 'userOut');
      renderAll();
    });
    on('share-changed', function (p) {
      var who = S.people.get(p.id);
      if (who) who.sharing = !!p.sharing;
      if (who && who.self) {
        if (!p.sharing) clearLocal(true);
      } else if (who) {
        if (p.sharing) toast(who.name + ' começou a compartilhar', 'info', 'monitor');
        else removeTile(p.id);
      }
      renderAll();
    });
    on('stream', function (p) {
      if (room.self && p.id === room.self.id) return; // minha própria tela: a prévia vem de startShare()
      addTile(p.id, p.stream); renderAll();
    });
    on('stream-ended', function (p) { removeTile(p.id); renderAll(); });
    on('connection', function (p) {
      var who = S.people.get(p.id);
      if (!who) return;
      if (p.state === 'failed' && who.state !== 'failed') toast('Não deu para conectar com ' + who.name + '. A tela dele pode não aparecer.', 'bad', 'alert', 5000);
      who.state = p.state;
      renderPeople();
    });
    on('reconnecting', function () { el.banner.hidden = false; });
    on('reconnected', function () { el.banner.hidden = true; toast('Conexão de volta', 'ok', 'wifi'); });
    on('error', function (e) { handleError(e || {}); });
  }

  function handleError(e) {
    var now = Date.now();
    if (S.lastErr[e.code] && now - S.lastErr[e.code] < 1200) return; // evita duplicar (rejeição + evento)
    S.lastErr[e.code] = now;

    if (e.code === 'share-denied') { toast('Compartilhamento cancelado. Clique em “Compartilhar tela” para tentar de novo.', 'warn', 'alert', 5000); return; }
    if (e.code === 'share-unsupported') { toast('Este navegador não compartilha tela. Você ainda pode assistir.', 'warn', 'alert', 5000); return; }

    var wasJoined = S.joined;
    teardown();
    if (e.code === 'signaling-lost' && wasJoined) {
      el.fatalTitle.textContent = 'A conexão caiu';
      el.fatalText.textContent = 'Tentamos reconectar ao servidor, mas não deu. Verifique sua internet e tente de novo.';
      show(el.fatal, function () { el.retry.focus(); });
      return;
    }
    show(el.lobby, function () {
      setBusy(el.join, false, 'Entrar na sala');
      if (e.code === 'name-invalid') { fieldError(el.name, el.eName, 'Nome inválido: use de 1 a 24 caracteres.'); el.name.focus(); }
      else if (e.code === 'code-invalid') { fieldError(el.code, el.eCode, 'Código inválido: use de 3 a 24 letras, números ou hífen.'); el.code.focus(); }
      else if (e.code === 'room-full') {
        formAlert(icon('alert') + '<p><strong>A sala “' + esc(S.code) + '” está cheia.</strong> Ela atingiu o limite de pessoas. Peça para alguém sair ou crie uma sala nova.</p>' +
          '<button type="button" class="btn btn-ghost btn-sm" id="btn-newroom">' + icon('shuffle') + 'Criar sala nova</button>');
        var b = $('btn-newroom');
        b.addEventListener('click', function () { el.code.value = API.randomCode(); formAlert(''); el.join.focus(); });
        b.focus();
      } else {
        formAlert(icon('alert') + '<p><strong>Não deu para conectar.</strong> Verifique sua internet e tente de novo.</p>');
        el.join.focus();
      }
    });
  }

  function teardown() {
    S.unsubs.forEach(function (u) { try { u(); } catch (e) { /* ok */ } });
    S.unsubs = [];
    if (S.room) { try { S.room.leave(); } catch (e) { /* ok */ } }
    S.room = null; S.joined = false; S.focus = null;
    S.tiles.forEach(function (t) { t.remove(); });
    S.tiles.clear();
    S.people.clear(); S.order = [];
    el.people.innerHTML = '';
    clearLocal(false);
    el.banner.hidden = true;
    el.toasts.innerHTML = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  }

  /* ---------------- pessoas ---------------- */
  function addPerson(p) {
    if (!S.people.has(p.id)) S.order.push(p.id);
    S.people.set(p.id, p);
  }

  var STATE_TXT = { self: 'assistindo', selfShare: 'enviando a tela', connecting: 'conectando…', connected: 'conectado', relay: 'conectado via relay', failed: 'falhou a conexão' };

  function renderPeople() {
    var seen = {};
    S.order.forEach(function (id) {
      var p = S.people.get(id);
      if (!p) return;
      seen[id] = true;
      var li = el.people.querySelector('[data-id="' + CSS.escape(id) + '"]');
      if (!li) {
        li = document.createElement('li');
        li.className = 'person';
        li.dataset.id = id;
        el.people.appendChild(li);
      }
      var canWatch = !p.self && S.tiles.has(id) && S.tiles.size > 1 && S.focus !== id;
      var sig = [p.name, p.state, p.sharing, canWatch].join('|');
      if (li.dataset.sig === sig) return;
      li.dataset.sig = sig;
      li.classList.toggle('is-sharing', !!p.sharing);
      li.innerHTML =
        '<span class="avatar" style="--h:' + hue(p.name) + '" aria-hidden="true">' + esc((p.name || '?').charAt(0).toUpperCase()) + '</span>' +
        '<span class="person-main">' +
          '<span class="person-name">' + esc(p.name) + (p.self ? ' <small>(você)</small>' : '') + '</span>' +
          '<span class="person-state st-' + p.state + '">' + (p.self ? '' : '<span class="dot" aria-hidden="true"></span>') + STATE_TXT[p.self && p.sharing ? 'selfShare' : p.state] + '</span>' +
        '</span>' +
        (p.sharing ? '<span class="sharing-badge">' + icon('monitor') + 'tela</span>' : '') +
        (canWatch ? '<button type="button" class="person-watch" aria-label="Ver tela de ' + esc(p.name) + ' em destaque" title="Ver em destaque">' + icon('eye') + '</button>' : '');
      var w = li.querySelector('.person-watch');
      if (w) w.addEventListener('click', function () { setFocus(id); });
    });
    Array.prototype.slice.call(el.people.children).forEach(function (li) {
      if (!seen[li.dataset.id] && !li.classList.contains('is-leaving')) {
        li.classList.add('is-leaving');
        setTimeout(function () { li.remove(); }, 160);
      }
    });
    var n = S.people.size;
    el.count.textContent = MAX ? n + '/' + MAX : String(n);
    el.count.parentNode.setAttribute('aria-label', MAX ? n + ' de ' + MAX + ' pessoas na sala' : n + (n === 1 ? ' pessoa' : ' pessoas') + ' na sala');
  }

  /* ---------------- telas ---------------- */
  function nameOf(id) { var p = S.people.get(id); return p ? p.name : 'alguém'; }

  function addTile(id, stream) {
    var t = S.tiles.get(id);
    if (!t) {
      t = document.createElement('div');
      t.className = 'tile';
      t.dataset.id = id;
      t.innerHTML =
        '<video muted playsinline autoplay></video>' +
        '<div class="tile-wait">Carregando a tela…</div>' +
        '<button type="button" class="tile-hit"></button>' +
        '<span class="tile-name">' + icon('monitor') + '<span></span></span>' +
        '<button type="button" class="tile-fs" title="Tela cheia">' + icon('max') + '</button>';
      var v = t.querySelector('video');
      v.addEventListener('loadeddata', function () { t.classList.add('is-live'); });
      t.querySelector('.tile-hit').addEventListener('click', function () {
        if (S.tiles.size < 2 || document.fullscreenElement) return;
        setFocus(S.focus === id ? null : id);
      });
      t.querySelector('.tile-hit').addEventListener('dblclick', function () { fullscreen(t); });
      t.querySelector('.tile-fs').addEventListener('click', function () { fullscreen(t); });
      el.tiles.appendChild(t);
      S.tiles.set(id, t);
    }
    var vid = t.querySelector('video');
    vid.srcObject = stream;
    var pr = vid.play(); if (pr && pr.catch) pr.catch(function () {});
  }

  function removeTile(id) {
    var t = S.tiles.get(id);
    if (!t) return;
    S.tiles.delete(id);
    if (S.focus === id) S.focus = null;
    if (document.fullscreenElement === t) document.exitFullscreen().catch(function () {});
    t.classList.add('is-leaving');
    setTimeout(function () { var v = t.querySelector('video'); v.srcObject = null; t.remove(); }, 150);
  }

  function setFocus(id) { S.focus = id; renderAll(); }

  function renderStage() {
    var ids = Array.from(S.tiles.keys());
    var n = ids.length;
    if (S.focus && !S.tiles.has(S.focus)) S.focus = null;
    var mode = n === 0 ? 'empty' : n === 1 ? 'single' : (S.focus ? 'focus' : 'grid');
    el.stage.dataset.mode = mode;
    var cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    var rem = n % cols;
    // grade com 2 subcolunas por tela: assim a última linha incompleta fica centralizada
    el.tiles.style.setProperty('--cols', mode === 'grid' ? cols * 2 : 1);
    el.tiles.style.setProperty('--others', Math.max(1, n - 1));
    if (mode === 'focus') el.tiles.style.gridTemplateColumns = '1fr repeat(' + (n - 1) + ', minmax(0, 160px)) 1fr';
    else el.tiles.style.gridTemplateColumns = '';

    var k = 0;
    ids.forEach(function (id) {
      var t = S.tiles.get(id), nm = nameOf(id);
      var focused = mode === 'focus' && S.focus === id;
      t.classList.toggle('is-focus', focused);
      var gi = ids.indexOf(id);
      if (mode === 'focus') t.style.gridColumn = focused ? '' : String(2 + k++);
      else if (mode === 'grid') t.style.gridColumn = (rem && gi === n - rem ? (cols - rem + 1) + ' / ' : '') + 'span 2';
      else t.style.gridColumn = '';
      t.style.gridRow = mode === 'focus' && !focused ? '2' : '';
      t.querySelector('.tile-name span').textContent = nm;
      var hit = t.querySelector('.tile-hit');
      if (mode === 'single') { hit.tabIndex = -1; hit.setAttribute('aria-label', 'Tela de ' + nm + '. Clique duas vezes para tela cheia.'); }
      else {
        hit.tabIndex = 0;
        hit.setAttribute('aria-label', focused ? 'Tela de ' + nm + ' em destaque. Clique para voltar à grade.' : 'Destacar a tela de ' + nm);
      }
      t.querySelector('.tile-fs').setAttribute('aria-label', 'Tela cheia: tela de ' + nm);
    });

    el.all.hidden = mode !== 'focus';
    el.fs.disabled = n === 0;

    if (mode === 'empty') renderEmpty();
  }

  function renderEmpty() {
    var alone = S.people.size <= 1;
    if (S.local) {
      el.emptyTitle.textContent = 'Você está compartilhando';
      el.emptyText.textContent = alone ? 'Sua tela já está saindo. Assim que alguém entrar pelo link, vai ver na hora.' : 'Quem está na sala já vê sua tela. A prévia do que você envia fica na lateral.';
      el.emptyActions.innerHTML = alone ? inviteHTML() : '';
    } else if (alone) {
      el.emptyTitle.textContent = 'Você é o primeiro aqui';
      el.emptyText.textContent = 'Mande o link para quem vai entrar.' + (MAX ? ' Cabem até ' + MAX + ' pessoas na sala.' : '');
      el.emptyActions.innerHTML = inviteHTML();
    } else {
      el.emptyTitle.textContent = 'Ninguém está compartilhando';
      el.emptyText.textContent = API.canShare ? 'Quando alguém compartilhar, a tela aparece aqui. Pode ser você.' : 'Quando alguém compartilhar, a tela aparece aqui.';
      el.emptyActions.innerHTML = API.canShare ? '<button type="button" class="btn btn-primary" data-act="share">' + icon('share') + 'Compartilhar minha tela</button>' : '';
    }
    var c = el.emptyActions.querySelector('[data-act="copy"]');
    if (c) c.addEventListener('click', copyLink);
    var s = el.emptyActions.querySelector('[data-act="share"]');
    if (s) s.addEventListener('click', toggleShare);
  }
  function inviteHTML() {
    return '<span class="invite-code">' + esc(S.code) + '<button type="button" class="btn btn-chip" data-act="copy">' + icon('link') + 'Copiar link</button></span>';
  }

  function renderShareBtn() {
    var on = !!S.local;
    el.share.classList.toggle('btn-primary', !on);
    el.share.classList.toggle('btn-stop', on);
    el.share.innerHTML = icon(on ? 'stop' : 'share') + '<span class="btn-label">' + (on ? 'Parar de compartilhar' : 'Compartilhar tela') + '</span>';
    el.share.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function renderAll() { renderStage(); renderPeople(); renderShareBtn(); }

  /* ---------------- compartilhar ---------------- */
  function toggleShare() {
    if (!S.room) return;
    if (S.local) { S.room.stopShare(); clearLocal(true); renderAll(); return; }
    el.share.disabled = true;
    el.share.querySelector('.btn-label').textContent = 'Escolha a tela…';
    S.room.startShare().then(function (stream) {
      if (!S.room) return;
      S.local = stream;
      el.previewVideo.srcObject = stream;
      var pr = el.previewVideo.play(); if (pr && pr.catch) pr.catch(function () {});
      el.preview.hidden = false;
      var me = S.people.get(S.room.self && S.room.self.id);
      if (me) me.sharing = true;
      toast('Você está compartilhando a tela', 'ok', 'share');
    }).catch(function (e) {
      handleError({ code: (e && e.code) || 'share-denied' });
    }).then(function () {
      el.share.disabled = false;
      renderAll();
    });
  }

  function clearLocal(notify) {
    if (!S.local) { el.preview.hidden = true; return; }
    S.local = null;
    el.previewVideo.srcObject = null;
    el.preview.hidden = true;
    S.people.forEach(function (p) { if (p.self) p.sharing = false; });
    if (notify) toast('Você parou de compartilhar', 'info', 'stop');
  }

  el.share.addEventListener('click', toggleShare);
  el.stop.addEventListener('click', toggleShare);

  /* ---------------- copiar link ---------------- */
  function inviteUrl() {
    var u = new URL(location.href);
    u.search = ''; u.hash = '';
    u.searchParams.set('sala', S.code);
    return u.toString();
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    return legacyCopy(text);
  }
  function legacyCopy(text) {
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ok */ }
      ta.remove(); ok ? res() : rej(new Error('copy'));
    });
  }
  function copyLink() {
    var url = inviteUrl();
    copyText(url).then(function () {
      el.copy.classList.add('is-done');
      el.copy.innerHTML = icon('check') + '<span class="btn-label">Copiado</span>';
      setTimeout(function () { el.copy.classList.remove('is-done'); el.copy.innerHTML = icon('link') + '<span class="btn-label">Copiar link</span>'; }, 1800);
      toast('Link copiado. Mande para quem vai entrar.', 'ok', 'check');
    }, function () {
      toast('Não deu para copiar. O código da sala é ' + S.code, 'warn', 'alert', 6000);
    });
  }
  el.copy.addEventListener('click', copyLink);

  /* ---------------- tela cheia ---------------- */
  function fullscreen(node) {
    if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); return; }
    if (node.requestFullscreen) node.requestFullscreen().catch(function () { toast('Tela cheia não está disponível aqui', 'warn', 'alert'); });
    else {
      var v = node.querySelector && node.querySelector('video');
      if (v && v.webkitEnterFullscreen) v.webkitEnterFullscreen();
      else if (node.webkitRequestFullscreen) node.webkitRequestFullscreen();
    }
  }
  el.fs.addEventListener('click', function () {
    var target = (S.focus && S.tiles.get(S.focus)) || (S.tiles.size === 1 ? S.tiles.values().next().value : el.stage);
    fullscreen(target);
  });
  document.addEventListener('fullscreenchange', function () {
    var on = !!document.fullscreenElement;
    el.fs.innerHTML = icon(on ? 'min' : 'max') + '<span class="btn-label">' + (on ? 'Sair da tela cheia' : 'Tela cheia') + '</span>';
  });
  el.all.addEventListener('click', function () { setFocus(null); });

  /* ---------------- sair ---------------- */
  el.leave.addEventListener('click', function () {
    teardown();
    show(el.lobby, function () { el.join.focus(); });
    toast('Você saiu da sala', 'info', 'userOut');
  });
  el.retry.addEventListener('click', function () {
    show(el.lobby, function () { doJoin(S.name, S.code); });
  });
  el.home.addEventListener('click', function () { show(el.lobby, function () { el.join.focus(); }); });

  document.addEventListener('keydown', function (e) {
    if (el.room.hidden || e.target.matches('input, textarea')) return;
    if (e.key === 'Escape' && S.focus && !document.fullscreenElement) setFocus(null);
  });
  window.addEventListener('pagehide', function () { if (S.room) S.room.leave(); });

  initLobby();
})();
