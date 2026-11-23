// QA fix (notes-core, found while wiring the task mirror): a checklist item linked to a task is one
// object in two places, checked exactly when the task is done and worded like it. notes_update kept
// that only for set_checked: an assistant that rewrote the note in Markdown with "- [x]" on the item,
// or replaced the item's block with "- [x] …" or new words, left the task as it was, and the Notes
// app later put the item back as the task is (it mirrors the task), so the assistant's change
// silently disappeared. Now, as in the Notes app (notes/core/notes.js pushToTasks), a linked item
// checked or unchecked in the Markdown or a replace completes or reopens its task (the task's items in
// other notes follow), a reworded one renames it, and an unrelated edit never touches a task. Also: a
// Markdown rewrite that deleted a linked item and edited another line gave that line the deleted
// item's id and task link (the first old block of its type nearby), which the Notes app then renamed
// to the task's title; an edited line now keeps the old block most like it, and a task link only
// when the two are alike.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { tools as NOTE_TOOLS } from '../server/tools-notes.mjs';
import { ymd, addDaysYmd } from '../shared/dates.js';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const today = ymd(new Date());
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-checks-'));
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
const task = (id) => core.store.get('tasks', id);
const item = (noteId, taskId) => core.store.get('notes', noteId).blocks.find((b) => b.task === taskId);

