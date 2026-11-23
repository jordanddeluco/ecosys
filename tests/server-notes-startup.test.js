// What the server does with notes as it starts (server/validate.mjs, server/core.mjs):
//  - loadValidators loads notes/core/schema.js itself, so note blocks and task.source survive
//    /api/ops, imports and replaces even when server/tools-notes.mjs never loads;
//  - a broken notes module is reported, and the server still starts and validates everything else
//    with shared/sanitize.js (not the structural fallback);
//  - notes whose 30 days in Recently Deleted are up are deleted for good, under the data lock.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCore, purgeNotesTrash } from '../server/core.mjs';
import { loadValidators } from '../server/validate.mjs';
import { DataStore } from '../server/store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (rel) => pathToFileURL(join(ROOT, rel)).href;
const DAY = 86400000;
const silent = { warn() {}, error() {}, info() {}, log() {} };
const made = [];
const tempDir = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

/** Run an ES module script in a fresh Node process; resolves with the JSON it prints last. */
function runChild(source) {
  const dir = tempDir('ecosys-notes-child-');
  const file = join(dir, 'child.mjs');
  writeFileSync(file, source);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [file], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) => {
      const last = out.trim().split('\n').at(-1);
      try {
        resolve({ code, err, result: JSON.parse(last) });
      } catch {
        reject(new Error(`child exited ${code} without a result.\nstdout: ${out}\nstderr: ${err}`));
      }
    });
  });
}

const NOTE = { id: 'n1', title: 'Trip', blocks: [{ id: 'b1', t: 'p', c: [['Pack the tent']] }, { id: 'b2', t: 'check', c: [['Buy gas']] }], createdAt: 1, updatedAt: 1 };
const TASK = { id: 't1', title: 'Buy gas', source: { app: 'notes', noteId: 'n1', blockId: 'b2' }, createdAt: 1, updatedAt: 1 };

// ------------------------------------------------------------------ the notes schema

test('loadValidators registers the notes schema itself: blocks and task.source survive ops, replace and import without the notes tools', async () => {
  const dataDir = tempDir('ecosys-notes-schema-');
  const { code, err, result } = await runChild(`
    import { registerHooks } from 'node:module';
    // Prove the point: server/tools-notes.mjs (which also loads the schema) never loads here.
    registerHooks({
      resolve(spec, ctx, next) {
        const r = next(spec, ctx);
        if (r.url.endsWith('/server/tools-notes.mjs')) throw new Error('server/tools-notes.mjs must not load in this test');
        return r;
      },
    });
    const { loadValidators } = await import(${JSON.stringify(url('server/validate.mjs'))});
    const { DataStore } = await import(${JSON.stringify(url('server/store.mjs'))});
    const errors = [];
    const log = { warn: (m) => errors.push(String(m)), error: (m) => errors.push(String(m)), info() {}, log() {} };
    const v = await loadValidators({ log });
    const note = ${JSON.stringify(NOTE)};
    const task = ${JSON.stringify(TASK)};
    const store = new DataStore({ dir: ${JSON.stringify(join(dataDir, 'a'))}, validators: v, log });
    const put = store.applyOps([{ op: 'put', c: 'notes', item: note }, { op: 'put', c: 'tasks', item: task }]);
    const afterPut = { blocks: store.get('notes', 'n1')?.blocks, source: store.get('tasks', 't1')?.source };
    store.applyOps([{ op: 'replace', c: 'notes', items: [note] }]);
    const afterReplace = store.get('notes', 'n1')?.blocks;
    const fresh = new DataStore({ dir: ${JSON.stringify(join(dataDir, 'b'))}, validators: v, log });
    fresh.importData({ data: { notes: [note], tasks: [task] }, settings: {} });
    const afterImport = { blocks: fresh.get('notes', 'n1')?.blocks, source: fresh.get('tasks', 't1')?.source };
    console.log(JSON.stringify({ notes: v.notes, source: v.source, rejected: put.rejected, afterPut, afterReplace, afterImport, errors }));
  `);
  assert.equal(code, 0, err);
  assert.equal(result.notes, true);
  assert.equal(result.source, 'shared/sanitize.js');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.afterPut.blocks.map((b) => b.id), ['b1', 'b2'], 'a browser put keeps its blocks');
  assert.deepEqual(result.afterPut.source, TASK.source, 'and a task keeps the note it came from');
  assert.deepEqual(result.afterReplace.map((b) => b.id), ['b1', 'b2'], 'a replace keeps them');
  assert.deepEqual(result.afterImport.blocks.map((b) => b.id), ['b1', 'b2'], 'a first-run import keeps them');
  assert.deepEqual(result.afterImport.source, TASK.source);
});

