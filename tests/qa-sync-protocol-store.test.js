// QA regression (sync protocol, server side): server/store.mjs never loses an edit and never takes an
// unreadable data.json for an empty one.
//   - a browser's put that says what it started from (base, fields, was) is applied whole when the
//     record is still that version, and only its fields are merged into a newer copy otherwise; a
//     field both sides changed goes to the newer write, and note blocks are merged block by block
//   - a record deleted after the version a browser started from stays deleted (also after Erase
//     everything), while a record the folder never had is created, and a delete loses to a later edit
//   - an op that changes nothing is not saved and does not move the rev; a failed save puts memory
//     back as it was
//   - data.json that can't be read at start stops the start (left as it is); while running, a busy
//     or corrupt file keeps the copy in memory, and a write waits, refuses, or keeps a copy first
//   - the write id catches a same-size write by another process; the data folder keeps one id, also
//     for a file written before ids existed
// Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStore, DataFileError, baseOf, valueHash } from '../server/store.mjs';
import { loadValidators } from '../server/validate.mjs';

const quiet = { error() {}, warn() {}, info() {}, log() {} };
const validators = await loadValidators({ log: quiet });
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ecosys-qa-sync-'));
  dirs.push(d);
  return d;
};
const T0 = 1795400000000;
const task = (id, extra = {}) => ({ id, title: `Task ${id}`, notes: '', done: false, priority: 0, createdAt: T0, updatedAt: T0, ...extra });
const store = (dir = tmp(), opts = {}) => new DataStore({ dir, validators, log: quiet, ...opts });
/** A browser's put: `prev` is the copy it started from, `next` what it has now. */
const edit = (c, prev, next) => {
  const fields = Object.keys(next).filter((k) => !['id', 'createdAt', 'updatedAt'].includes(k) && JSON.stringify(prev?.[k]) !== JSON.stringify(next[k]));
  return { op: 'put', c, item: next, base: prev ? prev.updatedAt : null, fields, was: Object.fromEntries(fields.map((f) => [f, baseOf(prev?.[f])])) };
};

test('a put from the version the record still has is applied whole', () => {
  const s = store();
  s.applyOps([{ op: 'put', c: 'tasks', item: task('aaaa000000000001') }]);
  const prev = s.get('tasks', 'aaaa000000000001');
  const out = s.applyOps([edit('tasks', prev, { ...prev, title: 'Renamed', updatedAt: T0 + 10 })]);
  assert.deepEqual(out.rejected, []);
  assert.equal(s.get('tasks', 'aaaa000000000001').title, 'Renamed');
  assert.equal(s.get('tasks', 'aaaa000000000001').updatedAt, T0 + 10, 'stored as sent');
});

test('an edit made on an older version only changes its own fields; the newer change stays', () => {
  const s = store();
  s.applyOps([{ op: 'put', c: 'tasks', item: task('aaaa000000000002') }]);
  const seen = s.get('tasks', 'aaaa000000000002');
  // Meanwhile an assistant completes it (a newer write).
  s.transaction((tx) => tx.put('tasks', { ...tx.get('tasks', 'aaaa000000000002'), done: true, completedAt: T0 + 50, updatedAt: T0 + 50 }));
  const rev = s.rev;
  // The browser's edit of the notes, from the version it saw (an offline edit, older than the completion).
  const out = s.applyOps([edit('tasks', seen, { ...seen, notes: 'Bring the form', updatedAt: T0 + 20 })]);
  const now = s.get('tasks', 'aaaa000000000002');
  assert.equal(now.notes, 'Bring the form', 'the browser’s field is merged in');
  assert.equal(now.done, true, 'the assistant’s completion is kept');
  assert.ok(now.updatedAt > T0 + 50, 'the merged copy is a version of its own');
  assert.equal(s.rev, rev + 1);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].outcome, 'merged', 'the browser is told to take the merged copy');
  assert.deepEqual(out.rejected[0].item, now);
  assert.deepEqual(out.applied.map((o) => o.item.notes), ['Bring the form'], 'other browsers get the merged copy');
});

test('a field both sides changed goes to the newer write', () => {
  const s = store();
  s.applyOps([{ op: 'put', c: 'tasks', item: task('aaaa000000000003', { title: 'Old' }) }]);
  const seen = s.get('tasks', 'aaaa000000000003');
  s.transaction((tx) => tx.put('tasks', { ...tx.get('tasks', 'aaaa000000000003'), title: 'Renamed later', updatedAt: T0 + 100 }));
  s.applyOps([edit('tasks', seen, { ...seen, title: 'Renamed offline first', updatedAt: T0 + 50 })]);
  assert.equal(s.get('tasks', 'aaaa000000000003').title, 'Renamed later', 'the older offline rename loses');
  s.applyOps([edit('tasks', s.get('tasks', 'aaaa000000000003'), { ...s.get('tasks', 'aaaa000000000003'), title: 'Newest', updatedAt: T0 + 200 })]);
  assert.equal(s.get('tasks', 'aaaa000000000003').title, 'Newest');
});

