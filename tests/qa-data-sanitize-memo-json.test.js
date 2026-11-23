// QA (data, final pass; perf finding "Every page load ... validates it all in one main-thread task",
// fix 4: shared/sanitize.js POST.notes stringifies every note). On a page load the store validates the
// server's state through a validation memo, and the memo keeps the JSON of every record it validates.
// For a note that meant writing it out twice: once in POST.notes to check the record limit, then again
// for the memo. Notes are most of the bytes (8 of the 11.5 MB in the perf tester's library), so the memo
// now reuses the JSON POST.notes wrote, for the very record it returns. These tests pin that a note is
// written out once, and that what the memo remembers is exactly the record's JSON (a hit on the next
// load is the record itself), including a note POST.notes had to cut.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCollection, validateItem, validateOp, createValidationMemo, ITEM_JSON_MAX } from '../shared/sanitize.js';
import '../notes/core/schema.js'; // every page and the server validate notes with it (shared/store.js imports it)

const now = 1795000000000;
const note = (i, text = `Note ${i} with "quotes" and a\nline break`) => ({
  id: `n${i}`,
  v: 1,
  rev: 1,
  blocks: [
    { id: `b${i}a`, t: 'h1', c: [[`Title ${i}`]] },
    { id: `b${i}b`, t: 'p', c: [[text]] },
    { id: `b${i}c`, t: 'check', ck: i % 2 === 0, c: [[`Step ${i}`]] },
  ],
  folderId: null,
  createdAt: now + i,
  updatedAt: now + i,
});
const parsed = (v) => JSON.parse(JSON.stringify(v));

/** Runs fn with JSON.stringify counting how often each object in `watch` is written out. */
function countWrites(watch, fn) {
  const real = JSON.stringify;
  const seen = new Map();
  const ids = new Set(watch);
  JSON.stringify = function (v, ...rest) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.id === 'string' && ids.has(v.id) && 'blocks' in v) seen.set(v, (seen.get(v) || 0) + 1);
    return real.call(JSON, v, ...rest);
  };
  try {
    return { result: fn(), seen };
  } finally {
    JSON.stringify = real;
  }
}

test('with a memo, each note is written out once, and the memo remembers exactly its JSON', () => {
  const raws = Array.from({ length: 40 }, (_, i) => note(i));
  const memo = createValidationMemo();
  const { result, seen } = countWrites(raws.map((n) => n.id), () => validateCollection('notes', parsed(raws), { memo }));
  assert.equal(result.items.length, 40);
  for (const it of result.items) assert.equal(seen.get(it) || 0, 1, `${it.id} was written out ${seen.get(it)} times`);
  // The next load: the same JSON is a hit for every note, i.e. the memo holds exactly JSON.stringify(note).
  const again = parsed(result.items);
  const second = validateCollection('notes', again, { memo });
  assert.equal(second.items.length, 40);
  second.items.forEach((it, i) => assert.equal(it, again[i], `${it.id} is a hit (returned as it is)`));
  assert.deepEqual(second.items, result.items);
  // A changed note is validated again, the others stay hits.
  const edited = parsed(result.items);
  edited[7].blocks[1].c = [['edited']];
  const third = validateCollection('notes', edited, { memo });
  third.items.forEach((it, i) => (i === 7 ? assert.notEqual(it, edited[i]) : assert.equal(it, edited[i])));
  assert.equal(third.items[7].blocks[1].c[0][0], 'edited');
});

test('the JSON a memo remembers is the JSON of the record it returned, never another one', () => {
  const memo = createValidationMemo();
  // a direct validateItem in between (no memo) leaves nothing behind for the memo to pick up
  validateItem('notes', note(1, 'first'));
  const a = validateCollection('notes', [parsed(note(2, 'second'))], { memo }).items[0];
  validateItem('notes', note(3, 'third'));
  const put = validateOp({ op: 'put', c: 'notes', item: parsed(note(4, 'fourth')) }, { memo }).item;
  validateItem('notes', note(5, 'fifth'));
  // both are hits with their own JSON, so the memo kept JSON.stringify(a) and JSON.stringify(put)
  const again = [parsed(a), parsed(put)];
  const r = validateCollection('notes', again, { memo });
  assert.equal(r.items[0], again[0]);
  assert.equal(r.items[1], again[1]);
  // a stale JSON would have made these misses: a record from another call must never be remembered
  assert.equal(validateCollection('notes', [parsed(note(2, 'other text'))], { memo }).items[0].blocks[1].c[0][0], 'other text');
});

test('a note that POST.notes cuts to the record limit is remembered as cut', () => {
  // A stage-1 note: a big HTML body full of quotes, which take two characters each in JSON.
  const body = `<p>${'"'.repeat(390000)}</p>`;
  const raw = { id: 'nbig', title: 'Big', body, createdAt: now, updatedAt: now };
  const memo = createValidationMemo();
  const out = validateCollection('notes', [parsed(raw)], { memo }).items[0];
  assert.ok(out, 'kept');
  assert.ok(JSON.stringify(out).length <= ITEM_JSON_MAX, 'under the record limit');
  assert.deepEqual(out, validateItem('notes', parsed(raw)), 'the same as without a memo');
  const again = [parsed(out)];
  assert.equal(validateCollection('notes', again, { memo }).items[0], again[0], 'a hit: the memo holds the cut record\'s JSON');
});

test('tasks, events and the rest are remembered as before', () => {
  const memo = createValidationMemo();
  const tasks = [{ id: 't1', title: 'Call "Sam"\n', date: '2026-12-03', createdAt: now, updatedAt: now }];
  const events = [{ id: 'e1', title: 'Lunch', start: '2026-12-03T12:00', end: '2026-12-03T11:00', createdAt: now, updatedAt: now }];
  const t = validateCollection('tasks', parsed(tasks), { memo }).items;
  const e = validateCollection('events', parsed(events), { memo }).items;
  assert.equal(e[0].end, '2026-12-03T13:00', 'repaired');
  const t2 = parsed(t);
  const e2 = parsed(e);
  assert.equal(validateCollection('tasks', t2, { memo }).items[0], t2[0]);
  assert.equal(validateCollection('events', e2, { memo }).items[0], e2[0]);
});