test('a broken notes module is reported and the server still starts, answers and validates with shared/sanitize.js', async () => {
  const dataDir = tempDir('ecosys-notes-broken-');
  const { code, err, result } = await runChild(`
    import { registerHooks } from 'node:module';
    import net from 'node:net';
    import http from 'node:http';
    registerHooks({
      load(u, ctx, next) {
        if (u.endsWith('/notes/core/schema.js')) return { format: 'module', source: 'throw new Error("schema exploded")', shortCircuit: true };
        return next(u, ctx);
      },
    });
    const lines = [];
    const log = { warn: (...a) => lines.push(['warn', a.join(' ')]), error: (...a) => lines.push(['error', a.join(' ')]), info() {}, log() {} };
    const { createCore } = await import(${JSON.stringify(url('server/core.mjs'))});
    const { createEcosysServer } = await import(${JSON.stringify(url('server/http.mjs'))});
    const core = await createCore({ dataDir: ${JSON.stringify(dataDir)}, log });
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const port = s.address().port;
    await new Promise((r) => s.close(r));
    const app = createEcosysServer({ core, port, log });
    await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
    // As a paired browser: the pairing secret the server keeps in its data folder.
    const { readFileSync } = await import('node:fs');
    const secret = JSON.parse(readFileSync(${JSON.stringify(join(dataDir, 'pair.json'))}, 'utf8')).secret;
    const call = (method, path, body) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const rq = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { host: '127.0.0.1:' + port, 'x-ecosys': secret, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(t) }));
      });
      rq.on('error', reject);
      rq.end(data || undefined);
    });
    const hello = await call('GET', '/api/hello');
    const ops = await call('POST', '/api/ops', { client: 'tab1', ops: [{ op: 'put', c: 'notes', item: ${JSON.stringify(NOTE)} }, { op: 'put', c: 'tasks', item: { id: 't2', title: 'Still validated', priority: 'urgent!', createdAt: 1, updatedAt: 1 } }] });
    const client = core.ai.createClient({ kind: 'claude' });
    const tool = core.callTool('create_tasks', { tasks: [{ text: 'Call the venue tomorrow 3pm' }] }, { client });
    const toolNames = core.tools.map((t) => t.name);
    await app.close();
    console.log(JSON.stringify({ notes: core.validators.notes, source: core.validators.source, hello: hello.status, ops, note: core.store.get('notes', 'n1'), task: core.store.get('tasks', 't2'), tool: { isError: tool.isError }, toolNames, lines }));
  `);
  assert.equal(code, 0, err);
  assert.equal(result.notes, false);
  assert.equal(result.source, 'shared/sanitize.js', 'every other record is still validated by the real sanitizer, not the structural fallback');
  const errs = result.lines.filter(([level]) => level === 'error').map(([, t]) => t);
  assert.ok(errs.some((t) => /notes\/core\/schema\.js could not be loaded \(schema exploded\); notes and folders keep only their basic fields/.test(t)), JSON.stringify(result.lines));
  assert.equal(result.hello, 200, 'the server answers');
  assert.equal(result.ops.status, 200);
  assert.equal(result.ops.json.applied, 2);
  assert.equal(result.note.title, 'Trip', 'notes still sync, with their basic fields');
  assert.equal(result.task.priority, 0, 'a task is still cleaned by sanitize.js');
  assert.equal(result.tool.isError, false, 'the core tools work');
  assert.ok(result.toolNames.includes('create_tasks') && !result.toolNames.some((n) => n.startsWith('notes_')), 'only the notes tools are missing');
});

test('in this process too, a core keeps note blocks through every write path', async () => {
  const validators = await loadValidators({ log: silent });
  assert.equal(validators.notes, true);
  const store = new DataStore({ dir: tempDir('ecosys-notes-here-'), validators, log: silent });
  const r = store.applyOps([{ op: 'put', c: 'notes', item: NOTE }]);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(store.get('notes', 'n1').blocks.map((b) => b.id), ['b1', 'b2']);
  assert.equal(validators.op({ op: 'put', c: 'tasks', item: TASK }).op.item.source.blockId, 'b2');
});

// ------------------------------------------------------------------ purging Recently Deleted

