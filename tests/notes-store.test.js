// notes/core/notes.js on the real shared store (fake localStorage): saving, views, folders, trash,
// daily/meeting notes, backlinks, tags, Send to Tasks, AI review, sample data. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i], get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const N = await import('../notes/core/notes.js');
const { db, settings } = await import('../shared/store.js');
const { blockText, validateBlocks } = await import('../notes/core/schema.js');
const { sampleNotesAndFolders } = await import('../notes/core/seed.js');
const { todayYmd, addDaysYmd } = await import('../shared/dates.js');

const purged = [];
window.addEventListener('ecosys:notes-purged', (e) => purged.push(...e.detail.ids));
const B = (t, text, extra = {}) => ({ t, c: text ? [[text]] : [], ...extra });
const texts = (n) => N.getNote(n.id).blocks.map(blockText);

test('createNote and saveBlocks: rev, editedAt, editedBy, aiPrev semantics, no-op saves', () => {
  const n = N.createNote();
  assert.deepEqual(n.blocks.map((b) => b.t), ['h1']);
  assert.equal(n.rev, 1);
  assert.equal(n.title, '');
  settings.set({ notesNewStyle: 'p' });
  assert.equal(N.createNote().blocks[0].t, 'p', 'first block follows settings.notesNewStyle');
  settings.set({ notesNewStyle: 'h1' });
  const s1 = N.saveBlocks(n.id, [B('h1', 'Groceries #home'), B('check', 'milk', { in: 0 })]);
  assert.equal(s1.title, 'Groceries #home');
  assert.deepEqual(s1.tags, ['home']);
  assert.equal(s1.rev, 2);
  assert.equal(s1.editedBy, 'user');
  assert.equal(N.saveBlocks(n.id, s1.blocks), s1, 'identical blocks: nothing saved');
  const s2 = N.saveBlocks(n.id, [...s1.blocks, B('p', 'from AI')], { by: 'mcp:claude' });
  assert.equal(s2.editedBy, 'mcp:claude');
  assert.equal(s2.aiPrev.by, 'mcp:claude');
  assert.equal(s2.aiPrev.rev, 2);
  assert.deepEqual(s2.aiPrev.blocks.map(blockText), ['Groceries #home', 'milk']);
  const s3 = N.saveBlocks(n.id, [...s2.blocks, B('p', 'AI again')], { by: 'mcp:grok' });
  assert.deepEqual(s3.aiPrev.blocks.map(blockText), ['Groceries #home', 'milk'], 'the oldest unreviewed copy is kept');
  const s4 = N.saveBlocks(n.id, [...s3.blocks, B('p', 'me')]);
  assert.ok(s4.aiPrev, 'user edits keep the review copy');
  assert.equal(N.reviewAiEdit(n.id, 'undo').blocks.map(blockText).join('|'), 'Groceries #home|milk');
  assert.equal(N.getNote(n.id).aiPrev, null);
  assert.equal(N.saveBlocks('nope', []), null);
  // a stage-1 note (HTML body) reads as blocks; saving writes the blocks and clears the old HTML
  const legacy = db.insert('notes', { title: 'Old', body: '<h1>Old</h1><p>text</p>' });
  assert.deepEqual(N.getNote(legacy.id).blocks.map(blockText), ['Old', 'text']);
  const saved = N.saveBlocks(legacy.id, [...N.getNote(legacy.id).blocks, B('p', 'new')]);
  assert.equal(saved.body, '');
  assert.deepEqual(saved.blocks.map(blockText), ['Old', 'text', 'new']);
});

test('chip labels follow their target; links and backlinks', () => {
  const target = N.createNote({ blocks: [B('h1', 'Target note')] });
  const other = N.createNote({ blocks: [B('h1', 'Linker'), { t: 'p', c: [['see '], ['old label', '', { ref: `note:${target.id}`, atom: 1 }]] }] });
  const saved = N.saveBlocks(other.id, [...other.blocks, B('p', 'more')]);
  assert.equal(saved.blocks[1].c[1][0], 'Target note');
  assert.deepEqual(saved.links, [`note:${target.id}`]);
  assert.deepEqual(N.backlinks(target.id).map((n) => n.id), [other.id]);
  const [entry] = N.backlinkEntries(target.id);
  assert.equal(entry.blockId, saved.blocks[1].id);
  assert.equal(entry.text, 'see Target note');
  N.trashNote(other.id);
  assert.deepEqual(N.backlinks(target.id), [], 'trashed notes do not count');
  N.restoreNote(other.id);
});

