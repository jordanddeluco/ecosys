// QA (server, third pass): the edges of date ranges that the verifier found.
//  - A field that takes one day (date, deadline, due_*, completed_*, end_date, occurrence, a notes day)
//    took the first day of anything that began "YYYY-MM-DDT": "2026-12-03T10:00 to 2026-12-05T10:00",
//    "2026-12-03T00:00:00Z/2026-12-05T00:00:00Z" and even "2026-12-03Tgarbage" were saved or searched
//    as Dec 3. Only a whole ISO date-time gives its date now; the rest is refused like any phrase that
//    isn't one day, and an impossible date in a whole one is named as such.
//  - An explicit field overrides only its own end of what the text says. create_tasks {text: "Prep
//    slides dec 3-5", date: Dec 10} saved a deadline of Dec 5 before the planned Dec 10 (before the
//    text gave no deadline at all), and an explicit deadline before the text's date did the same the
//    other way. Such a task is refused with what to send instead, as is one whose "by dec 5" falls
//    before an explicit date; an end that still fits is kept, and dates both sent as fields are kept
//    as sent.
//  - create_events {text: "Conference dec 3-5 9am-5pm", all_day: true} saved Dec 3 alone: the timed
//    range didn't give the all-day event its last day. It is all day Dec 3-5 now.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { clock, parseDate, ToolError } from '../server/model.mjs';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

async function withCore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-range-edges-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  core.store.importData({ data: { calendars: [{ id: 'cal1', name: 'Personal', color: 'iris', visible: true, order: 0, createdAt: 1, updatedAt: 1 }] }, settings: {} });
  const client = core.ai.createClient({ kind: 'claude', access: 'write', label: 'QA edges' });
  try {
    await fn(core, (name, args) => {
      const r = core.callTool(name, args, { client });
      return { isError: r.isError, text: r.content[0].text, data: r.structuredContent };
    });
  } finally {
    core.close();
  }
}
const named = (core, c, title) => core.store.all(c).find((x) => x.title === title);
const refuses = (fn, re) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof ToolError, `an error the model can act on: ${e}`);
    assert.match(e.message, re);
    return true;
  });

test('a one-day field takes the date of a whole ISO date-time only', () => {
  const c = clock(new Date(2026, 10, 22, 12)); // Sunday 22 November 2026, this process's zone
  // Not one date-time: refused, never taken as its first day.
  for (const s of ['2026-12-03T10:00 to 2026-12-05T10:00', '2026-12-03T00:00:00Z/2026-12-05T00:00:00Z', '2026-12-03Tgarbage', '2026-12-03T10:00Z extra', '2026-12-03T25:00']) {
    refuses(() => parseDate(s, c, 'deadline'), /^deadline ".+" is not a date I understand\. Use YYYY-MM-DD \(e\.g\. 2026-11-23\), "today" or "tomorrow"\.$/);
  }
  refuses(() => parseDate('2026-02-30T10:00', c, 'date'), /^date "2026-02-30T10:00" is not a real date\. Use YYYY-MM-DD \(e\.g\. 2026-11-23\)\.$/);
  // A whole one, with or without seconds, fraction or zone (in any case), gives its date as written.
  for (const s of ['2026-12-03T10:00', '2026-12-03T10:00:00', '2026-12-03T10:00:00.000Z', '2026-12-03T10:00:00-07:00', '2026-12-03T23:59+0530', '2026-12-03t10:00z']) {
    assert.equal(parseDate(s, c, 'deadline'), '2026-12-03', s);
  }
});

