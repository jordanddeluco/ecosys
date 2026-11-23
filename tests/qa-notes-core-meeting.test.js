// QA fix (notes-core): assistants can create, find and open the meeting notes of one occurrence of an
// event, linked as the Schedule app links them (note.event = {id, date}). Before, notes_create took
// no event, notes_read / notes_append could name a note only by id, title or day, and notes_read
// never said a note was a meeting note. (get_event pointing to the notes is server/tools.mjs's part;
// it uses meetingNotesOf from server/tools-notes.mjs, tested here.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { tools as NOTE_TOOLS, meetingNotesOf } from '../server/tools-notes.mjs';
import { ymd, addDaysYmd } from '../shared/dates.js';
import { blockText } from '../notes/core/schema.js';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const today = ymd(new Date());
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-meeting-'));
const ONE = addDaysYmd(today, 3); // a one-off event
const WEEK0 = addDaysYmd(today, -14); // a weekly series starts here (so ±7-day steps are occurrences)
const EV = (id, title, date, extra = {}) => ({ id, title, calendarId: 'cal', allDay: false, start: `${date}T09:30`, end: `${date}T10:00`, location: '', notes: '', repeat: null, exdates: [], until: null, createdAt: 1, updatedAt: 1, ...extra });

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
const fails = (name, args, re) => {
  const r = call(name, args);
  assert.equal(r.isError, true, `${name} should fail: ${r.text}`);
  if (re) assert.match(r.text, re);
  return r;
};
const stored = (id) => core.store.get('notes', id);