test('note blocks changed on both sides are merged block by block', () => {
  const s = store();
  const note = (blocks, extra = {}) => ({ id: 'nnnn000000000001', v: 1, rev: 1, createdAt: T0, updatedAt: T0, blocks, ...extra });
  const b = (id, text, t = 'p') => ({ id, t, c: [[text]] });
  s.applyOps([{ op: 'put', c: 'notes', item: note([b('h', 'Plan', 'h1'), b('p1', 'First line.')]) }]);
  const seen = s.get('notes', 'nnnn000000000001');
  // An assistant appends a line (notes_append), as a newer write.
  s.transaction((tx) => tx.put('notes', { ...seen, rev: 2, blocks: [...seen.blocks, b('ai', 'AILINE from the assistant')], updatedAt: T0 + 100 }));
  // The user's save of their typing in the first line, from the version they had.
  s.applyOps([edit('notes', seen, { ...seen, rev: 2, blocks: [seen.blocks[0], b('p1', 'First line. USERTEXT')], updatedAt: T0 + 50 })]);
  const now = s.get('notes', 'nnnn000000000001');
  const text = JSON.stringify(now.blocks);
  assert.ok(text.includes('USERTEXT'), 'the user’s text is kept');
  assert.ok(text.includes('AILINE'), 'the assistant’s line is kept');
  assert.equal(now.rev, 3, 'the merged note has a new rev, so open editors take it');
});

test('a record deleted after the version an edit started from stays deleted; one the folder never had is created', () => {
  const s = store();
  s.applyOps([{ op: 'put', c: 'tasks', item: task('aaaa000000000004') }]);
  const seen = s.get('tasks', 'aaaa000000000004');
  s.applyOps([{ op: 'del', c: 'tasks', id: 'aaaa000000000004' }]); // another browser deleted it
  const out = s.applyOps([edit('tasks', seen, { ...seen, title: 'Edited offline', updatedAt: Date.now() })]);
  assert.equal(s.get('tasks', 'aaaa000000000004'), null, 'not brought back');
  assert.equal(out.rejected[0]?.outcome, 'deleted', 'the browser is told to drop it');
  // A record this folder never had (a new data folder: the browser's version came from another one).
  const other = store();
  other.applyOps([edit('tasks', seen, { ...seen, title: 'From another folder', updatedAt: Date.now() })]);
  assert.equal(other.get('tasks', 'aaaa000000000004')?.title, 'From another folder');
  // A record made in the browser (no base) is created too.
  s.applyOps([edit('tasks', null, task('aaaa000000000005', { title: 'Made offline' }))]);
  assert.equal(s.get('tasks', 'aaaa000000000005')?.title, 'Made offline');
});

test('after Erase everything an edit of an erased record does not bring it back', () => {
  const s = store();
  s.applyOps([{ op: 'put', c: 'tasks', item: task('aaaa000000000006') }]);
  const seen = s.get('tasks', 'aaaa000000000006');
  s.applyOps([{ op: 'replace', c: 'tasks', items: [] }]);
  s.applyOps([edit('tasks', seen, { ...seen, done: true, updatedAt: Date.now() })]);
  assert.deepEqual(s.all('tasks'), []);
  // ...and the deletion times are saved with the file.
  assert.equal(store(s.dir).applyOps([edit('tasks', seen, { ...seen, done: true, updatedAt: Date.now() })]).rejected[0]?.outcome, 'deleted');
});

test('a delete loses to an edit made after it; an older edit does not stop it', () => {
  const s = store();
  s.applyOps([{ op: 'put', c: 'tasks', item: task('aaaa000000000007') }]);
  const seen = s.get('tasks', 'aaaa000000000007');
  s.transaction((tx) => tx.put('tasks', { ...seen, title: 'Renamed by the assistant', updatedAt: Date.now() + 5000 }));
  const out = s.applyOps([{ op: 'del', c: 'tasks', id: seen.id, base: seen.updatedAt, at: Date.now() }]);
  assert.equal(s.get('tasks', seen.id)?.title, 'Renamed by the assistant');
  assert.equal(out.rejected[0]?.outcome, 'kept');
  s.applyOps([{ op: 'del', c: 'tasks', id: seen.id, base: s.get('tasks', seen.id).updatedAt, at: Date.now() + 9000 }]);
  assert.equal(s.get('tasks', seen.id), null);
});

