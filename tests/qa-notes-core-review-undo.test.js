// QA fix (notes-core, verifier of the second pass): the Notes app's "Edited by …" banner Undo
// (notes/core/notes.js reviewAiEdit 'undo') put back the note's items but left their tasks as the
// assistant had made them. Since notes_update carries linked tasks along (a "- [x]" in the Markdown
// completes the task, a replace that rewords an item renames it), the task stayed completed or
// renamed, and the app's routine mirror of linked tasks (syncTaskChecks, on any task change, when the
// tab becomes visible, on first sync) then put the item back as the task was: the user's Undo silently
// reversed itself. Now the Undo takes the tasks back with their items, as the user's own edits do
// (pushToTasks), in one change; and revertNote, for the toast's "Undo" of that Undo (and of a Version
// history Restore), puts both forward again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i], get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const { createCore } = await import('../server/core.mjs');
const N = await import('../notes/core/notes.js');
const { db } = await import('../shared/store.js');
const { blockText } = await import('../notes/core/schema.js');

const silent = { warn() {}, error() {}, info() {}, log() {} };
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-undo-'));
let core;
let claude;
const call = (name, args) => {
  const r = core.callTool(name, args, { client: claude });
  assert.equal(r.isError, false, `${name}: ${r.content[0].text}`);
  return { text: r.content[0].text, data: r.structuredContent };
};

