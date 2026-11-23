// Repeats through MCP (server/model.mjs, server/tools.mjs):
//  - a repeat the phrase parser rejects ("every 100 days": intervals are 1-99) is an actionable error
//    on every path (create_tasks / create_events text, and every `repeat` field), never an item saved
//    without the repeat the assistant asked for, and the same for "every 0 weeks on mon", which
//    parseRepeat's weekly-days shortcut reads (never a rule clamped to weekly);
//  - complete_tasks moves a repeating task to the same next date as the apps (shared/recur.js
//    nextRepeatDates, used by shared/model.js toggleTask), however far overdue it is;
//  - an RRULE number ecosys can't store as sent (INTERVAL=2.5, COUNT=2.9, BYMONTHDAY=1,15, a weekday's
//    place in the month like BYDAY=2TU, an UNTIL that is not a real date) is refused the same way,
//    quoting the part that was sent, never rounded or dropped into a different rule; so is a part that
//    is not NAME=VALUE ("COUNT=10=", "INTERVAL"), one given twice, a combination ecosys would store as
//    another rule (BYMONTHDAY with WEEKLY, every 2 days on some weekdays, COUNT with UNTIL, a WKST that
//    regroups the weekdays) and a part it would ignore (BYMONTH for another month, BYSETPOS, BYHOUR...);
//  - a task, which repeats until its repeat is removed, refuses an RRULE COUNT or UNTIL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { parseRepeat, checkNlpRejectedRepeat, clock, ToolError } from '../server/model.mjs';
import { nextRepeatDates } from '../shared/recur.js';
import { parse as nlpParse } from '../shared/nlp.js';
import { ymd, addDaysYmd } from '../shared/dates.js';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const LIMIT = /is not a repeat ecosys can store: use every 1 to 99 days, weeks, months or years \(e\.g\. "every 2 weeks"\)/;

let core;
let client;
before(async () => {
  core = await createCore({ dataDir: mkdtempSync(join(tmpdir(), 'ecosys-repeats-')), log: silent });
  core.store.applyOps([{ op: 'put', c: 'calendars', item: { id: 'cpers', name: 'Personal', color: 'iris', visible: true, order: 0, createdAt: 1, updatedAt: 1 } }]);
  client = core.ai.createClient({ kind: 'claude' });
});
after(() => {
  core.close();
  rmSync(core.dataDir, { recursive: true, force: true, maxRetries: 3 });
});

const call = (name, args) => core.callTool(name, args, { client });
const text = (r) => r.content[0].text;
const today = () => ymd(new Date());
const tasksTitled = (title) => core.store.all('tasks').filter((t) => t.title.includes(title));

// ------------------------------------------------------------------ rejected repeats

test('create_tasks text: "every 100 days" fails that task with the 1-99 limit; the others are still created', () => {
  const r = call('create_tasks', {
    tasks: [{ text: 'Water the cactus every 100 days' }, { text: 'Water the ferns every 2 weeks' }, { text: 'Rotate tyres EVERY 365 Months' }, { text: 'Check smoke alarm every 0 days' }],
  });
  assert.equal(r.isError, false, text(r));
  const { created, failed } = r.structuredContent;
  assert.deepEqual(created.map((t) => t.title), ['Water the ferns']);
  assert.match(created[0].repeat, /^Every 2 weeks/);
  assert.deepEqual(failed.map((f) => f.index), [0, 2, 3]);
  assert.match(failed[0].error, /^text "every 100 days" /, 'quotes the phrase it rejected');
  assert.match(failed[1].error, /^text "EVERY 365 Months" /, 'as it was typed');
  assert.match(failed[2].error, /^text "every 0 days" /);
  for (const f of failed) assert.match(f.error, LIMIT);
  assert.equal(tasksTitled('cactus').length, 0, 'no task that never repeats was saved');
  assert.equal(tasksTitled('tyres').length, 0);
  assert.match(text(r), /Failed \(3\); fix and retry only these:/);
});

