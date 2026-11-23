// shared/sync.js with two tabs: one holds the event stream (Web Locks), the other gets changes and AI
// events over a BroadcastChannel. The server sends the AI status only to a stream that just connected,
// so a tab that opens later must get it from the tab holding the stream. Run with: npm test
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
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => new MemoryStorage() });
const { locks } = globalThis.navigator; // Node has Web Locks and BroadcastChannel, like a browser
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', userAgent: 'node', locks } });
globalThis.location = { hostname: '127.0.0.1' };
ls.setItem('ecosys:v1:sync', JSON.stringify({ rev: 1, at: Date.now() }));

const STATUS = { type: 'status', mode: 'read', clients: [{ id: 'k1', kind: 'chatgpt', label: 'ChatGPT', access: 'read', connected: true, lastSeen: 1 }] };
let streams = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace(/^.*\/api\//, '').replace(/\?.*$/, '');
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', features: ['sync'] });
  if (path === 'state') return json(200, { rev: 1, initialized: true, data: {}, settings: {} });
  if (path === 'events') {
    streams++;
    const stream = new ReadableStream({
      start(c) {
        // like server/http.mjs: the AI status goes to the stream that just connected, and only to it
        c.enqueue(new TextEncoder().encode(`event: ai\ndata: ${JSON.stringify(STATUS)}\n\n`));
        opts.signal?.addEventListener('abort', () => {
          try {
            c.error(new DOMException('Aborted', 'AbortError'));
          } catch {}
        });
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  return json(404, {});
};
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const skip = !locks || typeof BroadcastChannel !== 'function' ? 'needs Web Locks and BroadcastChannel (Node 24+)' : false;

test('a tab that opens later gets the AI status from the tab holding the stream', { skip }, async () => {
  const a = await import('../shared/sync.js?tab=a');
  await a.startSync();
  await until(() => a.syncState.leader && a.syncState.ai);
  assert.deepEqual(a.syncState.ai, { mode: 'read', clients: STATUS.clients });

  const seen = [];
  window.addEventListener('ecosys:ai', (e) => seen.push(e.detail));
  const b = await import('../shared/sync.js?tab=b');
  await b.startSync();
  await until(() => b.syncState.ai);
  assert.equal(b.syncState.leader, false);
  assert.equal(streams, 1, 'still one stream for the whole browser');
  assert.deepEqual(b.syncState.ai, { mode: 'read', clients: STATUS.clients });
  assert.ok(seen.some((d) => d.type === 'status' && d.mode === 'read'), 'and an ecosys:ai event in that tab');
  window.dispatchEvent(new Event('pagehide')); // both tabs: release the lock, close the channels
});
