// QA (server fix, second pass): the calendar tools point to an occurrence's meeting notes.
//  - get_event lists the meeting notes of the day it shows (an occurrence of a series: that one), in
//    the text as note_id= on a line of its own and in data.meeting_notes; find_events adds them to the
//    occurrence's line (after the event's own id=, which stays the line's first id=) and to its data.
//  - Only notes the notes tools would show: none hidden from AI, locked or deleted, and none at all
//    while notes access is Off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { isRelink, changeRefs } from '../server/ai-store.mjs';
import { addDaysYmd } from '../shared/dates.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-meeting-'));
let core;
let call;
let today;
before(async () => {
  core = await createCore({ dataDir: dir, log: silent });
  core.store.importData({ data: { calendars: [{ id: 'cw', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 }] }, settings: {} });
  const client = core.ai.createClient({ kind: 'claude', access: 'write' });
  call = (name, args = {}) => {
    const r = core.callTool(name, args, { client });
    return { isError: r.isError, text: r.content[0].text, data: r.structuredContent };
  };
  today = call('get_context').data.today;
});
after(() => {
  core?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const ok = (r) => {
  assert.equal(r.isError, false, r.text);
  return r;
};
const firstBareId = (line) => /\bid=([^\s|)]+)/.exec(line.replace(/"(?:[^"\\]|\\.)*"/g, '""'))?.[1] ?? null;
/** A note saved by the Notes app (synced, not through MCP) linked to occurrence {id, date}. */
function userNote(id, event, extra = {}) {
  const t = Date.now() - 60000;
  const out = core.store.applyOps([
    {
      op: 'put',
      c: 'notes',
      item: { id, v: 1, rev: 1, blocks: [{ id: `${id}h`, t: 'h1', c: [[extra.title || id]] }], folderId: null, pinned: false, day: null, event, aiHidden: false, aiPrev: null, locked: null, editedBy: 'user', editedAt: t, createdAt: t, updatedAt: t, trashedAt: null, trashedFrom: null, ...extra, title: undefined },
    },
  ]);
  assert.deepEqual(out.rejected, []);
}

test('get_event and find_events point to the meeting notes of an event', () => {
  const day = addDaysYmd(today, 20);
  const ev = ok(call('create_events', { events: [{ title: 'QA review', start: `${day}T11:00`, duration_minutes: 30, calendar: 'Work' }] })).data.created[0].event_id;
  const made = ok(call('notes_create', { event_id: ev, markdown: '# QA review notes\n\n- [ ] Follow up' })).data.id;
  const g = ok(call('get_event', { event_id: ev }));
  assert.deepEqual(g.data.event.meeting_notes, [{ note_id: made, title: 'QA review notes' }]);
  assert.match(g.text, new RegExp(`^Meeting notes: "QA review notes" note_id=${made} \\(notes_read with that id opens them\\)\\.$`, 'm'));
  const f = ok(call('find_events', { from: day, to: day, query: 'QA review' }));
  assert.deepEqual(f.data.events[0].meeting_notes, [{ note_id: made, title: 'QA review notes' }]);
  const line = f.text.split('\n').find((l) => l.startsWith('- ') && l.includes('QA review'));
  assert.match(line, new RegExp(`\\| meeting notes "QA review notes" note_id=${made}$`));
  assert.equal(firstBareId(line), ev, 'the line\'s first id= is still the event\'s');
  assert.equal(ok(call('notes_read', { id: made })).data.id, made, 'the note id works with notes_read');
});

test('a repeating event: each occurrence shows its own meeting notes', () => {
  const start = addDaysYmd(today, 30);
  const ev = ok(call('create_events', { events: [{ title: 'QA weekly', start: `${start}T15:00`, duration_minutes: 30, repeat: 'weekly', calendar: 'Work' }] })).data.created[0].event_id;
  const second = addDaysYmd(start, 7);
  const made = ok(call('notes_create', { event_id: ev, occurrence: second, markdown: '# Week two' })).data.id;
  assert.equal(call('get_event', { event_id: ev, occurrence: start }).data.event.meeting_notes, undefined, 'the first week has none');
  const g = ok(call('get_event', { event_id: ev, occurrence: second }));
  assert.deepEqual(g.data.event.meeting_notes, [{ note_id: made, title: 'Week two' }]);
  assert.match(g.text, new RegExp(`^Meeting notes of \\w{3} ${second}: "Week two" note_id=${made}`, 'm'));
  const f = ok(call('find_events', { from: start, to: addDaysYmd(start, 20), query: 'QA weekly' })).data.events;
  assert.deepEqual(f.map((x) => (x.meeting_notes || []).map((n) => n.note_id)), [[], [made], []]);
});

test('a stand-in\'s rev bump, when the link it is shown with moves, is bookkeeping like a moved link; nothing else is', () => {
  // A stand-in: the assistant's note for an occurrence whose notes it can't see, stored without a link.
  const s = { id: 's1', v: 1, rev: 1, blocks: [{ id: 'b', t: 'p', c: [['probe']] }], event: null, updatedAt: 1 };
  assert.equal(isRelink('notes', s, { ...s, rev: 2, updatedAt: 2 }), true);
  assert.deepEqual(changeRefs([{ c: 'notes', id: 's1', item: s }], [{ c: 'notes', id: 's1', item: { ...s, rev: 2, updatedAt: 2 } }]), [], 'not listed as a note the change edited');
  const linked = { ...s, event: { id: 'e1', date: '2026-11-30' } };
  assert.equal(isRelink('notes', linked, { ...linked, rev: 2 }), false, 'a linked note whose link stayed did not move');
  assert.equal(isRelink('notes', s, { ...s, rev: 2, blocks: [] }), false, 'an edit is an edit');
});

test('meeting notes hidden from AI, locked or deleted are never listed; none while notes access is Off', () => {
  const day = addDaysYmd(today, 40);
  const ev = ok(call('create_events', { events: [{ title: 'QA private', start: `${day}T09:00`, duration_minutes: 30, calendar: 'Work' }] })).data.created[0].event_id;
  userNote('nqaHidden', { id: ev, date: day }, { aiHidden: true, title: 'Secret agenda' });
  userNote('nqaGone', { id: ev, date: day }, { trashedAt: Date.now(), title: 'Deleted agenda' });
  userNote('nqaLocked', { id: ev, date: day }, { locked: { iv: 'aaaaaaaaaaaaaaaa', ct: 'QUJDRA' }, title: 'Locked agenda' });
  const g = ok(call('get_event', { event_id: ev }));
  assert.equal(g.data.event.meeting_notes, undefined);
  assert.doesNotMatch(g.text, /Secret agenda|nqaHidden|Deleted agenda|nqaGone|Locked agenda|nqaLocked|Meeting notes/);
  const f = ok(call('find_events', { from: day, to: day, query: 'QA private' }));
  assert.doesNotMatch(f.text, /meeting notes|nqaHidden|nqaGone|nqaLocked/);
  userNote('nqaShown', { id: ev, date: day }, { title: 'Open agenda' });
  assert.deepEqual(ok(call('get_event', { event_id: ev })).data.event.meeting_notes, [{ note_id: 'nqaShown', title: 'Open agenda' }]);
  core.store.applyOps([{ op: 'settings', patch: { notesAi: 'off' } }]);
  try {
    assert.equal(ok(call('get_event', { event_id: ev })).data.event.meeting_notes, undefined, 'notes access Off');
    assert.doesNotMatch(ok(call('find_events', { from: day, to: day, query: 'QA private' })).text, /meeting notes/);
  } finally {
    core.store.applyOps([{ op: 'settings', patch: { notesAi: 'edit' } }]);
  }
});
