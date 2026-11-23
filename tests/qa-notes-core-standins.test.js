// QA fix (notes-core, second pass): a date or event occurrence whose note is hidden from AI must answer
// exactly like one without a note, however the assistant uses its own trash and undo. Before:
//   - only 8 stand-in ids existed per hidden note, so after 8 × (notes_append, notes_trash) the next
//     note got a random id that no tool showed as that day's note: notes_append said "Created the
//     daily note" and notes_read {day} right after said not_found (a day without a note never does);
//   - only the newest live stand-in was shown, so append, trash, append, undo_change(trash) left one
//     daily note (and notes_read took the newest), where a day without a note has two (oldest first);
//   - a stand-in for an occurrence edited on its own (a copy event) was shown with the hidden note's
//     link to the series day (an exdate), not with the copy the assistant had named.
// Each script below runs on two isolated servers, one where the date or occurrence has a hidden note
// and one where it has none; what the assistant reads must be the same, ids aside (mapped in order).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { ymd, addDaysYmd } from '../shared/dates.js';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const today = ymd(new Date());
const now = Date.now();
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const D = addDaysYmd(today, -3); // the day under test
const M = addDaysYmd(today, 4); // the one-off meeting under test
const EV = (id, title, date, extra = {}) => ({ id, title, calendarId: 'cal', allDay: false, start: `${date}T10:00`, end: `${date}T10:30`, location: '', notes: '', repeat: null, exdates: [], until: null, createdAt: 1, updatedAt: 1, ...extra });
const NOTE = (id, extra) => ({ id, v: 1, rev: 1, blocks: [{ id: 'a', t: 'h1', c: [['Private']] }, { id: 'b', t: 'p', c: [['not for AI']] }], aiHidden: true, editedBy: 'user', editedAt: now - 3600000, createdAt: now - 86400000, updatedAt: now - 3600000, ...extra });

/** Two servers alike except that `hidden` notes (raw records) exist only in the first. → [{core, call, stored, kill}] */
async function worlds(ops, hidden) {
  const out = [];
  for (const extra of [hidden, []]) {
    const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-standin-'));
    dirs.push(dir);
    const core = await createCore({ dataDir: dir, log: silent });
    core.store.applyOps([
      { op: 'put', c: 'calendars', item: { id: 'cal', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 } },
      ...ops,
      ...extra.map((item) => ({ op: 'put', c: 'notes', item })),
    ]);
    const client = core.ai.createClient({ kind: 'claude' });
    const call = (name, args) => {
      const r = core.callTool(name, args, { client });
      return { isError: !!r.isError, text: r.content[0].text, data: r.structuredContent || null };
    };
    // A note deleted for good (Recently Deleted emptied in a browser): the record goes, as a browser's del op removes it.
    const kill = (id) => core.store.applyOps([{ op: 'del', c: 'notes', id }]);
    out.push({ core, call, kill, stored: (id) => core.store.get('notes', id) });
  }
  return out;
}

/** A transcript as the assistant sees it: ids and change ids replaced in order of first appearance, clock text dropped. */
function normal(lines) {
  const ids = new Map();
  const chg = new Map();
  return lines
    .join('\n')
    .replace(/ Today is [^\n]*/g, '')
    .replace(/note content [0-9a-f]{8}/g, 'note content TAG') // the fence's tag is random on every read
    .replace(/chg_[0-9a-f]+/g, (m) => (chg.has(m) ? chg : chg.set(m, `chg#${chg.size + 1}`)).get(m))
    .replace(/\b[0-9a-f]{16}\b/g, (m) => (ids.has(m) ? ids : ids.set(m, `ID#${ids.size + 1}`)).get(m))
    .replace(/(\b|T)\d{2}:\d{2}\b/g, '$1HH:MM'); // clock times, also in 2026-11-23T09:30
}

/** Runs `script(call, kill, log)` in both worlds and returns both transcripts. */
async function compare(ops, hidden, script) {
  const ws = await worlds(ops, hidden);
  const logs = [];
  for (const w of ws) {
    const log = [];
    const call = (name, args) => {
      const r = w.call(name, args);
      log.push(`> ${name} ${JSON.stringify(args)}`, `${r.isError ? 'ERROR ' : ''}${r.text}`, JSON.stringify(r.data ?? null));
      return r;
    };
    await script(call, w.kill, w);
    logs.push(normal(log));
  }
  for (const w of ws) w.core.close();
  return { hidden: logs[0], none: logs[1], ws };
}

const TARGETS = [
  { name: 'a daily note', target: { day: D }, ops: [], hidden: [NOTE('nHidDay', { day: D })], list: { daily: true } },
  { name: 'meeting notes', target: { event_id: 'evM' }, ops: [{ op: 'put', c: 'events', item: EV('evM', 'Therapy session', M) }], hidden: [NOTE('nHidMeet', { event: { id: 'evM', date: M } })], search: 'is:meeting' },
];