test('create_tasks text alone: the whole call fails with the limit (no change recorded)', () => {
  const before = core.store.rev;
  const r = call('create_tasks', { tasks: [{ text: 'Water plants every 100 days' }] });
  assert.equal(r.isError, true);
  assert.match(text(r), /No tasks created\. Task 1: text "every 100 days" is not a repeat ecosys can store/);
  assert.equal(core.store.rev, before, 'nothing was written');
  assert.equal(r.structuredContent, undefined);
});

test('create_tasks: an explicit repeat field decides, whatever the text says; every 1-99 still works', () => {
  const r = call('create_tasks', {
    tasks: [
      { text: 'Read "every 100 days" chapter 3 every 100 days', repeat: 'weekly' },
      { text: 'Descale kettle every 99 days' },
      { text: 'Inspect gutters every 100 days', repeat: 'none' },
    ],
  });
  assert.equal(r.isError, false, text(r));
  const { created, failed } = r.structuredContent;
  assert.deepEqual(failed, []);
  assert.match(created[0].repeat, /^Weekly/);
  assert.equal(created[1].repeat, 'Every 99 days');
  assert.equal(created[2].repeat, null, 'repeat "none" asks for no repeat');
});

// "every 0 weeks on mon" and the like are read by parseRepeat's own weekly-days shortcut, not by the
// phrase parser, so they are listed here too: they must not be clamped to a weekly rule.
const ZERO_WEEKS = ['every 0 weeks on mon', 'every 00 weeks on tue', 'each 0 week on mon', 'every 00 weeks on tue and thu', 'every 0 weeks on fri,sat', 'every 0 weeks on mon after completion'];

test('every repeat field: "every 100 days", "every 0 weeks on mon" (and spellings of them) get the limit, quoting what was sent', () => {
  for (const v of ['every 100 days', '100 days', 'Every 250 Weeks', 'every 100 weeks on mon', 'every 1000 years after completion', 'each 120 months', ...ZERO_WEEKS]) {
    const r = call('create_tasks', { tasks: [{ title: `Rare chore (${v})`, repeat: v }] });
    assert.equal(r.isError, true, v);
    assert.match(text(r), new RegExp(`repeat "${v.slice(0, 40)}" is not a repeat ecosys can store`), v);
    assert.match(text(r), LIMIT, v);
  }
  assert.equal(tasksTitled('Rare chore').length, 0);
  // Things that are not a repeat at all keep the general hint.
  const odd = call('create_tasks', { tasks: [{ title: 'Odd', repeat: 'whenever it rains' }] });
  assert.match(text(odd), /is not a pattern I understand/);
});

test('update_tasks: a rejected repeat fails that task and keeps the repeat it had', () => {
  const t = call('create_tasks', { tasks: [{ title: 'Clean filter', date: addDaysYmd(today(), 3), repeat: 'every 2 weeks' }] }).structuredContent.created[0];
  const before = core.store.get('tasks', t.task_id);
  assert.equal(before.repeat.interval, 2);
  for (const v of ['every 100 days', ...ZERO_WEEKS]) {
    const r = call('update_tasks', { tasks: [{ task_id: t.task_id, repeat: v }] });
    assert.equal(r.isError, true, v);
    assert.match(text(r), new RegExp(`repeat "${v}" is not a repeat ecosys can store`), v);
    assert.match(text(r), LIMIT, v);
    assert.deepEqual(core.store.get('tasks', t.task_id), before, `${v}: the "every 2 weeks" rule is kept`);
  }
  // In a call with other changes, only the task with the rejected repeat fails.
  const other = call('create_tasks', { tasks: [{ title: 'Oil the hinges', date: addDaysYmd(today(), 4) }] }).structuredContent.created[0];
  const mixed = call('update_tasks', { tasks: [{ task_id: t.task_id, repeat: 'every 0 weeks on mon' }, { task_id: other.task_id, repeat: 'every 3 weeks on mon' }] });
  assert.equal(mixed.isError, false, text(mixed));
  assert.deepEqual(mixed.structuredContent.failed.map((f) => f.index), [0]);
  assert.match(mixed.structuredContent.failed[0].error, LIMIT);
  assert.deepEqual(core.store.get('tasks', t.task_id), before);
  assert.deepEqual(core.store.get('tasks', other.task_id).repeat, { freq: 'week', interval: 3, days: [1] });
});

