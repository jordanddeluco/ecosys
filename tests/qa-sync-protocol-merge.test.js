// QA regression (sync protocol): shared/sync.js (the browser) and server/store.mjs (the server) merge
// an edit into a newer copy of its record with the same rules, so a browser's merged view is what the
// server stores. Both are given the same cases and must give the same results: hashes, the `was` of
// a version, and field and block merges.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => new MemoryStorage() });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => new MemoryStorage() });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
globalThis.location = { hostname: 'example.github.io' }; // not loopback: sync stays off

const client = await import('../shared/sync.js');
const server = await import('../server/store.mjs');

const b = (id, text, t = 'p') => ({ id, t, c: [[text]] });
const values = ['', 'x', 0, 1.5, null, true, false, undefined, [1, 2], { a: 1, b: [2] }, 'naïve ☕ 日本語', [b('a', 'one'), b('b', 'two')], []];

test('the same hashes and starting versions on both sides', () => {
  for (const v of values) {
    assert.equal(client.valueHash(v), server.valueHash(v), JSON.stringify(v));
    assert.deepEqual(client.baseOf(v), server.baseOf(v), JSON.stringify(v));
    assert.equal(client.isIdArray(v), server.isIdArray(v), JSON.stringify(v));
  }
  assert.equal(client.hash53('ecosys'), server.hash53('ecosys'));
  assert.notEqual(client.hash53('ecosys'), client.hash53('ecosys '));
});

/** Run one merge on both sides (the server reads `was` from the network form, a Map). */
function both(cur, item, fields, base, preferMine) {
  const was = Object.fromEntries(fields.map((f) => [f, server.baseOf(base[f])]));
  const toMap = (w) => new Map(Object.entries(w).map(([k, v]) => [k, Array.isArray(v) ? [v[0], new Map(Object.entries(v[1]))] : v]));
  const a = client.mergeRecord(cur, item, fields, toMap(was), preferMine);
  const s = server.mergeRecord(cur, item, fields, toMap(was), preferMine);
  assert.deepEqual(a, s, 'browser and server agree');
  return s;
}

test('fields: only one side changed it → that side; both → the newer write; unknown start → the newer write', () => {
  const base = { id: 'r1', title: 'Old', notes: '', done: false, updatedAt: 1 };
  const cur = { ...base, done: true, updatedAt: 3 }; // changed elsewhere
  const mine = { ...base, notes: 'typed', updatedAt: 2 }; // changed here
  assert.deepEqual(both(cur, mine, ['notes'], base, false), { ...cur, notes: 'typed' });
  const theirsTitle = { ...base, title: 'Theirs', updatedAt: 3 };
  assert.equal(both(theirsTitle, { ...base, title: 'Mine', updatedAt: 2 }, ['title'], base, false).title, 'Theirs', 'both changed: the newer (theirs) wins');
  assert.equal(both(theirsTitle, { ...base, title: 'Mine', updatedAt: 4 }, ['title'], base, true).title, 'Mine', 'both changed: the newer (mine) wins');
  assert.equal(both(cur, { ...cur, notes: 'x' }, ['notes'], {}, true).notes, 'x');
  const removed = { ...base };
  delete removed.notes;
  assert.ok(!('notes' in both(cur, removed, ['notes'], base, true)), 'a key this edit removed is removed');
  assert.equal(both(cur, { ...cur }, ['notes'], base, true), cur, 'nothing to change: the same object back');
});

test('blocks: both sides edit a note: every edited, added and deleted block is merged', () => {
  const base = { id: 'n1', blocks: [b('h', 'Plan', 'h1'), b('p1', 'First'), b('p2', 'Second'), b('p3', 'Third')], updatedAt: 1 };
  const theirs = { ...base, blocks: [b('h', 'Plan', 'h1'), b('p1', 'First'), b('p2', 'Second, edited there'), b('ai', 'Added there')], updatedAt: 3 }; // p3 deleted there
  const mine = { ...base, blocks: [b('new0', 'Added here at the top'), b('h', 'Plan', 'h1'), b('p1', 'First, edited here'), b('p2', 'Second'), b('p3', 'Third, edited here'), b('new', 'Added here')], updatedAt: 2 };
  const out = both(theirs, mine, ['blocks'], base, false);
  const text = out.blocks.map((x) => x.c[0][0]);
  assert.deepEqual(text, ['Added here at the top', 'Plan', 'First, edited here', 'Second, edited there', 'Third, edited here', 'Added here', 'Added there']);
  // A block I deleted that they did not touch goes; one they changed stays.
  const mine2 = { ...base, blocks: [b('h', 'Plan', 'h1'), b('p3', 'Third')], updatedAt: 2 };
  const out2 = both(theirs, mine2, ['blocks'], base, false);
  assert.deepEqual(out2.blocks.map((x) => x.id), ['h', 'p2', 'ai'], 'p1 deleted here (unchanged there) goes; p2 (changed there) stays; p3 deleted there stays deleted');
});