/** A data folder whose data.json holds these notes (as a browser would have synced them). */
function dataWith(notes, extra = {}) {
  const dir = tempDir('ecosys-notes-purge-');
  const note = (n) => ({ title: n.id, body: '', folderId: null, pinned: false, tags: [], createdAt: 1, updatedAt: 1, trashedAt: null, ...n });
  writeFileSync(
    join(dir, 'data.json'),
    JSON.stringify({ format: 1, rev: 7, initialized: true, data: { tasks: [{ id: 'tk', title: 'Keep me', createdAt: 1, updatedAt: 1 }], lists: [], events: [], calendars: [], notes: notes.map(note), folders: [{ id: 'f1', name: 'Trips', createdAt: 1, updatedAt: 1 }], ...extra }, settings: { theme: 'dark' } }),
  );
  return dir;
}
const noteIds = (dir) => JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')).data.notes.map((n) => n.id).sort();

test('starting ecosys deletes only notes whose 30 days in Recently Deleted are up', async () => {
  const now = Date.now();
  const dir = dataWith([
    { id: 'old', trashedAt: now - 31 * DAY },
    { id: 'justover', trashedAt: now - 30 * DAY - 60000 },
    { id: 'recent', trashedAt: now - 29 * DAY },
    { id: 'today', trashedAt: now - 60000 },
    { id: 'live', trashedAt: null },
    { id: 'zero', trashedAt: 0 }, // the apps show this note: a trashedAt of 0 is "not deleted"
  ]);
  const lines = [];
  const core = await createCore({ dataDir: dir, log: { ...silent, info: (m) => lines.push(String(m)), error: (m) => lines.push(`ERROR ${m}`) } });
  assert.deepEqual(core.store.all('notes').map((n) => n.id).sort(), ['live', 'recent', 'today', 'zero']);
  assert.deepEqual(noteIds(dir), ['live', 'recent', 'today', 'zero'], 'and data.json says so');
  assert.equal(core.store.rev, 8, 'one write');
  assert.deepEqual(core.store.all('tasks').map((t) => t.id), ['tk'], 'nothing else is touched');
  assert.deepEqual(core.store.all('folders').map((f) => f.id), ['f1']);
  assert.equal(core.store.settings().theme, 'dark');
  assert.deepEqual(lines, ['ecosys: deleted 2 note(s) whose time in Recently Deleted was up']);
  core.close();
  // A second start finds nothing more to do (and does not write).
  const again = await createCore({ dataDir: dir, log: silent });
  assert.equal(again.store.rev, 8);
  again.close();
});

test('the purge reloads under the lock: a note another process restored meanwhile is kept', async () => {
  const dir = dataWith([{ id: 'back', trashedAt: Date.now() - 40 * DAY }, { id: 'gone', trashedAt: Date.now() - 40 * DAY }]);
  const store = new DataStore({ dir, validators: await loadValidators({ log: silent }), log: silent });
  // Another process (a browser tab through the server, or the stdio bridge) restores "back".
  const disk = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'));
  disk.data.notes.find((n) => n.id === 'back').trashedAt = null;
  disk.rev = 8;
  writeFileSync(join(dir, 'data.json'), JSON.stringify(disk));
  assert.equal(store.get('notes', 'back').trashedAt > 0, true, 'this process still has the old copy');
  assert.equal(await purgeNotesTrash(store, silent), 1);
  assert.deepEqual(noteIds(dir), ['back']);
});

test('the purge is never fatal, and does nothing when nothing is in Recently Deleted', async () => {
  const dir = dataWith([{ id: 'old', trashedAt: Date.now() - 40 * DAY }]);
  const errors = [];
  const busy = new DataStore({ dir, validators: await loadValidators({ log: silent }), log: silent, lock: () => { throw Object.assign(new Error('the data lock stayed busy'), { code: 'ELOCKED' }); } });
  assert.equal(await purgeNotesTrash(busy, { ...silent, error: (m) => errors.push(String(m)) }), 0);
  assert.match(errors.join('\n'), /could not empty the notes trash: \[ELOCKED\]/);
  assert.deepEqual(noteIds(dir), ['old'], 'nothing changed');
  // No trashed notes: no lock is taken at all.
  let locked = 0;
  const idle = new DataStore({ dir: dataWith([{ id: 'live' }]), validators: await loadValidators({ log: silent }), log: silent, lock: (fn) => (locked++, fn()) });
  assert.equal(await purgeNotesTrash(idle, silent), 0);
  assert.equal(locked, 0);
});
