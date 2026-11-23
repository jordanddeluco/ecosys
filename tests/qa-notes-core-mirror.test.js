// QA fix (notes-core, server cross request): checking or unchecking a linked checklist item with
// notes_update completes or reopens its task, and the task's linked items in the user's OTHER notes
// now follow in the same change, as complete_tasks already does (server/tools.mjs mirrorTaskChecks).
// Before, only the note being edited and the task changed, so another note showing the same task
// kept an open item for a finished task. Only notes the assistant may change follow (never one hidden
// from AI, in a hidden folder or in Recently Deleted), the reply never names them, and undo_change
// puts everything back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { ymd, addDaysYmd } from '../shared/dates.js';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const today = ymd(new Date());
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-mirror-'));
let core;
let claude;
const call = (name, args) => {
  const r = core.callTool(name, args, { client: claude });
  return { isError: r.isError, text: r.content[0].text, data: r.structuredContent };
};
const ok = (name, args) => {
  const r = call(name, args);
  assert.equal(r.isError, false, `${name}: ${r.text}`);
  return r;
};
const note = (id) => core.store.get('notes', id);
const t0 = Date.now() - 3600000;
const N = (id, task, extra = {}) => ({
  id, v: 1, rev: 1, folderId: null, pinned: false, day: null, event: null, aiHidden: false, aiPrev: null, locked: null,
  editedBy: 'user', editedAt: t0, createdAt: t0, updatedAt: t0, trashedAt: null, trashedFrom: null,
  blocks: [{ id: `${id}h`, t: 'h1', c: [[`Note ${id}`]] }, { id: `${id}c`, t: 'check', in: 0, ck: false, task, c: [['Send the deck']] }],
  ...extra,
});
const ck = (id, task) => note(id).blocks.find((b) => b.task === task).ck;
let taskId;

before(async () => {
  core = await createCore({ dataDir: dir, log: silent });
  claude = core.ai.createClient({ kind: 'claude' });
  taskId = ok('create_tasks', { tasks: [{ title: 'Send the deck', date: addDaysYmd(today, 2) }] }).data.created[0].task_id;
  core.store.applyOps([
    { op: 'put', c: 'folders', item: { id: 'fhid', name: 'Private', parentId: null, color: 'red', order: 0, aiHidden: true, createdAt: t0, updatedAt: t0 } },
    { op: 'put', c: 'notes', item: N('edit', taskId) }, // the note the assistant edits
    { op: 'put', c: 'notes', item: N('other', taskId, { title: 'Weekly plan' }) }, // another note showing the same task
    { op: 'put', c: 'notes', item: N('hidden', taskId, { aiHidden: true }) },
    { op: 'put', c: 'notes', item: N('infolder', taskId, { folderId: 'fhid' }) },
    { op: 'put', c: 'notes', item: N('trashed', taskId, { trashedAt: t0, trashedFrom: null }) },
  ]);
});
after(() => {
  core?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const setChecked = (checked) => ok('notes_update', { id: 'edit', ifRev: note('edit').rev, ops: [{ op: 'set_checked', block: 'editc', checked }] });

test('checking a linked item completes the task, and its items in the other notes the assistant may change follow', () => {
  const before = { edit: note('edit').rev, other: note('other').rev };
  const r = setChecked(true);
  assert.equal(core.store.get('tasks', taskId).done, true, r.text);
  assert.equal(ck('edit', taskId), true);
  assert.equal(ck('other', taskId), true, 'another visible note showing the task follows in the same change');
  assert.equal(note('other').rev, before.other + 1, 'a system change: rev + 1');
  assert.equal(note('other').editedAt, t0, 'its edit time and editor are kept');
  assert.equal(note('other').editedBy, 'user');
  assert.equal(note('edit').rev, before.edit + 1, 'the edited note is written once, by notes_update itself');
  assert.deepEqual(['hidden', 'infolder', 'trashed'].map((id) => ck(id, taskId)), [false, false, false], 'hidden, in a hidden folder or deleted: left alone');
  assert.deepEqual(['hidden', 'infolder', 'trashed'].map((id) => note(id).rev), [1, 1, 1]);
  assert.doesNotMatch(r.text, /Weekly plan|\bother\b|hidden|infolder|trashed/, 'the reply names no other note');
  assert.match(r.text, /completed task "Send the deck"/);
  // One change: undo_change puts the task and both notes back.
  ok('undo_change', { change_id: r.data.change_id });
  assert.equal(core.store.get('tasks', taskId).done, false);
  assert.deepEqual([ck('edit', taskId), ck('other', taskId)], [false, false]);
});

test('unchecking reopens the task, and the other notes follow again', () => {
  setChecked(true);
  assert.equal(ck('other', taskId), true);
  const r = setChecked(false);
  assert.match(r.text, /reopened task "Send the deck"/);
  assert.equal(core.store.get('tasks', taskId).done, false);
  assert.deepEqual([ck('edit', taskId), ck('other', taskId)], [false, false]);
  assert.deepEqual(['hidden', 'infolder', 'trashed'].map((id) => ck(id, taskId)), [false, false, false]);
});

test('a repeating task moves on, and every visible item stays unchecked', () => {
  core.store.transaction((tx) => tx.put('tasks', { ...tx.get('tasks', taskId), repeat: { freq: 'day', interval: 1 }, date: today, updatedAt: Date.now() }));
  const r = setChecked(true);
  assert.match(r.text, /repeats: completed, next on/);
  assert.equal(core.store.get('tasks', taskId).done, false);
  assert.deepEqual([ck('edit', taskId), ck('other', taskId)], [false, false]);
});

test('with notes access Read nothing is written at all; complete_tasks and notes_update agree', () => {
  core.store.transaction((tx) => tx.put('tasks', { ...tx.get('tasks', taskId), repeat: null, updatedAt: Date.now() }));
  // complete_tasks mirrors into both visible notes; notes_update on one of them does the same.
  ok('complete_tasks', { task_ids: [taskId] });
  assert.deepEqual([ck('edit', taskId), ck('other', taskId)], [true, true]);
  setChecked(false);
  assert.deepEqual([ck('edit', taskId), ck('other', taskId)], [false, false]);
  core.store.applyOps([{ op: 'settings', patch: { notesAi: 'read' } }]);
  const r = call('notes_update', { id: 'edit', ifRev: note('edit').rev, ops: [{ op: 'set_checked', block: 'editc', checked: true }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /ai_access_read_only/);
  assert.equal(core.store.get('tasks', taskId).done, false);
  assert.deepEqual([ck('edit', taskId), ck('other', taskId)], [false, false]);
  core.store.applyOps([{ op: 'settings', patch: { notesAi: 'edit' } }]);
});