test('listNotes: views, pinned first, sorts, date groups', () => {
  for (const n of db.all('notes').slice()) db.remove('notes', n.id);
  const f = N.createFolder({ name: 'Work' });
  const sub = N.createFolder({ name: 'Clients', parentId: f.id });
  const now = Date.now();
  const mk = (title, extra = {}, age = 0) => {
    const n = N.createNote({ blocks: [B('h1', title)], ...extra });
    return db.update('notes', n.id, { editedAt: now - age * 86400000, createdAt: now - (age + 1) * 86400000 });
  };
  const a = mk('Alpha', { folderId: f.id }, 0);
  const b = mk('beta', { folderId: sub.id, pinned: true }, 3);
  const c = mk('Gamma #x', {}, 40);
  const d = mk('Delta', { day: todayYmd() }, 1);
  const e = mk('Epsilon #x/y', {}, 400);
  db.update('notes', e.id, { aiPrev: { at: now, by: 'mcp:chatgpt', rev: 0, blocks: [] } });
  const list = N.listNotes({ view: 'all', groupByDate: true });
  assert.deepEqual(list.map((n) => n.title), ['beta', 'Alpha', 'Delta', 'Gamma #x', 'Epsilon #x/y']);
  const keys = list.sections.map((s) => s.key);
  assert.deepEqual(keys.slice(0, 3), ['pinned', 'today', 'yesterday']);
  assert.ok(keys.slice(3).every((k) => /^\d{4}(-\d{2})?$/.test(k)), 'older notes are grouped by month, then year');
  assert.equal(list.sections[0].label, 'Pinned');
  const g = N.dateGroups([{ editedAt: now - 3 * 86400000 }, { editedAt: now - 20 * 86400000 }], { now });
  assert.deepEqual(g.map((x) => [x.key, x.label]), [['7d', 'Previous 7 Days'], ['30d', 'Previous 30 Days']]);
  assert.equal(Object.keys(list).includes('sections'), false, 'sections is not enumerable');
  assert.deepEqual(N.listNotes({ sort: 'title' }).map((n) => n.title), ['beta', 'Alpha', 'Delta', 'Epsilon #x/y', 'Gamma #x']);
  assert.deepEqual(N.listNotes({ sort: 'edited', dir: 'asc' }).map((n) => n.title), ['beta', 'Epsilon #x/y', 'Gamma #x', 'Delta', 'Alpha']);
  assert.deepEqual(N.listNotes({ view: 'folder', folderId: f.id }).map((n) => n.title), ['beta', 'Alpha'], 'subfolders included');
  assert.deepEqual(N.listNotes({ view: 'folder', folderId: f.id, deep: false }).map((n) => n.title), ['Alpha']);
  assert.deepEqual(N.listNotes({ view: 'folder', folderId: 'notes' }).map((n) => n.title).sort(), ['Epsilon #x/y', 'Gamma #x'], 'Notes: no folder, no daily notes');
  assert.deepEqual(N.listNotes({ view: 'tag', tags: ['x'] }).map((n) => n.title), ['Gamma #x', 'Epsilon #x/y']);
  assert.deepEqual(N.listNotes({ view: 'tag', tags: ['x/y', 'nope'], mode: 'any' }).map((n) => n.title), ['Epsilon #x/y']);
  assert.deepEqual(N.listNotes({ view: 'tag', tags: ['x/y', 'nope'], mode: 'all' }), []);
  assert.deepEqual(N.listNotes({ view: 'today' }).map((n) => n.id), [d.id]);
  assert.deepEqual(N.listNotes({ view: 'ai' }).map((n) => n.id), [e.id]);
  assert.deepEqual(N.listNotes({ view: 'search', q: 'alp' }).map((n) => n.id), [a.id]);
  assert.equal(N.searchAll('gamma')[0].note.id, c.id);
  const counts = N.noteCounts();
  assert.deepEqual([counts.all, counts.notes, counts.today, counts.ai, counts.trash], [5, 2, 1, 1, 0]);
  const tree = N.folderTree();
  assert.deepEqual(tree.map((x) => [x.folder.name, x.depth, x.count, x.own, x.path]), [['Work', 0, 2, 1, 'Work'], ['Clients', 1, 1, 1, 'Work/Clients']]);
  assert.deepEqual(N.allTagCounts().map((t) => [t.tag, t.count]), [['x', 1], ['x/y', 1]]);
  assert.ok(b && N.dateGroups([b], { now }).length === 1);
});

