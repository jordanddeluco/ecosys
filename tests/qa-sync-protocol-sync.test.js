// QA regression (sync protocol, browser side): shared/sync.js and shared/store.js against an ecosys
// server whose data is the real server/store.mjs DataStore (fetch and the event stream are faked in
// this process, the merge rules are the real ones). Checks, in order, on one browser tab:
//   - a new data folder: this browser's data goes there (import)
//   - a change from elsewhere while an edit of the same task waits to be sent: both are kept
//   - a push from an older version is merged on the server, the tab takes the merged copy, and a
//     late event about that older version does not undo it
//   - a task deleted elsewhere that this tab then edits stays deleted, here too
//   - the outbox is saved as references to the cached records (small), and survives a closed tab
//   - the server comes back with ANOTHER data folder that has data: this browser adds what it has
//   - a reload downloads the state once
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
const ss = new MemoryStorage();
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => ss });
// No Web Locks: one tab, holding its own stream (and no BroadcastChannel keeps the process alive).
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
globalThis.location = { hostname: '127.0.0.1' };

// ---------------------------------------------------------------- the server: a real DataStore
const quiet = { error() {}, warn() {}, info() {}, log() {} };
const { DataStore } = await import('../server/store.mjs');
const { loadValidators } = await import('../server/validate.mjs');
const validators = await loadValidators({ log: quiet });
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
const newFolder = () => {
  const d = mkdtempSync(join(tmpdir(), 'ecosys-qa-syncp-'));
  dirs.push(d);
  return new DataStore({ dir: d, validators, log: quiet });
};
const srv = { ds: newFolder(), streams: new Map(), states: 0, requests: [] };
const enc = new TextEncoder();
const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function broadcast(event, data, except = null) {
  for (const [c, id] of srv.streams) if (id !== except) c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}
