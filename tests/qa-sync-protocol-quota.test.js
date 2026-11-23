// QA regression (sync protocol, second pass): a library bigger than this browser's localStorage.
//   - a returning page's first state load cannot save the big collection while sync is still
//     'connecting': that is the server's data, so it is reported as a partial offline copy
//     ('ecosys:offline-cache'), never as 'ecosys:save-error' (the shell's "Could not save" toast and
//     Notes' "Not saved" banner on every page load, although everything was on the server)
//   - changes waiting to sync that cannot be saved in this browser either, while ecosys is away: the
//     user is told ('ecosys:save-error') and leaving the page asks first (beforeunload) until ecosys
//     has them; once it does, leaving is free again
// shared/sync.js and shared/store.js against a real server/store.mjs DataStore behind a fake fetch;
// localStorage here has a quota, like a browser's.
// Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class QuotaStorage {
  constructor() {
    this.map = new Map();
    this.quota = Infinity;
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
  }
  removeItem(k) {
    this.map.delete(k);
  }
  used() {
    return [...this.map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  }
}
const ls = new QuotaStorage();
const ss = new QuotaStorage();
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => ss });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
globalThis.location = { hostname: '127.0.0.1' };
const quietWarn = console.warn;
console.warn = () => {};
const events = [];
for (const name of ['ecosys:save-error', 'ecosys:offline-cache']) window.addEventListener(name, () => events.push([name, window.ecosysSync?.status]));

const quiet = { error() {}, warn() {}, info() {}, log() {} };
const { DataStore } = await import('../server/store.mjs');
const { loadValidators } = await import('../server/validate.mjs');
const validators = await loadValidators({ log: quiet });
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-syncp-quota-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
const ds = new DataStore({ dir, validators, log: quiet });
let opsDown = false;
const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url), 'http://127.0.0.1');
  const path = u.pathname.replace(/^.*\/api\//, '');
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
    if (opsDown) throw new TypeError('Failed to fetch');
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
/** Leaving the page now: true when it would ask first. */
const wouldAsk = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

const store = await import('../shared/store.js');
store.registerSeeder((d) => d.insert('tasks', { title: 'Sample' }));
store.seedIfEmpty();
let page = await import('../shared/sync.js?page=1');
const idle = () => until(() => page.syncState.online && page.syncState.pending === 0);

test('a returning page whose library is bigger than localStorage: its first load is a partial offline copy, not a failed save', async () => {
  await page.startSync(); // the folder starts with this browser's data
  assert.ok(await idle());
  window.dispatchEvent(new Event('pagehide')); // the tab is closed
  await sleep(30);
  // Meanwhile an assistant writes a lot of notes (about 800 KB).
  const t = Date.now();
  ds.transaction((tx) => {
    for (let i = 0; i < 40; i++) tx.put('notes', { id: `note${String(i).padStart(12, '0')}`, v: 1, rev: 1, createdAt: t, updatedAt: t, folderId: null, blocks: [{ id: `b${i}`, t: 'p', c: [['x'.repeat(20000)]] }] });
  });
  ls.quota = ls.used() + 100000; // this browser's localStorage can't hold them
  events.length = 0;
  page = await import('../shared/sync.js?page=2');
  await page.startSync();
  assert.ok(await idle(), `status ${page.syncState.status}`);
  await sleep(100);
  assert.equal(store.db.all('notes').length, 40, 'the tab has every note');
  assert.equal(store.cacheSaved('notes'), false, 'localStorage could not hold them');
  assert.deepEqual(events.filter(([n]) => n === 'ecosys:save-error'), [], 'no "Could not save"');
  assert.ok(events.some(([n]) => n === 'ecosys:offline-cache'), 'a partial offline copy');
});

test('changes that cannot be saved in this browser while ecosys is away: the user is told, and leaving the page asks first until ecosys has them', async () => {
  assert.equal(wouldAsk(), false, 'nothing waits: leaving is free');
  events.length = 0;
  opsDown = true; // ecosys stops taking changes
  ls.quota = ls.used() + 2000;
  const t = store.db.insert('tasks', { title: 'Long task typed now', notes: 'n'.repeat(60000) });
  assert.ok(await until(() => page.syncState.status === 'offline'), `status ${page.syncState.status}`);
  assert.deepEqual(events.filter(([n]) => n === 'ecosys:save-error'), [['ecosys:save-error', 'offline']], 'the user is told, once ecosys is found away');
  assert.equal(wouldAsk(), true, 'leaving the page asks first');
  ls.quota = Infinity;
  opsDown = false;
  assert.ok(await until(() => page.syncState.online && page.syncState.pending === 0, 15000), `status ${page.syncState.status}`);
  assert.ok(ds.get('tasks', t.id), 'ecosys has it');
  assert.equal(wouldAsk(), false, 'leaving is free again');
});

test('a closed tab’s unsent changes taken over by a page that cannot save its own copy stay saved where they were until it can', async () => {
  window.dispatchEvent(new Event('pagehide')); // this page goes away
  await sleep(30);
  const at = Date.now() - 200000;
  const item = { id: 'closedtab0000001', title: 'Typed in a tab that was closed before it could send', notes: '', done: false, priority: 0, createdAt: at, updatedAt: at };
  const dead = 'ecosys:v1:outbox:deadbeefdeadbeef';
  ls.setItem(dead, JSON.stringify({ v: 2, at, entries: [{ at, op: { op: 'put', c: 'tasks', item }, base: null, fields: Object.keys(item).filter((k) => !['id', 'createdAt', 'updatedAt'].includes(k)), was: {} }] }));
  opsDown = true;
  ls.quota = ls.used() + 300; // this page can't save a copy of its own
  page = await import('../shared/sync.js?page=3');
  await page.startSync();
  assert.ok(await until(() => page.syncState.status === 'offline'), `status ${page.syncState.status}`);
  assert.ok(page.syncState.pending >= 1, 'the closed tab’s change is waiting here');
  assert.ok(ls.getItem(dead), 'and still saved where it was');
  assert.equal(wouldAsk(), true);
  ls.quota = Infinity;
  opsDown = false;
  assert.ok(await until(() => page.syncState.online && page.syncState.pending === 0, 15000), `status ${page.syncState.status}`);
  assert.equal(ds.get('tasks', item.id)?.title, item.title, 'sent');
  assert.equal(ls.getItem(dead), null, 'then the old copy goes');
});

test('teardown', async () => {
  window.dispatchEvent(new Event('pagehide'));
  await sleep(20);
  console.warn = quietWarn;
});
