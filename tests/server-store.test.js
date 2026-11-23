// Data store, AI credential store and validation (server/store.mjs, server/ai-store.mjs, server/validate.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStore, ConflictError } from '../server/store.mjs';
import { AIStore } from '../server/ai-store.mjs';
import { loadValidators, createValidators } from '../server/validate.mjs';
import { safeEqual, isId, safeParse } from '../server/util.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ecosys-store-'));
const validators = await loadValidators({ log: { warn() {} } });
const task = (id, extra = {}) => ({ id, title: `Task ${id}`, notes: '', listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null, checklist: [], done: false, completedAt: null, order: 1, createdAt: 1, updatedAt: 1, ...extra });

test('validators come from shared/sanitize.js', () => {
  assert.equal(validators.source, 'shared/sanitize.js');
});

test('a new store starts empty and uninitialized; writes are atomic JSON', () => {
  const dir = tmp();
  const s = new DataStore({ dir, validators });
  assert.equal(s.rev, 0);
  assert.equal(s.initialized, false);
  const r = s.applyOps([{ op: 'put', c: 'tasks', item: task('a1') }]);
  assert.equal(r.rev, 1);
  assert.equal(r.applied.length, 1);
  const disk = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'));
  assert.equal(disk.format, 1);
  assert.equal(disk.rev, 1);
  assert.equal(disk.data.tasks[0].id, 'a1');
  assert.deepEqual(Object.keys(disk.data).sort(), ['calendars', 'events', 'folders', 'lists', 'notes', 'tasks']);
  assert.ok(!readdirSync(dir).some((n) => n.endsWith('.tmp')), 'no temp files left behind');
});

test('ops are validated one by one; bad ones are reported, good ones applied', () => {
  const s = new DataStore({ dir: tmp(), validators });
  const r = s.applyOps([
    { op: 'put', c: 'tasks', item: task('ok1') },
    { op: 'put', c: 'secrets', item: task('x') },
    { op: 'put', c: 'tasks', item: { ...task('bad id!') } },
    { op: 'del', c: 'tasks', id: '../../etc' },
    { op: 'nuke' },
    'nope',
    { op: 'settings', patch: { theme: 'dark', evil: '<script>' } },
  ]);
  assert.equal(r.applied.length, 2);
  assert.deepEqual(r.rejected.map((x) => x.index), [1, 2, 3, 4, 5]);
  assert.equal(s.settings().theme, 'dark');
  assert.equal(s.settings().evil, undefined);
  assert.throws(() => s.applyOps('nope'), /array/);
});

test('prototype pollution keys never survive', () => {
  const s = new DataStore({ dir: tmp(), validators });
  const evil = safeParse('{"op":"put","c":"tasks","item":{"id":"p1","title":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}');
  s.applyOps([evil]);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const stored = s.get('tasks', 'p1');
  assert.ok(stored);
  assert.ok(!Object.prototype.hasOwnProperty.call(stored, '__proto__'));
  assert.ok(!Object.prototype.hasOwnProperty.call(stored, 'constructor'));
});

test('replace swaps a whole collection and keeps a backup of the old one', () => {
  const dir = tmp();
  const s = new DataStore({ dir, validators });
  s.applyOps([{ op: 'put', c: 'tasks', item: task('old') }]);
  s.applyOps([{ op: 'replace', c: 'tasks', items: [task('n1'), task('n2'), { junk: true }, task('n1')] }]);
  assert.deepEqual(s.all('tasks').map((t) => t.id), ['n1', 'n2']);
  const backups = readdirSync(join(dir, 'backups'));
  assert.ok(backups.some((n) => n.includes('before-replace-tasks')));
});

test('import: only while uninitialized; keeps items written before it (e.g. by an AI)', () => {
  const dir = tmp();
  const s = new DataStore({ dir, validators });
  s.applyOps([{ op: 'put', c: 'tasks', item: task('ai1') }]);
  const r = s.importData({ data: { tasks: [task('b1'), task('b2'), { id: 'bad id' }], lists: [] }, settings: { theme: 'dim', nope: 1 } });
  assert.equal(r.dropped, 1);
  assert.equal(s.initialized, true);
  assert.deepEqual(s.all('tasks').map((t) => t.id).sort(), ['ai1', 'b1', 'b2']);
  assert.equal(s.settings().theme, 'dim');
  assert.equal(s.settings().nope, undefined);
  assert.throws(() => s.importData({ data: { tasks: [] } }), ConflictError);
  assert.ok(readdirSync(join(dir, 'backups')).some((n) => n.includes('rejected-import')), 'a rejected import is kept as a backup');
  assert.throws(() => s.importData({ nothing: true }), /data/);
});

