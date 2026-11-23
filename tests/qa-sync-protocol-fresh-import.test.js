// QA regression (sync protocol, second pass): a new browser profile that cannot reach ecosys yet
// starts over with the sample data and then imports a backup too large for one request (it is queued
// as a replace with the first records plus puts for the rest). When ecosys becomes reachable, its
// data folder already has data. Before the fix the queued replace emptied the folder's tasks and its
// puts overwrote the folder's newer copy of a shared task. Now (shared/sync.js adopt): the replace and
// the puts it was split into are this browser's alone; the first-sync merge adds what the folder lacks
// (the backup's other tasks), the folder keeps its newer copy, and untouched samples stay out.
// shared/sync.js and shared/store.js run against a real server/store.mjs DataStore behind a fake fetch.
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

const quiet = { error() {}, warn() {}, info() {}, log() {} };
const { DataStore } = await import('../server/store.mjs');
const { loadValidators } = await import('../server/validate.mjs');
const validators = await loadValidators({ log: quiet });
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-syncp-freshimp-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
const ds = new DataStore({ dir, validators, log: quiet });
const old = Date.now() - 30 * 86400000;
const recent = Date.now() - 3600000;
// The folder's copy of the shared task was edited an hour ago; the backup has a month-old copy.
ds.importData({
  data: {
    tasks: [
      { id: 'shared0000000001', title: 'Shared task, renamed in ecosys an hour ago', createdAt: old, updatedAt: recent },
      { id: 'real000000000001', title: 'Real task: file taxes', createdAt: old, updatedAt: old },
    ],
  },
  settings: {},
});
let reachable = false;
let opsRequests = 0;
const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url), 'http://127.0.0.1');
  const path = u.pathname.replace(/^.*\/api\//, '');
  if (!reachable) throw new TypeError('Failed to fetch');
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync', 'mcp'] });
  if (path === 'state') return json(200, ds.snapshotJSON());
  if (path === 'import') {
    try {
      return json(200, ds.importData(body));
    } catch (err) {
      return json(err.status || 500, { error: err.message });
    }
  }
  if (path === 'ops') {
    opsRequests++;
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
const until = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(10);
  }
  return true;
};

const store = await import('../shared/store.js');
store.registerSeeder((d) => d.insert('tasks', { title: 'Sample: welcome to tasks' }));
store.seedIfEmpty();
const sync = await import('../shared/sync.js');

test('a new profile’s Start over and large import made before it reached ecosys never replace the folder’s data', async () => {
  await sync.startSync();
  assert.equal(sync.syncState.status, 'offline');
  store.resetData({ withSamples: true }); // Settings > Start over with sample data
  // Import backup: about 1.7 MB of tasks (sent as a replace plus puts), the shared task last (a put).
  const backup = store.exportData();
  backup.tasks = [
    ...Array.from({ length: 3600 }, (_, i) => ({ id: `bak${String(i).padStart(13, '0')}`, title: `Backup task ${i}`, notes: 'n'.repeat(400), createdAt: old, updatedAt: old })),
    { id: 'shared0000000001', title: 'Shared task, as the month-old backup has it', createdAt: old, updatedAt: old },
  ];
  store.importData(backup);
  assert.ok(sync.syncState.pending > 2, 'the import is queued in several parts');
  reachable = true;
  assert.ok(await until(() => sync.syncState.online && sync.syncState.pending === 0), `status ${sync.syncState.status}: ${sync.syncState.lastError}`);
  await sleep(200);
  assert.equal(ds.get('tasks', 'real000000000001')?.title, 'Real task: file taxes', 'the folder keeps its own tasks');
  assert.equal(ds.get('tasks', 'shared0000000001')?.title, 'Shared task, renamed in ecosys an hour ago', 'and its newer copy of the shared task');
  assert.equal(ds.all('tasks').filter((t) => t.id.startsWith('bak')).length, 3600, 'the backup’s other tasks are added');
  assert.ok(!ds.all('tasks').some((t) => t.title.startsWith('Sample')), 'no samples are pushed');
  assert.ok(opsRequests >= 2, 'sent in more than one request');
  assert.equal(store.db.get('tasks', 'shared0000000001')?.title, 'Shared task, renamed in ecosys an hour ago', 'this browser takes the newer copy');
});

test('teardown', async () => {
  window.dispatchEvent(new Event('pagehide'));
  await sleep(20);
  console.warn = quietWarn;
});
