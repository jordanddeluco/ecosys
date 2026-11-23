// QA fix (notes-core): notes and folders hidden from AI must be indistinguishable from ones that don't
// exist for the notes write tools too (notes-spec section 7). Before: a folder path through a hidden
// folder answered folder_unavailable while a missing one was created; notes_append on a day whose
// daily note is hidden or locked was refused while any other day got a note; and assistants had no
// way to make meeting notes at all. Now a hidden folder is passed over (a visible folder of that name
// is made beside it, nothing is ever filed in the hidden one), and a day or event occurrence whose
// note the assistant can't see gets a "stand-in": a plain note of the assistant's own that every
// notes tool shows as that day's daily note (or that occurrence's meeting notes), so every answer,
// and every later read, is the one a day or occurrence without a note gets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { meetingNotesOf } from '../server/tools-notes.mjs';
import { ymd, addDaysYmd } from '../shared/dates.js';
import { COLORS } from '../shared/sanitize.js';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const today = ymd(new Date());
const now = Date.now();
const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-hidden-'));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const blk = (id, t, s) => ({ id, t, c: s ? [[s]] : [] });
const N = (id, blocks, extra = {}) => ({ id, v: 1, rev: 1, blocks, folderId: null, pinned: false, day: null, event: null, aiHidden: false, aiPrev: null, locked: null, editedBy: 'user', editedAt: now - 3600000, createdAt: now - 86400000, updatedAt: now - 3600000, trashedAt: null, trashedFrom: null, ...extra });
const EV = (id, title, date, extra = {}) => ({ id, title, calendarId: 'cal', allDay: false, start: `${date}T10:00`, end: `${date}T10:30`, location: '', notes: '', repeat: null, exdates: [], until: null, createdAt: 1, updatedAt: 1, ...extra });
const LOCK = { iv: 'aaaaaaaaaaaaaaaa', ct: 'QUJDRA' };

const H = addDaysYmd(today, -3); // daily note hidden from AI
const L = addDaysYmd(today, -6); // daily note locked
const E = addDaysYmd(today, -4); // no daily note
const MH = addDaysYmd(today, 5); // the event whose meeting notes are hidden
const MN = addDaysYmd(today, 6); // the event without meeting notes

/** A tool result as the assistant sees it, with names, ids, dates and change ids made alike. */
const same = (t) =>
  t
    .replace(/Today is .*/, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
    .replace(/chg_\w+/g, 'chg')
    .replace(/\b[0-9a-z]{16}\b/g, 'ID')
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2}\b/g, 'DAY')
    .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')
    .replace(/\b\d{2}:\d{2}\b/g, 'HH:MM')
    .replace(/\brev([= ])\d+/g, 'rev$1N')
    .replace(/event_id=\w+/g, 'event_id=EV');

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
const stored = (id) => core.store.get('notes', id);

function seed(c) {
  c.store.applyOps([
    { op: 'put', c: 'calendars', item: { id: 'cal', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 } },
    { op: 'put', c: 'events', item: EV('evHid', 'Therapy session', MH) },
    { op: 'put', c: 'events', item: EV('evNone', 'Dentist', MN) },
    { op: 'put', c: 'folders', item: { id: 'fhid', name: 'Therapy', parentId: null, color: COLORS[0], order: 0, aiHidden: true, createdAt: 1, updatedAt: 1 } },
    { op: 'put', c: 'notes', item: N('nInHid', [blk('a', 'h1', 'Session notes')], { folderId: 'fhid' }) },
    { op: 'put', c: 'notes', item: N('dayHid', [blk('b', 'h1', 'Dear diary'), blk('c', 'p', 'private')], { day: H, aiHidden: true }) },
    { op: 'put', c: 'notes', item: N('dayLock', [], { title: 'Locked day', day: L, locked: LOCK }) },
    { op: 'put', c: 'notes', item: N('meetHid', [blk('d', 'h1', 'Therapy session'), blk('e', 'p', 'very private')], { event: { id: 'evHid', date: MH }, aiHidden: true }) },
    { op: 'put', c: 'notes', item: N('plain', [blk('f', 'h1', 'Shopping'), blk('g', 'p', 'milk')]) },
  ]);
}

