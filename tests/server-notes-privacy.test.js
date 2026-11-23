// The notes rules for assistants (notes-spec section 7) hold in the core tools too (server/core.mjs,
// server/tools.mjs, server/ai-store.mjs): a note hidden from AI (itself, or a folder above it), a locked
// note, or any note while notes access is Off, never shows up in find_changes, undo_change or
// get_context's totals, and an assistant can't undo a change to it (nor to any note while notes access
// is Read). Notes access is read as the notes tools read it (any case, spaces ignored, an unknown value
// counts as Read). The user can still undo it from Connect AI. Undoing the creation of a note moves it
// to Recently Deleted (no hard delete), and the undo of that undo brings it back; a folder the change
// created stays while the user's notes or folders are in it (else a hidden parent would stop hiding them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as coreMod from '../server/core.mjs';
import * as aiStore from '../server/ai-store.mjs';
import { validateNote } from '../notes/core/schema.js';
import { ymd } from '../shared/dates.js';

const { createCore } = coreMod;
const changeRefs = (...a) => aiStore.changeRefs(...a);
const isRelink = (...a) => aiStore.isRelink(...a);

const silent = { warn() {}, error() {}, info() {}, log() {} };
const MASK = 'Changed a note or folder that is hidden from AI assistants';
const LOCK = { iv: 'aaaaaaaaaaaaaaaa', ct: 'QUJDRA' };

