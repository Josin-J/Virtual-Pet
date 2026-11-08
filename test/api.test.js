import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';

let app; let base;
const aid = () => crypto.randomBytes(8).toString('hex');

before(async () => {
  app = createApp({ limits: { auth: { capacity: 1000 } } });
  const { port } = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});
after(() => app.close());

async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && { 'content-type': 'application/json' }), ...headers },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
}
const act = (token, type, payload = {}, id = aid()) => call('/api/action', { method: 'POST', token, body: { id, type, payload } });

async function household() {
  const a = (await call('/api/pets', { method: 'POST', body: { deviceName: 'Jamie' } })).json;
  const b = (await call('/api/join', { method: 'POST', body: { joinCode: a.joinCode.toLowerCase(), deviceName: 'Sam' } })).json;
  return { a, b };
}

// Minimal SSE client built on fetch, mirroring what the browser does.
async function openStream(token) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const events = []; const waiters = [];
  (async () => {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data:'));
          if (data) { const ev = JSON.parse(data.slice(5)); events.push(ev); waiters.splice(0).forEach((w) => w()); }
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    events,
    async until(pred, ms = 2000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error('timed out waiting for stream event');
        await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
      }
    },
    close: () => ctrl.abort(),
  };
}

test('create pet returns session with join code and initial state', async () => {
  const r = await call('/api/pets', { method: 'POST', body: { deviceName: 'Jamie', petName: 'Boo' } });
  assert.equal(r.status, 200);
  assert.match(r.json.token, /^[a-f0-9]{64}$/);
  assert.match(r.json.joinCode, /^[A-Z2-9]{8}$/);
  assert.equal(r.json.state.name, 'Boo');
  assert.equal(r.json.device.role, 'owner');
  assert.equal(r.json.version, 1);
});

test('join: accepts lowercase/dashed code, rejects unknown code', async () => {
  const { a, b } = await household();
  assert.equal(b.device.role, 'member');
  assert.equal(b.members.length, 2);
  const dashed = `${a.joinCode.slice(0, 4)}-${a.joinCode.slice(4)}`;
  assert.equal((await call('/api/join', { method: 'POST', body: { joinCode: dashed, deviceName: 'Kim' } })).status, 200);
  assert.equal((await call('/api/join', { method: 'POST', body: { joinCode: 'ZZZZZZZZ', deviceName: 'X' } })).status, 404);
  assert.equal((await call('/api/join', { method: 'POST', body: { joinCode: 'abc', deviceName: 'X' } })).status, 404);
});

test('validation: names, malformed JSON, wrong content type, oversize body', async () => {
  assert.equal((await call('/api/pets', { method: 'POST', body: { deviceName: '   ' } })).status, 400);
  assert.equal((await call('/api/pets', { method: 'POST', body: { deviceName: 'x'.repeat(25) } })).status, 400);
  const bad = await fetch(`${base}/api/pets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  const wrongType = await fetch(`${base}/api/pets`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' });
  assert.equal(wrongType.status, 415);
  const big = await fetch(`${base}/api/pets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceName: 'a', pad: 'x'.repeat(20000) }) });
  assert.equal(big.status, 413);
});

test('auth: missing, malformed and unknown tokens are rejected', async () => {
  assert.equal((await call('/api/state')).status, 401);
  assert.equal((await call('/api/state', { token: 'abc' })).status, 401);
  assert.equal((await call('/api/state', { token: 'a'.repeat(64) })).status, 401);
  assert.equal((await act('a'.repeat(64), 'water', { day: '2026-11-06' })).status, 401);
});

test('task flow: add, complete, celebrate on last task, delete', async () => {
  const { a } = await household();
  const id = aid();
  let r = await act(a.token, 'task_add', { id, text: '  finish   science notes ' });
  assert.equal(r.json.state.tasks[0].text, 'finish science notes');
  assert.equal(r.json.version, 2);
  r = await act(a.token, 'task_set', { id, done: true });
  assert.equal(r.json.state.mood, 'surprised'); // last task done → celebration
  r = await act(a.token, 'task_delete', { id });
  assert.equal(r.json.state.tasks.length, 0);
});