test('folders: unique names, the reserved "Notes", 3 levels, rename errors, move, delete with undo', () => {
  const w = N.getFolder(db.all('folders').find((f) => f.name === 'Work').id);
  assert.equal(N.createFolder({ name: 'work' }).name, 'work 2');
  assert.equal(N.createFolder({ name: 'Notes' }).name, 'Notes 2', '"Notes" is the default folder');
  const l2 = N.createFolder({ name: 'L2', parentId: w.id });
  const l3 = N.createFolder({ name: 'L3', parentId: l2.id });
  assert.throws(() => N.createFolder({ name: 'L4', parentId: l3.id }), /3 levels/);
  assert.throws(() => N.renameFolder(l2.id, 'Clients'), /already a folder named/);
  assert.throws(() => N.renameFolder(l2.id, '  '), /needs a name/);
  assert.equal(N.renameFolder(l2.id, 'Level two').name, 'Level two');
  assert.throws(() => N.moveFolder(w.id, l3.id), /inside itself/);
  const top = N.createFolder({ name: 'Top' });
  assert.throws(() => N.moveFolder(l2.id, N.createFolder({ name: 'Deep', parentId: top.id }).id), /3 levels/);
  const n1 = N.createNote({ folderId: l3.id, blocks: [B('h1', 'In L3')] });
  const n2 = N.createNote({ folderId: l2.id, blocks: [B('h1', 'In L2')] });
  const undo = N.deleteFolder(l2.id);
  assert.equal(undo.count, 2);
  assert.equal(N.getFolder(l2.id), null);
  assert.equal(N.getFolder(l3.id), null, 'subfolders go too');
  assert.ok(N.getNote(n1.id).trashedAt && N.getNote(n2.id).trashedAt);
  assert.equal(N.getNote(n1.id).trashedFrom, l3.id);
  undo();
  assert.ok(N.getFolder(l2.id) && N.getFolder(l3.id));
  assert.equal(N.getNote(n1.id).trashedAt, null);
  const keep = N.deleteFolder(l3.id, { notesTo: 'parent' });
  assert.equal(N.getNote(n1.id).folderId, l2.id);
  assert.equal(keep.count, 1);
  assert.equal(N.updateFolder(top.id, { color: 'teal', sort: 'title', bogus: 1 }).color, 'teal');
  assert.equal(N.setFolderAiHidden(top.id, true).aiHidden, true);
});

