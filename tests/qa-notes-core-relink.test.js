// QA fix (notes-core, second pass): when an event moves, update_event moves the links of its meeting
// notes and each relinked note gets a new rev. A stand-in (the assistant's own note for an occurrence
// whose notes are hidden from it, see server/tools-notes.mjs showStandIns) is shown with the hidden
// note's link but is stored without one, so the move left its rev as it was: an assistant that moves
// the event itself (update_event, then undo_change) could tell its notes from real meeting notes by
// the rev. server/tools-notes.mjs relinkedNote gives the stand-ins of a relinked hidden note the same
// rev bump; server/tools.mjs relinkNotes calls it, and the AI history (server/ai-store.mjs
// onlyLinkMoved) counts that bump as the bookkeeping a moved link is, so undo_change puts it back the
// way it puts a moved link back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { relinkedNote } from '../server/tools-notes.mjs';
import { ymd, addDaysYmd } from '../shared/dates.js';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const today = ymd(new Date());
const now = Date.now();
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const M = addDaysYmd(today, 4);
const EV = (id, title, date) => ({ id, title, calendarId: 'cal', allDay: false, start: `${date}T10:00`, end: `${date}T10:30`, location: '', notes: '', repeat: null, exdates: [], until: null, createdAt: 1, updatedAt: 1 });
const NOTE = (id, extra) => ({ id, v: 1, rev: 1, blocks: [{ id: 'a', t: 'h1', c: [['Private']] }], aiHidden: true, editedBy: 'user', editedAt: now - 3600000, createdAt: now - 86400000, updatedAt: now - 3600000, ...extra });
const BASE = [
  { op: 'put', c: 'calendars', item: { id: 'cal', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 } },
  { op: 'put', c: 'events', item: EV('evM', 'Therapy session', M) },
];

async function server(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-relink-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  core.store.applyOps([...BASE, ...extra.map((item) => ({ op: 'put', c: 'notes', item }))]);
  const client = core.ai.createClient({ kind: 'claude' });
  const call = (name, args) => {
    const r = core.callTool(name, args, { client });
    return { isError: !!r.isError, text: r.content[0].text, data: r.structuredContent || null };
  };
  return { core, call };
}

function normal(lines) {
  const ids = new Map();
  const chg = new Map();
  return lines
    .join('\n')
    .replace(/ Today is [^\n]*/g, '')
    .replace(/note content [0-9a-f]{8}/g, 'note content TAG')
    .replace(/chg_[0-9a-f]+/g, (m) => (chg.has(m) ? chg : chg.set(m, `chg#${chg.size + 1}`)).get(m))
    .replace(/\b[0-9a-f]{16}\b/g, (m) => (ids.has(m) ? ids : ids.set(m, `ID#${ids.size + 1}`)).get(m))
    .replace(/(\b|T)\d{2}:\d{2}\b/g, '$1HH:MM'); // clock times, also in 2026-11-23T09:30
}

test('relinkedNote gives every stand-in of a relinked note assistants cannot see the rev bump a relinked note gets, and nothing else', async () => {
  const { core, call } = await server([NOTE('nHid', { event: { id: 'evM', date: M } }), NOTE('nSeen', { event: { id: 'evM', date: addDaysYmd(M, 7) }, aiHidden: false })]);
  const a = call('notes_append', { event_id: 'evM', markdown: 'one' });
  assert.equal(a.isError, false, a.text);
  call('notes_trash', { id: a.data.id });
  const b = call('notes_append', { event_id: 'evM', markdown: 'two' });
  assert.equal(core.store.get('notes', b.data.id).event, null, 'a stand-in');
  const revs = () => [a.data.id, b.data.id, 'nHid', 'nSeen'].map((id) => core.store.get('notes', id).rev);
  const before = revs();
  const t = Date.now();
  let n = 0;
  let unmoved = 0;
  core.store.transaction((tx) => {
    // As relinkNotes does: the moved link is stored, then the hook gets the note as it was.
    unmoved = relinkedNote(tx, tx.get('notes', 'nHid'), t); // its link didn't move: nothing to follow
    const relink = (id, date) => {
      const old = tx.get('notes', id);
      tx.put('notes', { ...old, event: { id: 'evM', date }, rev: old.rev + 1, updatedAt: t });
      return relinkedNote(tx, old, t);
    };
    n = relink('nHid', addDaysYmd(M, 1));
    n += relink('nSeen', addDaysYmd(M, 8)); // visible: no stand-ins are shown for it
    n += relinkedNote(tx, null, t) + relinkedNote(tx, { id: 'x' }, t) + relinkedNote(null, tx.get('notes', 'nHid'), t);
  });
  assert.equal(unmoved, 0);
  assert.equal(n, 2, 'both stand-ins (the one in Recently Deleted too), and only those');
  // The stand-ins once each (by the hook); the two relinked notes once each (by the relink itself).
  assert.deepEqual(revs(), [before[0] + 1, before[1] + 1, before[2] + 1, before[3] + 1]);
  assert.equal(core.store.get('notes', b.data.id).updatedAt, t);
  assert.deepEqual([core.store.get('notes', a.data.id).event, core.store.get('notes', b.data.id).event], [null, null], 'still plain notes in the user\'s apps');
  core.close();
});

test(
  'an assistant that moves an event and undoes it reads the same revs on its meeting notes whether or not the user has hidden notes there',
  async () => {
    const logs = [];
    for (const extra of [[NOTE('nHid', { event: { id: 'evM', date: M } })], []]) {
      const { core, call } = await server(extra);
      const log = [];
      const c = (name, args) => {
        const r = call(name, args);
        log.push(`> ${name} ${JSON.stringify(args)}`, `${r.isError ? 'ERROR ' : ''}${r.text}`, JSON.stringify(r.data ?? null));
        return r;
      };
      c('notes_create', { event_id: 'evM', markdown: '- [ ] probe' });
      const moved = c('update_event', { event_id: 'evM', date: addDaysYmd(M, 1) });
      c('notes_read', { event_id: 'evM' });
      c('undo_change', { change_id: moved.data.change_id });
      c('notes_read', { event_id: 'evM' });
      c('find_changes', {});
      core.close();
      logs.push(normal(log));
    }
    assert.equal(logs[0], logs[1]);
  },
);
