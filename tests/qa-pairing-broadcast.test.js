// QA (pairing key, perf finding): a change reaches the other tabs as soon as it is made in memory, not
// after the data file is written (190-290 ms with a large library). server/http.mjs passes the store a
// `beforeSave` callback and broadcasts from it; the writer is still answered only once the change is
// saved. A save that fails after the tabs were told is followed by a snapshot at the rev the store went
// back to, which makes every tab reload (shared/sync.js reloads on a snapshot below its own rev).
// The store's side is stood in for here (it calls beforeSave, then takes its time to "save").
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { createEcosysServer } from '../server/http.mjs';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const made = [];
const apps = [];
after(async () => {
  for (const a of apps) await a.close();
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ecosys-qa-bcast-'));
  made.push(dataDir);
  const core = await createCore({ dataDir, log: silent });
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  const app = createEcosysServer({ core, port, log: silent });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  apps.push(app);
  const secret = JSON.parse(readFileSync(join(dataDir, 'pair.json'), 'utf8')).secret;
  return { core, app, port, secret };
}

function post(s, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port: s.port, method: 'POST', path, agent: false, headers: { host: `127.0.0.1:${s.port}`, 'x-ecosys': s.secret, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(t || 'null') }));
      },
    );
    r.on('error', reject);
    r.end(data);
  });
}

/** A paired tab's event stream. */
function tab(s, client) {
  const events = [];
  const req = http.get({ host: '127.0.0.1', port: s.port, path: `/api/events?client=${client}`, agent: false, headers: { host: `127.0.0.1:${s.port}`, 'x-ecosys': s.secret } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        if (ev) events.push({ event: ev, data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) });
      }
    });
  });
  req.on('error', () => {});
  const wait = async (pred, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no such event; got ${JSON.stringify(events.map((e) => e.event))}`);
  };
  return { events, wait, close: () => req.destroy() };
}

const task = (id, title) => ({ op: 'put', c: 'tasks', item: { id, title, createdAt: 1, updatedAt: Date.now() } });
const spin = (ms) => {
  const t = performance.now();
  while (performance.now() - t < ms);
};

/** Record every broadcast with the moment it was made. */
function spyHub(app) {
  const calls = [];
  const real = app.hub.broadcast.bind(app.hub);
  app.hub.broadcast = (event, data, opts) => {
    calls.push({ event, data, at: performance.now() });
    return real(event, data, opts);
  };
  return calls;
}

test('POST /api/ops tells the other tabs from beforeSave, before a slow save finishes, and only once', async () => {
  const s = await start();
  const b = tab(s, 'tabB');
  try {
    await b.wait((e) => e.event === 'ai');
    const calls = spyHub(s.app);
    const real = s.core.store.applyOps.bind(s.core.store);
    let savedAt = 0;
    let seen = null;
    s.core.store.applyOps = (ops, opts) => {
      seen = opts;
      const out = real(ops); // made in memory (and here already written: the slow part is stood in for below)
      opts?.beforeSave?.(out);
      spin(150); // writing a large library
      savedAt = performance.now();
      return out;
    };
    const r = await post(s, '/api/ops', { client: 'tabA', ops: [task('bc1', 'Told early')] });
    assert.equal(r.status, 200);
    assert.equal(typeof seen?.beforeSave, 'function', 'the store is offered beforeSave');
    const told = calls.filter((c) => c.event === 'ops');
    assert.equal(told.length, 1, 'told once, not again after the save');
    assert.ok(told[0].at < savedAt, 'the tabs were told before the save finished');
    assert.equal(told[0].data.origin, 'tabA');
    assert.equal(told[0].data.rev, r.json.rev);
    const got = await b.wait((e) => e.event === 'ops');
    assert.equal(got.data.ops[0].item.title, 'Told early');
  } finally {
    b.close();
  }
});

test('a store without beforeSave (or a change that applies nothing) is told after the save, as before', async () => {
  const s = await start();
  const calls = spyHub(s.app);
  const r = await post(s, '/api/ops', { client: 'tabA', ops: [task('bc2', 'Told after')] });
  assert.equal(r.status, 200);
  assert.equal(calls.filter((c) => c.event === 'ops').length, 1);
  const none = await post(s, '/api/ops', { client: 'tabA', ops: [] });
  assert.equal(none.status, 200);
  assert.equal(calls.filter((c) => c.event === 'ops').length, 1, 'nothing applied: nothing told');
});

test('a save that fails after the tabs were told: the writer gets an error and every tab is told to reload', async () => {
  const s = await start();
  const b = tab(s, 'tabB');
  try {
    await b.wait((e) => e.event === 'ai');
    const rev = s.core.store.rev;
    const calls = spyHub(s.app);
    s.core.store.applyOps = (ops, opts) => {
      opts?.beforeSave?.({ rev: rev + 1, applied: [task('bc3', 'Never saved')], rejected: [] });
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); // memory is put back
    };
    const r = await post(s, '/api/ops', { client: 'tabA', ops: [task('bc3', 'Never saved')] });
    assert.ok(r.status >= 500, `the writer is told it failed (${r.status})`);
    assert.deepEqual(calls.map((c) => c.event), ['ops', 'snapshot']);
    assert.equal(calls[1].data.rev, rev, 'the snapshot is at the rev the store went back to');
    const snap = await b.wait((e) => e.event === 'snapshot');
    assert.ok(snap.data.rev < b.events.find((e) => e.event === 'ops').data.rev, 'below the rev the tab was told: shared/sync.js reloads');
  } finally {
    b.close();
  }
});

test('core.emit("snapshot") (an AI change told early whose save failed) makes every tab reload', async () => {
  const s = await start();
  const b = tab(s, 'tabB');
  try {
    await b.wait((e) => e.event === 'ai');
    s.core.emit('snapshot', {});
    const snap = await b.wait((e) => e.event === 'snapshot');
    assert.equal(snap.data.rev, s.core.store.rev);
  } finally {
    b.close();
  }
});