test('trash: soft delete with undo, empty notes discarded, restore target, purge, Delete Now', () => {
  const f = N.createFolder({ name: 'Trashy' });
  const n = N.createNote({ folderId: f.id, blocks: [B('h1', 'Bye')] });
  const undo = N.trashNote(n.id);
  assert.ok(N.getNote(n.id).trashedAt);
  assert.equal(N.getNote(n.id).trashedFrom, f.id);
  assert.ok(N.listNotes({ view: 'trash' }).some((x) => x.id === n.id));
  undo();
  assert.equal(N.getNote(n.id).trashedAt, null);
  const empty = N.createNote();
  N.trashNote(empty.id);
  assert.equal(N.getNote(empty.id), null, 'an empty note is discarded, not trashed');
  assert.ok(N.discardIfEmpty(N.createNote().id));
  N.trashNote(n.id);
  N.deleteFolder(f.id);
  assert.equal(N.restoreNote(n.id).folderId, null, 'its folder is gone: back to Notes');
  // daily notes stay unique per date when restored
  const d1 = N.dailyNote(addDaysYmd(todayYmd(), -3), { create: true });
  N.saveBlocks(d1.id, [...d1.blocks, B('p', 'x')]);
  N.trashNote(d1.id);
  const d2 = N.dailyNote(addDaysYmd(todayYmd(), -3), { create: true });
  assert.notEqual(d2.id, d1.id);
  assert.equal(N.restoreNote(d1.id).day, null);
  // purge after 30 days; Delete Now / Delete All
  const old = N.createNote({ blocks: [B('h1', 'Old')] });
  N.trashNote(old.id);
  db.update('notes', old.id, { trashedAt: Date.now() - 31 * 86400000 });
  const fresh = N.createNote({ blocks: [B('h1', 'Fresh')] });
  N.trashNote(fresh.id);
  assert.deepEqual(N.purgeTrash(), [old.id]);
  assert.ok(purged.includes(old.id));
  assert.ok(N.getNote(fresh.id));
  N.deleteForever(fresh.id);
  assert.equal(N.getNote(fresh.id), null);
  const x = N.createNote({ blocks: [B('h1', 'X')] });
  N.trashNotes([x.id]);
  assert.ok(N.emptyTrash().includes(x.id));
  assert.equal(N.listNotes({ view: 'trash' }).length, 0);
});

test('daily and meeting notes', () => {
  const ymd = addDaysYmd(todayYmd(), 1);
  assert.equal(N.dailyNote(ymd), null);
  const d = N.dailyNote(ymd, { create: true, locale: 'en-US' });
  assert.equal(d.day, ymd);
  assert.match(d.title, /\d{4}/);
  assert.equal(N.dailyNote(ymd).id, d.id);
  assert.equal(N.dailyNote('2026-02-30', { create: true }), null);
  const ev = db.insert('events', { title: 'Standup', calendarId: null, allDay: false, start: `${ymd}T09:30`, end: `${ymd}T09:45`, location: '', notes: '', repeat: null, exdates: [], until: null });
  const folder = N.createFolder({ name: 'Meetings' });
  settings.set({ notesMeetingFolder: folder.id });
  const m = N.meetingNote(ev.id, ymd, { create: true });
  assert.deepEqual(m.event, { id: ev.id, date: ymd });
  assert.equal(m.folderId, folder.id);
  assert.deepEqual(m.blocks.map((b) => [b.t, blockText(b)]), [['h1', 'Standup'], ['h3', 'Notes'], ['p', ''], ['h3', 'Action items'], ['check', '']]);
  assert.equal(N.meetingNote(ev.id, ymd).id, m.id);
  assert.equal(N.meetingNote(ev.id, addDaysYmd(ymd, 7)), null, 'one note per occurrence');
});

test('tags: counts with first-seen casing, rename (children follow), remove, add to many — all undoable', () => {
  for (const n of db.all('notes').slice()) db.remove('notes', n.id);
  const a = N.createNote({ blocks: [B('h1', 'A'), B('p', 'about #Work and #work/Clients')] });
  const b = N.createNote({ blocks: [B('h1', 'B'), B('p', '#work')] });
  const editedBefore = N.getNote(a.id).editedAt;
  assert.deepEqual(N.allTagCounts(), [{ tag: 'work', count: 2, label: 'Work' }, { tag: 'work/clients', count: 1, label: 'work/Clients' }]);
  const undo = N.renameTag('work', 'Job');
  assert.equal(undo.count, 2);
  assert.deepEqual(texts(a), ['A', 'about #Job and #Job/Clients']);
  assert.equal(N.getNote(a.id).editedAt, editedBefore, 'a tag rename is not a content edit');
  undo();
  assert.deepEqual(texts(a), ['A', 'about #Work and #work/Clients']);
  const rm = N.removeTag('work');
  assert.deepEqual(texts(a), ['A', 'about and']);
  assert.deepEqual(texts(b), ['B'], 'a line that was only the tag goes');
  rm();
  assert.deepEqual(texts(b), ['B', '#work']);
  const add = N.addTagToNotes([a.id, b.id], 'urgent');
  assert.equal(add.count, 2);
  assert.ok(N.getNote(b.id).tags.includes('urgent'));
  add();
  assert.ok(!N.getNote(b.id).tags.includes('urgent'));
});