before(async () => {
  core = await createCore({ dataDir: tempDir(), log: silent });
  seed(core);
  claude = core.ai.createClient({ kind: 'claude' });
});

test('a folder path through a hidden folder answers exactly like a path to a missing folder, and nothing is filed in the hidden one', () => {
  const hidden = call('notes_create', { markdown: '# probe one', folder: 'Therapy' });
  const absent = call('notes_create', { markdown: '# probe two', folder: 'Nowhere' });
  assert.equal(hidden.isError, false, hidden.text);
  assert.equal(same(hidden.text), same(absent.text), `hidden: ${hidden.text}\nabsent: ${absent.text}`);
  assert.deepEqual(hidden.data.created_folders, ['Therapy'], 'reported as a new folder, like the missing one');
  const twin = core.store.get('folders', stored(hidden.data.id).folderId);
  assert.deepEqual([twin.name, twin.parentId, twin.aiHidden], ['Therapy', null, false], 'a visible "Therapy" beside the hidden one');
  assert.notEqual(twin.id, 'fhid');
  // The new folder's colour is chosen among the folders the assistant can see: the hidden folder's
  // colour (COLORS[0]) is not skipped, so the choice says nothing about it.
  assert.equal(twin.color, COLORS[0]);
  // Asking again uses the visible one; nothing is ever made in or below the hidden one.
  const again = ok('notes_create', { markdown: '# probe three', folder: 'Therapy/Sub' });
  assert.equal(core.store.get('folders', core.store.get('folders', stored(again.data.id).folderId).parentId).id, twin.id);
  const moveHidden = call('notes_update', { id: 'plain', ifRev: stored('plain').rev, folder: 'Therapy/Deeper' });
  const moveAbsent = call('notes_update', { id: 'plain', ifRev: moveHidden.data?.rev ?? -1, folder: 'Elsewhere/Deeper' });
  assert.equal(moveHidden.isError, false, moveHidden.text);
  assert.equal(same(moveHidden.text), same(moveAbsent.text));
  assert.ok(!core.store.all('folders').some((f) => f.parentId === 'fhid'), 'no folder inside the hidden one');
  assert.deepEqual(core.store.all('notes').filter((n) => n.folderId === 'fhid').map((n) => n.id), ['nInHid'], 'no note filed in the hidden one');
  const paths = call('notes_structure', {}).data.folders.map((f) => f.path);
  assert.equal(paths.filter((p) => p === 'Therapy').length, 1, `the assistant sees one "Therapy": ${paths}`);
  assert.equal(call('notes_list', { folder: 'Therapy' }).data.notes.some((n) => n.id === 'nInHid'), false, 'the hidden folder\'s note stays invisible');
});