/** An assistant's change over MCP: written by the server, streamed to the browser (unless `quiet`). */
function aiWrite(fn, { stream = true } = {}) {
  const { ops, rev } = srv.ds.transaction(fn);
  if (stream && ops.length) broadcast('ops', { rev, origin: 'ai:claude1', ops });
  return { ops, rev };
}
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url), 'http://127.0.0.1');
  const path = u.pathname.replace(/^.*\/api\//, '');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  srv.requests.push({ method, path, body });
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync', 'mcp'] });
  if (path === 'state') {
    srv.states++;
    return json(200, srv.ds.snapshotJSON());
  }
  if (path === 'import' && method === 'POST') {
    try {
      const out = srv.ds.importData(body);
      broadcast('snapshot', { rev: out.rev });
      return json(200, out);
    } catch (err) {
      return json(err.status || 500, { error: err.message, rev: srv.ds.rev });
    }
  }
  if (path === 'ops' && method === 'POST') {
    const out = srv.ds.applyOps(body.ops);
    if (out.applied.length) broadcast('ops', { rev: out.rev, origin: body.client, ops: out.applied }, body.client);
    return json(200, { rev: out.rev, applied: out.applied.length, rejected: out.rejected });
  }
  if (path === 'events') {
    const client = u.searchParams.get('client');
    const stream = new ReadableStream({
      start(c) {
        srv.streams.set(c, client);
        opts.signal?.addEventListener('abort', () => {
          srv.streams.delete(c);
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
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(10);
  }
  return true;
};

const { db, registerSeeder, seedIfEmpty } = await import('../shared/store.js');
registerSeeder((d) => d.insert('tasks', { title: 'Sample task' }));
seedIfEmpty();
const mine = db.insert('tasks', { title: 'Mine, typed before the first sync' });
let page = await import('../shared/sync.js?page=1');
const idle = () => until(() => page.syncState.online && page.syncState.pending === 0 && srv.streams.size > 0);

test('a new data folder: this browser brings its data to it', async () => {
  await page.startSync();
  assert.ok(await idle(), `status ${page.syncState.status}: ${page.syncState.lastError}`);
  assert.equal(srv.ds.initialized, true);
  assert.ok(srv.ds.get('tasks', mine.id), 'the task typed here is on the server');
  assert.equal(JSON.parse(ls.getItem('ecosys:v1:sync')).dataId, srv.ds.dataId, 'this browser remembers the folder');
});

test('an assistant completes a task while the user is typing in it: both changes are kept', async () => {
  db.update('tasks', mine.id, { notes: 'Landlord wants it by the 3rd' }, { defer: true });
  aiWrite((tx) => tx.put('tasks', { ...tx.get('tasks', mine.id), done: true, completedAt: Date.now(), updatedAt: Date.now() }));
  assert.ok(await until(() => srv.ds.get('tasks', mine.id).notes === 'Landlord wants it by the 3rd'), 'the typing reached the server');
  await idle();
  assert.equal(srv.ds.get('tasks', mine.id).done, true, 'the completion is kept on the server');
  assert.equal(db.get('tasks', mine.id).done, true, 'and here');
  assert.equal(db.get('tasks', mine.id).notes, 'Landlord wants it by the 3rd');
});

test('a push from an older version is merged; the tab takes the merged copy and ignores the late event about the older one', async () => {
  const t = db.insert('tasks', { title: 'Renew passport' });
  await idle();
  // The assistant renames it; its event is slow to arrive.
  const late = aiWrite((tx) => tx.put('tasks', { ...tx.get('tasks', t.id), title: 'Renew passport before June', updatedAt: Date.now() }), { stream: false });
  db.update('tasks', t.id, { priority: 3 }); // starred here, from the version this tab has
  assert.ok(await until(() => srv.ds.get('tasks', t.id).priority === 3));
  await idle();
  assert.equal(srv.ds.get('tasks', t.id).title, 'Renew passport before June', 'the rename is kept on the server');
  assert.ok(await until(() => db.get('tasks', t.id).title === 'Renew passport before June'), 'this tab took the merged copy');
  assert.equal(db.get('tasks', t.id).priority, 3);
  broadcast('ops', { rev: late.rev, origin: 'ai:claude1', ops: late.ops }); // the late event
  await sleep(150);
  assert.equal(db.get('tasks', t.id).priority, 3, 'the late event does not undo the star');
});

test('a task deleted elsewhere that this tab then edits stays deleted, here too', async () => {
  const t = db.insert('tasks', { title: 'Old errand' });
  await idle();
  aiWrite((tx) => tx.del('tasks', t.id), { stream: false }); // deleted by an assistant; the event is lost
  db.update('tasks', t.id, { title: 'Old errand, edited' });
  assert.ok(await until(() => !db.get('tasks', t.id)), 'this tab drops it too');
  await idle();
  assert.equal(srv.ds.get('tasks', t.id), null, 'not brought back on the server');
});

test('the outbox is saved as references to the cached records, and a closed tab’s outbox is sent by the next page', async () => {
  // Typed while ecosys is not reachable: the outbox is kept in localStorage.
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes('/api/ops') ? Promise.reject(new TypeError('Failed to fetch')) : real(url, opts));
  const big = db.insert('tasks', { title: 'Typed offline', notes: 'x'.repeat(5000) });
  assert.ok(await until(() => page.syncState.status === 'offline'));
  const key = `ecosys:v1:outbox:${page.syncState.clientId}`;
  const saved = JSON.parse(ls.getItem(key));
  const entry = saved.entries.find((e) => e.op.item?.id === big.id);
  assert.ok(entry?.ref, 'saved as a reference');
  assert.ok(ls.getItem(key).length < 1000, 'small however long the task is');
  // The tab is closed; ecosys is reachable again; the next page sends it.
  window.dispatchEvent(new Event('pagehide'));
  await sleep(50);
  globalThis.fetch = real;
  assert.ok(ls.getItem(key), 'still saved after the tab closed');
  page = await import('../shared/sync.js?page=2');
  await page.startSync();
  assert.ok(await idle(), `status ${page.syncState.status}`);
  assert.equal(srv.ds.get('tasks', big.id)?.title, 'Typed offline', 'sent by the next page');
  assert.equal(ls.getItem(key), null, 'and taken over from the closed tab');
});

test('a large backup imported while ecosys is unreachable is saved for later as references, and all of it is sent', async () => {
  const { importData, exportData } = await import('../shared/store.js');
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes('/api/ops') ? Promise.reject(new TypeError('Failed to fetch')) : real(url, opts));
  const backup = exportData();
  backup.tasks = [...backup.tasks, ...Array.from({ length: 2500 }, (_, i) => ({ id: `imp${String(i).padStart(9, '0')}`, title: `Imported task ${i}`, notes: 'n'.repeat(400), createdAt: 1, updatedAt: 1 }))];
  importData(backup);
  assert.ok(await until(() => page.syncState.status === 'offline'));
  const saved = ls.getItem(`ecosys:v1:outbox:${page.syncState.clientId}`);
  assert.ok(saved && saved.length < 200000, `the saved outbox stays small (${saved?.length} chars for ~1 MB of tasks)`);
  globalThis.fetch = real;
  assert.ok(await until(() => page.syncState.online && page.syncState.pending === 0, 15000), `status ${page.syncState.status}`);
  assert.equal(srv.ds.all('tasks').filter((t) => t.id.startsWith('imp')).length, 2500, 'every imported task reached the server');
});

test('the server comes back with another data folder that has data: this browser adds what it has, and keeps it', async () => {
  const before = srv.ds;
  const other = newFolder();
  other.importData({ data: { tasks: [{ id: 'theirs0000000001', title: 'From the other folder', createdAt: 1, updatedAt: 1 }] }, settings: {} });
  srv.ds = other;
  // The tab's stream reconnects after the restart (a snapshot event reloads the same way).
  broadcast('snapshot', { rev: other.rev, dataId: other.dataId });
  assert.ok(await until(() => db.get('tasks', 'theirs0000000001')), 'the folder’s data is taken');
  await idle();
  assert.ok(db.get('tasks', mine.id), 'this browser keeps its own tasks');
  assert.ok(other.get('tasks', mine.id), 'and adds them to the folder');
  assert.ok(!other.all('tasks').some((t) => t.title === 'Sample task'), 'untouched samples are not added');
  assert.notEqual(before.dataId, other.dataId);
  assert.equal(JSON.parse(ls.getItem('ecosys:v1:sync')).dataId, other.dataId);
});

test('a reload downloads the state once', async () => {
  window.dispatchEvent(new Event('pagehide'));
  await sleep(50);
  const states = srv.states;
  page = await import('../shared/sync.js?page=3');
  await page.startSync();
  assert.ok(await idle());
  await sleep(500);
  assert.equal(srv.states - states, 1, 'one GET /api/state');
});

test('teardown', async () => {
  window.dispatchEvent(new Event('pagehide'));
  await sleep(20);
});