test('create_events text and repeat, update_event repeat: the same limit, nothing saved', () => {
  const before = core.store.all('events').length;
  const viaText = call('create_events', { events: [{ text: 'Standup every 100 days 9am' }] });
  assert.equal(viaText.isError, true);
  assert.match(text(viaText), /No events created\. Event 1: text "every 100 days" is not a repeat ecosys can store/);
  const viaField = call('create_events', { events: [{ title: 'Review', start: `${addDaysYmd(today(), 1)}T10:00`, repeat: 'every 100 days' }] });
  assert.equal(viaField.isError, true);
  assert.match(text(viaField), /repeat "every 100 days" is not a repeat ecosys can store/);
  for (const v of ZERO_WEEKS) {
    const zero = call('create_events', { events: [{ title: 'Planning', start: `${addDaysYmd(today(), 1)}T11:00`, repeat: v }] });
    assert.equal(zero.isError, true, v);
    assert.match(text(zero), new RegExp(`repeat "${v}" is not a repeat ecosys can store`), v);
    assert.match(text(zero), LIMIT, v);
  }
  const zeroText = call('create_events', { events: [{ text: 'Gym every 0 weeks on mon 7pm' }] });
  assert.equal(zeroText.isError, true, 'the text path agrees with the repeat field');
  assert.match(text(zeroText), /text "every 0 weeks" is not a repeat ecosys can store/);
  assert.equal(core.store.all('events').length, before, 'no one-off event instead of a series');
  // Mixed call: the good event is still created.
  const mixed = call('create_events', { events: [{ text: 'Yoga every 100 days 7am' }, { text: 'Gym every 2 days 7pm' }] });
  assert.equal(mixed.isError, false, text(mixed));
  assert.equal(mixed.structuredContent.created.length, 1);
  assert.equal(mixed.structuredContent.created[0].repeat, 'Every 2 days');
  assert.match(mixed.structuredContent.failed[0].error, LIMIT);
  const ev = mixed.structuredContent.created[0];
  const stored = core.store.get('events', ev.event_id);
  for (const v of ['every 100 days', ...ZERO_WEEKS]) {
    const up = call('update_event', { event_id: ev.event_id, repeat: v });
    assert.equal(up.isError, true, v);
    assert.match(text(up), LIMIT, v);
    assert.deepEqual(core.store.get('events', ev.event_id), stored, `${v}: the "every 2 days" series is kept`);
  }
});

test('over MCP (tools/call, both eras): "every 100 days" in text or repeat is an isError result with the limit', () => {
  const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  const rpc = (id, name, args, modern) => core.mcp.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(modern ? { _meta: META } : {}) } }, { client, transport: 'stdio' });
  for (const modern of [false, true]) {
    for (const [i, args] of [{ tasks: [{ text: 'Repot the fig every 100 days' }] }, { tasks: [{ title: 'Repot the palm', repeat: 'every 100 days' }] }].entries()) {
      const out = rpc(i + 1, 'create_tasks', args, modern);
      assert.equal(out.status, 200);
      assert.equal(out.body.error, undefined, 'a tool error, not a protocol error');
      assert.equal(out.body.result.isError, true, JSON.stringify(out.body));
      assert.match(out.body.result.content[0].text, LIMIT);
    }
  }
  assert.equal(tasksTitled('Repot').length, 0);
  const t = putTask({ title: 'Back up the laptop', date: '1999-01-04', repeat: { freq: 'week', interval: 1, days: [1] } });
  const done = rpc(9, 'complete_tasks', { task_ids: [t.id] }, false);
  assert.equal(done.body.result.isError, false);
  assert.equal(done.body.result.structuredContent.results[0].advanced_to, nextRepeatDates(t, today()).date);
});

