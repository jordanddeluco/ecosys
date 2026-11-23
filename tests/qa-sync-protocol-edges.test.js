// QA regression (sync protocol, second pass): one browser tab, shared/sync.js and shared/store.js
// against a real server/store.mjs DataStore behind a fake fetch and event stream.
//   - a letter typed and deleted again before the deferred save changes nothing but updatedAt: the
//     put still says what it started from, so an assistant's rename made meanwhile is kept (it was
//     sent without base/fields and applied whole over the rename)
//   - data.json put back to an older copy while ecosys runs (its rev goes down): the tab reloads it,
//     brings back the tasks the old copy lacks, and keeps getting live changes (the 'snapshot' and the
//     'ops' events below the rev it had loaded were dropped)
//   - an event stream that opens after the first state load (a busy server): a change made in
//     between is still fetched
//   - after a gap in the stream, the server's hello decides: nothing changed, no reload; a change that
//     went by unstreamed while this tab pushed one of its own, a reload (the tab's rev from its own push
//     answer used to hide it)
// Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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
globalThis.location = { hostname: '127.0.0.1' };
const quietWarn = console.warn;
console.warn = () => {};

// ---------------------------------------------------------------- the server
const quiet = { error() {}, warn() {}, info() {}, log() {} };
const { DataStore } = await import('../server/store.mjs');
const { loadValidators } = await import('../server/validate.mjs');
const validators = await loadValidators({ log: quiet });
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-syncp-edges-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
const ds = new DataStore({ dir, validators, log: quiet });
const srv = { streams: new Map(), states: 0, sent: [], streamDelay: 0, hello: false };
const enc = new TextEncoder();
const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const send = (c, event, data) => c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
function broadcast(event, data, except = null) {
  for (const [c, id] of srv.streams) if (id !== except) send(c, event, data);
}
// Like server/http.mjs: a change another process made to data.json is announced a moment later.
ds.onExternalChange = () => setTimeout(() => broadcast('snapshot', { rev: ds.rev, dataId: ds.dataId }), 250);
/** The event stream goes down (a restart): the tab reconnects after a moment. */
function dropStreams() {
  for (const c of srv.streams.keys()) {
    try {
      c.error(new Error('the server went away'));
    } catch {}
  }
  srv.streams.clear();
}
/** An assistant's change over MCP: written by the server, streamed to the browser (unless `stream` is false). */
function aiWrite(fn, { stream = true } = {}) {
  const { ops, rev } = ds.transaction(fn);
  if (stream && ops.length) broadcast('ops', { rev, origin: 'ai:claude1', ops });
  return { ops, rev };
}
const aiTask = (id, title) => aiWrite((tx) => tx.put('tasks', { id, title, notes: '', done: false, priority: 0, createdAt: Date.now(), updatedAt: Date.now() }));
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url), 'http://127.0.0.1');
  const path = u.pathname.replace(/^.*\/api\//, '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (path === 'hello') return json(200, { ok: true, app: 'ecosys', version: 'test', features: ['sync', 'mcp'] });
  if (path === 'state') {
    srv.states++;
    return json(200, ds.snapshotJSON());
  }
  if (path === 'import') {
    try {
      return json(200, ds.importData(body));
    } catch (err) {
      return json(err.status || 500, { error: err.message });
    }
  }
  if (path === 'ops') {
    srv.sent.push(...body.ops);
    const out = ds.applyOps(body.ops);
    if (out.applied.length) broadcast('ops', { rev: out.rev, origin: body.client, ops: out.applied }, body.client);
    return json(200, { rev: out.rev, applied: out.applied.length, rejected: out.rejected });
  }
  if (path === 'events') {
    if (srv.streamDelay) await new Promise((r) => setTimeout(r, srv.streamDelay)); // a busy server
    const client = u.searchParams.get('client');
    const stream = new ReadableStream({
      start(c) {
        srv.streams.set(c, client);
        if (srv.hello) send(c, 'hello', { rev: ds.rev, dataId: ds.dataId });
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
const until = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(10);
  }
  return true;
};

const { db, registerSeeder, seedIfEmpty } = await import('../shared/store.js');
registerSeeder(() => {});
seedIfEmpty();
let page = null;
let pageNo = 0;
const idle = () => until(() => page.syncState.online && page.syncState.pending === 0 && srv.streams.size > 0);
/** Close the page (if one is open) and open the next one: a reload. */
async function reload({ wait = true } = {}) {
  window.dispatchEvent(new Event('pagehide'));
  await sleep(30);
  page = await import(`../shared/sync.js?page=${++pageNo}`);
  const started = page.startSync();
  if (wait) {
    await started;
    assert.ok(await idle(), `status ${page.syncState.status}: ${page.syncState.lastError}`);
  }
  return started;
}

test('a letter typed and deleted again before the save: an assistant’s rename made meanwhile is kept', async () => {
  await reload();
  const t = db.insert('tasks', { title: 'Call the bank', notes: 'ask about fees' });
  assert.ok(await idle());
  // The assistant renames it; its event is still on its way.
  const late = aiWrite((tx) => tx.put('tasks', { ...tx.get('tasks', t.id), title: 'Call the bank before Friday', updatedAt: Date.now() }), { stream: false });
  db.update('tasks', t.id, { notes: 'ask about fees!' }, { defer: true });
  db.update('tasks', t.id, { notes: 'ask about fees' }, { defer: true });
  db.flush();
  assert.ok(await until(() => srv.sent.some((o) => o.item?.id === t.id && o.item.title === 'Call the bank' && o.item.updatedAt > t.updatedAt)), 'the edit was sent');
  await idle();
  const op = srv.sent.findLast((o) => o.item?.id === t.id);
  assert.ok('base' in op && Array.isArray(op.fields), 'it says what it started from');
  assert.deepEqual(op.fields, [], 'and that it changed nothing');
  assert.equal(ds.get('tasks', t.id).title, 'Call the bank before Friday', 'the rename is kept on the server');
  assert.ok(await until(() => db.get('tasks', t.id).title === 'Call the bank before Friday'), 'and in the tab');
  broadcast('ops', { rev: late.rev, origin: 'ai:claude1', ops: late.ops });
  await sleep(150);
  assert.equal(db.get('tasks', t.id).title, 'Call the bank before Friday');
  assert.equal(db.get('tasks', t.id).notes, 'ask about fees');
});

test('data.json put back to an older copy while ecosys runs: the tab takes it, brings back what it lost, and keeps getting live changes', async () => {
  for (let i = 0; i < 3; i++) db.insert('tasks', { title: `Early ${i}` });
  assert.ok(await idle());
  const older = readFileSync(join(dir, 'data.json'), 'utf8');
  const olderRev = ds.rev;
  for (let i = 0; i < 5; i++) {
    db.insert('tasks', { title: `Later ${i}` });
    assert.ok(await idle());
  }
  await reload(); // the tab now holds a state newer than the old copy
  assert.ok(page.syncState.rev > olderRev);
  writeFileSync(join(dir, 'data.json'), older); // a sync or backup tool restores the old copy
  aiTask('aaaaaaaaaaaa0001', 'Made by the assistant after the restore');
  assert.ok(await until(() => !!db.get('tasks', 'aaaaaaaaaaaa0001')), 'the tab gets the change made after the restore');
  assert.ok(await until(() => ds.all('tasks').filter((t) => t.title.startsWith('Later')).length === 5), 'the tasks the old copy lacked go back to the folder');
  assert.ok(await idle());
  aiTask('aaaaaaaaaaaa0002', 'Second assistant task');
  assert.ok(await until(() => !!db.get('tasks', 'aaaaaaaaaaaa0002')), 'and the next live change too');
});

test('a stream that opens after the first state load: a change made in between is still fetched', async () => {
  srv.streamDelay = 3500;
  const states = srv.states;
  const started = reload({ wait: false });
  assert.ok(await until(() => srv.states > states, 8000), 'the state is loaded without waiting for the stream');
  await sleep(50);
  aiTask('aaaaaaaaaaaa0009', 'Assistant task while the stream was opening'); // streamed to nobody
  await started;
  assert.ok(await until(() => srv.streams.size > 0, 8000), 'the stream opens');
  assert.ok(await until(() => !!db.get('tasks', 'aaaaaaaaaaaa0009'), 3000), 'the change made before it opened is fetched');
  srv.streamDelay = 0;
  assert.ok(await idle());
});

test('after a gap in the stream the server’s hello decides: nothing changed, no reload; a change went by while this tab pushed, a reload', async () => {
  srv.hello = true;
  await reload();
  // A restart that changed nothing: no reload.
  let states = srv.states;
  dropStreams();
  assert.ok(await until(() => page.syncState.status === 'offline'));
  assert.ok(await until(() => srv.streams.size > 0 && page.syncState.online), 'it reconnects');
  await sleep(600);
  assert.equal(srv.states, states, 'no GET /api/state: the hello shows nothing changed');
  // While the stream is down an assistant writes (not streamed), then this tab sends a change.
  dropStreams();
  assert.ok(await until(() => page.syncState.status === 'offline'));
  states = srv.states;
  aiTask('aaaaaaaaaaaa0010', 'Assistant task while the stream was down');
  const mine = db.insert('tasks', { title: 'Typed while the stream was down' });
  assert.ok(await until(() => !!ds.get('tasks', mine.id)), 'this tab’s change reached the server');
  assert.ok(await until(() => !!db.get('tasks', 'aaaaaaaaaaaa0010')), 'the assistant’s change, never streamed to this tab, is fetched');
  assert.equal(srv.states, states + 1, 'with one GET /api/state');
  srv.hello = false;
});

test('teardown', async () => {
  window.dispatchEvent(new Event('pagehide'));
  await sleep(20);
  console.warn = quietWarn;
});