test('stored text stays literal (no HTML interpretation server-side) and control chars are stripped', async () => {
  const { a } = await household();
  const r = await act(a.token, 'task_add', { id: aid(), text: '<img src=x onerror=alert(1)>\u0007\n' });
  assert.equal(r.json.state.tasks[0].text, '<img src=x onerror=alert(1)>');
});

test('concurrent completion of the same task from two devices applies exactly once', async () => {
  const { a, b } = await household();
  const id = aid();
  await act(a.token, 'task_add', { id, text: 'water the plant' });
  const before = (await call('/api/state', { token: a.token })).json.version;
  const [r1, r2] = await Promise.all([act(a.token, 'task_set', { id, done: true }), act(b.token, 'task_set', { id, done: true })]);
  const changed = [r1, r2].filter((r) => r.json.changed);
  const noted = [r1, r2].filter((r) => !r.json.changed);
  assert.equal(changed.length, 1);
  assert.equal(noted.length, 1);
  assert.match(noted[0].json.note, /already completed/);
  const after = (await call('/api/state', { token: a.token })).json;
  assert.equal(after.version, before + 1);
  assert.equal(after.state.tasks[0].done, true);
});

test('idempotency: replaying an action id does not apply it twice', async () => {
  const { a } = await household();
  const id = aid();
  const day = '2026-11-06';
  const r1 = await act(a.token, 'water', { day }, id);
  const r2 = await act(a.token, 'water', { day }, id);
  assert.equal(r1.json.state.water, 1);
  assert.equal(r2.json.duplicate, true);
  assert.equal(r2.json.state.water, 1);
  assert.equal(r2.json.version, r1.json.version);
});

test('offline replay: queued actions arriving late still converge', async () => {
  const { a, b } = await household();
  const id = aid();
  await act(a.token, 'task_add', { id, text: 'laundry' });
  await act(a.token, 'task_delete', { id });                          // another device removed it meanwhile
  const late = await act(b.token, 'task_set', { id, done: true });     // Sam's queued action arrives hours later
  assert.equal(late.status, 200);
  assert.equal(late.json.changed, false);
  assert.match(late.json.note, /already removed/);
});

test('water: daily reset, stale-day guard and cap', async () => {
  const { a } = await household();
  await act(a.token, 'water', { day: '2026-11-06' });
  await act(a.token, 'water', { day: '2026-11-06' });
  let r = await act(a.token, 'water', { day: '2026-11-07' });
  assert.equal(r.json.state.water, 1);                                  // new day resets
  r = await act(a.token, 'water', { day: '2026-11-06' });                // device behind in time
  assert.equal(r.json.changed, false);
  assert.equal(r.json.state.water, 1);
  assert.equal((await act(a.token, 'water', { day: 'yesterday' })).status, 400);
  for (let i = 0; i < 25; i++) {
    r = await act(a.token, 'water', { day: '2026-11-07' });
    if (r.status === 429) { await new Promise((x) => setTimeout(x, 150)); i -= 1; } // respect the rate limiter
  }
  assert.equal(r.json.state.water, 20);
});

test('permissions: only the owner can rename; invalid actions are rejected', async () => {
  const { a, b } = await household();
  assert.equal((await act(b.token, 'rename', { name: 'Ghosty' })).status, 403);
  const ok = await act(a.token, 'rename', { name: 'Ghosty' });
  assert.equal(ok.json.state.name, 'Ghosty');
  assert.equal((await act(a.token, 'emote', { mood: 'furious' })).status, 400);
  assert.equal((await act(a.token, 'launch_missiles')).status, 400);
  assert.equal((await call('/api/action', { method: 'POST', token: a.token, body: { id: 'x', type: 'water' } })).status, 400);
  assert.equal((await act(a.token, 'task_set', { id: aid(), done: 'yes' })).status, 400);
});

test('task list is capped at 50', async () => {
  const { a } = await household();
  let r;
  for (let i = 0; i < 51; i++) { r = await act(a.token, 'task_add', { id: aid(), text: `t${i}` }); if (i % 10 === 9) await new Promise((x) => setTimeout(x, 1100)); }
  assert.equal(r.status, 409);
});