test('external writes (another process) are detected and reloaded', async () => {
  const dir = tmp();
  const a = new DataStore({ dir, validators });
  const b = new DataStore({ dir, validators });
  let seen = null;
  a.onExternalChange = (rev) => (seen = rev);
  b.applyOps([{ op: 'put', c: 'tasks', item: task('fromB') }]);
  assert.equal(a.refresh(), true);
  assert.equal(seen, 1);
  assert.ok(a.get('tasks', 'fromB'));
  assert.equal(a.refresh(), false, 'no change, no reload');
  // A read-modify-write in A must keep B's item (no lost update).
  a.applyOps([{ op: 'put', c: 'tasks', item: task('fromA') }]);
  b.refresh();
  assert.ok(b.get('tasks', 'fromA') && b.get('tasks', 'fromB'));
  assert.equal(b.rev, 2);
});

test('transactions record before/after, compress repeated edits and roll back on error', () => {
  const s = new DataStore({ dir: tmp(), validators });
  s.applyOps([{ op: 'put', c: 'tasks', item: task('t1') }]);
  const { changes, ops, rev } = s.transaction((tx) => {
    tx.put('tasks', { ...tx.get('tasks', 't1'), title: 'one' });
    tx.put('tasks', { ...tx.get('tasks', 't1'), title: 'two' });
    tx.put('tasks', task('t2'));
    tx.del('tasks', 't2');
  });
  assert.equal(rev, 2);
  assert.equal(changes.length, 1, 't2 was created and deleted: no net change');
  assert.equal(changes[0].before.title, 'Task t1');
  assert.equal(changes[0].after.title, 'two');
  assert.equal(ops[0].op, 'put');
  assert.throws(() =>
    s.transaction((tx) => {
      tx.put('tasks', { ...tx.get('tasks', 't1'), title: 'three' });
      throw new Error('boom');
    }),
  );
  assert.equal(s.get('tasks', 't1').title, 'two');
  assert.equal(s.rev, 2, 'a failed transaction does not bump the revision');
  assert.throws(() => s.transaction((tx) => tx.put('tasks', { id: 'no good id', title: 'x' })), /invalid/);
});

test('a corrupt data.json stops the start and is left as it is (never taken for empty)', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'data.json'), '{ not json');
  assert.throws(() => new DataStore({ dir, validators, log: { error() {} }, startWaitMs: 0 }), (err) => err.name === 'DataFileError' && /not valid JSON/.test(err.message));
  assert.equal(readFileSync(join(dir, 'data.json'), 'utf8'), '{ not json');
  assert.ok(!readdirSync(dir).some((n) => n.startsWith('data.json.corrupt-')));
});

test('fallback validator (when sanitize.js is missing) is strict', () => {
  const v = createValidators(null);
  assert.equal(v.source, 'fallback');
  assert.equal(v.item('tasks', { id: 'ok', title: 'x', deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } }).deep.a.b.c.d.e, undefined);
  assert.equal(v.item('notes', { id: 'n1', body: '<img src=x onerror=alert(1)>' }), null, 'no notes without the HTML sanitizer');
  assert.equal(v.item('tasks', { id: 'bad id' }), null);
  assert.deepEqual(v.settings({ theme: 'dark', weekStart: 9, x: 1 }), { theme: 'dark' });
});