test('model: parseRepeat and checkNlpRejectedRepeat', () => {
  const c = clock();
  assert.throws(() => parseRepeat('every 100 days', c), (e) => e instanceof ToolError && LIMIT.test(e.message));
  assert.equal(parseRepeat('every 99 days', c).rule.interval, 99);
  // The weekly-days shortcut: 0 is refused like 100, quoting what was sent; 1-99, "other" and "biweekly" still work.
  for (const v of [...ZERO_WEEKS, 'every 100 weeks on mon', 'every 000 weeks on mon']) {
    assert.throws(() => parseRepeat(v, c, '2026-11-23'), (e) => e instanceof ToolError && LIMIT.test(e.message) && e.message.startsWith(`repeat "${v}" `), v);
  }
  const wk = (v) => parseRepeat(v, c, '2026-11-23').rule;
  assert.deepEqual(wk('every 1 week on mon'), { freq: 'week', interval: 1, days: [1] });
  assert.deepEqual(wk('every 01 weeks on mon'), { freq: 'week', interval: 1, days: [1] });
  assert.deepEqual(wk('every 99 weeks on tue and thu'), { freq: 'week', interval: 99, days: [2, 4] });
  assert.deepEqual(wk('every 2 weeks on mon, thu after completion'), { freq: 'week', interval: 2, days: [1, 4], from: 'done' });
  assert.deepEqual(wk('every other week on fri,sat'), { freq: 'week', interval: 2, days: [5, 6] });
  assert.deepEqual(wk('biweekly on tue'), { freq: 'week', interval: 2, days: [2] });
  assert.deepEqual(wk('weekly on mon, wed'), { freq: 'week', interval: 1, days: [1, 3] });
  assert.throws(() => checkNlpRejectedRepeat(nlpParse('Water plants every 100 days'), 'text'), /text "every 100 days" is not a repeat/);
  assert.doesNotThrow(() => checkNlpRejectedRepeat(nlpParse('Water plants every 2 weeks'), 'text'));
  assert.doesNotThrow(() => checkNlpRejectedRepeat(null));
  assert.throws(() => checkNlpRejectedRepeat({ rejectedRepeat: 'every 100 days' }, 'repeat', '100 days'), /repeat "100 days" is not/);
});

// ------------------------------------------------------------------ completing repeating tasks

/** Put a task straight into the store (as a browser would sync it) and return the stored copy. */
function putTask(fields) {
  const now = Date.now();
  const id = `t${Math.random().toString(36).slice(2, 12)}`;
  const out = core.store.applyOps([{ op: 'put', c: 'tasks', item: { id, title: `Chore ${id}`, notes: '', listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null, checklist: [], done: false, completedAt: null, order: 1, createdAt: now, updatedAt: now, ...fields } }]);
  assert.deepEqual(out.rejected, [], JSON.stringify(fields));
  return core.store.get('tasks', id);
}

test('complete_tasks: a daily task decades overdue comes back tomorrow, not on a past date', () => {
  const t = putTask({ title: 'Take vitamins', date: '2000-01-01', repeat: { freq: 'day', interval: 1 } });
  const started = performance.now();
  const r = call('complete_tasks', { task_ids: [t.id] });
  const ms = performance.now() - started;
  assert.equal(r.isError, false, text(r));
  const tomorrow = addDaysYmd(today(), 1);
  assert.equal(r.structuredContent.results[0].advanced_to, tomorrow);
  assert.match(text(r), new RegExp(`now comes back on \\w{3} ${tomorrow}`));
  const after = core.store.get('tasks', t.id);
  assert.equal(after.date, tomorrow);
  assert.equal(after.done, false);
  const copy = core.store.all('tasks').find((x) => x.repeatOf === t.id);
  assert.ok(copy && copy.done && copy.repeat === null && copy.date === '2000-01-01', 'the completed occurrence is logged as it was');
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
});

