// QA fix (notes-core, verifier of the second pass): which line of a Markdown rewrite is which linked
// checklist item, and what its task does then (server/tools-notes.mjs mergeBlocks and notes_update).
//  - An assistant that drops the " [task](ecosys://task/…)" endings and rewords and checks an item
//    ("- [x] Send the final deck") got a line that kept the link while its task stayed open under the
//    old name, with no word in the reply; the Notes app's mirror of linked tasks then put the old words
//    back and unchecked it. A line alike to the item at its spot is now that item: the task follows.
//  - Similar items were told apart by how much of the shorter one is in the other, so "Email Sam" and
//    "Email Sam's lawyer" tied: with the first deleted and the second checked, the line took the
//    deleted item's task (and, with the endings kept, its block id). Now the Dice coefficient ranks
//    them, a line naming its task keeps that item's own id, and a line with an item's words is that
//    item even when items were moved.
//  - A linked item's id goes only with its link, so a task never points at another line, and an item
//    that is gone (deleted, or reworded past recognition) is named in the reply: its task stays as it
//    was. A set_checked followed by a replace in one call renames the task too, and the task follows
//    the last word on its check state. A rewrite of a long list names 50 task changes, then a count.
//  - notes_read and notes_update tell assistants to keep the endings (notes_read naming no write tool).
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
const { tools: NOTE_TOOLS } = await import('../server/tools-notes.mjs');
const N = await import('../notes/core/notes.js');
const { db } = await import('../shared/store.js');
const { blockText } = await import('../notes/core/schema.js');

const silent = { warn() {}, error() {}, info() {}, log() {} };
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-match-'));
let core;
let claude;
const call = (name, args) => {
  const r = core.callTool(name, args, { client: claude });
  assert.equal(r.isError, false, `${name}: ${r.content[0].text}`);
  return { text: r.content[0].text, data: r.structuredContent };
};
const task = (id) => core.store.get('tasks', id);
const checks = (id) => core.store.get('notes', id).blocks.filter((b) => b.t === 'check');
const read = (id) => call('notes_read', { id }).data;
const strip = (md) => md.replace(/ \[task\]\(ecosys:\/\/task\/\w+\)/g, '');

