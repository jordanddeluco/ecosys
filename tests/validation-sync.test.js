// shared/sync.js reads parsed JSON from the server and from storage without converting odd values:
// objects whose toString / valueOf is not a function ({"toString": 0}, as a hand-edited data.json or
// a corrupted outbox can hold) make String(x), `${x}`, x > y and obj[x] throw. Before, such values
// failed the first load (sync retried forever while offline), crashed a push with an unhandled
// rejection, or hid a closed tab's unsent changes. Run with: npm test
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

const ODD = () => JSON.parse('{"valueOf":0,"toString":0}');
const T0 = Date.now() - 86400000;

// This browser: two tasks of its own, and the unsent outbox of a tab that was closed long ago, whose
// timestamp is an odd object.
ls.setItem('ecosys:v1:seeded', 'user');
ls.setItem('ecosys:v1:tasks', JSON.stringify([
  { id: 'srv1', title: 'Edited here', createdAt: T0, updatedAt: T0 + 1000 },
  { id: 'mine1', title: 'Made here', createdAt: T0, updatedAt: T0 },
]));
ls.setItem('ecosys:v1:outbox:deadbeefdeadbeef', JSON.stringify({ at: ODD(), entries: [{ at: T0, op: { op: 'put', c: 'tasks', item: { id: 'fromdead', title: 'Left by a closed tab', createdAt: T0, updatedAt: T0 } } }] }));

// A server whose data holds odd values: junk rows, a collection that is not a list, an odd timestamp.
const server = {
  rev: 5,
  data: {
    tasks: [null, 5, 'x', ['row'], { id: 'srv1', title: 'On the server', createdAt: T0, updatedAt: ODD() }],
    lists: { not: 'a list' },
    events: [],
    calendars: [],
    notes: [],
    folders: [],
  },
  pushed: [],
  mode: 'ok', // 'ok' | 'odd-rejected' (200 with odd rejected entries) | 'odd-error' (500 with an odd error message)
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: ODD(), features: ['sync'] });
  if (path === 'state') return json(200, { rev: server.rev, initialized: true, data: server.data, settings: {} });
  if (path === 'ops') {
    const body = JSON.parse(opts.body);
    if (server.mode === 'odd-error') return json(500, { error: { message: ODD() } });
    if (server.mode === 'odd-rejected') return json(200, { rev: ++server.rev, applied: 0, rejected: [{ index: ODD(), error: ODD() }, { index: 0, error: ODD() }] });
    server.pushed.push(...body.ops);
    return json(200, { rev: ++server.rev, applied: body.ops.length, rejected: [] });
  }
  if (path === 'events') {
    return new Response(new ReadableStream({ start(c) { opts.signal?.addEventListener('abort', () => { try { c.error(new DOMException('Aborted', 'AbortError')); } catch {} }); } }), { status: 200 });
  }
  return json(404, { error: 'Not found' });
};
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const unhandled = [];
process.on('unhandledRejection', (err) => unhandled.push(err));

const { db } = await import('../shared/store.js');
const { startSync, syncState } = await import('../shared/sync.js');

test('the first load copes with odd server data and merges what was made here', async () => {
  await startSync();
  assert.equal(syncState.status, 'online', `status ${syncState.status}: ${syncState.lastError}`);
  assert.equal(syncState.version, null, 'an odd version is not kept (Settings shows it)');
  await until(() => syncState.pending === 0);
  const ids = server.pushed.map((o) => o.item?.id);
  assert.ok(ids.includes('srv1'), 'the local edit is newer than a server copy with an unreadable timestamp');
  assert.ok(ids.includes('mine1'));
  assert.deepEqual(db.all('tasks').map((t) => t.id).sort(), ['fromdead', 'mine1', 'srv1']);
  assert.equal(db.get('tasks', 'srv1').title, 'Edited here');
});

test("a closed tab's outbox with an odd timestamp is still picked up and sent", () => {
  assert.ok(server.pushed.some((o) => o.item?.id === 'fromdead'));
  assert.equal(ls.getItem('ecosys:v1:outbox:deadbeefdeadbeef'), null, 'the claimed copy is removed');
});

test('a push answered with odd rejected entries is reported, not a crash', async () => {
  server.mode = 'odd-rejected';
  db.insert('tasks', { title: 'Refused by the server' });
  await until(() => /could not save/.test(syncState.lastError || ''));
  await until(() => syncState.pending === 0);
  assert.match(syncState.lastError, /It is kept in this browser only/);
  assert.deepEqual(unhandled, []);
});

test('an error reply with an odd message becomes a readable error, and the change is sent once the server recovers', async () => {
  server.mode = 'odd-error';
  const t = db.insert('tasks', { title: 'Sent after a server error' });
  await until(() => syncState.status === 'offline');
  assert.equal(syncState.lastError, 'HTTP 500');
  server.mode = 'ok';
  await until(() => server.pushed.some((o) => o.item?.id === t.id), 8000);
  await until(() => syncState.pending === 0);
  assert.deepEqual(unhandled, []);
  window.dispatchEvent(new Event('pagehide'));
});
