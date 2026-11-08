import { applyAction, effectiveMood } from '/shared/reducer.js';
import { pipSvg } from '/pip.js';

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// crypto.randomUUID() is unavailable on plain-http LAN addresses; getRandomValues is not.
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---- state -------------------------------------------------------------
let session = store.get('pip.session');             // { token, deviceId, deviceName, role }
let server = store.get('pip.server');               // last confirmed { state, version, members, joinCode }
let queue = store.get('pip.queue', []);             // actions not yet acknowledged by the server
let online = [];
let conn = 'connecting';                            // connecting | live | offline
let clockOffset = 0;
let loopId = 0, streamCtrl = null, wake = null, lastData = 0;
let flushing = false, retryTimer = null, retryDelay = 3000;
let lastMood = null, expiryTimer = null, toastTimer = null;

const now = () => Date.now() + clockOffset;
const myRole = () => server?.members?.find((m) => m.id === session.deviceId)?.role ?? session.role;

// Confirmed server state + still-pending local actions = what the user sees (optimistic UI).
function view() {
  if (!server) return null;
  const ctx = { now: now(), actor: session.deviceName, isOwner: myRole() === 'owner' };
  return queue.reduce((s, a) => applyAction(s, a, ctx).state, server.state);
}

// ---- networking ----------------------------------------------------------
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    cache: 'no-store',
    headers: { authorization: `Bearer ${session.token}`, ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status });
  return j;
}

function onServerState(d) {
  if (d.serverNow) clockOffset = d.serverNow - Date.now();
  if (server && d.version < server.version) return; // stale, out-of-order response
  server = {
    state: d.state,
    version: d.version,
    members: d.members ?? server?.members ?? [],
    joinCode: d.joinCode ?? server?.joinCode ?? '',
  };
  if (d.online) online = d.online;
  store.set('pip.server', server);
  render();
}

function dispatch(type, payload = {}) {
  queue.push({ id: uid(), type, payload });
  store.set('pip.queue', queue);
  render();
  flush();
}

async function flush() {
  if (flushing || !session) return;
  flushing = true;
  try {
    while (queue.length && session) {
      const a = queue[0];
      let res;
      try {
        res = await api('/api/action', { method: 'POST', body: a });
      } catch (e) {
        if (e.status === 401) return logout('This device was signed out. Join again to continue.');
        if (e.status && e.status < 500 && e.status !== 429) { // permanent rejection: drop it, tell the user
          queue.shift(); store.set('pip.queue', queue); toast(e.message); render(); continue;
        }
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, retryDelay);     // network/5xx/429: keep and retry with backoff
        retryDelay = Math.min(retryDelay * 2, 30000);
        render();
        return;
      }
      retryDelay = 3000;
      queue.shift(); store.set('pip.queue', queue);
      if (res.note) toast(res.note);
      onServerState(res);
    }
  } finally {
    flushing = false;
  }
}

function handleSse(block) {
  let event = 'message'; let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (event === 'state' && data) { try { onServerState(JSON.parse(data)); } catch { /* ignore malformed frame */ } }
}

async function streamLoop() {
  const mine = ++loopId;
  let delay = 1000;
  while (session && mine === loopId) {
    const ctrl = new AbortController();
    streamCtrl = ctrl;
    let watchdog;
    const arm = () => { lastData = Date.now(); clearTimeout(watchdog); watchdog = setTimeout(() => ctrl.abort(), 40000); };
    try {
      setConn('connecting');
      const res = await fetch('/api/stream', { headers: { authorization: `Bearer ${session.token}` }, signal: ctrl.signal, cache: 'no-store' });
      if (res.status === 401) return logout('This device was signed out. Join again to continue.');
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      arm(); delay = 1000; setConn('live'); flush();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm();
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { handleSse(buf.slice(0, i)); buf = buf.slice(i + 2); }
      }
    } catch { /* fall through to reconnect */ } finally { clearTimeout(watchdog); }
    if (!session || mine !== loopId) return;
    setConn('offline');
    await new Promise((r) => { const t = setTimeout(r, delay + Math.random() * 300); wake = () => { clearTimeout(t); r(); }; });
    wake = null;
    delay = Math.min(delay * 2, 15000);
  }
}

