'use strict';
// telinha — http estático de public/ + sinalização WebSocket em /ws (ver docs/PROTOCOLO.md).
// Única dependência: ws.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3004;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'));
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || '';  // IP/host público do coturn; vazio = só STUN público, sem TURN
const TURN_PORT = Number(process.env.TURN_PORT) || 3478;
const TURN_TTL = 12 * 3600; // s
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const MAX_PEERS = 5;
const MAX_CONNS = 400;
const MAX_PAYLOAD = 64 * 1024;
const GRACE_MS = 35000;      // socket caiu sem "leave": segura o lugar (cliente desiste em ~30 s)
const HEARTBEAT_MS = 25000;
const JOIN_TIMEOUT_MS = 10000;
const PENDING_MAX = 300;     // sinais guardados p/ quem está na carência
const RATE_BURST = 300;      // token bucket por socket
const RATE_PER_SEC = 60;

const BOOT = crypto.randomBytes(6).toString('base64url');
const RESUME_KEY = crypto.createHash('sha256')
  .update('telinha-resume:' + (TURN_SECRET || crypto.randomBytes(32).toString('hex'))).digest();

const CODE_RE = /^[a-z0-9-]{3,24}$/;
const FATAL = new Set(['room-full', 'name-invalid', 'code-invalid']);

/** rooms: code -> Map<id, member>; member = { id, name, sharing, conn|null, grace, pending[] } */
const rooms = new Map();

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ estático

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const REVALIDATE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest']);

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'display-capture=(self)',
  'X-Frame-Options': 'SAMEORIGIN',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extra });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'bad request'); }
  if (rel.includes('\0')) return send(res, 400, 'bad request');
  if (rel.endsWith('/')) rel += 'index.html';

  let root, file, st;
  try {
    root = await fs.promises.realpath(PUBLIC_DIR); // public pode ser symlink (releases/current)
    file = await fs.promises.realpath(path.join(root, path.normalize(rel)));
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 404, 'not found');
    st = await fs.promises.stat(file);
    if (st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await fs.promises.stat(file);
    }
  } catch {
    return send(res, 404, 'not found');
  }
  if (path.basename(file).startsWith('.')) return send(res, 404, 'not found');

  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  // html/js/css: sempre revalida (ETag/Last-Modified → 304), para deploy entrar na hora.
  // Obs.: a zona da Cloudflare reescreve max-age/no-cache de .js/.css para 4 h; "private, no-cache" ela respeita (BYPASS).
  const headers = {
    ...BASE_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': REVALIDATE.has(ext) ? 'private, no-cache' : 'public, max-age=300',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
  };
  const ims = Date.parse(req.headers['if-modified-since'] || '');
  if (req.headers['if-none-match'] === etag || (!req.headers['if-none-match'] && ims && Math.floor(st.mtimeMs / 1000) <= Math.floor(ims / 1000))) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad request'); }
  if (url.pathname === '/healthz') {
    let members = 0;
    for (const r of rooms.values()) members += r.size;
    return send(res, 200, JSON.stringify({ ok: true, rooms: rooms.size, members, conns: wss.clients.size, turn: !!(TURN_SECRET && TURN_HOST) }), 'application/json');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', undefined, { Allow: 'GET, HEAD' });
  serveStatic(req, res, url.pathname).catch(() => { if (!res.headersSent) send(res, 500, 'error'); else res.destroy(); });
});
server.headersTimeout = 15000;
server.requestTimeout = 30000;

// ------------------------------------------------------------------ helpers