test('ops that change nothing are not saved and do not move the rev; a put without base/fields is applied as it comes', () => {
  const s = store();
  s.applyOps([{ op: 'put', c: 'tasks', item: task('aaaa000000000008') }, { op: 'settings', patch: { theme: 'dark' } }]);
  const file = join(s.dir, 'data.json');
  const before = readFileSync(file, 'utf8');
  const rev = s.rev;
  const out = s.applyOps([{ op: 'put', c: 'tasks', item: s.get('tasks', 'aaaa000000000008') }, { op: 'del', c: 'tasks', id: 'nothere000000001' }, { op: 'settings', patch: { theme: 'dark' } }]);
  assert.equal(s.rev, rev, 'no new rev');
  assert.deepEqual(out.applied, []);
  assert.equal(readFileSync(file, 'utf8'), before, 'data.json was not rewritten');
  // An older client's whole put still overwrites (today's behaviour).
  s.applyOps([{ op: 'put', c: 'tasks', item: { ...s.get('tasks', 'aaaa000000000008'), title: 'Whole', updatedAt: T0 - 1 } }]);
  assert.equal(s.get('tasks', 'aaaa000000000008').title, 'Whole');
});

test('a failed save changes nothing: applyOps, importData and transactions roll memory back', () => {
  const s = store();
  s.applyOps([{ op: 'put', c: 'tasks', item: task('aaaa000000000009') }]);
  const rev = s.rev;
  const snap = s.snapshotJSON();
  const failOnce = () => {
    const real = s.save;
    s.save = () => {
      s.save = real;
      throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    };
  };
  failOnce();
  assert.throws(() => s.applyOps([{ op: 'put', c: 'tasks', item: task('bbbb000000000001') }, { op: 'del', c: 'tasks', id: 'aaaa000000000009' }, { op: 'settings', patch: { theme: 'dim' } }]), /ENOSPC/);
  assert.equal(s.rev, rev);
  assert.equal(s.snapshotJSON(), snap, 'memory is as it was');
  failOnce();
  assert.throws(() => s.transaction((tx) => tx.del('tasks', 'aaaa000000000009')), /ENOSPC/);
  assert.ok(s.get('tasks', 'aaaa000000000009'), 'the delete was rolled back');
  assert.equal(s.snapshotJSON(), snap);
  const fresh = store();
  const before = fresh.snapshotJSON();
  const real = fresh.save;
  fresh.save = () => {
    fresh.save = real;
    throw new Error('EPERM');
  };
  assert.throws(() => fresh.importData({ data: { tasks: [task('cccc000000000001')] }, settings: {} }), /EPERM/);
  assert.equal(fresh.initialized, false);
  assert.equal(fresh.snapshotJSON(), before);
  // The next successful write does not carry anything of the failed ones.
  s.applyOps([{ op: 'put', c: 'tasks', item: task('dddd000000000001') }]);
  assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'data.json'), 'utf8')).data.tasks.map((t) => t.id).sort(), ['aaaa000000000009', 'dddd000000000001']);
});

test('a data.json that is not valid JSON stops the start and is left exactly as it is; the message quotes none of it', () => {
  const dir = tmp();
  const text = '{"rev":3,"data":{"tasks":[{"id":"a","title":"Call the PRIVATEDOCTOR"x}]}}';
  writeFileSync(join(dir, 'data.json'), text);
  assert.throws(
    () => store(dir, { startWaitMs: 50 }),
    (err) => err instanceof DataFileError && /not valid JSON/.test(err.message) && !/PRIVATE|DOCTOR/.test(err.message) && /move data\.json/.test(err.message),
  );
  assert.equal(readFileSync(join(dir, 'data.json'), 'utf8'), text, 'not moved, not overwritten');
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('data.json')), ['data.json']);
});

test('while running, a corrupt data.json keeps the copy in memory; the next write keeps a copy of the bad file first', () => {
  const s = store();
  s.applyOps([{ op: 'put', c: 'tasks', item: task('eeee000000000001') }]);
  const file = join(s.dir, 'data.json');
  writeFileSync(file, '{"rev": 9, "data": {"tasks": [');
  assert.equal(s.refresh(), false);
  assert.ok(s.get('tasks', 'eeee000000000001'), 'still served');
  assert.equal(s.initialized, false);
  s.applyOps([{ op: 'put', c: 'tasks', item: task('eeee000000000002') }]);
  const aside = readdirSync(s.dir).filter((n) => n.startsWith('data.json.corrupt-'));
  assert.equal(aside.length, 1, 'the bad file is kept');
  assert.equal(readFileSync(join(s.dir, aside[0]), 'utf8'), '{"rev": 9, "data": {"tasks": [');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).data.tasks.map((t) => t.id).sort(), ['eeee000000000001', 'eeee000000000002']);
});

