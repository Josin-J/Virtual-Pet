import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyAction, effectiveMood, cleanName, validateEnvelope } from '../shared/reducer.js';

const ctx = (over = {}) => ({ now: 1_000_000, actor: 'Jamie', isOwner: true, ...over });
const act = (type, payload) => ({ id: 'abcdefgh12', type, payload });

test('mood is lazy: expires by timestamp, defaults to happy', () => {
  const r = applyAction(initialState(), act('emote', { mood: 'sad' }), ctx());
  assert.equal(effectiveMood(r.state, 1_000_001), 'sad');
  assert.equal(effectiveMood(r.state, 1_000_000 + 30_001), 'happy');
});

test('reducer never mutates its input', () => {
  const s = initialState();
  const frozen = structuredClone(s);
  applyAction(s, act('task_add', { id: 'task00001', text: 'x' }), ctx());
  assert.deepEqual(s, frozen);
});

test('task_add is idempotent per task id and validates text', () => {
  const s0 = initialState();
  const a = applyAction(s0, act('task_add', { id: 'task00001', text: 'read' }), ctx());
  const b = applyAction(a.state, act('task_add', { id: 'task00001', text: 'read' }), ctx());
  assert.equal(b.changed, false);
  assert.equal(b.state.tasks.length, 1);
  assert.ok(applyAction(s0, act('task_add', { id: 'task00002', text: '' }), ctx()).error);
  assert.ok(applyAction(s0, act('task_add', { id: 'task00002', text: 'x'.repeat(81) }), ctx()).error);
  assert.ok(applyAction(s0, act('task_add', { id: 'bad id', text: 'ok' }), ctx()).error);
});

test('cleanName strips control/bidi characters and collapses whitespace', () => {
  assert.equal(cleanName('  a ‮ b\n\tc ', 20), 'a b c');
  assert.equal(cleanName('', 5), null);
  assert.equal(cleanName(42, 5), null);
  assert.equal(cleanName('abcdef', 5), null);
});

test('validateEnvelope', () => {
  assert.equal(validateEnvelope({ id: 'abcdefgh', type: 'water', payload: {} }), null);
  assert.ok(validateEnvelope(null));
  assert.ok(validateEnvelope({ id: 'abcdefgh', type: 'water', payload: [] }));
  assert.ok(validateEnvelope({ id: '../../etc', type: 'water' }));
});