function iceServers(id) {
  if (!TURN_HOST) return [{ urls: ['stun:stun.l.google.com:19302'] }];
  const ice = [{ urls: [`stun:${TURN_HOST}:${TURN_PORT}`] }];
  if (TURN_SECRET) {
    // TURN REST API (coturn use-auth-secret): username = "<expiry>:<id>", credential = base64(HMAC-SHA1(secret, username))
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${id}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    ice.push({
      urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`],
      username,
      credential,
    });
  }
  return ice;
}

const tokenFor = (id) => crypto.createHmac('sha256', RESUME_KEY).update(id).digest('base64url').slice(0, 22);

function tokenOk(id, token) {
  if (typeof id !== 'string' || typeof token !== 'string' || !/^[A-Za-z0-9_-]{6,32}$/.test(id)) return false;
  const a = Buffer.from(tokenFor(id));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newId(room) {
  let id;
  do id = crypto.randomBytes(6).toString('base64url'); while (room && room.has(id));
  return id;
}

const normCode = (c) => String(c == null ? '' : c).toLowerCase().replace(/\s+/g, '');
// eslint-disable-next-line no-control-regex
const normName = (n) => String(n == null ? '' : n).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim();

function sendJson(conn, msg) {
  if (conn && conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg));
}

function deliver(member, msg) {
  if (member.conn) sendJson(member.conn, msg);
  else if (member.pending.length < PENDING_MAX) member.pending.push(msg);
}

function broadcast(room, msg, exceptId) {
  for (const m of room.values()) if (m.id !== exceptId) deliver(m, msg);
}

function fail(conn, code) {
  sendJson(conn, { t: 'error', code });
  if (FATAL.has(code)) conn.ws.close(4001, code);
}

function removeMember(code, member) {
  const room = rooms.get(code);
  if (!room || room.get(member.id) !== member) return;
  clearTimeout(member.grace);
  room.delete(member.id);
  if (room.size === 0) rooms.delete(code);
  else broadcast(room, { t: 'peer-left', id: member.id });
  log('leave', member.id, 'size', room.size);
}

// ------------------------------------------------------------------ protocolo

function onJoin(conn, msg) {
  if (conn.member) return;
  const code = normCode(msg.room);
  const name = normName(msg.name);
  if (!name || name.length > 24) return fail(conn, 'name-invalid');
  if (!CODE_RE.test(code)) return fail(conn, 'code-invalid');

  let room = rooms.get(code);
  let member = null;
  let resumed = false;

  const r = msg.resume;
  if (r && tokenOk(r.id, r.token)) {
    member = room && room.get(r.id);
    if (member) {
      // mesmo id voltando dentro da carência (ou trocando um socket velho): ninguém fica sabendo
      resumed = true;
      clearTimeout(member.grace);
      member.grace = null;
      if (member.conn) {
        const old = member.conn;
        old.member = null;
        old.ws.close(4002, 'replaced');
      }
      member.name = name;
    } else {
      if (room && room.size >= MAX_PEERS) return fail(conn, 'room-full');
      member = { id: r.id, name, sharing: false, conn: null, grace: null, pending: [] };
    }
  } else {
    if (room && room.size >= MAX_PEERS) return fail(conn, 'room-full');
    member = { id: newId(room), name, sharing: false, conn: null, grace: null, pending: [] };
  }

  if (!room) rooms.set(code, (room = new Map()));
  const isNew = !room.has(member.id);
  if (isNew) {
    broadcast(room, { t: 'peer-joined', id: member.id, name });
    room.set(member.id, member);
  }
  member.conn = conn;
  conn.member = member;
  conn.code = code;
  clearTimeout(conn.joinTimer);

  const peers = [];
  for (const m of room.values()) if (m !== member) peers.push({ id: m.id, name: m.name, sharing: m.sharing });
  sendJson(conn, { t: 'welcome', id: member.id, peers, ice: iceServers(member.id), token: tokenFor(member.id), resumed, boot: BOOT });
  if (resumed) {
    const pend = member.pending;
    member.pending = [];
    for (const m of pend) sendJson(conn, m);
  } else {
    member.pending = [];
  }
  log(resumed ? 'resume' : 'join', member.id, 'size', room.size);
}

function onMessage(conn, raw, isBinary) {
  // rate limit (token bucket)
  const now = Date.now();
  conn.tokens = Math.min(RATE_BURST, conn.tokens + ((now - conn.last) / 1000) * RATE_PER_SEC);
  conn.last = now;
  if (conn.tokens < 1) {
    if (++conn.strikes > 200) conn.ws.close(1008, 'rate');
    return;
  }
  conn.tokens -= 1;

  if (isBinary) return;
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { conn.strikes++; return; }
  if (!msg || typeof msg !== 'object') return;

  switch (msg.t) {
    case 'ping':
      return sendJson(conn, { t: 'pong' });
    case 'join':
      return onJoin(conn, msg);
  }

  const me = conn.member;
  if (!me) return;
  const room = rooms.get(conn.code);
  if (!room) return;

  switch (msg.t) {
    case 'signal': {
      if (typeof msg.to !== 'string' || msg.to === me.id) return;
      const d = msg.data;
      if (!d || typeof d !== 'object' || (!d.description && !d.candidate)) return;
      const target = room.get(msg.to);
      if (target) deliver(target, { t: 'signal', from: me.id, data: d });
      return;
    }
    case 'share': {
      const on = !!msg.on;
      if (me.sharing === on) return;
      me.sharing = on;
      broadcast(room, { t: 'share', id: me.id, on }, me.id);
      return;
    }
    case 'leave':
      conn.left = true;
      removeMember(conn.code, me);
      conn.member = null;
      conn.ws.close(1000, 'leave');
  }
}

function onClose(conn, code) {
  clearTimeout(conn.joinTimer);
  const me = conn.member;
  if (!me || me.conn !== conn) return;
  me.conn = null;
  conn.member = null;
  if (conn.left || code === 1000 || code === 1001) return removeMember(conn.code, me);
  me.grace = setTimeout(() => removeMember(conn.code, me), GRACE_MS);
}

// ------------------------------------------------------------------ websocket

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, clientTracking: true });

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // clientes não-navegador
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  return host === req.headers.host || ALLOWED_ORIGINS.includes(origin);
}

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* inválido */ }
  const reject = (status) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  if (pathname !== '/ws') return reject('404 Not Found');
  if (!originOk(req)) return reject('403 Forbidden');
  if (wss.clients.size >= MAX_CONNS) return reject('503 Service Unavailable');
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  const conn = { ws, member: null, code: null, alive: true, tokens: RATE_BURST, last: Date.now(), strikes: 0, left: false };
  conn.joinTimer = setTimeout(() => { if (!conn.member) ws.close(4003, 'join timeout'); }, JOIN_TIMEOUT_MS);
  ws.on('pong', () => { conn.alive = true; });
  ws.on('message', (raw, isBinary) => { conn.alive = true; onMessage(conn, raw, isBinary); });
  ws.on('close', (code) => onClose(conn, code));
  ws.on('error', () => {});
  ws._conn = conn;
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const conn = ws._conn;
    if (!conn) continue;
    if (!conn.alive) { ws.terminate(); continue; }
    conn.alive = false;
    try { ws.ping(); } catch { /* fechando */ }
  }
}, HEARTBEAT_MS);

server.listen(PORT, HOST, () => log(`telinha em http://${HOST}:${PORT}  public=${PUBLIC_DIR}  turn=${TURN_SECRET && TURN_HOST ? TURN_HOST : 'OFF'}  boot=${BOOT}`));

function shutdown() {
  log('desligando');
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1012, 'restart');
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