test('AI store: credentials, tokens, modes, activity and undo history', () => {
  const dir = tmp();
  const ai = new AIStore({ dir });
  assert.equal(ai.mode(), 'write');
  const c = ai.createClient({ kind: 'claude' });
  assert.ok(isId(c.id));
  assert.match(c.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(c.label, 'Claude');
  assert.equal(ai.createClient({ kind: 'claude', access: 'read' }).label, 'Claude 2');
  assert.equal(ai.byToken(c.token)?.id, c.id);
  assert.equal(ai.byToken(c.token.slice(0, -1) + (c.token.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(ai.byToken('short'), null);
  assert.throws(() => ai.createClient({ kind: 'skynet' }), /kind/);
  assert.throws(() => ai.setMode('god'), /mode/);
  ai.setMode('read');
  assert.equal(new AIStore({ dir }).mode(), 'read', 'persisted');
  const old = c.token;
  const rotated = ai.updateClient(c.id, { rotate: true, access: 'read' });
  assert.notEqual(rotated.token, old);
  assert.equal(ai.byToken(old), null);
  assert.equal(rotated.access, 'read');
  assert.equal(ai.touch(c.id, { clientName: 'claude-ai 0.1.0', handshake: true }), true, 'first request = connected');
  assert.equal(ai.touch(c.id, {}), false, 'not again right away');
  assert.equal(ai.statusClients().find((x) => x.id === c.id).connected, true);
  for (let i = 0; i < 205; i++) ai.addActivity({ client: c, tool: 'get_overview', summary: `n${i}` });
  assert.equal(ai.state.activity.length, 200);
  const ch = ai.addChange({ client: c, tool: 'create_tasks', summary: 's', before: [], after: [] });
  assert.match(ch.changeId, /^chg_/);
  ai.addChange({ client: c, tool: 'undo_change', summary: 'u', before: [], after: [], undoOf: ch.changeId });
  assert.ok(ai.change(ch.changeId).undoneBy);
  ai.deleteClient(c.id);
  assert.equal(ai.byToken(rotated.token), null);
  assert.throws(() => ai.deleteClient(c.id), /no such/);
});

test('AI store reports changes written by another process', () => {
  const dir = tmp();
  const server = new AIStore({ dir });
  const c = server.createClient({ kind: 'grok' });
  const bridge = new AIStore({ dir });
  let got = null;
  server.onExternal = (r) => (got = r);
  bridge.touch(c.id, { clientName: 'grok-cli', handshake: true });
  bridge.addActivity({ client: bridge.get(c.id), tool: 'find_tasks', summary: 'Searched tasks' });
  server.refresh();
  assert.ok(got);
  assert.equal(got.activity.length, 1);
  assert.equal(got.connected[0].id, c.id);
});

const undoItem = (n) => ({ c: 'tasks', id: `t${n}`, item: task(`t${n}`, { notes: 'x'.repeat(1000) }) });
const readAi = (dir) => JSON.parse(readFileSync(join(dir, 'ai.json'), 'utf8'));

test('AI store: undo data goes to changes/<id>.json; too big or too old loses it, newest first', () => {
  const dir = tmp();
  const ai = new AIStore({ dir, maxUndoBytes: 4000, undoBudget: 12000 });
  const c = ai.createClient({ kind: 'claude' });
  const a = ai.addChange({ client: c, tool: 'create_tasks', summary: 'a', before: [{ c: 'tasks', id: 't1', item: null }], after: [undoItem(1)] });
  assert.equal(a.undoable, true);
  assert.equal(a.entry.changeId, a.changeId, 'its activity entry links to it');
  const file = join(dir, 'changes', `${a.changeId}.json`);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).after, [undoItem(1)]);
  assert.deepEqual(ai.changePayload(ai.change(a.changeId)).after, [undoItem(1)]);
  const disk = readAi(dir);
  assert.equal(disk.changes[0].after, undefined, 'ai.json keeps only the summary');
  assert.equal(disk.changes[0].undoable, true);
  assert.equal(disk.activity.at(-1).changeId, a.changeId, 'saved together with its activity entry');
  // Too big: listed, but no undo file and no Undo in the activity list.
  const big = ai.addChange({ client: c, tool: 'create_tasks', summary: 'big', before: [], after: [undoItem(2), undoItem(3), undoItem(4), undoItem(5)] });
  assert.equal(big.undoable, false);
  assert.equal(big.entry.changeId, null);
  assert.ok(!existsSync(join(dir, 'changes', `${big.changeId}.json`)));
  assert.equal(ai.changePayload(ai.change(big.changeId)), null);
  // Over the budget the oldest changes lose their undo data (and files) first.
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(ai.addChange({ client: c, tool: 't', summary: `n${i}`, before: [], after: [undoItem(10 + i)] }).changeId);
  const kept = ids.filter((id) => ai.change(id).undoable);
  assert.ok(kept.length >= 5 && kept.length < 12, `kept ${kept.length}`);
  assert.deepEqual(kept, ids.slice(-kept.length), 'the newest keep theirs');
  assert.equal(ai.change(a.changeId).undoable, false);
  assert.ok(!existsSync(file), 'expired undo files are deleted');
  const files = readdirSync(join(dir, 'changes'));
  assert.deepEqual(files.sort(), kept.map((id) => `${id}.json`).sort());
  // A tampered id never turns into a path outside changes/.
  assert.equal(ai.changeFile('../ai'), null);
  assert.equal(ai.changePayload({ changeId: '../../x', undoable: true }), null);
});

test('AI store: at most 200 change summaries, and their undo files go with them', () => {
  const dir = tmp();
  const ai = new AIStore({ dir });
  const first = ai.addChange({ client: null, tool: 't', summary: 'first', before: [], after: [] });
  for (let i = 0; i < 200; i++) ai.addChange({ client: null, tool: 't', summary: `m${i}`, before: [], after: [] });
  assert.equal(ai.state.changes.length, 200);
  assert.equal(ai.change(first.changeId), null);
  const files = readdirSync(join(dir, 'changes'));
  assert.equal(files.length, 200);
  assert.ok(!files.includes(`${first.changeId}.json`));
  assert.ok(readFileSync(join(dir, 'ai.json')).length < 200 * 1024, 'ai.json stays small');
});

test('AI store: undo data an older version kept inside ai.json moves out on the next save', () => {
  const dir = tmp();
  const legacy = {
    changeId: 'chg_legacy0000001',
    at: 1,
    clientId: null,
    kind: 'claude',
    label: 'Claude',
    tool: 'create_tasks',
    summary: 'old',
    before: [{ c: 'tasks', id: 'a1', item: null }],
    after: [{ c: 'tasks', id: 'a1', item: task('a1') }],
    undoOf: null,
    undoneBy: null,
  };
  writeFileSync(join(dir, 'ai.json'), JSON.stringify({ mode: 'write', clients: [], activity: [], changes: [legacy] }));
  const ai = new AIStore({ dir });
  assert.deepEqual(ai.changePayload(ai.change(legacy.changeId)).after, legacy.after, 'usable before it moves');
  ai.setMode('read'); // any save
  const rec = readAi(dir).changes[0];
  assert.equal(rec.before, undefined);
  assert.equal(rec.after, undefined);
  assert.equal(rec.undoable, true);
  assert.ok(rec.bytes > 0);
  assert.deepEqual(new AIStore({ dir }).changePayload(rec).after, legacy.after, 'and after');
});

test('AI store: undo files that no summary points to are removed on start', () => {
  const dir = tmp();
  const keep = new AIStore({ dir }).addChange({ client: null, tool: 't', summary: 's', before: [], after: [] });
  mkdirSync(join(dir, 'changes'), { recursive: true });
  writeFileSync(join(dir, 'changes', 'chg_orphan00000001.json'), '{}');
  writeFileSync(join(dir, 'changes', 'readme.txt'), 'not ours');
  new AIStore({ dir });
  assert.deepEqual(readdirSync(join(dir, 'changes')).sort(), [`${keep.changeId}.json`, 'readme.txt']);
});

test('AI store: read activity is saved lazily, in time order, and never lost on a write or flush', () => {
  const dir = tmp();
  const ai = new AIStore({ dir });
  const c = ai.createClient({ kind: 'claude' });
  const before = readFileSync(join(dir, 'ai.json'), 'utf8');
  const r1 = ai.addActivity({ client: c, tool: 'find_tasks', summary: 'Searched' }, { defer: true });
  assert.equal(readFileSync(join(dir, 'ai.json'), 'utf8'), before, 'a read does not rewrite ai.json');
  assert.equal(ai.recentActivity(1)[0].id, r1.id, 'but is listed at once');
  // Another process sees it only once it is saved; a write takes it along, oldest first.
  const other = new AIStore({ dir });
  let seen = null;
  other.onExternal = (x) => (seen = x);
  other.refresh();
  assert.equal(seen, null);
  const w = ai.addActivity({ client: c, tool: 'create_tasks', summary: 'Added' });
  assert.deepEqual(readAi(dir).activity.map((x) => x.id), [r1.id, w.id]);
  other.refresh();
  assert.deepEqual(seen.activity.map((x) => x.id), [r1.id, w.id]);
  const r2 = ai.addActivity({ client: c, tool: 'get_task', summary: 'Opened' }, { defer: true });
  ai.flush();
  assert.equal(readAi(dir).activity.at(-1).id, r2.id, 'flush saves it');
  ai.flush(); // nothing pending: no-op
  assert.deepEqual(ai.recentActivity(3).map((x) => x.id), [r2.id, w.id, r1.id]);
});

test('safeEqual and safeParse', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual(null, 'x'), false);
  const o = safeParse('{"a":1,"__proto__":{"x":1},"b":{"constructor":{"prototype":{"y":1}}}}');
  assert.deepEqual(Object.keys(o), ['a', 'b']);
  assert.deepEqual(Object.keys(o.b), []);
});

test('cleanup', () => {
  // temp dirs live under the OS temp folder; nothing to assert, keep the suite tidy on CI
  for (const n of readdirSync(tmpdir())) if (n.startsWith('ecosys-store-')) try { rmSync(join(tmpdir(), n), { recursive: true, force: true }); } catch {}
  assert.ok(!existsSync(join(tmpdir(), 'ecosys-store-does-not-exist')));
});
