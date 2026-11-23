// QA regression (sync protocol, second pass, shared/store.js): an Erase everything or Import backup
// made in ANOTHER browser arrives as a replace in the tab that holds the event stream. It used to
// raise 'ecosys:data-replaced' (which clears undo history) only there; the other tabs of the browser
// got the new data through localStorage and kept their undo history, so their Ctrl+Z put a deleted
// task back into the erased or imported data. Now every tab hears it: through localStorage, or over
// the BroadcastChannel when localStorage is full.
// Two store instances share one localStorage, window and BroadcastChannel here, like two tabs of a
// browser; deliver() hands out the `storage` events a browser would.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.quota = Infinity;
    this.done = [];
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
function deliver() {
  for (const [key, newValue] of ls.done.splice(0)) window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue, storageArea: ls }));
}
const replaced = [];
window.addEventListener('ecosys:data-replaced', (e) => replaced.push(e.detail.reason));
const quietWarn = console.warn;
console.warn = () => {};

const A = await import('../shared/store.js?tab=a'); // holds the event stream
const B = await import('../shared/store.js?tab=b');
A.db.insert('tasks', { title: 'Welcome to tasks' });
deliver();

test('an Erase everything made in another browser clears the undo history in every tab of this one', async () => {
  replaced.length = 0;
  A.applyRemoteOps([{ op: 'replace', c: 'tasks', items: [] }]); // from the server's event stream
  assert.deepEqual(replaced, ['remote'], 'raised in the tab holding the stream');
  assert.equal(JSON.parse(ls.getItem('ecosys:v1:replaced')).reason, 'remote', 'the other tabs are told through localStorage');
  deliver();
  await tick();
  assert.deepEqual(replaced, ['remote', 'remote'], 'and raised in the other tab');
  assert.deepEqual(B.db.all('tasks'), [], 'which has the erased data');
});

test('with localStorage full, the other tabs hear it over the BroadcastChannel', async () => {
  B.db.insert('tasks', { title: 'Imported elsewhere' });
  deliver();
  await tick();
  replaced.length = 0;
  ls.quota = ls.used(); // nothing more fits
  A.applyRemoteOps([{ op: 'replace', c: 'tasks', items: [{ id: 'imported00000001', title: 'Only task in the backup', createdAt: 1, updatedAt: 1 }] }]);
  assert.deepEqual(replaced, ['remote']);
  deliver();
  await tick();
  assert.ok(replaced.length >= 2, `raised in the other tab too (${replaced.length})`);
  assert.deepEqual(B.db.all('tasks').map((t) => t.title), ['Only task in the backup'], 'which has the imported data');
  ls.quota = Infinity;
  console.warn = quietWarn;
});
