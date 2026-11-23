// QA regression (sync protocol): browser pairing (shared/pair.js, lead decision 1) and how
// shared/sync.js uses it.
//   - apiHeaders() sends the stored secret, or the legacy "1" while nothing is stored
//   - the pairing link (#pair=<secret>) is taken out of the address bar, keeping the route after it
//   - a 403 pairing_required forgets the secret that was sent (not one stored since) and shows one
//     calm notice, once per page, in the shared toast stack
//   - an unpaired tab keeps its changes; once another tab opens the pairing link it connects and
//     sends them, every request carrying the secret
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
// A tiny DOM: enough for the notice (createElement, append, classList, a body).
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.textContent = '';
    this.classList = { add: (c) => (this.className += ` ${c}`) };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  append(...xs) {
    for (const x of xs) {
      x.parent = this;
      this.children.push(x);
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
  }
  addEventListener(t, fn) {
    this.listeners[t] = fn;
  }
}
const body = new El('body');
const ls = new MemoryStorage();
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), {
  visibilityState: 'visible',
  body,
  createElement: (t) => new El(t),
  querySelector: (sel) => (sel === 'body > .toasts' ? body.children.find((c) => c.className === 'toasts') || null : null),
});
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => new MemoryStorage() });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node' } });
const replaced = [];
globalThis.history = { state: null, replaceState: (s, t, url) => replaced.push(url) };
const SECRET = 'Zx9_secretSECRETsecretSECRETsecret-0123456';
globalThis.location = { hostname: '127.0.0.1', pathname: '/tasks/', search: '', hash: `#pair=${SECRET}&/inbox` };

const notices = () => (body.children.find((c) => c.className === 'toasts')?.children || []).filter((t) => 'pairing' in t.dataset);
const storageEvent = (key) => window.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea: ls }));

const pair = await import('../shared/pair.js');

test('the pairing link is taken out of the address bar, keeping the route, and the secret is kept', () => {
  assert.equal(ls.getItem('ecosys:v1:pair'), SECRET);
  assert.deepEqual(replaced, ['/tasks/#/inbox']);
  assert.equal(pair.pairingState(), 'paired');
  assert.deepEqual(pair.apiHeaders(), { 'X-Ecosys': SECRET });
});

test('a refusal forgets the secret that was sent (not one stored since), and shows the notice once', () => {
  const seen = [];
  const off = pair.onPairingChange((s) => seen.push(s));
  pair.markRejected('some-older-secret-that-was-replaced-meanwhile');
  assert.equal(pair.pairingState(), 'paired', 'a newer secret stored meanwhile is kept');
  pair.markRejected(SECRET);
  assert.equal(pair.pairingState(), 'rejected');
  assert.equal(ls.getItem('ecosys:v1:pair'), null);
  assert.deepEqual(pair.apiHeaders(), { 'X-Ecosys': '1' }, 'the legacy header while nothing is stored');
  assert.deepEqual(seen, ['rejected']);
  assert.equal(notices().length, 1);
  assert.match(notices()[0].children[0].textContent, /isn't connected to ecosys on this computer\. Open the link shown where ecosys is running/);
  assert.doesNotMatch(notices()[0].children[0].textContent, /[\u{1F300}-\u{1FAFF}☀-➿]/u, 'no emoji');
  pair.markRejected();
  assert.equal(notices().length, 1, 'once per page');
  off();
});

test('a secret stored by another tab (the pairing link opened there) pairs this tab and hides the notice', () => {
  const seen = [];
  const off = pair.onPairingChange((s) => seen.push(s));
  ls.setItem('ecosys:v1:pair', JSON.stringify({ v: 1, secret: SECRET })); // a JSON wrapper is read too
  storageEvent('ecosys:v1:pair');
  assert.deepEqual(seen, ['paired']);
  assert.deepEqual(pair.apiHeaders(), { 'X-Ecosys': SECRET });
  assert.match(notices()[0]?.className || 'toast leaving', /leaving/);
  off();
});

// ---------------------------------------------------------------- sync.js with a server that requires the secret
const server = { secret: 'Kq4_anotherSecretAnotherSecretAnother-9876', tasks: new Map(), seen: [], rev: 1 };
const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
  const header = opts.headers?.['X-Ecosys'];
  server.seen.push([path, header]);
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync', 'mcp'], paired: header === server.secret });
  if (header !== server.secret) return json(403, { error: 'pairing_required' });
  if (path === 'state') return json(200, { rev: server.rev, initialized: true, dataId: 'folder0000000001', data: { tasks: [...server.tasks.values()] }, settings: {} });
  if (path === 'ops') {
    for (const o of JSON.parse(opts.body).ops) if (o.op === 'put') server.tasks.set(o.item.id, o.item);
    return json(200, { rev: ++server.rev, applied: 1, rejected: [] });
  }
  if (path === 'events') return new Response(new ReadableStream({ start(c) { opts.signal?.addEventListener('abort', () => { try { c.error(new DOMException('Aborted', 'AbortError')); } catch {} }); } }), { status: 200 });
  return json(404, { error: 'Not found' });
};
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
};

test('an unpaired tab works from its own copy and keeps its changes; once paired it connects and sends them', async () => {
  ls.setItem('ecosys:v1:sync', JSON.stringify({ rev: 1, at: Date.now(), dataId: 'folder0000000001' }));
  ls.setItem('ecosys:v1:seeded', 'user');
  const { db } = await import('../shared/store.js');
  const sync = await import('../shared/sync.js');
  await sync.startSync(); // the stored secret is the wrong one for this server
  assert.ok(await until(() => sync.syncState.status === 'unpaired'), `status ${sync.syncState.status}`);
  assert.equal(ls.getItem('ecosys:v1:pair'), null, 'the refused secret is forgotten');
  const t = db.insert('tasks', { title: 'Written while not connected' });
  assert.equal(sync.syncState.pending, 1, 'kept for later');
  assert.ok(!server.tasks.has(t.id));
  // The pairing link is opened in another tab.
  ls.setItem('ecosys:v1:pair', server.secret);
  storageEvent('ecosys:v1:pair');
  assert.ok(await until(() => sync.syncState.online && sync.syncState.pending === 0), `status ${sync.syncState.status}`);
  assert.ok(server.tasks.has(t.id), 'sent once connected');
  const after = server.seen.slice(server.seen.findLastIndex(([p, h]) => p === 'hello' && h !== server.secret) + 1);
  assert.ok(after.length && after.every(([, h]) => h === server.secret), 'every request since carries the secret, the event stream too');
  assert.ok(after.some(([p]) => p === 'events'));
  window.dispatchEvent(new Event('pagehide'));
});