test('renaming a tag in long text keeps the ids of the blocks it was split into (links to them keep working)', () => {
  // Stored as big (20,000 characters) and big-1: the longer name splits big again, and that piece
  // must not be named big-1 too (the stored big-1 would get a random id on save).
  const text = `${'word '.repeat(3995)}#Proj ${'more '.repeat(2000)}`;
  const n = N.createNote({ blocks: [B('h1', 'Long'), { id: 'big', t: 'p', c: [[text]] }] });
  const ids = N.getNote(n.id).blocks.map((b) => b.id);
  assert.deepEqual(ids.slice(1), ['big', 'big-1']);
  const tail = texts(n)[2];
  const undo = N.renameTag('proj', 'project-alpha');
  const after = N.getNote(n.id).blocks;
  assert.equal(after.length, 4, 'big was split again');
  assert.equal(new Set(after.map((b) => b.id)).size, after.length, 'ids stay unique');
  assert.deepEqual([after[0].id, after[1].id, after[3].id], ids, 'every block keeps its id, in place');
  assert.equal(blockText(after.find((b) => b.id === 'big-1')), tail, 'big-1 keeps its text');
  assert.equal(after.slice(1).map(blockText).join(' '), text.replace('#Proj ', '#project-alpha '));
  undo();
  assert.deepEqual(N.getNote(n.id).blocks.map((b) => b.id), ids);
  assert.equal(texts(n)[2], tail);
});

test('Send to Tasks: parsed tasks with source, linked items, two-way sync, repeating tasks', () => {
  const list = db.insert('lists', { name: 'Errands', color: 'teal', order: 0 });
  const n = N.createNote({ blocks: [B('h1', 'Errands'), B('check', 'Buy milk tomorrow #shop', { in: 1 }), B('bullet', 'Call Sam fri 3pm', { in: 0 }), B('p', ''), B('hr')] });
  const ids = n.blocks.map((b) => b.id);
  const tasks = N.sendBlocksToTasks(n.id, ids.slice(1), { listId: list.id });
  assert.equal(tasks.length, 2, 'empty lines and dividers are skipped');
  const [milk, sam] = tasks;
  assert.equal(milk.title, 'Buy milk');
  assert.equal(milk.date, addDaysYmd(todayYmd(), 1));
  assert.deepEqual(milk.tags, ['shop'], 'note tags become task labels, never lists');
  assert.equal(milk.listId, list.id);
  assert.deepEqual(milk.source, { app: 'notes', noteId: n.id, blockId: ids[1] }, 'source survives the store validators');
  assert.equal(sam.time, '15:00');
  const saved = N.getNote(n.id);
  assert.deepEqual(saved.blocks.slice(1, 3).map((b) => [b.t, b.in, b.task, blockText(b)]), [['check', 1, milk.id, 'Buy milk'], ['check', 0, sam.id, 'Call Sam']]);
  assert.deepEqual(N.sendBlocksToTasks(n.id, ids.slice(1)), [], 'already linked items are skipped');
  // block → task
  const r = N.setChecked(n.id, ids[1], true);
  assert.equal(db.get('tasks', milk.id).done, true);
  assert.equal(r.next, null);
  N.saveBlocks(n.id, N.getNote(n.id).blocks.map((b) => (b.id === ids[2] ? { ...b, c: [['Call Sam about dinner']] } : b)));
  assert.equal(db.get('tasks', sam.id).title, 'Call Sam about dinner');
  // task → block
  db.update('tasks', milk.id, { done: false, completedAt: null, title: 'Buy oat milk' });
  const synced = N.syncTaskChecks(n.id);
  assert.equal(synced.blocks[1].ck, false);
  assert.equal(blockText(synced.blocks[1]), 'Buy oat milk');
  assert.equal(N.syncTaskChecks(n.id), null, 'nothing left to sync');
  // repeating: completing advances the task and the item unchecks itself
  db.update('tasks', sam.id, { repeat: { freq: 'week', interval: 1 }, date: todayYmd() });
  const rep = N.setChecked(n.id, ids[2], true);
  assert.equal(rep.note.blocks[2].ck, false);
  assert.equal(rep.next, addDaysYmd(todayYmd(), 7));
  // a deleted task clears the link and keeps the text
  db.remove('tasks', milk.id);
  assert.equal(N.syncAllTaskChecks(), 1);
  assert.equal(N.getNote(n.id).blocks[1].task, undefined);
  assert.equal(blockText(N.getNote(n.id).blocks[1]), 'Buy oat milk');
});

