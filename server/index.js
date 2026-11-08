import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { initialState, applyAction, validateEnvelope, cleanName, LIMITS } from '../shared/reducer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = 'text/javascript; charset=utf-8';
// Whitelist: only these paths are ever read from disk (no path traversal surface).
const FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', JS],
  '/pip.js': ['public/pip.js', JS],
  '/shared/reducer.js': ['shared/reducer.js', JS],
  '/icon.svg': ['public/icon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const MAX_DEVICES = 10;
const MAX_STREAMS_PER_DEVICE = 3;
const EVENT_RETENTION_MS = 7 * 24 * 3600 * 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function makeLimiter({ capacity, perSec }, nowFn) {
  const buckets = new Map();
  return {
    take(key) {
      const t = nowFn();
      let b = buckets.get(key);
      if (!b) { b = { tokens: capacity, t }; buckets.set(key, b); }
      b.tokens = Math.min(capacity, b.tokens + ((t - b.t) / 1000) * perSec);
      b.t = t;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
    sweep() {
      const t = nowFn();
      for (const [k, b] of buckets) if (t - b.t > 600_000) buckets.delete(k);
    },
  };
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      return reject(httpError(415, 'Content-Type must be application/json.'));
    }
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) { tooBig = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(httpError(413, 'Request body too large.'));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape');
        resolve(v);
      } catch {
        reject(httpError(400, 'Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function createApp({ dbPath = ':memory:', now = () => Date.now(), trustProxy = false, limits = {} } = {}) {
  const { stmts, tx } = openDb(dbPath);
  const authLimiter = makeLimiter({ capacity: 10, perSec: 10 / 60, ...limits.auth }, now);
  const actionLimiter = makeLimiter({ capacity: 20, perSec: 10, ...limits.action }, now);

  /** petId -> Set<{res, deviceId}> */
  const streams = new Map();

  const clientIp = (req) => {
    const remote = req.socket.remoteAddress || 'unknown';
    if (!trustProxy) return remote;
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || remote;
  };

  function authenticate(req) {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!m) throw httpError(401, 'Sign in required.');
    const device = stmts.deviceByHash.get(sha256(m[1]));
    if (!device) throw httpError(401, 'This device is no longer signed in.');
    return device;
  }

  function onlineIds(petId) {
    return [...new Set([...(streams.get(petId) || [])].map((c) => c.deviceId))];
  }

  function snapshot(petId) {
    const pet = stmts.petById.get(petId);
    return {
      state: JSON.parse(pet.state),
      version: pet.version,
      serverNow: now(),
      joinCode: pet.join_code,
      members: stmts.devicesOfPet.all(petId).map((d) => ({ id: d.id, name: d.name, role: d.role })),
      online: onlineIds(petId),
    };
  }

  function writeFrame(conn, payload) {
    if (conn.res.writableEnded || conn.res.destroyed) return;
    if (conn.res.writableLength > 1_000_000) { conn.res.destroy(); return; } // slow consumer
    conn.res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  // Remove a stream from the registry *before* ending it, so nothing can write to it afterwards.
  function endConn(petId, conn) {
    const set = streams.get(petId);
    if (set) { set.delete(conn); if (set.size === 0) streams.delete(petId); }
    conn.res.end();
  }

  function broadcast(petId) {
    const set = streams.get(petId);
    if (!set || set.size === 0) return;
    const payload = snapshot(petId);
    for (const conn of set) writeFrame(conn, payload);
  }

  function session(petId, device, token) {
    return { token, device: { id: device.id, name: device.name, role: device.role }, ...snapshot(petId) };
  }

  function newDevice(petId, name, role) {
    const token = crypto.randomBytes(32).toString('hex');
    const device = { id: crypto.randomUUID(), name, role };
    stmts.insertDevice.run(device.id, petId, sha256(token), name, role, now());
    return { token, device };
  }

  function createPet(body) {
    const deviceName = cleanName(body.deviceName, LIMITS.deviceName);
    if (!deviceName) throw httpError(400, `Your name must be 1–${LIMITS.deviceName} characters.`);
    const petName = body.petName === undefined || body.petName === '' ? 'Pip' : cleanName(body.petName, LIMITS.petName);
    if (!petName) throw httpError(400, `Pet name must be 1–${LIMITS.petName} characters.`);
    const petId = crypto.randomUUID();
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    const { token, device } = tx(() => {
      stmts.insertPet.run(petId, code, JSON.stringify(initialState(petName)), now());
      return newDevice(petId, deviceName, 'owner');
    });
    return session(petId, device, token);
  }

  function joinPet(body) {
    const deviceName = cleanName(body.deviceName, LIMITS.deviceName);
    if (!deviceName) throw httpError(400, `Your name must be 1–${LIMITS.deviceName} characters.`);
    const code = String(body.joinCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const pet = code.length === 8 ? stmts.petByCode.get(code) : null;
    if (!pet) throw httpError(404, 'No pet found for that code.');
    const result = tx(() => {
      if (stmts.devicesOfPet.all(pet.id).length >= MAX_DEVICES) throw httpError(409, `This pet already has ${MAX_DEVICES} devices.`);
      return newDevice(pet.id, deviceName, 'member');
    });
    broadcast(pet.id);
    return session(pet.id, result.device, result.token);
  }

  function processAction(device, a) {
    const t = now();
    const out = tx(() => {
      const pet = stmts.petById.get(device.pet_id);
      const state = JSON.parse(pet.state);
      if (stmts.eventByAction.get(pet.id, a.id)) {
        return { duplicate: true, changed: false, state, version: pet.version };
      }
      const res = applyAction(state, a, { now: t, actor: device.name, isOwner: device.role === 'owner' });
      if (res.error) throw httpError(res.status || 400, res.error);
      let version = pet.version;
      if (res.changed) {
        version += 1;
        stmts.updatePet.run(version, JSON.stringify(res.state), pet.id);
      }
      stmts.insertEvent.run(pet.id, device.id, a.id, a.type, JSON.stringify(a.payload ?? {}), version, res.changed ? 1 : 0, t);
      return { duplicate: false, changed: res.changed, note: res.note, state: res.changed ? res.state : state, version };
    });
    if (out.changed) broadcast(device.pet_id);
    return out;
  }

  function leave(device) {
    const petId = device.pet_id;
    tx(() => {
      stmts.deleteDevice.run(device.id);
      const rest = stmts.devicesOfPet.all(petId);
      if (rest.length === 0) {
        stmts.deleteEventsOfPet.run(petId);
        stmts.deletePet.run(petId);
      } else if (!rest.some((d) => d.role === 'owner')) {
        stmts.promote.run(rest[0].id);
      }
    });
    for (const conn of [...(streams.get(petId) || [])]) if (conn.deviceId === device.id) endConn(petId, conn);
    if (stmts.petById.get(petId)) broadcast(petId);
  }

  function openStream(req, res, device) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const petId = device.pet_id;
    if (!streams.has(petId)) streams.set(petId, new Set());
    const set = streams.get(petId);
    const mine = [...set].filter((c) => c.deviceId === device.id);
    if (mine.length >= MAX_STREAMS_PER_DEVICE) endConn(petId, mine[0]); // drop the oldest tab's stream
    const conn = { res, deviceId: device.id };
    streams.get(petId)?.add(conn) ?? streams.set(petId, new Set([conn]));
    res.on('error', () => {}); // a dead client socket must never become an unhandled 'error'
    res.on('close', () => {
      const live = streams.get(petId);
      if (!live || !live.delete(conn)) return; // already removed by endConn()
      if (live.size === 0) streams.delete(petId);
      else broadcast(petId); // presence update
    });
    broadcast(petId); // snapshot for the newcomer + presence for everyone else
  }

  async function handle(req, res) {
    const p = new URL(req.url, 'http://local').pathname;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    if (req.method === 'GET' && FILES[p]) {
      const [file, type] = FILES[p];
      const body = await fs.promises.readFile(path.join(ROOT, file));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': body.length });
      return res.end(body);
    }
    if (p === '/healthz') return sendJson(res, 200, { ok: true });
    if (!p.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });

    switch (`${req.method} ${p}`) {
      case 'POST /api/pets':
      case 'POST /api/join': {
        if (!authLimiter.take(clientIp(req))) throw httpError(429, 'Too many attempts. Please wait a minute.');
        const body = await readJson(req);
        return sendJson(res, 200, p === '/api/pets' ? createPet(body) : joinPet(body));
      }
      case 'GET /api/state': {
        const device = authenticate(req);
        return sendJson(res, 200, { device: { id: device.id, name: device.name, role: device.role }, ...snapshot(device.pet_id) });
      }
      case 'POST /api/action': {
        const device = authenticate(req);
        if (!actionLimiter.take(device.id)) throw httpError(429, 'Slow down a little.');
        const body = await readJson(req);
        const bad = validateEnvelope(body);
        if (bad) throw httpError(400, bad);
        const out = processAction(device, body);
        return sendJson(res, 200, { ...out, serverNow: now() });
      }
      case 'POST /api/leave': {
        leave(authenticate(req));
        return sendJson(res, 200, { ok: true });
      }
      case 'GET /api/stream':
        return openStream(req, res, authenticate(req));
      default:
        if (['/api/pets', '/api/join', '/api/state', '/api/action', '/api/leave', '/api/stream'].includes(p)) {
          throw httpError(405, 'Method not allowed.');
        }
        throw httpError(404, 'Not found.');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err.status) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'Internal server error.' });
    });
  });

  const timers = [
    setInterval(() => { // SSE keep-alive so proxies and phones notice dead sockets
      for (const set of streams.values()) for (const c of set) if (!c.res.writableEnded) c.res.write(': ping\n\n');
    }, 15_000),
    setInterval(() => { authLimiter.sweep(); actionLimiter.sweep(); }, 60_000),
    setInterval(() => stmts.pruneEvents.run(now() - EVENT_RETENTION_MS), 3600_000),
  ];
  timers.forEach((t) => t.unref());

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: () =>
      new Promise((resolve) => {
        timers.forEach(clearInterval);
        for (const set of streams.values()) for (const c of set) c.res.end();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.env.DB_PATH || path.join(ROOT, 'data', 'pip.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const app = createApp({ dbPath, trustProxy: process.env.TRUST_PROXY === '1' });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);
  console.log(`Pip is running on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
