// QA regression (sync protocol, shared/store.js): the tabs of one browser.
//   - a write that does not fit (localStorage full) is never "rolled back" by writing older values,
//     which every other tab would load; a large collection that did not fit is not serialized and
//     written again on every change
//   - while sync says every change reaches the server, a full localStorage is reported as a partial
//     offline copy ('ecosys:offline-cache'), not as a failed save
//   - changes to a collection a tab could not save reach the other tabs over a BroadcastChannel
//   - Erase everything in one tab clears the undo history (ecosys:data-replaced) in the others
//   - the sync adapter is given the record each op changed, as it was before; samples are remembered
// Two store instances share one localStorage, window and BroadcastChannel here, like two tabs of a
// browser; deliver() hands out the `storage` events a browser would.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.quota = Infinity;
    this.tries = []; // every setItem, also the refused ones
    this.done = []; // the ones that were stored, not yet delivered to the other tab
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
    const s = String(v);
    this.tries.push(k);
    let used = 0;
    for (const [key, val] of this.map) if (key !== k) used += key.length + val.length;
    if (used + k.length + s.length > this.quota) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    this.map.set(k, s);
    this.done.push([k, s]);
  }
  removeItem(k) {
    this.map.delete(k);
  }
  used() {
    return [...this.map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  }
}
const ls = new MemoryStorage();
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
/** The `storage` events of the writes so far (the tab that wrote a key ignores its own value). */
function deliver() {
  for (const [key, newValue] of ls.done.splice(0)) window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue, storageArea: ls }));
}
const P = 'ecosys:v1:';
const events = [];
for (const name of ['ecosys:save-error', 'ecosys:offline-cache', 'ecosys:data-replaced']) window.addEventListener(name, (e) => events.push([name, e.detail]));
const quietWarn = console.warn;
console.warn = () => {};

const A = await import('../shared/store.js?tab=a');
const B = await import('../shared/store.js?tab=b');
const bigNote = (k) => ({ v: 1, rev: 1, blocks: Array.from({ length: 12 }, (_, i) => ({ id: `b${k}x${i}`, t: 'p', c: [[`${k} `.repeat(9000)]] })) });

test('the adapter gets the record each op changed, as it was before; samples are remembered', () => {
  const got = [];
  A.setSyncAdapter({ push: (ops, prevs) => got.push(...ops.map((o, i) => [o.op, prevs?.[i]])) });
  A.registerSeeder((d) => d.insert('tasks', { title: 'Sample' }));
  A.seedIfEmpty();
  assert.ok([...A.sampleIds()].some((k) => k.startsWith('tasks:')), 'the sample task is remembered');
  const t = A.db.insert('tasks', { title: 'One' });
  const first = A.db.get('tasks', t.id);
  A.db.update('tasks', t.id, { title: 'Two' });
  A.db.update('tasks', t.id, { notes: 'a' }, { defer: true });
  const before = A.db.get('tasks', t.id);
  A.db.update('tasks', t.id, { notes: 'ab' }, { defer: true });
  A.db.flush();
  A.db.remove('tasks', t.id);
  assert.deepEqual(got.map(([op]) => op), ['put', 'put', 'put', 'del']);
  assert.equal(got[0][1], undefined, 'an insert has nothing before it');
  assert.equal(got[1][1], first, 'an update: the record before it');
  assert.equal(got[2][1]?.title, 'Two', 'a run of deferred edits: the record before the first of them');
  assert.notEqual(got[2][1], before);
  assert.equal(got[3][1]?.notes, 'ab', 'a delete: the record deleted');
  A.setSyncAdapter(null);
  deliver();
});

test('a write that does not fit is not rolled back with older values; the big collection is not written again on every change', async () => {
  A.db.insert('tasks', { title: 'Fits' });
  deliver();
  const listsBefore = ls.getItem(`${P}lists`);
  ls.quota = ls.used() + 4000; // nearly full
  events.length = 0;
  // One batch: a small change to lists, then notes (some 650 KB) that cannot fit.
  A.db.batch(() => {
    A.db.update('lists', A.db.all('lists')[0].id, { name: 'Renamed list' });
    for (const k of [1, 2, 3]) A.db.insert('notes', bigNote(k));
  });
  assert.notEqual(ls.getItem(`${P}lists`), listsBefore, 'lists were saved');
  assert.ok(!ls.done.some(([k, v]) => k === `${P}lists` && v === listsBefore), 'and never written back to the old value');
  assert.equal(A.cacheSaved('notes'), false, 'notes live in memory');
  assert.equal(events.filter(([n]) => n === 'ecosys:save-error').length, 1, 'reported once');
  const tries = ls.tries.filter((k) => k === `${P}notes`).length;
  A.db.update('notes', A.db.all('notes').at(-1).id, { pinned: true });
  A.db.update('notes', A.db.all('notes').at(-1).id, { pinned: false });
  assert.equal(ls.tries.filter((k) => k === `${P}notes`).length, tries, 'not serialized and tried again on each change');
  deliver();
  await tick();
  assert.ok(B.db.all('lists').some((l) => l.name === 'Renamed list'), 'the other tab has the saved change');
  assert.equal(B.db.all('notes').filter((n) => n.blocks.length === 12).length, 3, 'and the notes that could not be saved, sent to it directly');
});

test('changes to a collection that could not be saved reach the other tabs, local and remote ones', async () => {
  const n = A.db.all('notes').at(-1);
  A.db.update('notes', n.id, { pinned: true });
  A.applyRemoteOps([{ op: 'put', c: 'notes', item: { ...A.db.get('notes', n.id), blocks: [...n.blocks.slice(0, 11), { id: 'ai', t: 'p', c: [['From the assistant']] }], updatedAt: Date.now() + 1000 } }]);
  assert.equal(A.cacheSaved('notes'), false);
  deliver();
  await tick();
  const there = B.db.get('notes', n.id);
  assert.equal(there?.pinned, true);
  assert.equal(there?.blocks.at(-1).c[0][0], 'From the assistant');
});

test('while every change reaches the server, a full localStorage is a partial offline copy, not a failed save', () => {
  events.length = 0;
  A.setSyncAdapter({ push() {}, safe: () => true });
  ls.quota = 10;
  A.db.update('lists', A.db.all('lists')[0].id, { name: 'Renamed again' });
  A.db.update('notes', A.db.all('notes').at(-1).id, { pinned: false });
  assert.deepEqual(events.map(([name]) => name), ['ecosys:offline-cache']);
  assert.equal(events[0][1].partial, true);
  A.setSyncAdapter(null);
  ls.quota = Infinity;
  deliver();
});

test('Erase everything in one tab clears the undo history in the others', () => {
  events.length = 0;
  B.resetData();
  const raw = ls.getItem(`${P}replaced`);
  assert.equal(JSON.parse(raw).reason, 'erase', 'the other tabs are told through localStorage');
  deliver();
  assert.deepEqual(events.filter(([n]) => n === 'ecosys:data-replaced').map(([, d]) => d.reason), ['erase', 'erase'], 'raised in the tab that erased and once in the other one');
  // A remote replace raises it too, even when this tab already had the result.
  events.length = 0;
  A.applyRemoteOps([{ op: 'replace', c: 'events', items: A.db.all('events') }]);
  assert.deepEqual(events.filter(([n]) => n === 'ecosys:data-replaced').map(([, d]) => d.reason), ['remote']);
  console.warn = quietWarn;
});