for (const t of TARGETS) {
  test(`${t.name}: 10 × (notes_append, notes_trash), then append and read, answers as where there is no note`, async () => {
    const r = await compare(t.ops, t.hidden, (call) => {
      for (let i = 0; i < 10; i++) {
        const a = call('notes_append', { ...t.target, markdown: `round ${i}` });
        call('notes_trash', { id: a.data.id });
      }
      const last = call('notes_append', { ...t.target, markdown: 'final' });
      const read = call('notes_read', t.target);
      assert.equal(read.isError, false, `read back right after the append: ${read.text}`);
      assert.equal(read.data.id, last.data.id);
      call('notes_append', { ...t.target, markdown: 'final again' });
      if (t.list) call('notes_list', t.list);
      if (t.search) call('notes_search', { query: t.search });
      call('notes_structure', {});
    });
    assert.equal(r.hidden, r.none);
  });

  test(`${t.name}: append, trash, append, undo_change(trash) leaves two notes, oldest first, as where there is no note`, async () => {
    const r = await compare(t.ops, t.hidden, (call) => {
      const a = call('notes_append', { ...t.target, markdown: 'probe one' });
      const tr = call('notes_trash', { id: a.data.id });
      const b = call('notes_append', { ...t.target, markdown: 'probe two' });
      assert.notEqual(b.data.id, a.data.id);
      call('undo_change', { change_id: tr.data.change_id });
      if (t.list) call('notes_list', t.list);
      if (t.search) call('notes_search', { query: t.search });
      const read = call('notes_read', t.target);
      assert.equal(read.data.id, a.data.id, 'the oldest is the one read');
      call('notes_append', { ...t.target, markdown: 'probe three' });
      call('notes_create', t.target.event_id ? { ...t.target, markdown: 'more' } : { markdown: '# Plain note' });
    });
    assert.equal(r.hidden, r.none);
  });

  test(`${t.name}: a note id is never used twice while another note of that ${t.target.day ? 'day' : 'occurrence'} is kept, even after one is deleted for good`, async () => {
    const r = await compare(t.ops, t.hidden, (call, kill) => {
      const a = call('notes_append', { ...t.target, markdown: 'one' });
      call('notes_trash', { id: a.data.id });
      const b = call('notes_append', { ...t.target, markdown: 'two' });
      kill(a.data.id); // the first one deleted for good
      call('notes_trash', { id: b.data.id });
      const c = call('notes_append', { ...t.target, markdown: 'three' });
      assert.notEqual(c.data.id, a.data.id, 'not the id of the note deleted for good');
      call('notes_read', t.target);
      call('undo_change', { change_id: call('notes_trash', { id: c.data.id }).data.change_id });
      call('notes_read', t.target);
    });
    assert.equal(r.hidden, r.none);
  });
}

test('stand-ins are stored as plain notes and the hidden notes are never changed, whatever the assistant does', async () => {
  const ws = await worlds(TARGETS.flatMap((t) => t.ops), TARGETS.flatMap((t) => t.hidden));
  const w = ws[0];
  const before = ['nHidDay', 'nHidMeet'].map((id) => JSON.stringify(w.stored(id)));
  const made = [];
  for (const t of TARGETS) {
    for (let i = 0; i < 12; i++) {
      const a = w.call('notes_append', { ...t.target, markdown: `x${i}` });
      made.push(a.data.id);
      if (i % 3) w.call('notes_trash', { id: a.data.id });
    }
  }
  assert.deepEqual(['nHidDay', 'nHidMeet'].map((id) => JSON.stringify(w.stored(id))), before);
  // Per target: an append after a kept note adds to it (i = 1, 4, 7, 10), every other one starts a note.
  assert.equal(new Set(made).size, 2 * 8);
  for (const id of new Set(made)) assert.deepEqual([w.stored(id).day, w.stored(id).event], [null, null], `stand-in ${id} is a plain note in the user's apps`);
  assert.equal(w.core.store.all('notes').filter((n) => n.day === D).length, 1, 'one daily note for that date in the apps');
  assert.equal(w.core.store.all('notes').filter((n) => n.event?.id === 'evM').length, 1, 'one note linked to that occurrence in the apps');
  for (const x of ws) x.core.close();
});

test('meeting notes for an occurrence edited on its own: a stand-in is shown with the copy the assistant named, and its link follows the copy when it moves', async () => {
  const W0 = addDaysYmd(today, -14);
  const dow = new Date(`${W0}T12:00`).getDay();
  const d1 = addDaysYmd(W0, 7);
  const c1 = addDaysYmd(d1, 1);
  const ops = [
    { op: 'put', c: 'events', item: EV('evS', 'Weekly', W0, { repeat: { freq: 'week', interval: 1, days: [dow] }, exdates: [d1] }) },
    { op: 'put', c: 'events', item: EV('cp1', 'Weekly', c1, { seriesId: 'evS', occurrence: d1 }) },
  ];
  // The user's hidden notes for that week, made before the occurrence was moved: linked to the series day.
  const hidden = [NOTE('nHidSeries', { event: { id: 'evS', date: d1 } })];
  const links = [];
  const r = await compare(ops, hidden, (call, _kill, w) => {
    const made = call('notes_create', { event_id: 'cp1', markdown: '- [ ] probe' });
    assert.deepEqual(made.data.event, { id: 'cp1', date: c1 });
    const back = call('notes_read', { id: made.data.id });
    assert.deepEqual(back.data.event, { id: 'cp1', date: c1 }, 'read back with the link it was made with');
    assert.match(back.text.split('\n')[0], new RegExp(`event_id=cp1 occurrence=${c1}`));
    call('notes_read', { event_id: 'cp1' });
    call('notes_create', { event_id: 'cp1', markdown: 'again' });
    call('notes_search', { query: 'is:meeting' });
    // That occurrence moves a day later: the link the notes are shown with follows it.
    const moved = w.call('update_event', { event_id: 'cp1', date: addDaysYmd(c1, 1) });
    assert.equal(moved.isError, false, moved.text);
    links.push([w.call('notes_read', { id: made.data.id }).data.event, w.call('notes_read', { event_id: 'cp1' }).data.id === made.data.id]);
  });
  assert.equal(r.hidden, r.none);
  assert.deepEqual(links, [[{ id: 'cp1', date: addDaysYmd(c1, 1) }, true], [{ id: 'cp1', date: addDaysYmd(c1, 1) }, true]]);
});
