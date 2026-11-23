// QA (server, second pass): date ranges through the MCP tools (the data owner's cross requests).
//  - create_tasks and create_events "text" read a date range whole: a task is planned for the first
//    day and due on the last ("Prep slides dec 3-5"), an event spans the days, all day ("Vacation dec
//    20-28") or from the first day's start to the last day's end ("Conference dec 3-5 9am-5pm").
//    Before, the text path kept only the first day and left "-5" or "to dec 5" in the title.
//    Explicit fields still win over what the text implies.
//  - A field that takes one day (date, deadline, due_*, end_date ...) or one date-time (start, end,
//    from, to) names a range as one and says what to send instead; nothing is saved or searched from
//    one of its ends. A same-day range ("dec 20-20") and single-day phrases ("next week") still work.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { clock, parseDate, parseWhen, ToolError } from '../server/model.mjs';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

async function withCore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-ranges-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  core.store.importData({ data: {}, settings: {} });
  core.store.applyOps([{ op: 'put', c: 'calendars', item: { id: 'cal1', name: 'Personal', color: 'iris', visible: true, order: 0, createdAt: 1, updatedAt: 1 } }]);
  const client = core.ai.createClient({ kind: 'claude', access: 'write', label: 'QA ranges' });
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

test('create_tasks text keeps both ends of a date range: planned on the first day, due on the last', async () => {
  await withCore(async (core, call) => {
    const r = call('create_tasks', { tasks: [{ text: 'QA Pack 2030-12-03 to 2030-12-05' }, { text: 'QA Explicit 2030-12-03 to 2030-12-05', deadline: '2030-12-10' }] });
    assert.equal(r.isError, false, r.text);
    const t = named(core, 'tasks', 'QA Pack');
    assert.ok(t, `the title keeps no part of the range: ${r.text}`);
    assert.deepEqual([t.date, t.deadline], ['2030-12-03', '2030-12-05']);
    assert.match(r.text, /"QA Pack" \| \w{3} 2030-12-03 \| deadline \w{3} 2030-12-05/);
    // An explicit field wins over what the text implies.
    const x = named(core, 'tasks', 'QA Explicit');
    assert.deepEqual([x.date, x.deadline], ['2030-12-03', '2030-12-10']);
  });
});