test('pin, move, duplicate, hide from AI', () => {
  const f = N.createFolder({ name: 'Moves' });
  const n = N.createNote({ blocks: [B('h1', 'Movable'), B('check', 'x', { task: 'tk' })] });
  const rev = n.rev;
  assert.equal(N.setPinned(n.id, true).pinned, true);
  assert.equal(N.getNote(n.id).rev, rev + 1);
  assert.equal(N.getNote(n.id).editedAt, n.editedAt, 'pinning is not an edit');
  assert.equal(N.moveNote(n.id, f.id).folderId, f.id);
  assert.equal(N.moveNote(n.id, 'missing').folderId, null);
  const undo = N.moveNotes([n.id], f.id);
  assert.equal(N.getNote(n.id).folderId, f.id);
  undo();
  assert.equal(N.getNote(n.id).folderId, null);
  const copy = N.duplicateNote(n.id);
  assert.notEqual(copy.id, n.id);
  assert.equal(copy.title, 'Movable');
  assert.ok(copy.blocks.every((b, i) => b.id !== N.getNote(n.id).blocks[i].id));
  assert.equal(copy.blocks[1].task, undefined, 'a copy is not linked to the task');
  assert.equal(N.setNoteAiHidden(n.id, true).aiHidden, true);
  assert.ok(N.isHiddenFromAi(N.getNote(n.id)));
  N.setFolderAiHidden(f.id, true);
  N.setNoteAiHidden(n.id, false);
  N.moveNote(n.id, f.id);
  assert.ok(N.isHiddenFromAi(N.getNote(n.id)), 'inherited from the folder');
  assert.equal(N.noteFolderPath(N.getNote(n.id)), 'Moves');
});

test('AI review: keep, undo, an AI-created note goes to Recently Deleted, expiry after 7 days', () => {
  const n = N.createNote({ blocks: [B('h1', 'Mine')] });
  N.saveBlocks(n.id, [B('h1', 'Mine'), B('p', 'AI line')], { by: 'mcp:claude' });
  assert.equal(N.reviewAiEdit(n.id, 'keep').aiPrev, null);
  assert.deepEqual(texts(n), ['Mine', 'AI line']);
  const ai = db.update('notes', N.createNote({ blocks: [B('h1', 'By AI')] }).id, { aiPrev: { at: Date.now(), by: 'mcp:grok', rev: 0, blocks: [] }, editedBy: 'mcp:grok' });
  const undone = N.reviewAiEdit(ai.id, 'undo');
  assert.ok(undone.trashedAt);
  const stale = N.createNote({ blocks: [B('h1', 'Stale')] });
  db.update('notes', stale.id, { aiPrev: { at: Date.now() - 8 * 86400000, by: 'mcp:other', rev: 1, blocks: validateBlocks([B('p', 'old')]) } });
  const expired = N.expireAiReviews();
  assert.deepEqual(expired.map((x) => x.id), [stale.id]);
  assert.equal(expired[0].aiPrev.blocks[0].c[0][0], 'old', 'returned with the copy so history can keep it');
  assert.equal(N.getNote(stale.id).aiPrev, null);
});

