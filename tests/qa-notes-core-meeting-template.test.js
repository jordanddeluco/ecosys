// QA fix (notes-core, second pass): meeting notes of a repeating event could not be told apart, and
// their template read as unfinished work.
//   - The template's empty "Action items" checkbox counted as an open to-do: a 0/1 ring, has:todo and
//     is:checklist matches, Home's open count, and "0/1 done" in notes_list for every template note.
//     An item without text is a place to type: it now counts as neither open nor done.
//   - Every template note previewed as "Notes" (its first section heading). Section headings after the
//     title are passed over now: the preview is what was written in the note, or nothing yet.
//   - notes_create {event_id} titled a note "Notes" when its Markdown started with "## Notes" (the
//     template's shape): only a "# Title" line names the note; otherwise it is titled like the event.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as S from '../notes/core/schema.js';
import { searchNotes } from '../notes/core/search.js';
import { createCore } from '../server/core.mjs';
import { ymd, addDaysYmd } from '../shared/dates.js';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});
const note = (id, blocks, extra = {}) => S.validateNote({ id, blocks: S.validateBlocks(blocks), ...extra });
const B = (t, text, extra = {}) => ({ t, c: text ? [[text]] : [], ...extra });

test('an empty checklist item is not a to-do: noteStats, has:todo, has:done and is:checklist', () => {
  const template = note('tpl', S.meetingNoteBlocks('Team standup'));
  const filled = note('fill', [...S.meetingNoteBlocks('Team standup').slice(0, 4), B('check', 'Send the summary'), B('check', ' ', { ck: true }), B('check', '')]);
  const done = note('done', [B('h1', 'Done list'), B('check', 'Booked', { ck: true }), B('check', '')]);
  assert.deepEqual(S.noteStats(template).checks, { open: 0, done: 0 });
  assert.deepEqual(S.noteStats(filled).checks, { open: 1, done: 0 }, 'a checked item without text is not done either');
  assert.deepEqual(S.noteStats(done).checks, { open: 0, done: 1 });
  const ids = (q) => searchNotes([template, filled, done], q, { limit: 10 }).map((r) => r.note.id).sort();
  assert.deepEqual(ids('has:todo'), ['fill']);
  assert.deepEqual(ids('has:done'), ['done']);
  assert.deepEqual(ids('is:checklist'), ['done', 'fill']);
  assert.deepEqual(ids('-has:todo'), ['done', 'tpl']);
});

test('the preview passes over section headings: a template previews nothing, a filled one what was written', () => {
  const tpl = S.meetingNoteBlocks('Team standup');
  assert.equal(S.notePreview({ blocks: tpl }), '');
  const filled = S.validateBlocks([...tpl.slice(0, 2), B('p', 'Discussed the launch'), ...tpl.slice(3, 4), B('check', 'Send the summary')]);
  assert.equal(S.notePreview({ blocks: filled }), 'Discussed the launch');
  const onlyItems = S.validateBlocks([...tpl.slice(0, 4), B('check', 'Send the summary')]);
  assert.equal(S.notePreview({ blocks: onlyItems }), 'Send the summary');
  assert.equal(S.notePreview({ blocks: S.validateBlocks([B('h1', 'Trip'), B('h2', 'Day 1'), B('p', 'We flew to Lisbon')]) }), 'We flew to Lisbon');
  // Unchanged: the title block's own second line, and a body line under the title.
  assert.equal(S.notePreview({ blocks: S.validateBlocks([B('h1', 'Groceries\nfor the week'), B('h2', 'Dairy')]) }), 'for the week');
  assert.equal(S.notePreview({ blocks: S.validateBlocks([B('p', 'Call list'), B('bullet', 'Sam')]) }), 'Sam');
  assert.equal(S.notePreview({ blocks: S.validateBlocks([B('h2', 'Plan'), B('h3', 'Phase 1')]) }), '');
});

test('notes_create with event_id: only a "# Title" line names meeting notes; a section heading first keeps the event title; template notes list no to-do', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-mtpl-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: { warn() {}, error() {}, info() {}, log() {} } });
  const today = ymd(new Date());
  const ev = (id, title, d) => ({ op: 'put', c: 'events', item: { id, title, calendarId: 'cal', allDay: false, start: `${d}T09:30`, end: `${d}T09:45`, location: '', notes: '', repeat: null, exdates: [], until: null, createdAt: 1, updatedAt: 1 } });
  core.store.applyOps([
    { op: 'put', c: 'calendars', item: { id: 'cal', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 } },
    ev('e1', 'Standup', addDaysYmd(today, 1)),
    ev('e2', 'Standup', addDaysYmd(today, 2)),
    ev('e3', 'Planning', addDaysYmd(today, 3)),
    ev('e4', 'Review', addDaysYmd(today, 4)),
  ]);
  const client = core.ai.createClient({ kind: 'claude' });
  const call = (name, args) => {
    const r = core.callTool(name, args, { client });
    assert.equal(!!r.isError, false, `${name}: ${r.content[0].text}`);
    return { text: r.content[0].text, data: r.structuredContent };
  };
  const blocksOf = (id) => core.store.get('notes', id).blocks.map((b) => [b.t, S.blockText(b)]);

  const sections = call('notes_create', { event_id: 'e1', markdown: '## Notes\n\n## Action items\n- [ ] Follow up with design' });
  assert.equal(sections.data.title, 'Standup');
  assert.match(sections.text, /^Created meeting notes "Standup" for "Standup" on /);
  assert.deepEqual(blocksOf(sections.data.id), [['h1', 'Standup'], ['h2', 'Notes'], ['h2', 'Action items'], ['check', 'Follow up with design']]);
  const own = call('notes_create', { event_id: 'e3', markdown: '# Planning, Q1 kickoff\n\n- [ ] Draft the plan' });
  assert.equal(own.data.title, 'Planning, Q1 kickoff', 'a "# Title" line is the note\'s own name');
  const plain = call('notes_create', { event_id: 'e4', markdown: 'Quick one today' });
  assert.deepEqual(blocksOf(plain.data.id), [['h1', 'Review'], ['p', 'Quick one today']]);

  const tpl = call('notes_create', { event_id: 'e2', markdown: '' });
  const line = call('notes_list', {}).text.split('\n').find((l) => l.includes(`id=${tpl.data.id}`));
  assert.ok(line && !/done/.test(line), `no to-do in the template's line: ${line}`);
  assert.equal(call('notes_list', {}).data.notes.find((n) => n.id === tpl.data.id).preview, '');
  assert.ok(!call('notes_search', { query: 'has:todo' }).data.results.some((r) => r.id === tpl.data.id));
  // The meeting notes of the two standups differ in what the assistant reads: their dates.
  const lines = call('notes_list', {}).text.split('\n').filter((l) => /^- "Standup"/.test(l));
  assert.equal(new Set(lines.map((l) => l.match(/meeting notes (\S+)/)?.[1])).size, 2, lines.join('\n'));
  core.close();
});