test('create_events text makes one event over the whole range, all day or timed', async () => {
  await withCore(async (core, call) => {
    const r = call('create_events', {
      events: [
        { text: 'QA Vacation 2030-12-20 to 2030-12-28', calendar: 'Personal' },
        { text: 'QA Conference 2030-12-03 to 2030-12-05 9am-5pm', calendar: 'Personal' },
        { text: 'QA Retreat 2030-01-10 to 2030-01-12', calendar: 'Personal', end_date: '2030-01-15' },
      ],
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.created.length, 3, r.text);
    const v = named(core, 'events', 'QA Vacation');
    assert.deepEqual([v.allDay, v.start, v.end], [true, '2030-12-20', '2030-12-28'], 'all day over those days (end is the last day)');
    const c = named(core, 'events', 'QA Conference');
    assert.deepEqual([c.allDay, c.start, c.end], [false, '2030-12-03T09:00', '2030-12-05T17:00'], 'from the first day at 9 to the last at 5');
    // An explicit end_date wins.
    const t = named(core, 'events', 'QA Retreat');
    assert.deepEqual([t.start, t.end], ['2030-01-10', '2030-01-15']);
    assert.match(r.text, /2030-12-20 to \w{3} 2030-12-28 all day \| "QA Vacation"/);
  });
});

test('a field that takes one day refuses a range by name and says what to send instead', () => {
  const c = clock(new Date(2026, 10, 22, 12)); // Sunday 22 November 2026, this process's zone
  const refuses = (fn, re) =>
    assert.throws(fn, (e) => {
      assert.ok(e instanceof ToolError, `an error the model can act on: ${e}`);
      assert.match(e.message, re);
      return true;
    });
  // Two days: the example is the end a deadline or a window's end means, else the first day.
  refuses(() => parseDate('dec 3-5', c, 'deadline'), /^deadline "dec 3-5" names two days \(2026-12-03 and 2026-12-05\); deadline takes one\. Use YYYY-MM-DD \(e\.g\. 2026-12-05\)\.$/);
  refuses(() => parseDate('dec 3-5', c, 'due_to'), /e\.g\. 2026-12-05/);
  refuses(() => parseDate('dec 3-5', c, 'end_date'), /e\.g\. 2026-12-05/);
  refuses(() => parseDate('dec 3-5', c, 'date'), /^date "dec 3-5" names two days .*e\.g\. 2026-12-03\)\.$/);
  // "dec 3 by dec 5" was silently Dec 3.
  refuses(() => parseDate('dec 3 by dec 5', c, 'date'), /names two days \(2026-12-03 and 2026-12-05\)/);
  // A date-time field: a range, with the fields that cover it.
  refuses(() => parseWhen('dec 20-28', c, 'from'), /^from "dec 20-28" is a date range \(2026-12-20 to 2026-12-28\); from takes one day or date-time\..* To cover those days use from "2026-12-20" and to "2026-12-28"\.$/);
  refuses(() => parseWhen('dec 20-28', c, 'to'), /e\.g\. 2026-12-28\)\. To cover those days/);
  refuses(() => parseWhen('dec 20-28', c, 'end'), /e\.g\. 2026-12-28\)\. For an all-day event over those days use end_date "2026-12-28"\.$/);
  refuses(() => parseWhen('dec 3-5 9am-5pm', c, 'start'), /^start "dec 3-5 9am-5pm" is a date range \(2026-12-03 to 2026-12-05\)/);
  // Still one day: a same-day range, and phrases that name one day.
  assert.equal(parseDate('dec 20-20', c, 'date'), '2026-12-20');
  assert.deepEqual(parseWhen('dec 20-20', c, 'start'), { date: '2026-12-20', time: null });
  assert.equal(parseDate('next week', c, 'due_from'), '2026-11-23');
  assert.equal(parseDate('this weekend', c, 'date'), '2026-11-22');
  assert.deepEqual(parseWhen('tomorrow 3pm', c, 'start'), { date: '2026-11-23', time: '15:00' });
});

test('the tools refuse a range in a one-day field and save nothing', async () => {
  await withCore(async (core, call) => {
    for (const [args, re] of [
      [{ tasks: [{ title: 'QA one', deadline: '2030-12-03 to 2030-12-05' }] }, /deadline "2030-12-03 to 2030-12-05" names two days \(2030-12-03 and 2030-12-05\); deadline takes one\. Use YYYY-MM-DD \(e\.g\. 2030-12-05\)/],
      [{ tasks: [{ title: 'QA two', date: '2030-12-03 to 2030-12-05' }] }, /date "2030-12-03 to 2030-12-05" names two days .*e\.g\. 2030-12-03/],
    ]) {
      const r = call('create_tasks', args);
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, re);
    }
    assert.equal(core.store.all('tasks').length, 0, 'nothing saved');
    for (const [times, re] of [
      [{ start: '2030-12-18', end: '2030-12-20 to 2030-12-28' }, /end "2030-12-20 to 2030-12-28" is a date range .* use end_date "2030-12-28"/],
      [{ start: '2030-12-20 to 2030-12-28' }, /start "2030-12-20 to 2030-12-28" is a date range \(2030-12-20 to 2030-12-28\)/],
      [{ start: '2030-12-20', end_date: '2030-12-20 to 2030-12-28' }, /end_date "2030-12-20 to 2030-12-28" names two days/],
    ]) {
      const r = call('create_events', { events: [{ title: 'QA one day', calendar: 'Personal', ...times }] });
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, re);
    }
    assert.equal(core.store.all('events').length, 0, 'nothing saved');
    const f = call('find_events', { from: '2030-12-20 to 2030-12-28', to: '2031-01-01' });
    assert.equal(f.isError, true, f.text);
    assert.match(f.text, /To cover those days use from "2030-12-20" and to "2030-12-28"/);
    // a same-day range is that day
    const ok = call('create_tasks', { tasks: [{ title: 'QA same day', date: '2030-12-20 to 2030-12-20' }] });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(named(core, 'tasks', 'QA same day').date, '2030-12-20');
  });
});