test('sample notes and folders are valid, linked and delightful', () => {
  const s = sampleNotesAndFolders(todayYmd());
  assert.equal(s.folders.length, 3);
  assert.ok(s.notes.length >= 3 && s.notes.length <= 5);
  for (const f of s.folders) db.insert('folders', f);
  for (const n of s.notes) db.insert('notes', n);
  const stored = s.notes.map((n) => N.getNote(n.id));
  assert.ok(stored.every((n) => n && n.blocks.length && n.title));
  assert.ok(stored.some((n) => n.blocks.some((b) => b.t === 'check')), 'a checklist');
  assert.ok(stored.some((n) => n.day === todayYmd()), "today's daily note");
  assert.ok(stored.some((n) => n.title === 'Project kickoff' && n.event === null && n.folderId), 'meeting notes, not linked to an event, in a nested folder');
  assert.ok(stored.some((n) => n.pinned));
  const groceries = stored.find((n) => n.title === 'Groceries');
  assert.ok(N.backlinks(groceries.id).length >= 2, 'other samples link to it');
  assert.ok(stored.some((n) => n.tags.length));
  assert.ok(stored.every((n) => n.createdAt === n.updatedAt), 'untouched samples (sync treats them as pristine)');
  const work = N.folderTree().find((x) => x.folder.id === s.folders[0].id);
  assert.equal(work.count, 1, 'rolled up from Meetings');
  assert.equal(work.own, 0);
  const t = db.insert('tasks', { title: 'Reply to Taylor', notes: '', listId: null, tags: [], priority: 0, date: todayYmd(), done: false });
  const linked = sampleNotesAndFolders(todayYmd(), { task: t }).notes.find((n) => n.day);
  const item = linked.blocks.find((b) => b.task);
  assert.deepEqual([item.task, blockText(item), item.ck], [t.id, 'Reply to Taylor', false], "today's note links the sample task");
});

test('saving more than a note holds throws note_too_large and changes nothing (never a silent cut)', () => {
  const n = N.createNote({ blocks: [B('h1', 'Big')] });
  const rev = N.getNote(n.id).rev;
  const blocks = [B('h1', 'Big'), ...Array.from({ length: 300 }, (_, i) => B('p', `para ${i} ${'x'.repeat(1000)}`)), B('p', 'LAST LINE')];
  assert.throws(() => N.saveBlocks(n.id, blocks), (e) => e.code === 'note_too_large' && e instanceof N.NoteTooLargeError && e.size > 256 * 1024 && /too long to save/.test(e.message));
  assert.equal(N.getNote(n.id).rev, rev, 'nothing was written');
  assert.deepEqual(texts(n), ['Big']);
  assert.throws(() => N.saveBlocks(n.id, Array.from({ length: 5001 }, (_, i) => B('p', `${i}`))), (e) => e.code === 'note_too_large' && e.count === 5001);
  assert.throws(() => N.createNote({ blocks }), (e) => e.code === 'note_too_large');
  // a block longer than 20,000 characters is split, not cut
  const long = N.saveBlocks(n.id, [B('h1', 'Big'), B('p', 'y'.repeat(25000))]);
  assert.deepEqual(long.blocks.map((b) => blockText(b).length), [3, 20000, 5000]);
  // add tag: a note that is full keeps its text, the rest are tagged, and the caller learns how many were skipped
  const full = N.createNote({ blocks: Array.from({ length: 5000 }, (_, i) => B('p', `${i} #x`)) });
  const other = N.createNote({ blocks: [B('h1', 'Small')] });
  const undo = N.addTagToNotes([full.id, other.id], 'later');
  assert.equal(undo.count, 1);
  assert.equal(undo.tooLarge, 1);
  assert.equal(N.getNote(full.id).blocks.length, 5000);
  assert.ok(N.getNote(other.id).tags.includes('later'));
  undo();
  for (const x of [n, full, other]) N.deleteForever(x.id);
});