before(async () => {
  core = await createCore({ dataDir: dir, log: silent });
  claude = core.ai.createClient({ kind: 'claude' });
});
after(() => {
  core?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A note whose checklist items are all sent to Tasks → {id, ids: {title: block id}, tasks: {title: task id}}. */
function sentNote(markdown) {
  const id = call('notes_create', { markdown }).data.id;
  const sent = call('notes_send_to_tasks', { id }).data.tasks;
  const tasks = Object.fromEntries(sent.map((t) => [t.title, t.task_id]));
  const ids = Object.fromEntries(checks(id).map((b) => [blockText(b), b.id]));
  return { id, ids, tasks };
}
/** The Notes app's mirror of linked tasks (notes/core/notes.js syncTaskChecks) on a copy of the server's data. */
function appMirror(id) {
  for (const t of core.store.all('tasks')) db.put('tasks', t);
  db.put('notes', core.store.get('notes', id));
  return N.syncTaskChecks(id);
}

test('Markdown without the endings: a reworded, checked item renames and completes its task, and the Notes app keeps it', () => {
  const p = sentNote('# Launch\n\n- [ ] Send the deck\n- [ ] Book the room\n\nAgenda below.');
  const r = read(p.id);
  const u = call('notes_update', { id: p.id, ifRev: r.rev, markdown: strip(r.markdown).replace('- [ ] Send the deck', '- [x] Send the final deck') });
  assert.match(u.text, /\nTasks: renamed task "Send the deck" to "Send the final deck"; completed task "Send the final deck"\./);
  const deck = checks(p.id).find((b) => b.task === p.tasks['Send the deck']);
  assert.deepEqual([deck.id, blockText(deck), deck.ck], [p.ids['Send the deck'], 'Send the final deck', true]);
  assert.deepEqual([task(deck.task).title, task(deck.task).done], ['Send the final deck', true]);
  assert.equal(appMirror(p.id), null, 'the item and its task agree: the mirror changes nothing');
});

test('"Email Sam" deleted and "Email Sam\'s lawyer" checked: the line keeps its own task and id, with or without the endings', () => {
  for (const endings of [false, true]) {
    const p = sentNote("# Legal\n\n- [ ] Email Sam\n- [ ] Email Sam's lawyer\n\nNotes below.");
    const T = p.tasks['Email Sam'];
    const U = p.tasks["Email Sam's lawyer"];
    const r = read(p.id);
    let md = r.markdown.split('\n').filter((l) => !l.startsWith('- [ ] Email Sam [task]')).join('\n').replace("- [ ] Email Sam's lawyer", "- [x] Email Sam's lawyer");
    if (!endings) md = strip(md);
    const u = call('notes_update', { id: p.id, ifRev: r.rev, markdown: md });
    const [line] = checks(p.id);
    assert.deepEqual([line.task, line.id, line.ck], [U, p.ids["Email Sam's lawyer"], true], `endings ${endings}: ${u.text}`);
    assert.equal(task(U).done, true);
    assert.deepEqual([task(T).title, task(T).done], ['Email Sam', false], 'the deleted item\'s task is untouched');
    assert.equal(task(U).source.blockId, line.id, 'the task still points at its own line');
    assert.ok(u.text.includes(`no line in this note is linked to task "Email Sam" (task_id=${T}) now; the task is unchanged (a line stays linked to its task when it keeps its " [task](ecosys://task/…)" ending)`), u.text);
    assert.equal(appMirror(p.id), null);
  }
});

test('a line naming its task keeps that item\'s id, however much its words changed', () => {
  const p = sentNote('# Trip\n\n- [ ] Book flights\n- [ ] Pack bags\n\nPacking list below.');
  const r = read(p.id);
  const U = p.tasks['Pack bags'];
  // "Book flights" deleted; "Pack bags" reworded, its ending kept: the line is more like the deleted one.
  const md = r.markdown.split('\n').filter((l) => !l.startsWith('- [ ] Book flights')).join('\n').replace('- [ ] Pack bags', '- [ ] Book a taxi to the airport');
  const u = call('notes_update', { id: p.id, ifRev: r.rev, markdown: md });
  const [line] = checks(p.id);
  assert.deepEqual([line.task, line.id], [U, p.ids['Pack bags']], u.text);
  assert.equal(task(U).title, 'Book a taxi to the airport');
  assert.equal(task(p.tasks['Book flights']).title, 'Book flights');
});

test('items moved around without their endings keep their ids and tasks', () => {
  const p = sentNote('# Plan\n\n- [ ] Send the deck\n\nAgenda\n\n- [ ] Book the room\n\nEnd');
  const r = read(p.id);
  const lines = strip(r.markdown).split('\n');
  const a = lines.indexOf('- [ ] Send the deck');
  const b = lines.indexOf('- [ ] Book the room');
  [lines[a], lines[b]] = ['- [x] Book the room', '- [ ] Send the deck'];
  const u = call('notes_update', { id: p.id, ifRev: r.rev, markdown: lines.join('\n') });
  assert.deepEqual(
    checks(p.id).map((x) => [blockText(x), x.id, x.task, !!x.ck]),
    [['Book the room', p.ids['Book the room'], p.tasks['Book the room'], true], ['Send the deck', p.ids['Send the deck'], p.tasks['Send the deck'], false]],
    u.text,
  );
  assert.equal(task(p.tasks['Book the room']).done, true);
  assert.doesNotMatch(u.text, /no line in this note/);
});

test('a line reworded past recognition is no longer linked, takes no item\'s id, and the reply says the task is unchanged', () => {
  const p = sentNote('# Kitchen\n\n- [ ] Send the deck\n\nAgenda below.');
  const T = p.tasks['Send the deck'];
  const r = read(p.id);
  const u = call('notes_update', { id: p.id, ifRev: r.rev, markdown: strip(r.markdown).replace('- [ ] Send the deck', '- [x] Check the oven') });
  const [line] = checks(p.id);
  assert.equal(line.task, undefined);
  assert.notEqual(line.id, p.ids['Send the deck'], "the task's source never points at another line");
  assert.deepEqual([task(T).title, task(T).done], ['Send the deck', false]);
  assert.match(u.text, new RegExp(`\\nTasks: no line in this note is linked to task "Send the deck" \\(task_id=${T}\\) now; the task is unchanged`));
  // An unrelated edit says nothing about tasks.
  const r2 = read(p.id);
  assert.doesNotMatch(call('notes_update', { id: p.id, ifRev: r2.rev, markdown: r2.markdown.replace('Agenda below.', 'Agenda below, later.') }).text, /Tasks:/);
});

test('ops: set_checked then replace renames the task too, and its check state follows the last op', () => {
  const p = sentNote('# Ops\n\n- [ ] Send the deck\n- [ ] Book the room');
  const deck = p.ids['Send the deck'];
  let u = call('notes_update', { id: p.id, ifRev: read(p.id).rev, ops: [{ op: 'set_checked', block: deck, checked: true }, { op: 'replace', block: deck, markdown: 'Send the final deck' }] });
  assert.deepEqual([task(p.tasks['Send the deck']).title, task(p.tasks['Send the deck']).done], ['Send the final deck', true], u.text);
  assert.match(u.text, /Tasks: completed task "Send the deck"; renamed task "Send the deck" to "Send the final deck"\./);
  const room = p.ids['Book the room'];
  u = call('notes_update', { id: p.id, ifRev: read(p.id).rev, ops: [{ op: 'set_checked', block: room, checked: true }, { op: 'replace', block: room, markdown: '- [ ] Book the room' }] });
  assert.equal(task(p.tasks['Book the room']).done, false, u.text);
  assert.equal(checks(p.id).find((b) => b.id === room).ck, false);
  assert.match(u.text, /Tasks: completed task "Book the room"; reopened task "Book the room"\./);
  assert.equal(appMirror(p.id), null);
});

test('an item whose task was deleted, and two items of one task that now disagree, are named in the reply', () => {
  const p = sentNote('# Gone\n\n- [ ] Send the deck\n- [ ] Book the room');
  core.store.transaction((tx) => tx.del('tasks', p.tasks['Send the deck']));
  let u = call('notes_update', { id: p.id, ifRev: read(p.id).rev, ops: [{ op: 'set_checked', block: p.ids['Send the deck'], checked: true }] });
  assert.match(u.text, /Tasks: the task of "Send the deck" no longer exists, so the item is no longer linked\./);
  assert.equal(checks(p.id).find((b) => b.id === p.ids['Send the deck']).task, undefined);
  core.store.transaction((tx) => tx.del('tasks', p.tasks['Book the room']));
  const r = read(p.id);
  u = call('notes_update', { id: p.id, ifRev: r.rev, markdown: r.markdown.replace('- [ ] Book the room', '- [x] Book the room') });
  assert.match(u.text, /Tasks: the task of "Book the room" no longer exists, so the item is no longer linked\./);
  // Two lines of one task (a copy the user made), one checked by the assistant: the task can't follow.
  const twin = sentNote('# Twins\n\n- [ ] Water the plants');
  const W = twin.tasks['Water the plants'];
  const r2 = read(twin.id);
  const line = r2.markdown.split('\n').find((l) => l.startsWith('- [ ] Water the plants'));
  call('notes_update', { id: twin.id, ifRev: r2.rev, markdown: `${r2.markdown.trimEnd()}\n${line}\n` });
  const r3 = read(twin.id);
  assert.equal(checks(twin.id).filter((b) => b.task === W).length, 2, 'control: two items of the task');
  u = call('notes_update', { id: twin.id, ifRev: r3.rev, markdown: r3.markdown.replace('- [ ] Water the plants', '- [x] Water the plants') });
  assert.equal(task(W).done, false);
  assert.match(u.text, /Tasks: task "Water the plants" is unchanged: its items in this note are now checked and unchecked\./);
});

test('a rewrite that checks a long list names 50 task changes and counts the rest; every task follows', () => {
  const now = Date.now();
  const ops = [];
  const blocks = [{ id: 'h', t: 'h1', c: [['Long list']] }];
  for (let i = 0; i < 60; i++) {
    const id = `tlong${String(i).padStart(3, '0')}`;
    ops.push({ op: 'put', c: 'tasks', item: { id, title: `Item ${i}`, listId: null, done: false, createdAt: now, updatedAt: now, order: i, source: { app: 'notes', noteId: 'nlong', blockId: `bl${i}` } } });
    blocks.push({ id: `bl${i}`, t: 'check', in: 0, ck: false, task: id, c: [[`Item ${i}`]] });
  }
  core.store.applyOps([...ops, { op: 'put', c: 'notes', item: { id: 'nlong', v: 1, rev: 1, folderId: null, blocks, createdAt: now, updatedAt: now, editedAt: now, editedBy: 'user' } }]);
  const r = read('nlong');
  const u = call('notes_update', { id: 'nlong', ifRev: r.rev, markdown: strip(r.markdown).replace(/- \[ \] /g, '- [x] ') });
  const line = u.text.split('\n').find((l) => l.startsWith('Tasks: '));
  assert.equal(line.match(/completed task "Item \d+"/g).length, 50);
  assert.match(line, /; and 10 more task changes\.$/);
  assert.equal(checks('nlong').filter((b) => b.ck && b.task && task(b.task).done).length, 60);
});

test('notes_read and notes_update tell assistants to keep the endings; notes_read names no write tool', () => {
  const desc = (n) => NOTE_TOOLS.find((t) => t.name === n).description;
  assert.match(desc('notes_read'), /a checklist item linked to a task ends with " \[task\]\(ecosys:\/\/task\/<id>\)": keep that ending when you write the item back, so it stays linked\./);
  const writes = NOTE_TOOLS.filter((t) => t.write).map((t) => t.name);
  assert.deepEqual(writes.filter((w) => desc('notes_read').includes(w)), []);
  assert.match(desc('notes_update'), /In markdown, keep each linked item's " \[task\]\(ecosys:\/\/task\/<id>\)" ending as notes_read shows it: a line without one is matched to an item by its words, and a line reworded past recognition is no longer linked \(the result says so; its task stays as it was\)\./);
  for (const n of ['notes_read', 'notes_update']) assert.ok(desc(n).length < 1024, n);
});