before(async () => {
  core = await createCore({ dataDir: dir, log: silent });
  claude = core.ai.createClient({ kind: 'claude' });
});
after(() => {
  core?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A note with two items sent to Tasks → {id, deck, room} (task ids). */
function plan(title) {
  const n = ok('notes_create', { markdown: `# ${title}\n\n- [ ] Send the deck\n- [ ] Book the room\n\nAgenda below.` });
  const sent = ok('notes_send_to_tasks', { id: n.data.id }).data.tasks;
  return { id: n.data.id, deck: sent.find((t) => t.title === 'Send the deck').task_id, room: sent.find((t) => t.title === 'Book the room').task_id };
}
const read = (id) => ok('notes_read', { id }).data;

test('"- [x]" in a Markdown rewrite completes the linked task; "- [ ]" reopens it', () => {
  const p = plan('Launch');
  let r = read(p.id);
  const checked = ok('notes_update', { id: p.id, ifRev: r.rev, markdown: r.markdown.replace('- [ ] Send the deck', '- [x] Send the deck') });
  assert.equal(task(p.deck).done, true, checked.text);
  assert.equal(task(p.room).done, false, 'the other item is untouched');
  assert.equal(item(p.id, p.deck).ck, true);
  assert.match(checked.text, /\nTasks: completed task "Send the deck"\./);
  r = read(p.id);
  const unchecked = ok('notes_update', { id: p.id, ifRev: r.rev, markdown: r.markdown.replace('- [x] Send the deck', '- [ ] Send the deck') });
  assert.equal(task(p.deck).done, false);
  assert.match(unchecked.text, /reopened task "Send the deck"/);
  // undo_change takes both back.
  ok('undo_change', { change_id: unchecked.data.change_id });
  assert.deepEqual([task(p.deck).done, item(p.id, p.deck).ck], [true, true]);
});

test('a replace op that checks a linked item completes its task; plain text keeps the item checked and the task done', () => {
  const p = plan('Offsite');
  const blocks = ok('notes_read', { id: p.id, format: 'blocks' }).data.blocks;
  const room = blocks.find((b) => b.task === p.room);
  const r = ok('notes_update', { id: p.id, ifRev: read(p.id).rev, ops: [{ op: 'replace', block: room.id, markdown: '- [x] Book the room' }] });
  assert.equal(task(p.room).done, true, r.text);
  assert.equal(item(p.id, p.room).id, room.id, 'the item keeps its id and its link');
  ok('notes_update', { id: p.id, ifRev: read(p.id).rev, ops: [{ op: 'replace', block: room.id, markdown: 'Book the big room' }] });
  assert.deepEqual([task(p.room).done, item(p.id, p.room).ck], [true, true], 'new words keep the item checked and the task done');
  assert.equal(task(p.room).title, 'Book the big room', 'and rename the task, as in the Notes app');
});

test('an edit that leaves an item as it was never changes its task, even when the two disagree', () => {
  const p = plan('Retro');
  // The task was finished while the note couldn't be changed by assistants (notes access Read), so
  // the item still shows it open.
  core.store.applyOps([{ op: 'settings', patch: { notesAi: 'read' } }]);
  ok('complete_tasks', { task_ids: [p.deck] });
  core.store.applyOps([{ op: 'settings', patch: { notesAi: 'edit' } }]);
  assert.deepEqual([task(p.deck).done, item(p.id, p.deck).ck], [true, false], 'control: they disagree');
  const r = read(p.id);
  const edit = ok('notes_update', { id: p.id, ifRev: r.rev, markdown: r.markdown.replace('Agenda below.', 'Agenda below, with notes.') });
  assert.equal(task(p.deck).done, true, 'an unrelated edit does not reopen the task');
  assert.doesNotMatch(edit.text, /Tasks:/);
  // Moving lines around, or adding a copy of a linked item, is not a check either.
  const r2 = read(p.id);
  const lines = r2.markdown.split('\n');
  const deck = lines.find((l) => l.startsWith('- [ ] Send the deck'));
  const room = lines.find((l) => l.startsWith('- [ ] Book the room'));
  ok('notes_update', { id: p.id, ifRev: r2.rev, markdown: r2.markdown.replace(`${deck}\n${room}`, `${room}\n${deck}`) });
  assert.deepEqual([task(p.deck).done, task(p.room).done], [true, false]);
  ok('notes_append', { id: p.id, markdown: room.replace('- [ ]', '- [x]') });
  assert.equal(task(p.room).done, false, 'a new line linking a task changes nothing about it');
});

test('a repeating task moves on and its item stays unchecked; the task\'s items in other notes follow', () => {
  const p = plan('Weekly');
  core.store.transaction((tx) => tx.put('tasks', { ...tx.get('tasks', p.deck), repeat: { freq: 'week', interval: 1 }, date: today, updatedAt: Date.now() }));
  const r = read(p.id);
  const done = ok('notes_update', { id: p.id, ifRev: r.rev, markdown: r.markdown.replace('- [ ] Send the deck', '- [x] Send the deck') });
  assert.match(done.text, /task "Send the deck" repeats: completed, next on /);
  assert.equal(task(p.deck).done, false);
  assert.equal(task(p.deck).date, addDaysYmd(today, 7));
  assert.equal(item(p.id, p.deck).ck, false, 'ready for next time');
  // Another note showing the room task follows when this one checks it.
  const other = ok('notes_create', { markdown: `# Room list\n\n- [ ] Book the room [task](ecosys://task/${p.room})` }).data.id;
  assert.equal(item(other, p.room).ck, false);
  const r2 = read(p.id);
  ok('notes_update', { id: p.id, ifRev: r2.rev, markdown: r2.markdown.replace('- [ ] Book the room', '- [x] Book the room') });
  assert.deepEqual([task(p.room).done, item(other, p.room).ck], [true, true]);
});

test('Markdown without the "[task](…)" ending: an item with unchanged words still completes its task', () => {
  const p = plan('Board');
  const r = read(p.id);
  const md = r.markdown.replace(/ \[task\]\(ecosys:\/\/task\/\w+\)/g, '').replace('- [ ] Send the deck', '- [x] Send the deck');
  assert.doesNotMatch(md, /ecosys:\/\/task/, 'control: no line names its task');
  ok('notes_update', { id: p.id, ifRev: r.rev, markdown: md });
  assert.deepEqual([task(p.deck).done, task(p.room).done], [true, false]);
  assert.ok(item(p.id, p.deck) && item(p.id, p.room), 'both items keep their links');
});

test('a line that takes the place of a deleted item never takes over its task', () => {
  const n = ok('notes_create', { markdown: '# Shop\n\n- [ ] Send the deck\n- [x] Bought milk\n\nAgenda below.' }).data.id;
  const deckBlock = ok('notes_read', { id: n, format: 'blocks' }).data.blocks.find((b) => b.markdown.startsWith('Send the deck'));
  const deck = ok('notes_send_to_tasks', { id: n, blocks: [deckBlock.id] }).data.tasks[0].task_id;
  const milkId = core.store.get('notes', n).blocks.find((b) => b.ck).id;
  // The deck line is deleted and the checked milk line edited, in one Markdown rewrite.
  ok('notes_update', { id: n, ifRev: read(n).rev, markdown: '# Shop\n\n- [x] Bought oat milk\n\nAgenda below.' });
  assert.equal(task(deck).done, false, 'the deck task stays open');
  const milk = core.store.get('notes', n).blocks.find((b) => b.t === 'check');
  assert.equal(milk.id, milkId, 'the edited line keeps its own id');
  assert.equal(milk.task, undefined, 'and no task link');
});

test('a reworded item renames its task: a replace op, Markdown naming the task, or a line alike to the item', () => {
  const p = plan('Renames');
  const room = ok('notes_read', { id: p.id, format: 'blocks' }).data.blocks.find((b) => b.task === p.room);
  const r = ok('notes_update', { id: p.id, ifRev: read(p.id).rev, ops: [{ op: 'replace', block: room.id, markdown: 'Book the big room' }] });
  assert.equal(task(p.room).title, 'Book the big room');
  assert.match(r.text, /Tasks: renamed task "Book the room" to "Book the big room"\./);
  // In Markdown, an item that keeps its "[task](…)" ending is that task's item, whatever its words.
  const md = read(p.id).markdown.replace('- [ ] Send the deck', '- [x] Email the slides to Alex');
  assert.match(md, /- \[x\] Email the slides to Alex \[task\]\(ecosys:\/\/task\/\w+\)/);
  const both = ok('notes_update', { id: p.id, ifRev: read(p.id).rev, markdown: md });
  assert.deepEqual([task(p.deck).title, task(p.deck).done], ['Email the slides to Alex', true], both.text);
  assert.match(both.text, /renamed task "Send the deck" to "Email the slides to Alex"; completed task "Email the slides to Alex"/);
  // Without the ending, a reworded line alike to the item at its spot is that item too: the line keeps
  // the link, and its task follows (before, the task stayed as it was and the Notes app later put the
  // item back as the task was, so the assistant's edit silently disappeared).
  const q = plan('No proof');
  const plain = read(q.id).markdown.replace(/ \[task\]\(ecosys:\/\/task\/\w+\)/g, '').replace('- [ ] Send the deck', '- [x] Send the final deck');
  const r3 = ok('notes_update', { id: q.id, ifRev: read(q.id).rev, markdown: plain });
  assert.deepEqual([task(q.deck).title, task(q.deck).done], ['Send the final deck', true], r3.text);
  assert.deepEqual([item(q.id, q.deck)?.c[0][0], item(q.id, q.deck)?.ck], ['Send the final deck', true], 'the edited line keeps the link (alike enough)');
  assert.match(r3.text, /\nTasks: renamed task "Send the deck" to "Send the final deck"; completed task "Send the final deck"\./);
  // undo_change puts the task's name back.
  ok('undo_change', { change_id: r.data.change_id });
  assert.equal(task(p.room).title, 'Book the room');
});

test('the description says so', () => {
  const d = NOTE_TOOLS.find((t) => t.name === 'notes_update').description;
  assert.match(d, /Checking a checklist item linked to a task \(set_checked, or "- \[x\]" in markdown\) completes the task; unchecking reopens it, and rewording it renames the task\./);
  assert.ok(d.length < 1024);
});