before(async () => {
  core = await createCore({ dataDir: dir, log: silent });
  claude = core.ai.createClient({ kind: 'claude' });
});
after(() => {
  core?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** The Notes app's copy of the server's notes and tasks (as sync would leave it). */
function toBrowser() {
  for (const t of core.store.all('tasks')) db.put('tasks', t);
  for (const n of core.store.all('notes')) db.put('notes', n);
}
/** The note's linked items in the browser, each with its task: [{text, ck, title, done}]. */
const linked = (id) =>
  db
    .get('notes', id)
    .blocks.filter((b) => b.task)
    .map((b) => ({ text: blockText(b), ck: !!b.ck, title: db.get('tasks', b.task)?.title, done: !!db.get('tasks', b.task)?.done }));

/**
 * The user's note made in the app, two items sent to Tasks (kept), and a second note showing the deck
 * task. Then an assistant checks "Send the deck" in a Markdown rewrite and rewords "Book the room" with
 * a replace op. → {id, other, deck, room}
 */
function aiEdited(id) {
  const t0 = Date.now() - 3600000;
  core.store.applyOps([{ op: 'put', c: 'notes', item: { id, v: 1, rev: 1, folderId: null, blocks: [{ id: 'h', t: 'h1', c: [['Launch']] }, { id: 'c1', t: 'check', in: 0, ck: false, c: [['Send the deck']] }, { id: 'c2', t: 'check', in: 0, ck: false, c: [['Book the room']] }], createdAt: t0, updatedAt: t0, editedAt: t0, editedBy: 'user' } }]);
  const sent = call('notes_send_to_tasks', { id }).data.tasks;
  const deck = sent.find((t) => t.title === 'Send the deck').task_id;
  const room = sent.find((t) => t.title === 'Book the room').task_id;
  core.store.transaction((tx) => tx.put('notes', { ...tx.get('notes', id), aiPrev: null })); // the user kept the send
  const other = call('notes_create', { markdown: `# Checklist\n\n- [ ] Send the deck [task](ecosys://task/${deck})` }).data.id;
  core.store.transaction((tx) => tx.put('notes', { ...tx.get('notes', other), aiPrev: null }));
  const r = call('notes_read', { id });
  const checked = call('notes_update', { id, ifRev: r.data.rev, markdown: r.data.markdown.replace('- [ ] Send the deck', '- [x] Send the deck') });
  assert.match(checked.text, /Tasks: completed task "Send the deck"/);
  const b = call('notes_read', { id, format: 'blocks' }).data;
  const renamed = call('notes_update', { id, ifRev: b.rev, ops: [{ op: 'replace', block: b.blocks.find((x) => x.task === room).id, markdown: 'Book the big room' }] });
  assert.match(renamed.text, /Tasks: renamed task "Book the room" to "Book the big room"/);
  return { id, other, deck, room };
}

test('the banner Undo of an AI edit reopens and renames back the tasks it changed, and the mirror keeps the Undo', () => {
  const p = aiEdited('nUndo');
  toBrowser();
  assert.deepEqual(linked(p.id), [{ text: 'Send the deck', ck: true, title: 'Send the deck', done: true }, { text: 'Book the big room', ck: false, title: 'Book the big room', done: false }], 'control: the AI edit');
  assert.equal(db.get('notes', p.other).blocks.find((b) => b.task === p.deck).ck, true, 'control: the other note followed');
  const rev = db.get('notes', p.id).rev;
  const undone = N.reviewAiEdit(p.id, 'undo');
  assert.equal(undone.aiPrev, null);
  assert.equal(undone.editedBy, 'user');
  assert.ok(undone.rev > rev, 'rev goes up');
  assert.deepEqual(linked(p.id), [{ text: 'Send the deck', ck: false, title: 'Send the deck', done: false }, { text: 'Book the room', ck: false, title: 'Book the room', done: false }]);
  assert.equal(db.get('notes', p.other).blocks.find((b) => b.task === p.deck).ck, false, "the task's item in another note follows");
  // The Notes app's routine mirror of linked tasks finds nothing to change: the Undo holds.
  assert.equal(N.syncTaskChecks(p.id), null);
  assert.equal(N.syncAllTaskChecks(), 0);
  assert.deepEqual(linked(p.id).map((x) => [x.text, x.ck]), [['Send the deck', false], ['Book the room', false]]);
});

test("the toast's Undo of that Undo (revertNote) puts the AI's version and its tasks back, with a newer rev", () => {
  const p = aiEdited('nRedo');
  toBrowser();
  const aiVersion = structuredClone(db.get('notes', p.id)); // what the app clones before the banner Undo
  N.reviewAiEdit(p.id, 'undo');
  const rev = db.get('notes', p.id).rev;
  const back = N.revertNote(aiVersion);
  assert.ok(back.rev > rev && back.rev > aiVersion.rev, 'rev only goes up');
  assert.ok(back.aiPrev, 'the edit is waiting for review again');
  assert.deepEqual(linked(p.id), [{ text: 'Send the deck', ck: true, title: 'Send the deck', done: true }, { text: 'Book the big room', ck: false, title: 'Book the big room', done: false }]);
  assert.equal(db.get('notes', p.other).blocks.find((b) => b.task === p.deck).ck, true);
  assert.equal(N.syncTaskChecks(p.id), null, 'the mirror keeps it');
  assert.equal(N.revertNote(null), null);
});

test('an Undo with nothing of a task changed leaves the tasks alone (no rename or toggle from untouched items)', () => {
  const t0 = Date.now() - 3600000;
  core.store.applyOps([{ op: 'put', c: 'notes', item: { id: 'nPlain', v: 1, rev: 1, folderId: null, blocks: [{ id: 'h', t: 'h1', c: [['Plain']] }, { id: 'c1', t: 'check', in: 0, ck: false, c: [['Water the plants']] }, { id: 'p1', t: 'p', c: [['Notes']] }], createdAt: t0, updatedAt: t0, editedAt: t0, editedBy: 'user' } }]);
  const task = call('notes_send_to_tasks', { id: 'nPlain' }).data.tasks[0].task_id;
  core.store.transaction((tx) => tx.put('notes', { ...tx.get('notes', 'nPlain'), aiPrev: null }));
  const r = call('notes_read', { id: 'nPlain' });
  call('notes_update', { id: 'nPlain', ifRev: r.data.rev, markdown: r.data.markdown.replace('Notes', 'Notes, with more') });
  toBrowser();
  const before = structuredClone(db.get('tasks', task));
  N.reviewAiEdit('nPlain', 'undo');
  assert.equal(blockText(db.get('notes', 'nPlain').blocks[2]), 'Notes');
  assert.deepEqual(db.get('tasks', task), before, 'the task is exactly as it was');
});
