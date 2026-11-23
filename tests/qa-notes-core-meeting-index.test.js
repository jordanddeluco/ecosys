// QA fix (notes-core, second pass): find_events lists each occurrence's meeting notes. Asking
// meetingNotesOf per occurrence looks at every note each time, so server/tools.mjs asks only for
// occurrences some stored note links to, and at most 50 per page: links of notes hidden from AI then
// used up that budget, so the assistant's own meeting notes could go unlisted where hidden notes
// exist. meetingNotesIndex looks at the notes once and answers every occurrence alike.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { meetingNotesIndex, meetingNotesOf } from '../server/tools-notes.mjs';
import { ymd, addDaysYmd } from '../shared/dates.js';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const today = ymd(new Date());
const now = Date.now();
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});
const EV = (id, title, date, extra = {}) => ({ id, title, calendarId: 'cal', allDay: false, start: `${date}T10:00`, end: `${date}T10:30`, location: '', notes: '', repeat: null, exdates: [], until: null, createdAt: 1, updatedAt: 1, ...extra });
const NOTE = (id, title, event, extra = {}) => ({ id, v: 1, rev: 1, event, blocks: [{ id: 'a', t: 'h1', c: [[title]] }], editedBy: 'user', editedAt: now, createdAt: now - 1000, updatedAt: now, ...extra });

test('meetingNotesIndex answers like meetingNotesOf for every occurrence: hidden notes left out, stand-ins and notes of edited occurrences in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-mindex-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  const W0 = addDaysYmd(today, -7);
  const dow = new Date(`${W0}T12:00`).getDay();
  const d1 = addDaysYmd(W0, 7);
  const ops = [
    { op: 'put', c: 'calendars', item: { id: 'cal', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 } },
    { op: 'put', c: 'events', item: EV('evS', 'Weekly', W0, { repeat: { freq: 'week', interval: 1, days: [dow] }, exdates: [d1] }) },
    { op: 'put', c: 'events', item: EV('cp1', 'Weekly', addDaysYmd(d1, 1), { seriesId: 'evS', occurrence: d1 }) },
    { op: 'put', c: 'events', item: EV('evH', 'Therapy', addDaysYmd(today, 2)) },
    { op: 'put', c: 'notes', item: NOTE('nW0', 'Weekly notes', { id: 'evS', date: W0 }) },
    { op: 'put', c: 'notes', item: NOTE('nOld', 'Before the move', { id: 'evS', date: d1 }) }, // the edited occurrence's, via the series day
    { op: 'put', c: 'notes', item: NOTE('nHid', 'Therapy', { id: 'evH', date: addDaysYmd(today, 2) }, { aiHidden: true }) },
  ];
  for (let i = 0; i < 60; i++) {
    const d = addDaysYmd(today, 10 + i);
    ops.push({ op: 'put', c: 'events', item: EV(`h${i}`, `Private ${i}`, d) });
    ops.push({ op: 'put', c: 'notes', item: NOTE(`nh${i}`, `Private ${i}`, { id: `h${i}`, date: d }, { aiHidden: true }) });
  }
  core.store.applyOps(ops);
  const client = core.ai.createClient({ kind: 'claude' });
  const made = core.callTool('notes_create', { event_id: 'evH', markdown: '- [ ] probe' }, { client });
  assert.equal(made.isError, false, made.content[0].text);
  const idx = meetingNotesIndex(core.store);
  const ev = (id) => core.store.get('events', id);
  const cases = [
    [ev('evS'), W0],
    [ev('cp1'), addDaysYmd(d1, 1)],
    [ev('evH'), addDaysYmd(today, 2)],
    [ev('evS'), addDaysYmd(W0, 14)],
    ...Array.from({ length: 60 }, (_, i) => [ev(`h${i}`), addDaysYmd(today, 10 + i)]),
  ];
  for (const [e, d] of cases) assert.deepEqual(idx(e, d), meetingNotesOf(core.store, e, d), `${e.id} ${d}`);
  assert.deepEqual(idx(ev('evS'), W0), [{ id: 'nW0', title: 'Weekly notes' }]);
  assert.deepEqual(idx(ev('cp1'), addDaysYmd(d1, 1)), [{ id: 'nOld', title: 'Before the move' }]);
  assert.deepEqual(idx(ev('evH'), addDaysYmd(today, 2)), [{ id: made.structuredContent.id, title: 'Therapy' }], 'the stand-in, not the hidden note');
  assert.deepEqual(cases.slice(4).flatMap(([e, d]) => idx(e, d)), [], 'no hidden note is ever listed');
  assert.deepEqual([idx(null, W0), idx(ev('evS'), 'not a date')], [[], []]);
  core.store.applyOps([{ op: 'settings', patch: { notesAi: 'off' } }]);
  assert.equal(meetingNotesIndex(core.store), null, 'nothing while AI access to notes is off');
  core.close();
});