addEventListener('online', () => { wake?.(); streamCtrl?.abort(); flush(); });
addEventListener('offline', () => { setConn('offline'); streamCtrl?.abort(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !session) return;
  if (conn !== 'live') wake?.();
  else if (Date.now() - lastData > 20000) streamCtrl?.abort(); // socket likely died while suspended
  flush();
});

// ---- rendering -----------------------------------------------------------
function setConn(c) { conn = c; renderStatus(); }

function renderStatus() {
  const pill = $('#status'); const n = queue.length;
  if (conn === 'live') {
    pill.dataset.state = 'live';
    pill.textContent = n ? 'Syncing…' : `Live · ${Math.max(online.length, 1)} online`;
  } else if (conn === 'connecting') {
    pill.dataset.state = 'connecting';
    pill.textContent = 'Connecting…';
  } else {
    pill.dataset.state = 'offline';
    pill.textContent = n ? `Offline · ${n} change${n > 1 ? 's' : ''} will sync` : 'Offline · showing last saved';
  }
}

function bubbleText(s, mood, t) {
  if (s.last && t - s.last.at < 12000 && t >= s.last.at - 2000) return s.last.text;
  const done = s.tasks.filter((x) => x.done).length; const total = s.tasks.length;
  if (mood === 'sad') return "I'm right here. No rush.";
  if (mood === 'angry') return 'Hmph! …okay, I forgive you.';
  if (mood === 'surprised') return 'Whoa! Did you see that?';
  if (total && done === total) return 'You did enough today.';
  if (total) return `${total - done} to go. One small step at a time.`;
  return `Hi ${session.deviceName}! Add one gentle task to start.`;
}

function taskItem(t) {
  const li = document.createElement('li');
  if (t.done) li.className = 'done';
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox'; box.checked = t.done; box.dataset.k = `${t.id}:chk`;
  box.addEventListener('change', () => dispatch('task_set', { id: t.id, done: box.checked }));
  const text = document.createElement('span'); text.className = 'text'; text.textContent = t.text;
  label.append(box, text);
  if (t.done && t.doneBy) { const by = document.createElement('span'); by.className = 'by'; by.textContent = `by ${t.doneBy}`; label.append(by); }
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'del'; del.textContent = '✕'; del.dataset.k = `${t.id}:del`;
  del.setAttribute('aria-label', `Remove task: ${t.text}`);
  del.addEventListener('click', () => dispatch('task_delete', { id: t.id }));
  li.append(label, del);
  return li;
}