test('the write id catches a same-size write by another process in the same timestamp slot', () => {
  const dir = tmp();
  const file = join(dir, 'data.json');
  // A file system that keeps 2-second times (FAT32): every save lands in the same slot.
  const coarse = (s) => {
    const save = s.save.bind(s);
    s.save = () => {
      save();
      utimesSync(file, 1795400000, 1795400000);
      const st = statSync(file);
      s.stampValue = { mtimeMs: st.mtimeMs, size: st.size };
    };
    return s;
  };
  const a = coarse(store(dir));
  a.applyOps([{ op: 'put', c: 'tasks', item: task('ffff000000000001', { title: 'Call the bank' }) }]);
  const b = coarse(store(dir));
  b.transaction((tx) => tx.put('tasks', { ...tx.get('tasks', 'ffff000000000001'), title: 'Call the vets', updatedAt: T0 + 1 }));
  assert.deepEqual(a.stampValue, b.stampValue, 'the premise: both writes look the same to the file system');
  assert.equal(a.refresh(), true, 'the different write id shows the change');
  assert.equal(a.get('tasks', 'ffff000000000001').title, 'Call the vets');
  assert.equal(a.refresh(), false, 'and then nothing more');
});

test('the data folder keeps one id: across restarts, also for a file from before ids, and in snapshots and imports', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'data.json'), JSON.stringify({ format: 1, rev: 4, initialized: true, data: { tasks: [task('gggg000000000001')] }, settings: {} }));
  const a = store(dir);
  const b = store(dir); // the stdio bridge, or the next start
  assert.ok(a.dataId);
  assert.equal(a.dataId, b.dataId, 'derived from the file the same way in every process');
  assert.equal(JSON.parse(a.snapshotJSON()).dataId, a.dataId);
  a.applyOps([{ op: 'put', c: 'tasks', item: task('gggg000000000002') }]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')).dataId, a.dataId, 'stored with the next write');
  assert.equal(store(dir).dataId, a.dataId);
  const fresh = store();
  const out = fresh.importData({ data: { tasks: [] }, settings: {} });
  assert.equal(out.dataId, fresh.dataId);
  assert.notEqual(fresh.dataId, a.dataId, 'another folder has another id');
});

test('two folders moved into each other from two browsers: the move that would close the cycle goes to the top level', () => {
  const s = store();
  const F = (id, parentId, extra = {}) => ({ id, name: id, parentId, color: 'blue', order: 0, createdAt: T0, updatedAt: T0, ...extra });
  s.applyOps([{ op: 'put', c: 'folders', item: F('recipes000000001', null) }, { op: 'put', c: 'folders', item: F('travel0000000001', null) }]);
  const travel = s.get('folders', 'travel0000000001');
  s.applyOps([{ op: 'put', c: 'folders', item: F('recipes000000001', 'travel0000000001', { updatedAt: T0 + 1 }) }]);
  // The other browser had not heard of that move: its edit starts from the old version (the merge path).
  const out = s.applyOps([edit('folders', travel, { ...travel, parentId: 'recipes000000001', updatedAt: T0 + 2 })]);
  assert.equal(s.get('folders', 'recipes000000001').parentId, 'travel0000000001');
  assert.equal(s.get('folders', 'travel0000000001').parentId, null, 'no cycle is stored');
  assert.equal(out.rejected[0]?.outcome, 'merged', 'and that browser is told to take the stored copy');
});

test('data.json is written once per change, as compact JSON, and GET /api/state reuses that text', () => {
  const s = store();
  s.applyOps([{ op: 'put', c: 'tasks', item: task('hhhh000000000001') }]);
  const text = readFileSync(join(s.dir, 'data.json'), 'utf8');
  assert.ok(!text.includes('\n "'), 'not indented');
  assert.match(text, /^\{"format":1,"wid":"[0-9a-f]+",/);
  const snap = s.snapshotJSON();
  assert.equal(snap, JSON.stringify(s.snapshot()));
  assert.ok(text.endsWith(`${snap.slice(1)}\n`), 'the state is serialized once for both');
  assert.equal(s.snapshotJSON(), snap);
  assert.equal(valueHash(undefined), 'u');
  assert.ok(!existsSync(join(s.dir, 'data.json.tmp')));
});
