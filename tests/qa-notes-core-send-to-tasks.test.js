// QA fix (notes-core): notes_send_to_tasks has create_tasks' duplicate guard. An assistant that made a
// meeting's follow-ups with create_tasks and then sent the note's checklist to Tasks got every
// follow-up twice; now an item whose open task (same title, made in the last 10 minutes, not linked
// to a note yet) exists is linked to that task, both ways, instead of getting a second one.
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
const tomorrow = addDaysYmd(today, 1);
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-tasks-'));
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
const named = (title) => core.store.all('tasks').filter((t) => t.title.toLowerCase() === title.toLowerCase());

before(async () => {
  core = await createCore({ dataDir: dir, log: silent });
  core.store.applyOps([
    { op: 'put', c: 'lists', item: { id: 'lwork', name: 'Work', color: 'blue', icon: '', order: 0, createdAt: 1, updatedAt: 1 } },
    { op: 'put', c: 'lists', item: { id: 'lhome', name: 'Home', color: 'green', icon: '', order: 1, createdAt: 1, updatedAt: 1 } },
  ]);
  claude = core.ai.createClient({ kind: 'claude' });
});
after(() => {
  core?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

test('follow-ups made with create_tasks, then the checklist sent to Tasks: linked, not duplicated', () => {
  const made = ok('create_tasks', { tasks: [{ title: 'Follow up with design', date: 'tomorrow', list: 'Work' }] }).data.created[0];
  const note = ok('notes_create', { markdown: '# Standup\n\n## Action items\n\n- [ ] Follow up with design\n- [ ] Update the roadmap', folder: 'Work/Meetings' });
  const r = ok('notes_send_to_tasks', { id: note.data.id, list: 'Work' });
  assert.equal(named('Follow up with design').length, 1, 'still one "Follow up with design"');
  assert.equal(named('Update the roadmap').length, 1);
  const linked = r.data.tasks.find((t) => t.title === 'Follow up with design');
  assert.deepEqual([linked.task_id, linked.existing, linked.date], [made.task_id, true, tomorrow]);
  assert.ok(!r.data.tasks.find((t) => t.title === 'Update the roadmap').existing);
  assert.match(r.text, /^Created 1 task and linked 1 item to the open task with the same title made in the last 10 minutes \(no duplicate\)/);
  assert.match(r.text, new RegExp(`task_id=${made.task_id} block=\\w+ \\(existing task, now linked\\)`));
  // Linked both ways, like a task the note made itself.
  const block = core.store.get('notes', note.data.id).blocks.find((b) => b.task === made.task_id);
  assert.ok(block, 'the checklist item links the existing task');
  assert.deepEqual(core.store.get('tasks', made.task_id).source, { app: 'notes', noteId: note.data.id, blockId: block.id });
  // Checking the item completes that task.
  ok('notes_update', { id: note.data.id, ifRev: core.store.get('notes', note.data.id).rev, ops: [{ op: 'set_checked', block: block.id, checked: true }] });
  assert.equal(core.store.get('tasks', made.task_id).done, true);
});

test('a task is not taken as the same one when it is older, done, already linked, in another list, or due another day', () => {
  const old = Date.now() - 11 * 60000;
  core.store.applyOps([
    { op: 'put', c: 'tasks', item: { id: 'tOld', title: 'Water plants', listId: null, tags: [], priority: 0, date: null, done: false, createdAt: old, updatedAt: old } },
    { op: 'put', c: 'tasks', item: { id: 'tDone', title: 'Pay rent', listId: null, tags: [], priority: 0, date: null, done: true, completedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() } },
  ]);
  ok('create_tasks', { tasks: [{ title: 'Call the bank', list: 'Home' }, { title: 'Book flights', date: 'today' }] });
  const linkedElsewhere = ok('notes_create', { markdown: '- [ ] Renew passport' });
  ok('notes_send_to_tasks', { id: linkedElsewhere.data.id });
  const n = ok('notes_create', { markdown: '- [ ] Water plants\n- [ ] Pay rent\n- [ ] Call the bank\n- [ ] Book flights tomorrow\n- [ ] Renew passport' });
  const r = ok('notes_send_to_tasks', { id: n.data.id, list: 'Work' });
  assert.deepEqual(r.data.tasks.filter((t) => t.existing), [], `every item got a task of its own: ${r.text}`);
  for (const title of ['Water plants', 'Pay rent', 'Call the bank', 'Book flights', 'Renew passport']) assert.equal(named(title).length, 2, title);
  // Without a list, a task made moments ago in any list is the same one.
  ok('create_tasks', { tasks: [{ title: 'Order paint', list: 'Home' }] });
  const any = ok('notes_create', { markdown: '- [ ] order paint' });
  const r2 = ok('notes_send_to_tasks', { id: any.data.id });
  assert.equal(named('Order paint').length, 1);
  assert.equal(r2.data.tasks[0].existing, true);
  assert.equal(r2.data.tasks[0].list, 'Home');
});

test('the description says to use one of the two, not both', () => {
  const d = NOTE_TOOLS.find((t) => t.name === 'notes_send_to_tasks').description;
  assert.match(d, /write them as checklist items and call this; don't also call create_tasks/);
  assert.ok(d.length < 1024);
});