function renderTasks(s) {
  const ul = $('#tasks');
  const focusKey = ul.contains(document.activeElement) ? document.activeElement.dataset.k : null;
  if (s.tasks.length) ul.replaceChildren(...s.tasks.map(taskItem));
  else { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No tasks yet. Add one small thing.'; ul.replaceChildren(li); }
  if (focusKey) ul.querySelector(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
  const done = s.tasks.filter((x) => x.done).length;
  $('#prog').max = Math.max(s.tasks.length, 1); $('#prog').value = done;
  $('#progText').textContent = s.tasks.length ? `${done} of ${s.tasks.length} done` : '';
}

function renderCare(s) {
  const count = s.waterDay === localDay() ? s.water : 0;
  $('#waterText').textContent = `${count} of 8 glasses today`;
}

function renderShare(s) {
  const code = server?.joinCode || '';
  $('#code').textContent = code ? `${code.slice(0, 4)}-${code.slice(4)}` : '';
  const ul = $('#members');
  ul.replaceChildren(...(server?.members || []).map((m) => {
    const li = document.createElement('li');
    li.textContent = m.id === session.deviceId ? `${m.name} (you)` : m.name;
    if (online.includes(m.id) || (m.id === session.deviceId && conn === 'live')) li.className = 'on';
    return li;
  }));
  $('#renameForm').hidden = myRole() !== 'owner';
  $('#renameInput').placeholder = `Rename ${s.name}`;
}

function render() {
  const s = view();
  if (!s || !session) return;
  const t = now();
  const mood = effectiveMood(s, t);
  document.body.dataset.mood = mood;
  document.title = `${s.name} — your pocket ghost`;
  $('#petName').textContent = s.name;
  if (mood !== lastMood) { $('#pip').innerHTML = pipSvg(mood); lastMood = mood; }
  $('#pip').setAttribute('aria-label', `${s.name} looks ${mood}`);
  $('#bubble').textContent = bubbleText(s, mood, t);
  renderTasks(s); renderCare(s); renderShare(s); renderStatus();
  clearTimeout(expiryTimer);
  const next = Math.min(s.moodUntil > t ? s.moodUntil : Infinity, s.last && s.last.at + 12000 > t ? s.last.at + 12000 : Infinity);
  if (Number.isFinite(next)) expiryTimer = setTimeout(render, next - t + 50);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

// ---- breathing mini-game -------------------------------------------------
const dlg = $('#breathe');
let breatheRun = 0;
dlg.addEventListener('close', () => { breatheRun += 1; });
$('#breatheStop').addEventListener('click', () => dlg.close());
async function openBreathe() {
  const run = ++breatheRun;
  const orb = $('#orb'); const label = $('#breatheLabel'); const count = $('#breatheCount');
  orb.classList.remove('big'); label.textContent = 'Get comfy…'; count.textContent = '';
  dlg.showModal();
  await sleep(900);
  for (let i = 1; i <= 3; i++) {
    if (run !== breatheRun) return;
    count.textContent = `Breath ${i} of 3`;
    label.textContent = 'Breathe in…'; orb.classList.add('big'); await sleep(4000);
    if (run !== breatheRun) return;
    label.textContent = 'Breathe out…'; orb.classList.remove('big'); await sleep(4000);
  }
  if (run !== breatheRun) return;
  dlg.close();
  dispatch('breathe_done');
}

// ---- screens / session -----------------------------------------------------
function showWelcome(msg = '') {
  $('#app').hidden = true; $('#welcome').hidden = false;
  $('#welcomeError').textContent = msg;
  document.body.dataset.mood = 'happy';
  $('#welcomePip').innerHTML = pipSvg('happy');
}

function startApp() {
  $('#welcome').hidden = true; $('#app').hidden = false;
  lastMood = null; online = [];
  render();
  streamLoop();
  flush();
}

function logout(msg) {
  session = null; server = null; queue = []; online = []; loopId += 1;
  streamCtrl?.abort(); clearTimeout(retryTimer); clearTimeout(expiryTimer);
  ['pip.session', 'pip.server', 'pip.queue'].forEach(store.del);
  showWelcome(msg);
}

async function enter(path, body, button) {
  const err = $('#welcomeError');
  button.disabled = true; err.textContent = '';
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
    session = { token: j.token, deviceId: j.device.id, deviceName: j.device.name, role: j.device.role };
    store.set('pip.session', session);
    queue = []; store.set('pip.queue', queue);
    server = null; onServerState(j);
    startApp();
  } catch (e) {
    err.textContent = e instanceof TypeError ? "Can't reach the server. Check your connection." : e.message;
  } finally {
    button.disabled = false;
  }
}

function setTab(create) {
  $('#tabCreate').setAttribute('aria-pressed', String(create)); $('#tabJoin').setAttribute('aria-pressed', String(!create));
  $('#createForm').hidden = !create; $('#joinForm').hidden = create;
  $('#welcomeError').textContent = '';
}
$('#tabCreate').addEventListener('click', () => setTab(true));
$('#tabJoin').addEventListener('click', () => setTab(false));
$('#createForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  enter('/api/pets', { deviceName: f.get('deviceName'), petName: f.get('petName') }, e.submitter);
});
$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  enter('/api/join', { joinCode: f.get('joinCode'), deviceName: f.get('deviceName') }, e.submitter);
});