/** A fresh core on a temp data folder, with one Claude connection; removed afterwards. */
async function withCore(fn) {
  const core = await createCore({ dataDir: mkdtempSync(join(tmpdir(), 'ecosys-notes-privacy-')), log: silent });
  try {
    const client = core.ai.createClient({ kind: 'claude', label: 'Claude' });
    const call = (name, args) => core.callTool(name, args, { client });
    const ok = (r) => {
      assert.equal(r.isError, false, r.content[0].text);
      return r.structuredContent;
    };
    await fn({ core, client, call, ok });
  } finally {
    core.close();
    rmSync(core.dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

const text = (r) => r.content[0].text;
/** Everything find_changes tells the assistant, text and structured content. */
const changesSeen = (call) => {
  const r = call('find_changes', { limit: 50 });
  assert.equal(r.isError, false, text(r));
  return { r, all: `${text(r)}\n${JSON.stringify(r.structuredContent)}`, changes: r.structuredContent.changes };
};
const setNotesAi = (core, v) => core.store.transaction((tx) => tx.setSettings({ notesAi: v }));
const putNote = (core, id, patch) => core.store.transaction((tx) => tx.put('notes', { ...tx.get('notes', id), ...patch, updatedAt: Date.now() }));
const folderNamed = (core, name) => core.store.all('folders').find((f) => f.name === name);
/** A note of the user's own, as the Notes app syncs it (not through MCP). */
function userNote(core, id, title, body, folderId, extra = {}) {
  const t = Date.now() - 1000;
  const item = {
    id, v: 1, rev: 1, blocks: [{ id: `${id}h`, t: 'h1', c: [[title]] }, { id: `${id}p`, t: 'p', c: [[body]] }], folderId, pinned: false, day: null, event: null,
    aiHidden: false, aiPrev: null, locked: null, editedBy: 'user', editedAt: t, createdAt: t, updatedAt: t, trashedAt: null, trashedFrom: null, ...extra,
  };
  assert.deepEqual(core.store.applyOps([{ op: 'put', c: 'notes', item }]).rejected, []);
  return id;
}
const putFolder = (core, item) => assert.deepEqual(core.store.applyOps([{ op: 'put', c: 'folders', item: { color: 'graphite', order: 0, aiHidden: false, createdAt: 1, updatedAt: 1, ...item } }]).rejected, []);

test('find_changes: a change to a note hidden from AI (itself, by a folder, or locked) is listed without its summary', async () => {
  await withCore(async ({ core, call, ok }) => {
    const med = ok(call('notes_create', { markdown: '# Medical results\nBlood test on Friday.', folder: 'Private/Health' }));
    const salary = ok(call('notes_create', { markdown: '# Salary plan\nAsk for a raise.' }));
    const diary = ok(call('notes_create', { markdown: '# Diary entry\nDear diary.' }));
    const shop = ok(call('notes_create', { markdown: '# Shopping list\nOat milk.' }));
    ok(call('notes_append', { id: med.id, markdown: 'Results came back fine.' }));
    ok(call('create_tasks', { tasks: [{ title: 'Water the plants' }] }));
    const before = changesSeen(call);
    for (const t of ['Medical results', 'Salary plan', 'Diary entry', 'Shopping list', 'Water the plants']) assert.ok(before.all.includes(t), `${t} is named while visible`);

    // The top folder of Private/Health is hidden, Salary plan is hidden itself, Diary entry is locked.
    core.store.transaction((tx) => tx.put('folders', { ...folderNamed(core, 'Private'), aiHidden: true, updatedAt: Date.now() }));
    putNote(core, salary.id, { aiHidden: true });
    putNote(core, diary.id, { locked: LOCK });
    const after = changesSeen(call);
    for (const t of ['Medical', 'Salary', 'Diary', 'Private', 'Health', 'Blood']) assert.ok(!after.all.includes(t), `${t} never shows`);
    assert.ok(after.all.includes('Shopping list') && after.all.includes('Water the plants'), 'visible notes and tasks are still named');
    assert.equal(after.changes.length, before.changes.length, 'the changes are still listed (their change_id too)');
    // Masked: the four changes that touched a hidden note or folder (two creates, one append, one more create).
    assert.equal(after.changes.filter((c) => c.summary === MASK).length, 4);
    assert.ok(after.changes.filter((c) => c.summary === MASK).every((c) => /^chg_/.test(c.change_id)));
  });
});

test('find_changes with notes access Off names no note change at all; with Read the visible ones are still named', async () => {
  await withCore(async ({ core, call, ok }) => {
    const shop = ok(call('notes_create', { markdown: '# Shopping list\nOat milk.' }));
    const secret = ok(call('notes_create', { markdown: '# Secret recipe\nCardamom.' }));
    ok(call('create_tasks', { tasks: [{ title: 'Water the plants' }] }));
    putNote(core, secret.id, { aiHidden: true });
    setNotesAi(core, 'off');
    let seen = changesSeen(call);
    assert.ok(!seen.all.includes('Shopping list') && !seen.all.includes('Secret recipe'), 'Off: no note is named');
    assert.ok(seen.all.includes('Water the plants'), 'Off: task changes are still listed by name');
    setNotesAi(core, 'read');
    seen = changesSeen(call);
    assert.ok(seen.all.includes('Shopping list'), 'Read: reading is allowed, so visible notes are named');
    assert.ok(!seen.all.includes('Secret recipe'), 'Read: the hidden one is not');
    assert.ok(shop.id);
  });
});

test('undo_change by an assistant: a note it can\'t see now is left alone and never named; the user can still undo it', async () => {
  await withCore(async ({ core, call, ok }) => {
    // Folder hidden after the assistant edited a note in it: nothing it may undo.
    const med = ok(call('notes_create', { markdown: '# Medical results\nBlood test on Friday.', folder: 'Private' }));
    const add = ok(call('notes_append', { id: med.id, markdown: 'Results came back fine.' }));
    core.store.transaction((tx) => tx.put('folders', { ...folderNamed(core, 'Private'), aiHidden: true, updatedAt: Date.now() }));
    const stored = JSON.stringify(core.store.get('notes', med.id));
    const refused = call('undo_change', { change_id: add.change_id });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /Nothing was undone: chg_\w+ changed notes or folders the user doesn't let AI assistants see or change now/);
    assert.ok(!/Medical|Blood|Private/.test(text(refused)) && !text(refused).includes(med.id), text(refused));
    assert.equal(JSON.stringify(core.store.get('notes', med.id)), stored, 'the note is unchanged');
    // A later undo_change of the same change by the assistant is refused again (it was never marked undone).
    assert.equal(call('undo_change', { change_id: add.change_id }).isError, true);
    // The user (Connect AI, no actor) can undo it.
    const mine = core.undo(add.change_id, null);
    assert.equal(mine.data.restored, 1);
    assert.ok(!JSON.stringify(core.store.get('notes', med.id)).includes('Results came back fine'));
    // ...and that undo, which repeats the summary, is not named to the assistant either.
    const seen = changesSeen(call);
    assert.ok(!seen.all.includes('Medical'), seen.all);
    const undoRow = seen.changes.find((c) => c.change_id === mine.data.change_id);
    assert.equal(undoRow.summary, MASK);
    assert.equal(undoRow.undo_of, add.change_id);
  });
});

test('undo_change by an assistant: only the parts it may change are undone, and the summary is not repeated', async () => {
  await withCore(async ({ core, call, ok }) => {
    // A note with a checklist item sent to Tasks; checking it in the note completes the task too.
    const n = ok(call('notes_create', { markdown: '# Contract review\n- [ ] Call the lawyer' }));
    ok(call('notes_send_to_tasks', { id: n.id }));
    const note = core.store.get('notes', n.id);
    const block = note.blocks.find((b) => b.t === 'check');
    const taskId = block.task;
    const done = ok(call('notes_update', { id: n.id, ifRev: note.rev, ops: [{ op: 'set_checked', block: block.id, checked: true }] }));
    assert.equal(core.store.get('tasks', taskId).done, true);
    putNote(core, n.id, { aiHidden: true });
    const hidden = JSON.stringify(core.store.get('notes', n.id));
    const r = call('undo_change', { change_id: done.change_id });
    assert.equal(r.isError, false, text(r));
    assert.ok(!/Contract|lawyer/.test(`${text(r)}${JSON.stringify(r.structuredContent)}`), text(r));
    assert.match(text(r), new RegExp(`^Undid ${done.change_id} \\(${MASK}\\): restored 1 item\\(s\\)\\.`));
    assert.match(text(r), /Left alone because the user doesn't let AI assistants see or change them: 1 note\(s\) or folder\(s\)\./);
    assert.deepEqual(r.structuredContent.skipped, [{ c: 'notes', id: null, title: 'a note', reason: 'not available to AI assistants' }]);
    assert.ok(!JSON.stringify(r.structuredContent).includes(n.id), 'not even its id');
    assert.equal(core.store.get('tasks', taskId).done, false, 'the task (visible) is open again');
    assert.equal(JSON.stringify(core.store.get('notes', n.id)), hidden, 'the hidden note is left as it is');
  });
});

test('undo_change by an assistant: with notes access Read or Off, notes changes are not undone', async () => {
  await withCore(async ({ core, call, ok }) => {
    const n = ok(call('notes_create', { markdown: '# Trip ideas\nLisbon in May.' }));
    const add = ok(call('notes_append', { id: n.id, markdown: 'Porto too.' }));
    const stored = JSON.stringify(core.store.get('notes', n.id));
    for (const mode of ['read', 'off']) {
      setNotesAi(core, mode);
      const r = call('undo_change', { change_id: add.change_id });
      assert.equal(r.isError, true, `${mode}: ${text(r)}`);
      assert.match(text(r), /notes access set to Read or Off/);
      assert.equal(JSON.stringify(core.store.get('notes', n.id)), stored, `${mode}: unchanged`);
      if (mode === 'off') assert.ok(!text(r).includes('Trip'), 'Off: the note is not named');
    }
    setNotesAi(core, 'edit');
    ok(call('undo_change', { change_id: add.change_id }));
    assert.ok(!JSON.stringify(core.store.get('notes', n.id)).includes('Porto'));
  });
});

test('undoing notes_create moves the note to Recently Deleted (no hard delete); undoing that brings it back', async () => {
  await withCore(async ({ core, call, ok }) => {
    const n = ok(call('notes_create', { markdown: '# Trip ideas\nLisbon in May.', folder: 'Travel' }));
    const folderId = core.store.get('notes', n.id).folderId;
    assert.ok(folderId);
    const u = ok(call('undo_change', { change_id: n.change_id }));
    const trashed = core.store.get('notes', n.id);
    assert.ok(trashed, 'the note still exists');
    assert.ok(trashed.trashedAt > 0, 'in Recently Deleted');
    assert.equal(trashed.trashedFrom, folderId, 'Recover knows where it was');
    assert.equal(trashed.aiPrev, null, 'no review banner on a deleted note');
    assert.equal(core.store.get('folders', folderId), null, 'the folder the change created is gone again');
    assert.match(text(call('notes_read', { id: n.id })), /not_found/, 'deleted notes are invisible to assistants');
    assert.ok(u.restored >= 2);
    // The undo of the undo brings it back as it was.
    ok(call('undo_change', { change_id: u.change_id }));
    const back = core.store.get('notes', n.id);
    assert.equal(back.trashedAt, null);
    assert.ok(back.blocks.length > 0 && core.store.get('folders', folderId));
    // From Connect AI (the user) too, and for a daily note notes_append started.
    const d = ok(call('notes_append', { day: 'today', markdown: 'Standup went well.' }));
    assert.equal(d.created, true);
    core.undo(d.change_id, null);
    const daily = core.store.get('notes', d.id);
    assert.ok(daily && daily.trashedAt > 0 && daily.day === ymd(new Date()), 'the daily note went to Recently Deleted');
  });
});

test('get_context counts only the notes an assistant may see, and none while notes access is Off', async () => {
  await withCore(async ({ core, call, ok }) => {
    const totals = () => {
      const r = call('get_context', {});
      assert.equal(r.isError, false, text(r));
      return { line: text(r).split('\n').find((l) => l.startsWith('Totals')), notes: r.structuredContent.counts.notes };
    };
    const ids = [];
    for (const md of ['# One\na', '# Two\nb', '# Hidden\nc', '# Locked\nd', '# Deleted\ne']) ids.push(ok(call('notes_create', { markdown: md })).id);
    const inFolder = ok(call('notes_create', { markdown: '# Deep\nf', folder: 'Private/Inner' })).id;
    assert.equal(totals().notes, 6);
    putNote(core, ids[2], { aiHidden: true });
    putNote(core, ids[3], { locked: LOCK });
    putNote(core, ids[4], { trashedAt: Date.now() });
    core.store.transaction((tx) => tx.put('folders', { ...folderNamed(core, 'Private'), aiHidden: true, updatedAt: Date.now() }));
    let t = totals();
    assert.equal(t.notes, 2, 'One and Two only');
    assert.match(t.line, /, 2 notes\.$/);
    setNotesAi(core, 'read');
    assert.equal(totals().notes, 2);
    setNotesAi(core, 'off');
    t = totals();
    assert.equal(t.notes, undefined, 'Off: no count');
    assert.ok(!/note/.test(t.line), t.line);
    setNotesAi(core, 'edit');
    for (const id of ids.slice(0, 2)) putNote(core, id, { aiHidden: true });
    t = totals();
    assert.equal(t.notes, undefined, 'nothing visible: no count (not even "0 notes")');
    assert.ok(inFolder);
  });
});

test('ai-store: changes list the notes and folders they edited, not meeting-note links that moved with an event', () => {
  const note = { id: 'n1', v: 1, rev: 3, blocks: [{ id: 'b', t: 'p', c: [['x']] }], event: { id: 'e1', date: '2026-11-23' }, updatedAt: 1 };
  const moved = { ...note, rev: 4, event: { id: 'e2', date: '2026-11-24' }, updatedAt: 2 };
  const edited = { ...moved, blocks: [{ id: 'b', t: 'p', c: [['y']] }] };
  assert.equal(isRelink('notes', note, moved), true);
  assert.equal(isRelink('notes', note, edited), false, 'text changed too');
  assert.equal(isRelink('notes', note, { ...note, rev: 4 }), false, 'nothing moved');
  assert.equal(isRelink('notes', note, null), false);
  assert.equal(isRelink('events', note, moved), false);
  const before = [
    { c: 'notes', id: 'n1', item: note },
    { c: 'notes', id: 'n2', item: null },
    { c: 'folders', id: 'f1', item: { id: 'f1', name: 'Work' } },
    { c: 'events', id: 'e1', item: { id: 'e1' } },
    { c: 'notes', id: 'bad id!', item: null },
  ];
  const after = [
    { c: 'notes', id: 'n1', item: moved },
    { c: 'notes', id: 'n2', item: { id: 'n2' } },
    { c: 'folders', id: 'f1', item: null },
    { c: 'events', id: 'e1', item: null },
    { c: 'notes', id: 'bad id!', item: {} },
  ];
  assert.deepEqual(changeRefs(before, after), ['notes:n2', 'folders:f1']);
  assert.deepEqual(changeRefs([{ c: 'notes', id: 'n1', item: note }], [{ c: 'notes', id: 'n1', item: edited }]), ['notes:n1']);
});

test('ai-store: refs are saved with each change (ids only) and an undo keeps those of the change it took back', async () => {
  await withCore(async ({ core, call, ok }) => {
    const n = ok(call('notes_create', { markdown: '# Plans\nx', folder: 'Work' }));
    const t = ok(call('create_tasks', { tasks: [{ title: 'Buy milk' }] }));
    const rec = core.ai.change(n.change_id);
    assert.deepEqual([...rec.refs].sort(), [`folders:${folderNamed(core, 'Work').id}`, `notes:${n.id}`].sort());
    assert.deepEqual(core.ai.change(t.change_id).refs, []);
    // Saved in ai.json and read back the same way after a restart.
    core.ai.load();
    assert.deepEqual([...core.ai.change(n.change_id).refs].sort(), [...rec.refs].sort());
    const u = core.undo(n.change_id, null);
    assert.deepEqual([...core.ai.change(u.data.change_id).refs].sort(), [...rec.refs].sort());
  });
});

test('change records from before refs existed: worked out from their undo data', async () => {
  await withCore(async ({ core, call, ok }) => {
    const n = ok(call('notes_create', { markdown: '# Old record\nx' }));
    // As an older ecosys saved it: no refs.
    core.ai.mutate((s) => {
      const r = s.changes.find((x) => x.changeId === n.change_id);
      delete r.refs;
    });
    core.ai.load();
    assert.equal(core.ai.change(n.change_id).refs, null);
    putNote(core, n.id, { aiHidden: true });
    const seen = changesSeen(call);
    assert.ok(!seen.all.includes('Old record'), seen.all);
    assert.equal(seen.changes.find((c) => c.change_id === n.change_id).summary, MASK);
    assert.equal(call('undo_change', { change_id: n.change_id }).isError, true);
  });
});

test('notes access is read as the notes tools read it: any case, spaces ignored, an unknown value counts as Read', async () => {
  await withCore(async ({ core, call, ok }) => {
    const n = ok(call('notes_create', { markdown: '# Trip ideas\nLisbon in May.' }));
    const adds = [];
    for (const [value, access] of [['OFF', 'off'], ['Off', 'off'], [' off ', 'off'], ['Read', 'read'], ['readonly', 'read'], ['ask', 'read']]) {
      const what = JSON.stringify(value);
      setNotesAi(core, 'edit');
      const add = ok(call('notes_append', { id: n.id, markdown: `Line for ${value}` }));
      adds.push(add.change_id);
      setNotesAi(core, value);
      assert.equal(core.store.settings().notesAi, value, `${what} is stored as sent (the browser API takes it too)`);
      // The notes tools themselves treat it so.
      const direct = call('notes_update', { id: n.id, ifRev: core.store.get('notes', n.id).rev, markdown: '# Trip ideas\nOverwritten' });
      assert.match(text(direct), access === 'off' ? /^ai_access_off:/ : /^ai_access_read_only:/, what);
      // find_changes: Off names no note change; Read still names the notes it may read.
      const seen = changesSeen(call);
      const row = seen.changes.find((c) => c.change_id === add.change_id);
      if (access === 'off') {
        assert.equal(row.summary, MASK, what);
        assert.ok(!seen.all.includes('Trip ideas'), `${what}: ${seen.all}`);
        assert.equal(call('get_context', {}).structuredContent.counts.notes, undefined, `${what}: no note count`);
      } else {
        assert.equal(row.summary, 'Added to note "Trip ideas"', what);
      }
      // undo_change: refused either way, and the note is left exactly as it is.
      const stored = JSON.stringify(core.store.get('notes', n.id));
      const u = call('undo_change', { change_id: add.change_id });
      assert.equal(u.isError, true, `${what}: ${text(u)}`);
      assert.match(text(u), /notes access set to Read or Off/, what);
      if (access === 'off') assert.ok(!text(u).includes('Trip'), `${what}: ${text(u)}`);
      assert.equal(JSON.stringify(core.store.get('notes', n.id)), stored, `${what}: the note is unchanged`);
    }
    // ' EDIT ' is Read & edit: the assistant may undo again (the last line it added goes).
    setNotesAi(core, ' EDIT ');
    ok(call('undo_change', { change_id: adds.at(-1) }));
    assert.ok(!JSON.stringify(core.store.get('notes', n.id).blocks).includes('Line for ask'));
  });
});

test('notesAccessOf (the core) reads notesAi exactly as the notes tools do', async () => {
  const st = (v) => ({ settings: () => (v === undefined ? {} : { notesAi: v }) });
  const table = [
    [undefined, 'edit'], [null, 'edit'], ['', 'edit'], ['edit', 'edit'], [' Edit ', 'edit'], ['EDIT', 'edit'],
    ['read', 'read'], ['READ', 'read'], ['off', 'off'], [' OFF ', 'off'], ['Off\t', 'off'],
    ['ask', 'read'], ['readonly', 'read'], ['none', 'read'], [0, 'read'], [false, 'read'], [true, 'read'], [{}, 'read'], [['off'], 'read'],
  ];
  const notesTools = await import('../server/tools-notes.mjs').catch(() => null);
  for (const [v, want] of table) {
    assert.equal(coreMod.notesAccessOf(st(v)), want, `core: ${JSON.stringify(v)}`);
    if (typeof notesTools?.notesAiAccess === 'function') assert.equal(notesTools.notesAiAccess(st(v)), want, `notes tools: ${JSON.stringify(v)}`);
  }
  assert.equal(coreMod.notesAccessOf({ settings: () => null }), 'edit');
});

test("undoing a change that made folders keeps a folder the user's notes are in now, so a hidden parent still hides them", async () => {
  await withCore(async ({ core, call, ok }) => {
    const made = ok(call('notes_create', { markdown: '# Clinic list\nDr. Lee', folder: 'Private/Health' }));
    const health = folderNamed(core, 'Health').id;
    const priv = folderNamed(core, 'Private').id;
    // The user files a note of their own in Health, then hides Private (synced from the Notes app).
    userNote(core, 'usrDiag', 'Diagnosis results', 'Very private', health);
    putFolder(core, { ...core.store.get('folders', priv), aiHidden: true, updatedAt: Date.now() });
    assert.equal(ok(call('notes_search', { query: 'Diagnosis' })).total, 0);
    // The assistant may not undo it (both folders are hidden from it now); the user can, from Connect AI.
    assert.equal(call('undo_change', { change_id: made.change_id }).isError, true);
    const u = core.undo(made.change_id, null);
    assert.ok(core.store.get('notes', made.id).trashedAt > 0, "the assistant's note went to Recently Deleted");
    assert.ok(core.store.get('folders', health), 'Health stays: a note of the user is in it');
    assert.ok(core.store.get('folders', priv), 'Private stays (it changed since, and Health is in it)');
    assert.equal(core.store.get('notes', 'usrDiag').folderId, health);
    assert.deepEqual(u.data.skipped.map((s) => `${s.c} ${s.title}: ${s.reason}`).sort(), ['folders Health: changed again since', 'folders Private: changed again since']);
    const r = call('notes_search', { query: 'Diagnosis' });
    assert.equal(r.structuredContent.total, 0, `still hidden from assistants: ${text(r)}`);
    assert.ok(!text(r).includes('Very private'));
  });
});

test('undoing a folder creation: a deleted note filed there, a folder made in it, or its own note edited since keeps it; else every folder goes, inner ones first', async () => {
  await withCore(async ({ core, call, ok }) => {
    // The assistant undoes its own change; the user's note in the folder is hidden from AI itself.
    const a = ok(call('notes_create', { markdown: '# Packing list\nSocks', folder: 'Trips' }));
    const trips = folderNamed(core, 'Trips').id;
    userNote(core, 'usrPass', 'Passport scan', 'Number 123', trips, { aiHidden: true });
    const r = call('undo_change', { change_id: a.change_id });
    assert.equal(r.isError, false, text(r));
    assert.match(text(r), /restored 1 item\(s\)\.\nLeft alone because they changed again since: folder "Trips"\./);
    assert.ok(!/Passport|usrPass|123/.test(`${text(r)}${JSON.stringify(r.structuredContent)}`), text(r));
    assert.ok(core.store.get('folders', trips) && core.store.get('notes', a.id).trashedAt > 0);
    assert.equal(core.store.get('notes', 'usrPass').folderId, trips);

    // A note of the user's filed there and then deleted: Recover would put it back there.
    const b = ok(call('notes_create', { markdown: '# Soup\nLeek', folder: 'Recipes' }));
    const recipes = folderNamed(core, 'Recipes').id;
    userNote(core, 'usrGone', 'Old recipe', 'Bland', recipes, { trashedAt: Date.now() - 500, trashedFrom: recipes });
    core.undo(b.change_id, null);
    assert.ok(core.store.get('folders', recipes), 'kept for the deleted note');

    // A folder the user made inside it.
    const c = ok(call('notes_create', { markdown: '# Q3 plan\nGrow', folder: 'Work' }));
    const work = folderNamed(core, 'Work').id;
    putFolder(core, { id: 'usrClients', name: 'Clients', parentId: work });
    core.undo(c.change_id, null);
    assert.ok(core.store.get('folders', work) && core.store.get('folders', 'usrClients'));

    // Its own note, edited by the user since: the note stays, so its folder does too.
    const d = ok(call('notes_create', { markdown: '# Garden\nTomatoes', folder: 'Home' }));
    const home = folderNamed(core, 'Home').id;
    putNote(core, d.id, { blocks: [{ id: 'g1', t: 'h1', c: [['Garden']] }, { id: 'g2', t: 'p', c: [['Tomatoes and basil']] }], editedBy: 'user' });
    assert.throws(() => core.undo(d.change_id, null), /Nothing was undone: 2 item\(s\) were changed again/);
    assert.ok(core.store.get('folders', home) && !core.store.get('notes', d.id).trashedAt);

    // Nothing else in them: both folders of a path go (the inner one first), and the note is deleted softly.
    const e = ok(call('notes_create', { markdown: '# Someday\nSail', folder: 'Ideas/Later' }));
    const ideas = folderNamed(core, 'Ideas').id;
    const later = folderNamed(core, 'Later').id;
    const ue = core.undo(e.change_id, null);
    assert.deepEqual(ue.data.skipped, []);
    assert.equal(ue.data.restored, 3);
    assert.equal(core.store.get('folders', ideas), null);
    assert.equal(core.store.get('folders', later), null);
    assert.ok(core.store.get('notes', e.id).trashedAt > 0);
  });
});

test('ai-store: a meeting note saved in an older form (HTML body, no blocks) that only moved with its event is a link, not an edit', () => {
  const legacy = { id: 'nLeg', title: 'Legacy minutes', body: '<p>Secret legacy minutes</p>', folderId: null, event: { id: 'sLeg', date: '2026-12-04' }, aiHidden: true, createdAt: 5, updatedAt: 5 };
  // As the store saves it after update_event moved the link (server/tools.mjs relinkNotes writes it in today's form).
  const after = validateNote({ ...validateNote(legacy), event: { id: 'copy1', date: '2026-12-04' }, rev: 1, updatedAt: 99 });
  assert.equal(after.editedAt, 5, 'the edit time it had');
  assert.equal(isRelink('notes', legacy, after), false, 'compared as stored, the two forms differ in many fields');
  assert.equal(isRelink('notes', legacy, after, validateNote), true);
  assert.equal(isRelink('notes', legacy, { ...after, blocks: [{ id: 'x', t: 'p', c: [['Rewritten']] }] }, validateNote), false, 'an edit is still an edit');
  assert.equal(isRelink('notes', legacy, { ...after, event: legacy.event }, validateNote), false, 'nothing moved');
  assert.equal(isRelink('notes', legacy, after, () => { throw new Error('bad'); }), false);
  assert.deepEqual(changeRefs([{ c: 'notes', id: 'nLeg', item: legacy }], [{ c: 'notes', id: 'nLeg', item: after }], validateNote), []);
  assert.deepEqual(changeRefs([{ c: 'notes', id: 'nLeg', item: legacy }], [{ c: 'notes', id: 'nLeg', item: after }]), ['notes:nLeg']);
});