test('a day whose daily note is hidden or locked looks like a day without one: before, during and after notes_append', () => {
  const before = { H: JSON.stringify(stored('dayHid')), L: JSON.stringify(stored('dayLock')) };
  const reads = [H, L, E].map((d) => call('notes_read', { day: d }));
  for (const r of reads) assert.equal(r.isError, true);
  assert.equal(same(reads[0].text), same(reads[2].text));
  assert.equal(same(reads[1].text), same(reads[2].text));

  const adds = [H, L, E].map((d) => call('notes_append', { day: d, markdown: 'probe' }));
  for (const r of adds) assert.equal(r.isError, false, r.text);
  assert.equal(same(adds[0].text), same(adds[2].text), `hidden: ${adds[0].text}\nnone: ${adds[2].text}`);
  assert.equal(same(adds[1].text), same(adds[2].text));
  assert.deepEqual(adds.map((r) => r.data.created), [true, true, true]);

  // Read back by day, by id, in lists and in search: each is that day's daily note.
  for (const [i, d] of [H, L, E].entries()) {
    const byDay = ok('notes_read', { day: d });
    assert.equal(byDay.data.id, adds[i].data.id);
    assert.equal(byDay.data.day, d);
    assert.match(byDay.text.split('\n')[0], new RegExp(`\\| daily ${d} \\|`));
    assert.equal(ok('notes_read', { id: adds[i].data.id }).data.day, d);
  }
  const daily = ok('notes_list', { daily: true }).data.notes.map((n) => [n.id, n.day]);
  for (const [i, d] of [H, L, E].entries()) assert.ok(daily.some(([id, day]) => id === adds[i].data.id && day === d), `listed as daily ${d}: ${JSON.stringify(daily)}`);
  const root = ok('notes_list', { folder: 'Notes' }).data.notes.map((n) => n.id);
  for (const r of adds) assert.ok(!root.includes(r.data.id), 'like a daily note, not in the default folder');
  const found = ok('notes_search', { query: 'is:daily probe' }).data.results.map((x) => x.id);
  for (const r of adds) assert.ok(found.includes(r.data.id));

  // A second call adds to the same note, as on any day.
  const second = [H, E].map((d) => ok('notes_append', { day: d, markdown: 'second' }));
  assert.deepEqual(second.map((r) => r.data.id), [adds[0].data.id, adds[2].data.id]);
  assert.equal(same(second[0].text), same(second[1].text));

  // Stored: never a second daily note for one date, and the user's notes are left exactly as they were.
  assert.equal(JSON.stringify(stored('dayHid')), before.H, 'the hidden daily note is never changed');
  assert.equal(JSON.stringify(stored('dayLock')), before.L, 'the locked daily note is never changed');
  for (const d of [H, L]) assert.equal(core.store.all('notes').filter((n) => n.day === d && !n.trashedAt).length, 1, `one daily note for ${d}`);
  for (const r of adds.slice(0, 2)) {
    const n = stored(r.data.id);
    assert.equal(n.day, null, 'the assistant\'s text is a plain note in the user\'s apps');
    assert.equal(n.folderId, null);
    assert.ok(n.blocks.some((b) => b.c?.[0]?.[0] === 'probe'));
  }
  assert.equal(stored(adds[2].data.id).day, E, 'a day without a note gets a real daily note');
});

test('editing or deleting a stand-in never writes the day it is shown with', () => {
  const id = ok('notes_read', { day: H }).data.id;
  let r = ok('notes_update', { id, ifRev: stored(id).rev, title: 'Renamed day', folder: 'Journal', pinned: true });
  assert.equal(stored(id).day, null);
  assert.equal(ok('notes_read', { id }).data.day, H, 'still the daily note for that date to the assistant');
  r = ok('notes_append', { id, markdown: '- [ ] call back' });
  r = ok('notes_send_to_tasks', { id });
  assert.equal(stored(id).day, null);
  ok('notes_trash', { id });
  assert.equal(stored(id).day, null);
  assert.ok(stored(id).trashedAt > 0);
  // With it in Recently Deleted, the day has no note again; the next call starts another stand-in.
  assert.equal(call('notes_read', { day: H }).isError, true);
  const next = ok('notes_append', { day: H, markdown: 'after the trash' });
  assert.notEqual(next.data.id, id);
  assert.equal(next.data.created, true);
  assert.equal(stored(next.data.id).day, null);
  assert.equal(ok('notes_read', { day: H }).data.id, next.data.id);
  assert.ok(r);
});

