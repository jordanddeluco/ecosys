// QA regression (sync protocol, second pass): a browser profile that has never synced with the data
// folder records Erase everything / Start over as whole-collection replaces and sends them once it
// connects. Before the fix, a new profile that was not paired yet (decision 1) and cleaned up its
// samples erased the folder's real data in ecosys, and in every other browser, once its pairing link
// was opened. Now (shared/sync.js adopt):
//   - a replace made before this browser ever synced with the folder stays this browser's: the
//     folder's data is kept, what was typed here is added, untouched samples are not
//   - once it has synced, an Erase everything made while ecosys is away is still applied to that
//     folder when it is back (the user's erase is not dropped)
// shared/sync.js and shared/store.js run against a real server/store.mjs DataStore behind a fake fetch
// that requires the pairing secret like the paired server will (403 pairing_required).
// Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const ls = new MemoryStorage();
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => new MemoryStorage() });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
globalThis.location = { hostname: '127.0.0.1', pathname: '/tasks/', search: '', hash: '' };
globalThis.history = { state: null, replaceState() {} };
const quietWarn = console.warn;
console.warn = () => {};

// ---------------------------------------------------------------- the server: a real DataStore that wants the pairing secret
const quiet = { error() {}, warn() {}, info() {}, log() {} };
const { DataStore } = await import('../server/store.mjs');
const { loadValidators } = await import('../server/validate.mjs');
const validators = await loadValidators({ log: quiet });
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-syncp-fresh-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
const ds = new DataStore({ dir, validators, log: quiet });
const day = Date.now() - 86400000;
ds.importData({
  data: {
    tasks: [
      { id: 'real000000000001', title: 'Real task: file taxes', createdAt: day, updatedAt: day },
      { id: 'real000000000002', title: 'Real task: call mom', createdAt: day, updatedAt: day },
    ],
    lists: [{ id: 'reallist00000001', name: 'Home', color: 'iris', order: 0, createdAt: day, updatedAt: day }],
  },
  settings: {},
});
let SECRET = 'Pq7_qaSecretQaSecretQaSecretQaSecret-1234';
let reachable = true;
const requests = []; // [path, time]
const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url), 'http://127.0.0.1');
  const path = u.pathname.replace(/^.*\/api\//, '');
  requests.push([path, Date.now()]);
  if (!reachable) throw new TypeError('Failed to fetch');
  const header = opts.headers?.['X-Ecosys'];
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync', 'mcp'], paired: header === SECRET });
  if (header !== SECRET) return json(403, { error: 'pairing_required' });
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (path === 'state') return json(200, ds.snapshotJSON());
  if (path === 'import') {
    try {
      return json(200, ds.importData(body));
    } catch (err) {
      return json(err.status || 500, { error: err.message });
    }
  }
  if (path === 'ops') {
    const out = ds.applyOps(body.ops);
    return json(200, { rev: out.rev, applied: out.applied.length, rejected: out.rejected });
  }
  if (path === 'events') {
    const stream = new ReadableStream({
      start(c) {
        opts.signal?.addEventListener('abort', () => {
          try {
            c.error(new DOMException('Aborted', 'AbortError'));
          } catch {}
        });
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  return json(404, { error: 'Not found' });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(10);
  }
  return true;
};
const titles = (list) => list.map((t) => t.title).sort();

const store = await import('../shared/store.js');
store.registerSeeder((d) => {
  d.insert('tasks', { title: 'Sample: welcome to tasks' });
  d.insert('tasks', { title: 'Sample: plan the week' });
});
store.seedIfEmpty(); // a new browser profile: sample data, never synced
const sync = await import('../shared/sync.js');
const idle = () => until(() => sync.syncState.online && sync.syncState.pending === 0);

test('a new profile not connected yet: its Erase everything never erases the folder, and what was typed there is added', async () => {
  await sync.startSync();
  assert.ok(await until(() => sync.syncState.status === 'unpaired'), `status ${sync.syncState.status}`);
  assert.equal(sync.syncState.synced, false, 'this browser has not synced with a data folder');
  // Settings > Erase everything (to clear the samples), then a task typed here.
  store.resetData();
  const typed = store.db.insert('tasks', { title: 'Typed here while not connected' });
  assert.ok(sync.syncState.pending > 0, 'kept for when it is connected');
  // The pairing link is opened (in another tab).
  ls.setItem('ecosys:v1:pair', SECRET);
  window.dispatchEvent(Object.assign(new Event('storage'), { key: 'ecosys:v1:pair', storageArea: ls }));
  assert.ok(await idle(), `status ${sync.syncState.status}: ${sync.syncState.lastError}`);
  await sleep(200);
  assert.deepEqual(titles(ds.all('tasks')), ['Real task: call mom', 'Real task: file taxes', 'Typed here while not connected'], 'the folder keeps its tasks and gets the typed one');
  assert.ok(ds.get('lists', 'reallist00000001'), 'and its lists');
  assert.ok(!ds.all('tasks').some((t) => t.title.startsWith('Sample')), 'no samples are pushed');
  assert.deepEqual(titles(store.db.all('tasks')), titles(ds.all('tasks')), 'this browser now shows the folder’s data with its own task');
  assert.ok(store.db.get('tasks', typed.id));
  assert.equal(sync.syncState.synced, true);
});

test('once it has synced, an Erase everything made while ecosys is away is applied to that folder when it is back', async () => {
  reachable = false;
  store.db.insert('tasks', { title: 'Typed while ecosys is away' });
  assert.ok(await until(() => sync.syncState.status === 'offline'), `status ${sync.syncState.status}`);
  store.resetData();
  reachable = true;
  assert.ok(await idle(), `status ${sync.syncState.status}: ${sync.syncState.lastError}`);
  assert.deepEqual(ds.all('tasks'), [], 'the folder this browser synced with is erased, as asked');
  assert.deepEqual(store.db.all('tasks'), []);
});

test('a tab whose pairing is refused while it syncs stops asking until it is paired again, and keeps its changes', async () => {
  SECRET = 'Zz9_aNewSecretANewSecretANewSecretANew-5678'; // a new data folder, or the secret was reset
  const t = store.db.insert('tasks', { title: 'Typed as the pairing was refused' });
  assert.ok(await until(() => sync.syncState.status === 'unpaired'), `status ${sync.syncState.status}`);
  const from = Date.now();
  await sleep(2500); // longer than a reconnect's first wait
  assert.deepEqual(requests.filter(([p, at]) => at >= from && p.startsWith('events')), [], 'the event stream is not opened again');
  assert.ok(sync.syncState.pending > 0, 'the change is kept');
  ls.setItem('ecosys:v1:pair', SECRET); // the new pairing link is opened
  window.dispatchEvent(Object.assign(new Event('storage'), { key: 'ecosys:v1:pair', storageArea: ls }));
  assert.ok(await idle(), `status ${sync.syncState.status}: ${sync.syncState.lastError}`);
  assert.ok(ds.get('tasks', t.id), 'and sent once paired');
});

test('teardown', async () => {
  window.dispatchEvent(new Event('pagehide'));
  await sleep(20);
  console.warn = quietWarn;
});