test('the tools refuse a date-time range in a one-day field and save nothing', async () => {
  await withCore(async (core, call) => {
    const range = '2030-12-03T10:00 to 2030-12-05T10:00';
    for (const [name, args] of [
      ['create_tasks', { tasks: [{ title: 'QA deadline', deadline: range }] }],
      ['create_tasks', { tasks: [{ title: 'QA date', date: '2030-12-03T00:00:00Z/2030-12-05T00:00:00Z' }] }],
      ['create_events', { events: [{ title: 'QA all day', calendar: 'Personal', start: '2030-12-03', end_date: range }] }],
      ['find_tasks', { due_to: range }],
      ['find_tasks', { completed_from: '2030-12-03Tgarbage' }],
      ['notes_read', { day: range }],
      ['notes_append', { day: range, markdown: 'QA should not land' }],
    ]) {
      const r = call(name, args);
      assert.equal(r.isError, true, `${name}: ${r.text}`);
      assert.match(r.text, /" is not a date I understand\. Use YYYY-MM-DD/, `${name}: ${r.text}`);
    }
    assert.equal(core.store.all('tasks').length, 0, 'no task saved');
    assert.equal(core.store.all('events').length, 0, 'no event saved');
    assert.equal(core.store.all('notes').filter((n) => n.day).length, 0, 'no daily note started');
    // A whole date-time still names its day.
    const ok = call('create_tasks', { tasks: [{ title: 'QA whole', deadline: '2030-12-05T17:00:00Z' }] });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(named(core, 'tasks', 'QA whole').deadline, '2030-12-05');
  });
});

test('create_tasks: an explicit date or deadline that contradicts the end the text still gives is refused', async () => {
  await withCore(async (core, call) => {
    for (const [item, re] of [
      // An explicit date after the text's deadline (from a range, from "dec 3 by dec 5", from "by").
      [{ text: 'QA slides 2030-12-03 to 2030-12-05', date: '2030-12-10' }, /^No tasks created\. Task 1: text "QA slides 2030-12-03 to 2030-12-05" gives the deadline 2030-12-05, before date 2030-12-10\. Send deadline too \(the one you mean\), or leave the dates out of text\./],
      [{ text: 'QA slides dec 3 2030 by dec 5 2030', date: '2030-12-10' }, /gives the deadline 2030-12-05, before date 2030-12-10/],
      [{ text: 'QA call by dec 5 2030', date: '2030-12-10' }, /gives the deadline 2030-12-05, before date 2030-12-10/],
      // An explicit deadline before the text's date.
      [{ text: 'QA slides 2030-12-03 to 2030-12-05', deadline: '2030-12-01' }, /^No tasks created\. Task 1: text "QA slides 2030-12-03 to 2030-12-05" gives the date 2030-12-03, after deadline 2030-12-01\. Send date too \(the one you mean\), or leave the dates out of text\./],
    ]) {
      const r = call('create_tasks', { tasks: [item] });
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, re);
    }
    assert.equal(core.store.all('tasks').length, 0, 'nothing saved');

    // In a batch only that task fails, and the result says how to fix it.
    const batch = call('create_tasks', { tasks: [{ title: 'QA fine', date: '2030-12-04' }, { text: 'QA clash 2030-12-03 to 2030-12-05', date: '2030-12-10' }] });
    assert.equal(batch.isError, false, batch.text);
    assert.match(batch.text, /Failed \(1\); fix and retry only these:\n- task 2 "QA clash 2030-12-03 to 2030-12-05": text "QA clash 2030-12-03 to 2030-12-05" gives the deadline 2030-12-05, before date 2030-12-10\./);
    assert.equal(batch.data.failed[0].index, 1);

    // What still fits is kept; both sent as fields are kept as sent.
    const r = call('create_tasks', {
      tasks: [
        { text: 'QA inside 2030-12-03 to 2030-12-05', date: '2030-12-04' },
        { text: 'QA longer 2030-12-03 to 2030-12-05', deadline: '2030-12-08' },
        { text: 'QA same day 2030-12-03 to 2030-12-05', date: '2030-12-05' },
        { text: 'QA both sent 2030-12-03 to 2030-12-05', date: '2030-12-10', deadline: '2030-12-05' },
        { title: 'QA fields only', date: '2030-12-10', deadline: '2030-12-05' },
      ],
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.failed.length, 0, r.text);
    const dates = (title) => {
      const t = named(core, 'tasks', title);
      return [t.date, t.deadline];
    };
    assert.deepEqual(dates('QA inside'), ['2030-12-04', '2030-12-05']);
    assert.deepEqual(dates('QA longer'), ['2030-12-03', '2030-12-08']);
    assert.deepEqual(dates('QA same day'), ['2030-12-05', '2030-12-05']);
    assert.deepEqual(dates('QA both sent'), ['2030-12-10', '2030-12-05']);
    assert.deepEqual(dates('QA fields only'), ['2030-12-10', '2030-12-05']);
  });
});

test('create_events: all_day:true over a timed text range covers every day of it', async () => {
  await withCore(async (core, call) => {
    const r = call('create_events', {
      events: [
        { text: 'QA Conference 2030-12-03 to 2030-12-05 9am-5pm', calendar: 'Personal', all_day: true },
        { text: 'QA Summit 2030-12-03 to 2030-12-05 9am-5pm', calendar: 'Personal', all_day: true, end_date: '2030-12-04' },
        { text: 'QA Offsite 2030-12-03 to 2030-12-05 9am-5pm', calendar: 'Personal' },
        { text: 'QA Lunch 2030-12-03 12pm-1pm', calendar: 'Personal', all_day: true },
      ],
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.created.length, 4, r.text);
    const span = (title) => {
      const e = named(core, 'events', title);
      return [e.allDay, e.start, e.end];
    };
    assert.deepEqual(span('QA Conference'), [true, '2030-12-03', '2030-12-05'], 'all day over the three days, not Dec 3 alone');
    assert.match(r.text, /\w{3} 2030-12-03 to \w{3} 2030-12-05 all day \| "QA Conference"/);
    assert.deepEqual(span('QA Summit'), [true, '2030-12-03', '2030-12-04'], 'an explicit end_date wins');
    assert.deepEqual(span('QA Offsite'), [false, '2030-12-03T09:00', '2030-12-05T17:00'], 'timed as before without all_day');
    assert.deepEqual(span('QA Lunch'), [true, '2030-12-03', '2030-12-03'], 'a one-day time range is that day');
  });
});