test('complete_tasks matches the apps (nextRepeatDates) for overdue, off-pattern, early, deadline-only and undated tasks', () => {
  const d = today();
  const cases = [
    { date: '1990-01-01', repeat: { freq: 'week', interval: 1, days: [1, 3] } },
    { date: '1999-12-31', repeat: { freq: 'week', interval: 3, days: [5] } },
    { date: '2003-07-20', repeat: { freq: 'month', interval: 1, monthDay: 15 } }, // off its pattern
    { date: '2004-01-31', repeat: { freq: 'month', interval: 1, monthDay: 31 } },
    { date: '2004-02-29', repeat: { freq: 'year', interval: 1, monthDay: 29, month: 2 } },
    { date: '2010-05-10', repeat: { freq: 'month', interval: 2 } }, // no monthDay (a rule from another source)
    { date: '1975-03-03', repeat: { freq: 'day', interval: 7 } },
    { date: addDaysYmd(d, 1), repeat: { freq: 'day', interval: 1, from: 'done' } }, // completed early
    { date: addDaysYmd(d, -400), repeat: { freq: 'week', interval: 2, days: [2], from: 'done' } },
    { deadline: '2001-03-15', repeat: { freq: 'month', interval: 1, monthDay: 15 } }, // deadline only
    { date: '2015-06-01', deadline: '2015-06-05', repeat: { freq: 'week', interval: 1, days: [1] } },
    { repeat: { freq: 'day', interval: 3 } }, // no date at all
    { date: addDaysYmd(d, 5), repeat: { freq: 'week', interval: 1, days: [0, 6] } }, // not due yet
  ];
  for (const fields of cases) {
    const t = putTask(fields);
    const want = nextRepeatDates(t, today());
    const r = call('complete_tasks', { task_ids: [t.id] });
    assert.equal(r.isError, false, text(r));
    const got = core.store.get('tasks', t.id);
    const label = JSON.stringify(fields);
    assert.deepEqual({ date: got.date, deadline: got.deadline }, want, label);
    assert.ok((got.date || got.deadline) > today(), `${label} comes back after today, got ${got.date || got.deadline}`);
    assert.equal(r.structuredContent.results[0].advanced_to, got.date || got.deadline, label);
  }
});

test('complete_tasks: an "after completion" task finished early still moves on (it used to stay put)', () => {
  const tomorrow = addDaysYmd(today(), 1);
  const t = putTask({ title: 'Water seedlings', date: tomorrow, repeat: { freq: 'day', interval: 1, from: 'done' } });
  const r = call('complete_tasks', { task_ids: [t.id] });
  assert.equal(r.structuredContent.results[0].advanced_to, addDaysYmd(today(), 2));
});

// ------------------------------------------------------------------ RRULE numbers