// ---- interactions ----------------------------------------------------------
document.querySelectorAll('.emotes button').forEach((b) => b.addEventListener('click', () => dispatch('emote', { mood: b.dataset.mood })));
$('#taskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#taskInput'); const text = input.value.trim();
  if (!text) return;
  input.value = '';
  dispatch('task_add', { id: uid(), text });
});
$('#waterBtn').addEventListener('click', () => dispatch('water', { day: localDay() }));
$('#breatheBtn').addEventListener('click', openBreathe);
$('#renameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#renameInput').value.trim();
  if (!name) return;
  $('#renameInput').value = '';
  dispatch('rename', { name });
});
$('#copyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(server.joinCode); toast('Code copied'); }
  catch { toast('Select the code and copy it manually'); }
});
$('#leaveBtn').addEventListener('click', async () => {
  if (!confirm('Leave this Pip on this device? You can rejoin with the code.')) return;
  try { await api('/api/leave', { method: 'POST', body: {} }); } catch { /* leave locally even if offline */ }
  logout('You left Pip.');
});

// ---- floating pet physics & roaming ----------------------------------------
const floatBtn = $('#floatToggleBtn');
const pipEl = $('#pip');
let isFloating = false;
let floatAnimId = null;
let lastTick = 0;
let posX = 100, posY = 100;
let velX = 45, velY = 35; // px per second
let isDragging = false;
let dragStartX = 0, dragStartY = 0;
let dragInitX = 0, dragInitY = 0;
let dragMoved = false;

// Enhanced animation state
let currentTilt = 0;
let squishX = 1, squishY = 1;
let targetAngle = Math.atan2(velY, velX);
let nextTurnTime = 3;
let sparkleTimer = 0;
let idleTimer = 0;
let idlePause = 0;
let moodAnimCooldown = 0;

const SPARKLE_SHADES = [
  { bg: '#ffffff', border: '#111111', shadow: 'rgba(0, 0, 0, 0.35)' },
  { bg: '#111111', border: '#ffffff', shadow: 'rgba(255, 255, 255, 0.5)' },
  { bg: '#ffffff', border: 'transparent', shadow: 'rgba(0, 0, 0, 0.25)' },
  { bg: '#2b2b2b', border: '#ffffff', shadow: 'rgba(0, 0, 0, 0.4)' },
  { bg: '#f0f0f0', border: '#333333', shadow: 'rgba(0, 0, 0, 0.3)' },
];

