// QA (server fix, second pass): update_event on a repeating series without an occurrence.
//  - A series whose first occurrence is today has begun: a dated start without occurrence is refused
//    (pass occurrence and scope), so "move tomorrow's standup" can't move today's away.
//  - A series that has not begun may still be moved by a dated start (the date is its new first day),
//    but the result says so: where it starts now, which of its days it no longer has, and that their
//    meeting notes went along, in words that are the same whatever notes there are (so nothing tells
//    of a note hidden from assistants).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { addDaysYmd } from '../shared/dates.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

async function withCore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-series-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  core.store.importData({ data: { calendars: [{ id: 'cw', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 }] }, settings: {} });
  const client = core.ai.createClient({ kind: 'claude', access: 'write' });
  const call = (name, args = {}) => {
    const r = core.callTool(name, args, { client });
    return { isError: r.isError, text: r.content[0].text, data: r.structuredContent };
  };
  const today = call('get_context').data.today;
  try {
    await fn({ core, call, today });
  } finally {
    core.close();
  }
}
const daily = (call, title, start) => call('create_events', { events: [{ title, start: `${start}T09:30`, duration_minutes: 15, repeat: 'daily', calendar: 'Work' }] }).data.created[0].event_id;
const count = (call, from, to, query) => call('find_events', { from, to, query }).data.total;
function userNote(core, id, event, extra = {}) {
  const t = Date.now() - 60000;
  core.store.applyOps([{ op: 'put', c: 'notes', item: { id, v: 1, rev: 1, blocks: [{ id: `${id}h`, t: 'h1', c: [[id]] }], folderId: null, pinned: false, day: null, event, aiHidden: false, aiPrev: null, locked: null, editedBy: 'user', editedAt: t, createdAt: t, updatedAt: t, trashedAt: null, trashedFrom: null, ...extra } }]);
}

test('a series that started today has begun: a dated start without occurrence is refused and today stays', async () => {
  await withCore(async ({ call, today }) => {
    const id = daily(call, 'QA standup', today);
    const r = call('update_event', { event_id: id, start: `${addDaysYmd(today, 1)}T10:00` });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /repeats \(since \w{3} \S+\)\. Pass occurrence \(the day to change, e\.g\. \S+\) and scope "this"/);
    assert.equal(count(call, today, today, 'QA standup'), 1, 'today\'s occurrence is still there');
    // With the day it means, it works.
    const ok = call('update_event', { event_id: id, occurrence: addDaysYmd(today, 1), scope: 'this', start: `${addDaysYmd(today, 1)}T10:00` });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(count(call, today, today, 'QA standup'), 1);
  });
});

test('moving a series that has not begun says where it starts now, which days it lost, and that their meeting notes went along', async () => {
  const said = [];
  for (const notes of [[], ['nqaSeen'], ['nqaSeen', 'nqaHidden']]) {
    await withCore(async ({ core, call, today }) => {
      const start = addDaysYmd(today, 2);
      const id = daily(call, 'QA future standup', start);
      if (notes.includes('nqaSeen')) userNote(core, 'nqaSeen', { id, date: addDaysYmd(start, 2) });
      if (notes.includes('nqaHidden')) userNote(core, 'nqaHidden', { id, date: addDaysYmd(start, 3) }, { aiHidden: true });
      const r = call('update_event', { event_id: id, start: `${addDaysYmd(start, 5)}T10:00` });
      assert.equal(r.isError, false, r.text);
      assert.match(
        r.text,
        new RegExp(`Its days moved: the series now starts \\w{3} ${addDaysYmd(start, 5)} \\(it started \\w{3} ${start}\\), so 5 occurrences from \\w{3} ${start} to \\w{3} ${addDaysYmd(start, 4)} are no longer on the calendar; meeting notes of its days moved with them\\. If that was not meant \\(to change one day, pass occurrence and scope "this"\\), undo_change puts it back\\.`),
      );
      if (notes.includes('nqaSeen')) assert.deepEqual(core.store.get('notes', 'nqaSeen').event, { id, date: addDaysYmd(start, 7) }, 'control: the note went along');
      assert.equal(count(call, start, addDaysYmd(start, 4), 'QA future standup'), 0, 'control: those days are gone');
      said.push(r.text.split('\n').slice(2).join('\n').replaceAll(id, 'ID').replace(/chg_[a-z0-9]+/gi, 'CHG'));
      call('undo_change', { change_id: r.data.change_id });
      assert.equal(count(call, start, addDaysYmd(start, 4), 'QA future standup'), 5, 'undo_change puts them back');
    });
  }
  assert.equal(new Set(said).size, 1, `the same words with no notes, with one, and with one hidden from AI: ${said.join(' / ')}`);
});

test('a time-only change of a whole series, or a title change, moves no days and says nothing about it', async () => {
  await withCore(async ({ call, today }) => {
    const id = daily(call, 'QA quiet', addDaysYmd(today, 3));
    for (const args of [{ start: '11:00', scope: 'all' }, { title: 'QA quiet (renamed)' }]) {
      const r = call('update_event', { event_id: id, ...args });
      assert.equal(r.isError, false, r.text);
      assert.doesNotMatch(r.text, /days moved|no longer on the calendar|meeting note/);
    }
  });
});