// [rule, the part quoted, what the message says ecosys can store]
const RRULE_REFUSED = [
  ['FREQ=WEEKLY;INTERVAL=2.5', 'INTERVAL=2.5', /use every 1 to 99 days, weeks, months or years, as a whole INTERVAL \(e\.g\. "FREQ=WEEKLY;INTERVAL=2"/],
  ['FREQ=DAILY;INTERVAL=0', 'INTERVAL=0', /use every 1 to 99 days/],
  ['FREQ=DAILY;INTERVAL=100', 'INTERVAL=100', /use every 1 to 99 days/],
  ['FREQ=DAILY;INTERVAL=+2', 'INTERVAL=+2', /use every 1 to 99 days/],
  ['FREQ=DAILY;INTERVAL=1e1', 'INTERVAL=1E1', /use every 1 to 99 days/],
  ['FREQ=DAILY;COUNT=2.9', 'COUNT=2.9', /COUNT must be a whole number of occurrences from 1 to 1000 \(e\.g\. "FREQ=DAILY;COUNT=10"\)/],
  ['FREQ=DAILY;COUNT=0', 'COUNT=0', /COUNT must be a whole number/],
  ['FREQ=DAILY;COUNT=1001', 'COUNT=1001', /COUNT must be a whole number/],
  ['FREQ=MONTHLY;BYMONTHDAY=1,15', 'BYMONTHDAY=1,15', /a repeat can be on one day of the month \(e\.g\. "FREQ=MONTHLY;BYMONTHDAY=15"\); for two days a month, add one repeating item for each day/],
  ['FREQ=MONTHLY;BYMONTHDAY=15.5', 'BYMONTHDAY=15.5', /BYMONTHDAY must be one whole day of the month from 1 to 31/],
  ['FREQ=MONTHLY;BYMONTHDAY=-1', 'BYMONTHDAY=-1', /from 1 to 31 .*31 means the last day of shorter months/],
  ['FREQ=MONTHLY;BYMONTHDAY=32', 'BYMONTHDAY=32', /from 1 to 31/],
  ['FREQ=MONTHLY;BYDAY=2TU', 'BYDAY=2TU', /not on a weekday's place in the month like 2TU or -1FR/],
  ['FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2', 'BYDAY=TU', /not on a weekday's place in the month/],
  ['FREQ=WEEKLY;BYDAY=-1FR', 'BYDAY=-1FR', /not on a weekday's place in the month/],
  ['FREQ=WEEKLY;BYDAY=XX', 'BYDAY=XX', /BYDAY lists weekdays as SU, MO, TU, WE, TH, FR or SA/],
  ['FREQ=DAILY;UNTIL=20261340', 'UNTIL=20261340', /UNTIL must be a real date written YYYYMMDD \(e\.g\. "UNTIL=20261231"\)/],
  ['FREQ=DAILY;UNTIL=20260231', 'UNTIL=20260231', /UNTIL must be a real date/],
  ['FREQ=HOURLY;INTERVAL=2', 'FREQ=HOURLY', /FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY/],
  // Parts that are not NAME=VALUE, or come twice: never skipped (these used to save a series without its end).
  ['FREQ=DAILY;COUNT=10=', 'COUNT=10=', /write each part once, as NAME=VALUE separated by ";" \(e\.g\. "FREQ=DAILY;COUNT=10"\)/],
  ['FREQ=DAILY;UNTIL=20261231=', 'UNTIL=20261231=', /as NAME=VALUE/],
  ['FREQ=WEEKLY;INTERVAL=2=3', 'INTERVAL=2=3', /as NAME=VALUE/],
  ['FREQ=WEEKLY;INTERVAL', 'INTERVAL', /as NAME=VALUE/],
  ['FREQ=DAILY;COUNT', 'COUNT', /as NAME=VALUE/],
  ['=DAILY;FREQ=DAILY', '=DAILY', /as NAME=VALUE/],
  ['FREQ=MONTHLY;BYMONTHDAY=1;BYMONTHDAY=15', 'BYMONTHDAY=15', /a repeat can be on one day of the month/],
  ['FREQ=WEEKLY;BYDAY=MO;BYDAY=WE', 'BYDAY=WE', /list every weekday in one BYDAY \(e\.g\. "FREQ=WEEKLY;BYDAY=MO,WE,FR"\)/],
  ['FREQ=DAILY;FREQ=WEEKLY', 'FREQ=WEEKLY', /give FREQ once/],
  // Combinations ecosys would store as another rule.
  ['FREQ=WEEKLY;BYMONTHDAY=15', 'BYMONTHDAY=15', /a day of the month goes with FREQ=MONTHLY or FREQ=YEARLY \(e\.g\. "FREQ=MONTHLY;BYMONTHDAY=15"\)/],
  ['FREQ=DAILY;BYMONTHDAY=15', 'BYMONTHDAY=15', /goes with FREQ=MONTHLY or FREQ=YEARLY/],
  ['FREQ=DAILY;INTERVAL=2;BYDAY=MO,WE,FR', 'INTERVAL=2', /a daily repeat on chosen weekdays is every week on those days .*use FREQ=WEEKLY \(e\.g\. "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR"\)/],
  ['FREQ=DAILY;COUNT=5;UNTIL=20261231', 'UNTIL=20261231', /end a repeat with COUNT or with UNTIL, not both/],
  ['FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=MO', 'WKST=MO', /ecosys starts weeks on Sunday, and with INTERVAL=2 a week from MO puts these weekdays into different weeks/],
  ['FREQ=WEEKLY;WKST=XX', 'WKST=XX', /WKST is a weekday: SU, MO, TU, WE, TH, FR or SA/],
  // Parts it would ignore.
  ['FREQ=MONTHLY;BYMONTH=3', 'BYMONTH=3', /a yearly repeat comes back in the month of the item's own date/],
  ['FREQ=WEEKLY;BYDAY=TU;BYSETPOS=2', 'BYSETPOS=2', /not on a weekday's place in the month/],
  ['FREQ=DAILY;BYHOUR=9', 'BYHOUR=9', /a repeat comes back at the time of the item itself/],
  ['FREQ=YEARLY;BYWEEKNO=20', 'BYWEEKNO=20', /ecosys stores FREQ, INTERVAL, BYDAY, BYMONTHDAY, COUNT and UNTIL/],
  ['FREQ=DAILY;X-NAME=1', 'X-NAME=1', /ecosys stores FREQ, INTERVAL/],
];
const refusedRRule = (part, hint) => (e) => e instanceof ToolError && e.message.startsWith(`repeat "${part}" is not a repeat ecosys can store: `) && hint.test(e.message);

test('model: an RRULE number ecosys cannot store is refused, quoting the part, never rounded; valid rules are unchanged', () => {
  const c = clock();
  for (const [rule, part, hint] of RRULE_REFUSED) assert.throws(() => parseRepeat(rule, c, '2026-11-23'), refusedRRule(part, hint), rule);
  const p = (v) => parseRepeat(v, c, '2026-11-23');
  assert.deepEqual(p('FREQ=WEEKLY;INTERVAL=2'), { rule: { freq: 'week', interval: 2, days: [1] }, until: null, count: null });
  assert.deepEqual(p('freq=weekly;interval=02;byday=mo,we'), { rule: { freq: 'week', interval: 2, days: [1, 3] }, until: null, count: null });
  assert.deepEqual(p('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10'), { rule: { freq: 'week', interval: 1, days: [1, 2, 3, 4, 5] }, until: null, count: 10 });
  assert.deepEqual(p('FREQ=DAILY;BYDAY=MO,WE'), { rule: { freq: 'week', interval: 1, days: [1, 3] }, until: null, count: null });
  assert.deepEqual(p('FREQ=MONTHLY;BYMONTHDAY=31'), { rule: { freq: 'month', interval: 1, monthDay: 31 }, until: null, count: null });
  assert.deepEqual(p('RRULE:FREQ=DAILY;INTERVAL=99;UNTIL=20261231T235959Z'), { rule: { freq: 'day', interval: 99 }, until: '2026-12-31', count: null });
  assert.deepEqual(p('FREQ=YEARLY;COUNT=1000'), { rule: { freq: 'year', interval: 1, monthDay: 23 }, until: null, count: 1000 });
  // An empty part (a trailing ";") says nothing; spaces around weekdays are fine.
  assert.deepEqual(p('FREQ=DAILY;'), { rule: { freq: 'day', interval: 1 }, until: null, count: null });
  assert.deepEqual(p('FREQ=DAILY;;COUNT=3'), { rule: { freq: 'day', interval: 1 }, until: null, count: 3 });
  assert.deepEqual(p('FREQ=WEEKLY;BYDAY=MO, WE'), { rule: { freq: 'week', interval: 1, days: [1, 3] }, until: null, count: null });
  // WKST is read only to check that it changes nothing: every week, one weekday, or weekdays it keeps together.
  assert.deepEqual(p('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO'), { rule: { freq: 'week', interval: 2, days: [1, 3] }, until: null, count: null });
  assert.deepEqual(p('FREQ=WEEKLY;BYDAY=SU,MO;WKST=MO'), { rule: { freq: 'week', interval: 1, days: [0, 1] }, until: null, count: null });
  assert.deepEqual(p('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU'), { rule: { freq: 'week', interval: 2, days: [0, 1] }, until: null, count: null });
  assert.deepEqual(p('FREQ=WEEKLY;INTERVAL=3;WKST=TH'), { rule: { freq: 'week', interval: 3, days: [1] }, until: null, count: null });
  // BYMONTH may only say again the month of the item's own date (23 November here).
  assert.deepEqual(p('FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=23'), { rule: { freq: 'year', interval: 1, monthDay: 23 }, until: null, count: null });
  assert.throws(() => p('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'), refusedRRule('BYMONTH=3', /the month of the item's own date \(November\)/));
  assert.throws(() => parseRepeat('FREQ=YEARLY;BYMONTH=11', c, null), refusedRRule('BYMONTH=11', /give the item a date in the month you want/));
  // A task can't end: COUNT and UNTIL are refused for it, and still read for events.
  const task = (v) => parseRepeat(v, c, '2026-11-23', { canEnd: false });
  for (const [rule, part] of [['FREQ=DAILY;COUNT=10', 'COUNT=10'], ['FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231', 'UNTIL=20261231'], ['FREQ=DAILY;COUNT=2.9', 'COUNT=2.9']]) {
    assert.throws(() => task(rule), refusedRRule(part, /a repeating task comes back until its repeat is removed, so it can't end after a number of times or on a date/), rule);
  }
  assert.deepEqual(task('FREQ=WEEKLY;BYDAY=MO'), { rule: { freq: 'week', interval: 1, days: [1] }, until: null, count: null });
  assert.deepEqual(p('FREQ=DAILY;COUNT=10').count, 10);
});

test('tasks refuse an RRULE that would end (COUNT or UNTIL): a repeating task would never use it', () => {
  const r = call('create_tasks', { tasks: [{ title: 'Pills for 10 days', repeat: 'FREQ=DAILY;COUNT=10' }, { title: 'Stretch daily', repeat: 'FREQ=DAILY' }] });
  assert.equal(r.isError, false, text(r));
  assert.deepEqual(r.structuredContent.failed.map((f) => f.index), [0]);
  assert.match(r.structuredContent.failed[0].error, /^repeat "COUNT=10" is not a repeat ecosys can store: a repeating task comes back until its repeat is removed/);
  assert.equal(tasksTitled('Pills for 10 days').length, 0, 'not saved as an endless repeat');
  const stretch = tasksTitled('Stretch daily')[0];
  const u = call('update_tasks', { tasks: [{ task_id: stretch.id, repeat: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231' }] });
  assert.equal(u.isError, true, text(u));
  assert.match(text(u), /repeat "UNTIL=20261231" is not a repeat ecosys can store: a repeating task/);
  assert.deepEqual(core.store.get('tasks', stretch.id), stretch, 'the task keeps its rule');
});

test('RRULE numbers through the tools: refused on every repeat field, and nothing is saved or changed', () => {
  const start = `${addDaysYmd(today(), 2)}T09:00`;
  const eventsBefore = core.store.all('events').length;
  for (const [rule, part, hint] of RRULE_REFUSED) {
    const r = call('create_events', { events: [{ title: `RRULE ${part}`, start, repeat: rule }] });
    assert.equal(r.isError, true, rule);
    assert.ok(text(r).includes(`repeat "${part}" is not a repeat ecosys can store: `), `${rule}: ${text(r)}`);
    assert.match(text(r), hint, rule);
  }
  assert.equal(core.store.all('events').length, eventsBefore, 'no event saved with a rounded or partial rule');
  // Tasks: the item fails (the rest of the call still works), and update_tasks keeps the rule it had.
  const mixed = call('create_tasks', { tasks: [{ title: 'Pay rent', repeat: 'FREQ=MONTHLY;BYMONTHDAY=1,15' }, { title: 'Pay gym', repeat: 'FREQ=MONTHLY;BYMONTHDAY=15' }] });
  assert.equal(mixed.isError, false, text(mixed));
  assert.deepEqual(mixed.structuredContent.failed.map((f) => f.index), [0]);
  assert.equal(tasksTitled('Pay rent').length, 0);
  const gym = tasksTitled('Pay gym')[0];
  assert.deepEqual(gym.repeat, { freq: 'month', interval: 1, monthDay: 15 });
  for (const rule of ['FREQ=WEEKLY;INTERVAL=2.5', 'FREQ=DAILY;COUNT=2.9', 'FREQ=MONTHLY;BYDAY=2TU']) {
    const u = call('update_tasks', { tasks: [{ task_id: gym.id, repeat: rule }] });
    assert.equal(u.isError, true, rule);
    assert.deepEqual(core.store.get('tasks', gym.id), gym, `${rule}: the task is unchanged`);
  }
  // update_event keeps the series as it was.
  const ev = call('create_events', { events: [{ title: 'Fortnightly sync', start, repeat: 'FREQ=WEEKLY;INTERVAL=2' }] }).structuredContent.created[0];
  const stored = core.store.get('events', ev.event_id);
  for (const rule of ['FREQ=WEEKLY;INTERVAL=2.5', 'FREQ=WEEKLY;INTERVAL=2;COUNT=2.9', 'FREQ=DAILY;UNTIL=20261340']) {
    const u = call('update_event', { event_id: ev.event_id, repeat: rule });
    assert.equal(u.isError, true, rule);
    assert.deepEqual(core.store.get('events', ev.event_id), stored, `${rule}: the series is unchanged`);
  }
});