before(async () => {
  core = await createCore({ dataDir: dir, log: silent });
  core.store.applyOps([
    { op: 'put', c: 'calendars', item: { id: 'cal', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 } },
    { op: 'put', c: 'events', item: EV('evOne', 'QA sync', ONE) },
    { op: 'put', c: 'events', item: EV('evWeek', 'Weekly 1:1 with Sam', WEEK0, { repeat: { freq: 'week', interval: 1, days: [new Date(`${WEEK0}T12:00`).getDay()] } }) },
    { op: 'put', c: 'folders', item: { id: 'fwork', name: 'Work', parentId: null, color: 'blue', order: 0, aiHidden: false, createdAt: 1, updatedAt: 1 } },
    { op: 'put', c: 'folders', item: { id: 'fmeet', name: 'Meetings', parentId: 'fwork', color: 'teal', order: 0, aiHidden: false, createdAt: 1, updatedAt: 1 } },
    { op: 'put', c: 'folders', item: { id: 'fsecret', name: 'Secret', parentId: null, color: 'red', order: 1, aiHidden: true, createdAt: 1, updatedAt: 1 } },
    { op: 'settings', patch: { notesMeetingFolder: 'fmeet' } },
  ]);
  claude = core.ai.createClient({ kind: 'claude' });
});
after(() => {
  core?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

test('the notes tools take an event (and occurrence) wherever a note can be named', () => {
  for (const n of ['notes_create', 'notes_read', 'notes_append']) {
    const props = NOTE_TOOLS.find((t) => t.name === n).inputSchema.properties;
    assert.ok(props.event_id && props.occurrence, `${n} takes event_id and occurrence: ${Object.keys(props)}`);
  }
  assert.deepEqual(NOTE_TOOLS.find((t) => t.name === 'notes_create').inputSchema.required, ['markdown']);
});

test('notes_create with event_id makes linked meeting notes in the meeting-notes folder; notes_read and is:meeting find them', () => {
  const made = ok('notes_create', { event_id: 'evOne', markdown: '# QA sync notes\n\n## Action items\n\n- [ ] Follow up with design' });
  assert.deepEqual(made.data.event, { id: 'evOne', date: ONE });
  assert.match(made.text, new RegExp(`^Created meeting notes "QA sync notes" for "QA sync" on \\w{3} ${ONE} in "Work/Meetings" id=${made.data.id} rev=1`));
  const n = stored(made.data.id);
  assert.deepEqual(n.event, { id: 'evOne', date: ONE }, 'linked as the Schedule app links them');
  assert.equal(n.folderId, 'fmeet', 'Notes settings: Meeting notes go to');
  assert.equal(n.editedBy, 'mcp:claude');
  assert.deepEqual(n.aiPrev.blocks, [], 'shows up in Recent AI edits');

  const read = ok('notes_read', { event_id: 'evOne' });
  assert.equal(read.data.id, made.data.id);
  assert.deepEqual(read.data.event, { id: 'evOne', date: ONE });
  assert.match(read.text.split('\n')[0], new RegExp(`\\| meeting notes for "QA sync" on \\w{3} ${ONE} \\(event_id=evOne occurrence=${ONE}\\)`), 'the text says what the note belongs to');
  assert.deepEqual(ok('notes_read', { event_id: 'evOne', occurrence: ONE }).data.id, made.data.id);
  assert.ok(ok('notes_search', { query: 'is:meeting QA sync' }).data.results.some((x) => x.id === made.data.id));
  const line = ok('notes_list', { folder: 'Work/Meetings' }).text.split('\n').find((l) => l.includes(made.data.id));
  assert.match(line, new RegExp(`\\| meeting notes ${ONE} \\|`));
  assert.deepEqual(ok('notes_list', {}).data.notes.find((x) => x.id === made.data.id).event, { id: 'evOne', date: ONE });
  assert.deepEqual(meetingNotesOf(core.store, core.store.get('events', 'evOne'), ONE), [{ id: made.data.id, title: 'QA sync notes' }]);

  // One set of notes per occurrence: a second create points to the first; a retried call returns it.
  const again = fails('notes_create', { event_id: 'evOne', markdown: 'Another take' }, /^meeting_notes_exist: "QA sync" on \w{3} \S+ already has meeting notes, "QA sync notes" id=(\w+) rev=1\. Nothing was created\. Add to them with notes_append/);
  assert.ok(again.text.includes(made.data.id));
  const retry = ok('notes_create', { event_id: 'evOne', markdown: '# QA sync notes\n\n## Action items\n\n- [ ] Follow up with design' });
  assert.deepEqual([retry.data.id, retry.data.duplicate], [made.data.id, true]);
  assert.equal(core.store.all('notes').filter((x) => x.event?.id === 'evOne').length, 1);

  // notes_append by event: under a heading of the note.
  const add = ok('notes_append', { event_id: 'evOne', markdown: '- [ ] Book the room', heading: 'Action items' });
  assert.equal(add.data.id, made.data.id);
  assert.equal(add.data.created, false);
  assert.deepEqual(stored(made.data.id).blocks.slice(-2).map(blockText), ['Follow up with design', 'Book the room']);
});

test('a repeating event needs its occurrence; each occurrence has its own notes', () => {
  fails('notes_create', { event_id: 'evWeek', markdown: 'x' }, /"Weekly 1:1 with Sam" repeats: pass occurrence \(YYYY-MM-DD.*Nearby occurrences: \d{4}-\d{2}-\d{2}/);
  fails('notes_create', { event_id: 'evWeek', occurrence: addDaysYmd(WEEK0, 1), markdown: 'x' }, /is not an occurrence of "Weekly 1:1 with Sam"\. Nearby occurrences: /);
  fails('notes_read', { event_id: 'evWeek' }, /repeats: pass occurrence/);
  const d1 = addDaysYmd(WEEK0, 7);
  const d2 = addDaysYmd(WEEK0, 14);
  // Empty markdown: the template the Schedule app starts meeting notes with.
  const tpl = ok('notes_create', { event_id: 'evWeek', occurrence: d1, markdown: '' });
  assert.deepEqual(stored(tpl.data.id).blocks.map((b) => [b.t, blockText(b)]), [['h1', 'Weekly 1:1 with Sam'], ['h3', 'Notes'], ['p', ''], ['h3', 'Action items'], ['check', '']]);
  assert.deepEqual(stored(tpl.data.id).event, { id: 'evWeek', date: d1 });
  // Markdown that doesn't start with a heading is titled like the event.
  const other = ok('notes_create', { event_id: 'evWeek', occurrence: d2, markdown: 'Talked about the roadmap.' });
  assert.deepEqual(stored(other.data.id).blocks.map((b) => [b.t, blockText(b)]), [['h1', 'Weekly 1:1 with Sam'], ['p', 'Talked about the roadmap.']]);
  assert.notEqual(other.data.id, tpl.data.id);
  assert.equal(ok('notes_read', { event_id: 'evWeek', occurrence: d1 }).data.id, tpl.data.id);
  assert.equal(ok('notes_read', { event_id: 'evWeek', occurrence: d2 }).data.id, other.data.id);
});

test('notes_append with event_id starts missing meeting notes, titled like the event, and adds to them after that', () => {
  const d3 = addDaysYmd(WEEK0, 21);
  fails('notes_read', { event_id: 'evWeek', occurrence: d3 }, /^not_found: there are no meeting notes for "Weekly 1:1 with Sam" on \w{3} \S+ that AI assistants can open \(notes_create or notes_append with event_id starts them\)/);
  const first = ok('notes_append', { event_id: 'evWeek', occurrence: d3, markdown: '- [ ] Send the summary', heading: 'Action items' });
  assert.equal(first.data.created, true);
  assert.deepEqual(first.data.event, { id: 'evWeek', date: d3 });
  assert.match(first.text, /^Created the meeting notes "Weekly 1:1 with Sam" for "Weekly 1:1 with Sam" on \w{3} \S+ and added 1 block under a new heading "Action items"/);
  const n = stored(first.data.id);
  assert.deepEqual(n.event, { id: 'evWeek', date: d3 });
  assert.equal(n.folderId, 'fmeet');
  assert.deepEqual(n.blocks.map((b) => [b.t, blockText(b)]), [['h1', 'Weekly 1:1 with Sam'], ['h2', 'Action items'], ['check', 'Send the summary']]);
  const second = ok('notes_append', { event_id: 'evWeek', occurrence: d3, markdown: 'Sam is out next week.' });
  assert.equal(second.data.id, first.data.id);
  assert.equal(second.data.created, false);
  assert.match(second.text, /^Added 1 block at the end/);
});

test('an occurrence edited on its own finds the notes made before it was split off (as Schedule does)', () => {
  const d1 = addDaysYmd(WEEK0, 7);
  const series = ok('notes_read', { event_id: 'evWeek', occurrence: d1 }).data.id;
  // The Schedule app moved that day to 11:00 on its own: a copy with its own id; the note still has the series link.
  core.store.applyOps([{ op: 'put', c: 'events', item: EV('evCopy', 'Weekly 1:1 with Sam', d1, { start: `${d1}T11:00`, end: `${d1}T11:30`, seriesId: 'evWeek', occurrence: d1 }) }]);
  assert.equal(ok('notes_read', { event_id: 'evCopy' }).data.id, series);
  assert.deepEqual(meetingNotesOf(core.store, core.store.get('events', 'evCopy'), d1).map((x) => x.id), [series]);
});

test('meeting notes never go to a hidden folder; wrong arguments say what to pass', () => {
  core.store.transaction((tx) => tx.setSettings({ notesMeetingFolder: 'fsecret' }));
  try {
    core.store.applyOps([
      { op: 'put', c: 'events', item: EV('evLater', 'Planning', addDaysYmd(today, 9)) },
      { op: 'put', c: 'events', item: EV('evPrep', 'Prep', addDaysYmd(today, 10)) },
    ]);
    const r = ok('notes_create', { event_id: 'evLater', markdown: '' });
    assert.equal(stored(r.data.id).folderId, null, 'the meeting-notes folder is hidden from AI: the default Notes folder');
    assert.match(r.text, / in "Notes" id=/);
    // A folder the assistant names wins over the setting.
    const p = ok('notes_create', { event_id: 'evPrep', markdown: '# Prep', folder: 'Work/Prep' });
    assert.equal(p.data.folder, 'Work/Prep');
    assert.deepEqual(stored(p.data.id).event, { id: 'evPrep', date: addDaysYmd(today, 10) });
  } finally {
    core.store.transaction((tx) => tx.setSettings({ notesMeetingFolder: 'fmeet' }));
  }
  fails('notes_create', { markdown: 'x', occurrence: ONE }, /occurrence goes with event_id/);
  fails('notes_read', { id: 'whatever', occurrence: ONE }, /occurrence goes with event_id/);
  fails('notes_create', { event_id: 'nope', markdown: 'x' }, /^not_found: no event with id "nope"\. Use find_events/);
  fails('notes_read', { day: 'today', event_id: 'evOne' }, /exactly one of id, title, day, event_id/);
});

test('meetingNotesOf lists only notes an assistant may open, and nothing while notes access is Off', () => {
  const e = core.store.get('events', 'evOne');
  const visible = meetingNotesOf(core.store, e, ONE);
  assert.equal(visible.length, 1);
  core.store.transaction((tx) => tx.put('notes', { ...tx.get('notes', visible[0].id), aiHidden: true, updatedAt: Date.now() }));
  assert.deepEqual(meetingNotesOf(core.store, e, ONE), []);
  core.store.transaction((tx) => tx.put('notes', { ...tx.get('notes', visible[0].id), aiHidden: false, updatedAt: Date.now() }));
  core.store.transaction((tx) => tx.setSettings({ notesAi: 'off' }));
  assert.equal(meetingNotesOf(core.store, e, ONE), null);
  core.store.transaction((tx) => tx.setSettings({ notesAi: 'edit' }));
  assert.equal(meetingNotesOf(core.store, null, ONE), null);
  assert.equal(meetingNotesOf(core.store, e, 'not a date'), null);
});