test('live sync: action on one device is pushed to the other, with presence', async () => {
  const { a, b } = await household();
  const sb = await openStream(b.token);
  const first = await sb.until(() => true);
  assert.equal(first.state.tasks.length, 0);                            // immediate snapshot
  const sa = await openStream(a.token);
  await sb.until((e) => e.online.length === 2);                          // presence update
  const t0 = Date.now();
  const id = aid();
  await act(a.token, 'task_add', { id, text: 'stretch' });
  const pushed = await sb.until((e) => e.state.tasks.some((t) => t.id === id));
  assert.ok(Date.now() - t0 < 1000, 'broadcast should arrive well under a second locally');
  assert.equal(pushed.state.last.by, 'Jamie');
  sa.close();
  await sb.until((e) => e.online.length === 1);                          // disconnect presence
  sb.close();
});

test('pets are isolated: a device never receives another pet\'s events', async () => {
  const { a } = await household();
  const other = await household();
  const so = await openStream(other.a.token);
  await so.until(() => true);
  const n = so.events.length;
  await act(a.token, 'task_add', { id: aid(), text: 'private' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(so.events.length, n);
  so.close();
});

test('leave: owner leaving promotes member; last device deletes the pet', async () => {
  const { a, b } = await household();
  assert.equal((await call('/api/leave', { method: 'POST', token: a.token, body: {} })).status, 200);
  assert.equal((await call('/api/state', { token: a.token })).status, 401);
  const st = await call('/api/state', { token: b.token });
  assert.equal(st.json.members.length, 1);
  assert.equal(st.json.device.role, 'owner');
  await call('/api/leave', { method: 'POST', token: b.token, body: {} });
  assert.equal((await call('/api/join', { method: 'POST', body: { joinCode: a.joinCode, deviceName: 'Late' } })).status, 404);
});

test('regression: leaving with a live stream open does not crash the server', async () => {
  const { a, b } = await household();
  const sa = await openStream(a.token);
  const sb = await openStream(b.token);
  await sb.until((e) => e.online.length === 2);
  assert.equal((await call('/api/leave', { method: 'POST', token: a.token, body: {} })).status, 200);
  const upd = await sb.until((e) => e.members.length === 1);              // remaining device is told
  assert.equal(upd.members[0].role, 'owner');
  assert.equal((await call('/api/state', { token: b.token })).status, 200); // server still alive
  sa.close(); sb.close();
});

test('regression: opening more than 3 streams per device evicts the oldest without crashing', async () => {
  const { a } = await household();
  const streams = [];
  for (let i = 0; i < 5; i++) streams.push(await openStream(a.token));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await act(a.token, 'emote', { mood: 'happy' })).status, 200);
  await streams[4].until((e) => e.state.mood === 'happy');                  // newest still receives
  streams.forEach((s) => s.close());
});

test('device limit per pet', async () => {
  const { a } = await household();
  for (let i = 0; i < 8; i++) assert.equal((await call('/api/join', { method: 'POST', body: { joinCode: a.joinCode, deviceName: `D${i}` } })).status, 200);
  assert.equal((await call('/api/join', { method: 'POST', body: { joinCode: a.joinCode, deviceName: 'Eleven' } })).status, 409);
});

test('rate limiting: action burst gets 429', async () => {
  const { a } = await household();
  const rs = await Promise.all(Array.from({ length: 60 }, () => act(a.token, 'emote', { mood: 'happy' })));
  assert.ok(rs.some((r) => r.status === 429));
  assert.ok(rs.some((r) => r.status === 200));
});

test('static files: served with security headers; everything else is 404', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  for (const p of ['/app.js', '/pip.js', '/shared/reducer.js', '/style.css', '/icon.svg', '/manifest.webmanifest']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  for (const p of ['/server/index.js', '/server/db.js', '/package.json', '/data/pip.db', '/etc/passwd']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  assert.equal((await call('/api/state', { method: 'DELETE' })).status, 405);
});

test('join/create attempts are rate limited per IP', async () => {
  const tight = createApp({ limits: { auth: { capacity: 3, perSec: 0 } } });
  const { port } = await tight.listen(0, '127.0.0.1');
  const post = () => fetch(`http://127.0.0.1:${port}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ joinCode: 'ABCDEFGH', deviceName: 'x' }) });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await post()).status);
  await tight.close();
  assert.deepEqual(statuses, [404, 404, 404, 429, 429]);
});
