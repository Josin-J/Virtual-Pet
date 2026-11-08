// Pure pet-state logic, shared by the server (authoritative) and the browser
// (optimistic updates while offline). No I/O, no randomness, no clock access:
// everything non-deterministic arrives through `ctx` or the action payload.

export const MOODS = ['happy', 'sad', 'angry', 'surprised'];
export const ACTION_TYPES = ['task_add', 'task_set', 'task_delete', 'water', 'breathe_done', 'emote', 'rename'];

export const LIMITS = { tasks: 50, taskText: 80, water: 20, petName: 20, deviceName: 24 };
const MOOD_MS = { happy: 6000, sad: 30000, angry: 5000, surprised: 7000 };

export function initialState(name = 'Pip') {
  return { name, mood: 'happy', moodUntil: 0, tasks: [], water: 0, waterDay: '', breaths: 0, last: null };
}

// Mood is lazy: it expires by comparing timestamps on read, so no per-pet timers are needed.
export function effectiveMood(state, now) {
  return state.moodUntil > now ? state.mood : 'happy';
}

export function cleanName(value, max) {
  if (typeof value !== 'string') return null;
  const s = value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const isId = (v) => typeof v === 'string' && ID_RE.test(v);

export function validateEnvelope(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'Invalid action.';
  if (!isId(a.id)) return 'Action id must be 8–64 letters, digits, "-" or "_".';
  if (!ACTION_TYPES.includes(a.type)) return 'Unknown action type.';
  if (a.payload !== undefined && (a.payload === null || typeof a.payload !== 'object' || Array.isArray(a.payload))) {
    return 'Payload must be an object.';
  }
  return null;
}

const EMOTE_TEXT = {
  happy: (w) => `${w} gave Pip a pat 💛`,
  angry: (w) => `${w} poked Pip. Hmph!`,
  surprised: (w) => `${w} surprised Pip!`,
  sad: (w) => `${w} is feeling low. Pip is staying close.`,
};

/**
 * @returns {{state, changed:boolean, note?:string, error?:string, status?:number}}
 * ctx: { now:number(ms), actor:string, isOwner:boolean }
 * Resolution is semantic, not positional: actions state the desired outcome
 * ("task X done"), so concurrent or replayed actions converge without version checks.
 */
export function applyAction(prev, action, ctx) {
  const s = structuredClone(prev);
  const p = action.payload || {};
  const who = ctx.actor || 'Someone';
  const fail = (error, status = 400) => ({ state: prev, changed: false, error, status });
  const noop = (note) => ({ state: prev, changed: false, note });
  const setMood = (m) => { s.mood = m; s.moodUntil = ctx.now + MOOD_MS[m]; };
  const say = (text) => { s.last = { by: who, text, at: ctx.now }; };

  switch (action.type) {
    case 'task_add': {
      const text = cleanName(p.text, LIMITS.taskText);
      if (!text) return fail(`Task text must be 1–${LIMITS.taskText} characters.`);
      if (!isId(p.id)) return fail('Invalid task id.');
      if (s.tasks.some((t) => t.id === p.id)) return noop();
      if (s.tasks.length >= LIMITS.tasks) return fail(`The task list is full (${LIMITS.tasks}).`, 409);
      s.tasks.push({ id: p.id, text, done: false, doneBy: null });
      setMood('happy');
      say(`${who} added “${text}”`);
      break;
    }
    case 'task_set': {
      if (typeof p.done !== 'boolean') return fail('"done" must be true or false.');
      const t = s.tasks.find((x) => x.id === p.id);
      if (!t) return noop('That task was already removed.');
      if (t.done === p.done) {
        return noop(p.done ? `${t.doneBy || 'Someone'} already completed “${t.text}”.` : `“${t.text}” was already reopened.`);
      }
      t.done = p.done;
      t.doneBy = p.done ? who : null;
      if (!p.done) { say(`${who} reopened “${t.text}”`); break; }
      if (s.tasks.every((x) => x.done)) { setMood('surprised'); say(`All done! ${who} finished the last task 🎉`); }
      else { setMood('happy'); say(`${who} finished “${t.text}” ✓`); }
      break;
    }
    case 'task_delete': {
      const i = s.tasks.findIndex((x) => x.id === p.id);
      if (i < 0) return noop();
      const [t] = s.tasks.splice(i, 1);
      say(`${who} removed “${t.text}”`);
      break;
    }
    case 'water': {
      if (typeof p.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.day)) return fail('Invalid day.');
      if (p.day < s.waterDay) return noop(); // device clock/timezone behind the shared day
      if (p.day > s.waterDay) { s.waterDay = p.day; s.water = 0; }
      if (s.water >= LIMITS.water) return noop('Daily water limit reached. Great job!');
      s.water += 1;
      setMood('happy');
      say(`${who} drank water 💧`);
      break;
    }
    case 'breathe_done':
      s.breaths += 1;
      setMood('happy');
      say(`${who} took a calming breathing break 🌿`);
      break;
    case 'emote':
      if (!MOODS.includes(p.mood)) return fail('Unknown mood.');
      setMood(p.mood);
      say(EMOTE_TEXT[p.mood](who));
      break;
    case 'rename': {
      if (!ctx.isOwner) return fail('Only the owner can rename Pip.', 403);
      const name = cleanName(p.name, LIMITS.petName);
      if (!name) return fail(`Name must be 1–${LIMITS.petName} characters.`);
      if (name === s.name) return noop();
      s.name = name;
      say(`${who} renamed the pet to ${name}`);
      break;
    }
    default:
      return fail('Unknown action type.');
  }
  return { state: s, changed: true };
}