test('meeting notes of an occurrence whose notes are hidden: answered as for an occurrence without notes', () => {
  const before = JSON.stringify(stored('meetHid'));
  const reads = ['evHid', 'evNone'].map((event_id) => call('notes_read', { event_id }));
  assert.deepEqual(reads.map((r) => r.isError), [true, true]);
  assert.equal(same(reads[0].text), same(reads[1].text));
  assert.deepEqual(meetingNotesOf(core.store, core.store.get('events', 'evHid'), MH), [], 'the hidden note is never listed');

  const made = ['evHid', 'evNone'].map((event_id) => call('notes_create', { event_id, markdown: '- [ ] probe' }));
  for (const r of made) assert.equal(r.isError, false, r.text);
  assert.equal(same(made[0].text), same(made[1].text), `hidden: ${made[0].text}\nnone: ${made[1].text}`);
  assert.deepEqual(made[0].data.event, { id: 'evHid', date: MH });

  const back = ['evHid', 'evNone'].map((event_id) => ok('notes_read', { event_id }));
  assert.deepEqual(back.map((r) => r.data.id), made.map((r) => r.data.id));
  assert.deepEqual(back[0].data.event, { id: 'evHid', date: MH });
  assert.deepEqual(back[1].data.event, { id: 'evNone', date: MN });
  assert.equal(same(back[0].text.split('\n')[0]), same(back[1].text.split('\n')[0]));
  assert.ok(ok('notes_search', { query: 'is:meeting probe' }).data.results.some((x) => x.id === made[0].data.id));
  assert.deepEqual(meetingNotesOf(core.store, core.store.get('events', 'evHid'), MH), [{ id: made[0].data.id, title: 'Therapy session' }]);
  // A second create for either answers alike too.
  const twice = ['evHid', 'evNone'].map((event_id) => call('notes_create', { event_id, markdown: 'another' }));
  assert.deepEqual(twice.map((r) => r.isError), [true, true]);
  assert.equal(same(twice[0].text), same(twice[1].text));

  // Stored: the user's hidden notes are unchanged and still the only notes linked to that occurrence.
  assert.equal(JSON.stringify(stored('meetHid')), before);
  assert.deepEqual(core.store.all('notes').filter((n) => n.event?.id === 'evHid').map((n) => n.id), ['meetHid']);
  assert.equal(stored(made[0].data.id).event, null);
  assert.deepEqual(stored(made[1].data.id).event, { id: 'evNone', date: MN }, 'an occurrence without notes gets real meeting notes');
});

test('when the user unhides their note, it is that day\'s note again and the stand-in a plain note; nothing is lost', () => {
  const standIn = ok('notes_read', { day: H }).data.id;
  core.store.transaction((tx) => tx.put('notes', { ...tx.get('notes', 'dayHid'), aiHidden: false, updatedAt: Date.now() }));
  const r = ok('notes_read', { day: H });
  assert.equal(r.data.id, 'dayHid');
  const other = ok('notes_read', { id: standIn });
  assert.equal(other.data.day, null);
  assert.match(other.data.markdown, /after the trash/);
  core.store.transaction((tx) => tx.put('notes', { ...tx.get('notes', 'dayHid'), aiHidden: true, updatedAt: Date.now() }));
  assert.equal(ok('notes_read', { day: H }).data.id, standIn, 'hidden again: the stand-in is the day\'s note again');
});

test('a stand-in is found again after a restart (its id comes from the hidden note, not from memory)', async () => {
  const dir = tempDir();
  let c = await createCore({ dataDir: dir, log: silent });
  seed(c);
  const client = c.ai.createClient({ kind: 'claude' });
  const first = c.callTool('notes_append', { day: H, markdown: 'before restart' }, { client });
  assert.equal(first.isError, false, first.content[0].text);
  const id = first.structuredContent.id;
  c.close();
  c = await createCore({ dataDir: dir, log: silent });
  const again = c.callTool('notes_append', { day: H, markdown: 'after restart' }, { client: c.ai.get(client.id) });
  assert.equal(again.isError, false, again.content[0].text);
  assert.equal(again.structuredContent.id, id);
  assert.equal(again.structuredContent.created, false);
  assert.equal(c.store.all('notes').filter((n) => n.day === H).length, 1);
  c.close();
});