function spawnFloatSparkle(x, y) {
  const el = document.createElement('div');
  el.className = 'sparkle-trail';
  const shade = SPARKLE_SHADES[Math.floor(Math.random() * SPARKLE_SHADES.length)];
  const size = 4 + Math.random() * 6;
  el.style.cssText = `left:${x + Math.random() * 30 - 15}px;top:${y + Math.random() * 30 - 15}px;width:${size}px;height:${size}px;background:${shade.bg};border:1px solid ${shade.border};box-shadow:0 0 ${size * 1.5}px ${shade.shadow};`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

function spawnWebMoodParticle(mood, x, y) {
  const el = document.createElement('div');
  el.className = 'mood-particle-web';
  const ox = (Math.random() - 0.5) * 50;
  const oy = (Math.random() - 0.5) * 30;
  switch (mood) {
    case 'happy': el.classList.add('mp-heart'); el.textContent = ['✦', '✧', '★', '☆', '✨'][Math.floor(Math.random() * 5)]; break;
    case 'angry': el.classList.add('mp-puff'); break;
    case 'surprised': el.classList.add('mp-star'); el.textContent = ['✦', '⚡', '✧', '•'][Math.floor(Math.random() * 4)]; break;
    case 'sad': el.classList.add('mp-tear'); el.textContent = ['•', '°', '·'][Math.floor(Math.random() * 3)]; break;
  }
  el.style.left = (x + ox) + 'px';
  el.style.top = (y + oy) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function triggerWebAcrobatics(mood) {
  if (moodAnimCooldown > 0 || !isFloating) return;
  moodAnimCooldown = 6;
  switch (mood) {
    case 'happy':
      pipEl.classList.add('pip-spin');
      setTimeout(() => pipEl.classList.remove('pip-spin'), 700);
      for (let i = 0; i < 8; i++) setTimeout(() => spawnFloatSparkle(posX + 75, posY + 75), i * 80);
      break;
    case 'surprised':
      { const a = Math.random() * Math.PI * 2; velX = Math.cos(a) * 220; velY = Math.sin(a) * 220; }
      break;
    case 'sad':
      velX *= 0.3; velY = 12;
      break;
    case 'angry':
      { const ox = velX, oy = velY; let c = 0;
        const si = setInterval(() => { velX = (c % 2 === 0 ? 1 : -1) * 110; velY = (c % 2 === 0 ? -1 : 1) * 70; c++; if (c >= 8) { clearInterval(si); velX = ox; velY = oy; } }, 80);
      } break;
  }
}

function applyFloatTransform() {
  const sc = `scale(${squishX.toFixed(3)}, ${squishY.toFixed(3)})`;
  const ro = `rotate(${currentTilt.toFixed(1)}deg)`;
  pipEl.style.transform = `translate3d(${posX.toFixed(1)}px, ${posY.toFixed(1)}px, 0) ${ro} ${sc}`;
}

function stepFloat(t) {
  if (!isFloating) return;
  if (!lastTick) lastTick = t;
  const dt = Math.min((t - lastTick) / 1000, 0.1);
  lastTick = t;

  if (moodAnimCooldown > 0) moodAnimCooldown -= dt;

  if (!isDragging) {
    // Idle pause
    if (idlePause > 0) {
      idlePause -= dt;
      posY += Math.sin(t / 400) * 0.3;
      applyFloatTransform();
      floatAnimId = requestAnimationFrame(stepFloat);
      return;
    }
    idleTimer += dt;
    if (idleTimer > 8 + Math.random() * 7) { idleTimer = 0; idlePause = 1.5 + Math.random() * 3; }

    // Organic curves
    nextTurnTime -= dt;
    if (nextTurnTime <= 0) { nextTurnTime = 2 + Math.random() * 4; targetAngle += (Math.random() - 0.5) * Math.PI * 0.8; }
    const curAngle = Math.atan2(velY, velX);
    let angleDiff = targetAngle - curAngle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    const newAngle = curAngle + angleDiff * 1.5 * dt;

    // Mood-based speed
    const mood = document.body.dataset.mood || 'happy';
    let baseSpeed;
    switch (mood) {
      case 'happy': baseSpeed = 55 + Math.sin(t / 2000) * 15; break;
      case 'sad': baseSpeed = 20 + Math.sin(t / 3000) * 5; break;
      case 'angry': baseSpeed = 80 + Math.sin(t / 800) * 25; break;
      case 'surprised': baseSpeed = 70 + Math.sin(t / 1500) * 20; break;
      default: baseSpeed = 45;
    }
    const curSpeed = Math.hypot(velX, velY);
    const spd = curSpeed + (baseSpeed - curSpeed) * dt * 2;
    velX = Math.cos(newAngle) * spd;
    velY = Math.sin(newAngle) * spd;

    const w = pipEl.offsetWidth || 150;
    const h = pipEl.offsetHeight || 150;
    const pad = 12;
    const maxX = Math.max(window.innerWidth - w - pad, pad);
    const maxY = Math.max(window.innerHeight - h - pad, pad);

    posX += velX * dt;
    posY += velY * dt;

    let bounced = false;
    if (posX <= pad) { posX = pad; velX = Math.abs(velX); targetAngle = Math.atan2(velY, velX); bounced = true; }
    else if (posX >= maxX) { posX = maxX; velX = -Math.abs(velX); targetAngle = Math.atan2(velY, velX); bounced = true; }
    if (posY <= pad) { posY = pad; velY = Math.abs(velY); targetAngle = Math.atan2(velY, velX); bounced = true; }
    else if (posY >= maxY) { posY = maxY; velY = -Math.abs(velY); targetAngle = Math.atan2(velY, velX); bounced = true; }

    // Squish on bounce
    if (bounced) {
      if (posX <= pad || posX >= maxX) { squishX = 0.75; squishY = 1.2; }
      else { squishX = 1.2; squishY = 0.75; }
    }
    squishX += (1 - squishX) * dt * 6;
    squishY += (1 - squishY) * dt * 6;

    // Tilt / banking
    const tiltTarget = Math.max(-25, Math.min(25, velX * 0.3));
    currentTilt += (tiltTarget - currentTilt) * dt * 4;

    applyFloatTransform();

    // Sparkle trail
    sparkleTimer += dt;
    const spInt = mood === 'sad' ? 0.25 : 0.12;
    if (sparkleTimer >= spInt) {
      sparkleTimer = 0;
      if (Math.hypot(velX, velY) > 10) spawnFloatSparkle(posX + w / 2, posY + h * 0.8);
    }

    // Mood particles
    if (Math.random() < dt * 0.35) spawnWebMoodParticle(mood, posX + w / 2, posY + h / 2);
  }
  floatAnimId = requestAnimationFrame(stepFloat);
}

function setFloating(enabled) {
  if (isFloating === enabled) return;
  isFloating = enabled;
  store.set('pip.float', enabled);
  if (floatBtn) {
    floatBtn.setAttribute('aria-pressed', String(enabled));
    floatBtn.textContent = enabled ? '📌 Dock' : '🚀 Float';
  }
  if (enabled) {
    const rect = pipEl.getBoundingClientRect();
    posX = Math.max(12, Math.min(rect.left, window.innerWidth - 160));
    posY = Math.max(12, Math.min(rect.top, window.innerHeight - 160));
    velX = (Math.random() > 0.5 ? 1 : -1) * (40 + Math.random() * 25);
    velY = (Math.random() > 0.5 ? 1 : -1) * (30 + Math.random() * 25);
    targetAngle = Math.atan2(velY, velX);
    squishX = 1; squishY = 1; currentTilt = 0;
    sparkleTimer = 0; idleTimer = 0; idlePause = 0;
    pipEl.classList.add('floating');
    applyFloatTransform();
    lastTick = 0;
    cancelAnimationFrame(floatAnimId);
    floatAnimId = requestAnimationFrame(stepFloat);
  } else {
    cancelAnimationFrame(floatAnimId);
    floatAnimId = null;
    pipEl.classList.remove('floating');
    pipEl.style.transform = '';
    squishX = 1; squishY = 1; currentTilt = 0;
  }
}

floatBtn?.addEventListener('click', () => setFloating(!isFloating));

// Restore float state from localStorage
if (store.get('pip.float', false)) {
  // Defer so the DOM is ready
  setTimeout(() => { if (session && !isFloating) setFloating(true); }, 300);
}

// Trigger acrobatics when mood changes while floating
let prevFloatMood = null;
const origRender = render;
// We'll hook into mood changes via a MutationObserver on body[data-mood]
new MutationObserver(() => {
  const m = document.body.dataset.mood;
  if (m && m !== prevFloatMood && isFloating) { triggerWebAcrobatics(m); prevFloatMood = m; }
  else if (m) prevFloatMood = m;
}).observe(document.body, { attributes: true, attributeFilter: ['data-mood'] });

pipEl.addEventListener('pointerdown', (e) => {
  if (!isFloating) return;
  isDragging = true;
  dragMoved = false;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragInitX = posX;
  dragInitY = posY;
  pipEl.setPointerCapture(e.pointerId);
});

pipEl.addEventListener('pointermove', (e) => {
  if (!isDragging) return;
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  if (Math.hypot(dx, dy) > 4) dragMoved = true;
  posX = dragInitX + dx;
  posY = dragInitY + dy;
  applyFloatTransform();
});

const onPointerUp = (e) => {
  if (!isDragging) return;
  isDragging = false;
  try { pipEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (dragMoved) {
    velX = (e.clientX - dragStartX) * 1.5;
    velY = (e.clientY - dragStartY) * 1.5;
    const speed = Math.hypot(velX, velY);
    if (speed < 30) {
      velX = (Math.random() > 0.5 ? 1 : -1) * 45;
      velY = (Math.random() > 0.5 ? 1 : -1) * 35;
    } else if (speed > 200) {
      velX = (velX / speed) * 200;
      velY = (velY / speed) * 200;
    }
    targetAngle = Math.atan2(velY, velX);
  } else {
    // Clicked while floating without dragging: cycle gentle interaction
    dispatch('emote', { mood: 'happy' });
  }
};

pipEl.addEventListener('pointerup', onPointerUp);
pipEl.addEventListener('pointercancel', onPointerUp);

// ---- boot --------------------------------------------------------------------
if (session) { online = []; startApp(); } else showWelcome();
