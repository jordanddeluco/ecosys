// shared/sync.js start-up: a plain static server ("no ecosys here") leaves saved outboxes alone; a
// busy or restarting ecosys server (no answer, 5xx) keeps the adapter, records writes and retries,
// so nothing written meanwhile (or left by an earlier page) is lost. Run with: npm test
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
const ls = new MemoryStorage();
const ss = new MemoryStorage();
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => ss });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
globalThis.location = { hostname: '127.0.0.1' };

const now = Date.now();
const put = (id, title, at) => ({ at, op: { op: 'put', c: 'tasks', item: { id, title, createdAt: at, updatedAt: at } } });
// This browser synced before (so later loads take the server's state), and has unsent changes:
// one from the previous page in this tab, one from a tab that was closed before it could send.
ls.setItem('ecosys:v1:sync', JSON.stringify({ rev: 1, at: now - 60000 }));
ls.setItem('ecosys:v1:seeded', 'user');
ss.setItem('ecosys:sync:outbox', JSON.stringify({ id: 'prevpage00000001', entries: [put('fromprev01', 'From the previous page', now - 5000)] }));
ls.setItem('ecosys:v1:outbox:prevpage00000001', JSON.stringify({ at: now - 5000, entries: [put('fromprev01', 'From the previous page', now - 5000)] }));
ls.setItem('ecosys:v1:outbox:closedtab0000001', JSON.stringify({ at: now - 300000, entries: [put('fromclosed', 'From a closed tab', now - 300000)] }));

const server = { mode: 'static', helloFailures: 0, requests: [], tasks: new Map(), rev: 1 };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
  server.requests.push(path);
  if (server.mode === 'static') return new Response('Not found', { status: 404 });
  if (path === 'hello') {
    if (server.helloFailures-- > 0) return json(503, { error: 'busy' });
    return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync'] });
  }
  if (path === 'state') return json(200, { rev: server.rev, initialized: true, data: { tasks: [...server.tasks.values()] }, settings: {} });
  if (path === 'ops') {
    for (const o of JSON.parse(opts.body).ops) if (o.op === 'put' && o.c === 'tasks') server.tasks.set(o.item.id, o.item);
    return json(200, { rev: ++server.rev, applied: 1, rejected: [] });
  }
  if (path === 'events') return new Response(new ReadableStream({ start(c) { opts.signal?.addEventListener('abort', () => { try { c.error(new DOMException('Aborted', 'AbortError')); } catch {} }); } }), { status: 200 });
  return json(404, {});
};
const until = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const saved = () => {
  const s = JSON.parse(ss.getItem('ecosys:sync:outbox') || 'null');
  return (s?.entries || []).map((e) => e.op.item.id).sort();
};

const { db } = await import('../shared/store.js');

test('no ecosys server (a plain static server): stay local and leave saved outboxes in place', async () => {
  const page = await import('../shared/sync.js?page=static');
  await page.startSync();
  assert.equal(page.syncState.status, 'off');
  assert.equal(page.syncState.online, false);
  assert.deepEqual(saved(), ['fromclosed', 'fromprev01'], 'still saved for a page that can sync');
  assert.ok(ls.getItem('ecosys:v1:outbox:closedtab0000001'), 'the closed tab\'s copy is not deleted');
  assert.ok(ls.getItem('ecosys:v1:outbox:prevpage00000001'));
  db.insert('tasks', { title: 'Written without a server' });
  assert.equal(page.syncState.pending, 0, 'writes are not recorded when there is no server');
});

test('ecosys busy or restarting: writes are recorded and everything is sent once it answers', async () => {
  server.mode = 'ecosys';
  server.helloFailures = 1;
  const page = await import('../shared/sync.js?page=busy');
  const statuses = [];
  window.addEventListener('ecosys:sync', (e) => statuses.push(e.detail.status));
  await page.startSync(); // resolves after the first try
  assert.equal(page.syncState.status, 'offline');
  const t = db.insert('tasks', { title: 'Written while ecosys was busy' });
  assert.equal(page.syncState.pending, 3, 'two restored changes and this one');
  assert.ok(saved().includes(t.id), 'saved for the next page too');
  assert.equal(ls.getItem('ecosys:v1:outbox:closedtab0000001'), null, 'taken over from the closed tab');
  await until(() => page.syncState.status === 'online' && page.syncState.pending === 0);
  assert.ok(server.tasks.has(t.id) && server.tasks.has('fromprev01') && server.tasks.has('fromclosed'));
  assert.ok(db.get('tasks', t.id), 'not removed by loading the server state');
  assert.ok(db.get('tasks', 'fromclosed'));
  assert.deepEqual(statuses.slice(-1), ['online']);
  assert.equal(ss.getItem('ecosys:sync:outbox'), null);
  window.dispatchEvent(new Event('pagehide'));
});
