// MCP tools, run directly against a core with a temporary data folder (server/tools.mjs, server/model.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { CORE_TOOLS, toolDefinition, checkArgs, ARG_LIMITS } from '../server/tools.mjs';
import { parseRepeat, parseWhen, parseDate, parseTime, parseLabels, clock, freeSlots, instancesBetween, ToolError } from '../server/model.mjs';
import { ymd, addDaysYmd, parseYmd } from '../shared/dates.js';

const today = ymd(new Date());
const day = (n) => addDaysYmd(today, n);
/** Next date (after today) that falls on weekday `wd` (0=Sun). */
const nextWeekday = (wd) => {
  for (let i = 1; i <= 7; i++) if (parseYmd(day(i)).getDay() === wd) return day(i);
};
const silent = { warn() {}, error() {}, info() {}, log() {} };

let core;
let client;
let events;
const call = (name, args, c = client) => core.callTool(name, args, { client: c });
const text = (r) => r.content[0].text;
const data = (r) => r.structuredContent;

before(async () => {
  events = [];
  core = await createCore({ dataDir: mkdtempSync(join(tmpdir(), 'ecosys-tools-')), emit: (e, p) => events.push([e, p]), log: silent });
  core.store.applyOps([
    { op: 'put', c: 'lists', item: { id: 'lwork', name: 'Work', color: 'blue', icon: '', order: 0, createdAt: 1, updatedAt: 1 } },
    { op: 'put', c: 'lists', item: { id: 'lhome', name: 'Home', color: 'green', icon: '', order: 1, createdAt: 1, updatedAt: 1 } },
    { op: 'put', c: 'calendars', item: { id: 'cpers', name: 'Personal', color: 'iris', visible: true, order: 0, createdAt: 1, updatedAt: 1 } },
    { op: 'put', c: 'calendars', item: { id: 'cwork', name: 'Work', color: 'blue', visible: true, order: 1, createdAt: 1, updatedAt: 1 } },
  ]);
  client = core.ai.createClient({ kind: 'claude' });
});
after(() => {
  core.close();
  rmSync(core.dataDir, { recursive: true, force: true, maxRetries: 3 });
});

/** Fastest of a few runs, so a busy machine cannot make a fast path look slow. */
function fastest(fn, runs = 5) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

test('every tool is well formed (names, titles, schemas, annotations)', () => {
  for (const t of CORE_TOOLS) {
    const d = toolDefinition(t);
    assert.match(d.name, /^[a-z][a-z0-9_]{2,40}$/, d.name);
    assert.ok(d.title && d.description.length > 20, d.name);
    assert.equal(d.inputSchema.type, 'object', d.name);
    assert.equal(d.inputSchema.additionalProperties, false, d.name);
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof d.annotations[k], 'boolean', `${d.name}.${k}`);
    assert.equal(d.annotations.openWorldHint, false);
    assert.equal(d.annotations.readOnlyHint, !t.write, d.name);
    assert.equal(d.annotations.title, d.title);
    assert.ok(d.description.length < 1024);
  }
  const names = CORE_TOOLS.map((t) => t.name);
  for (const n of ['get_overview', 'get_context', 'find_tasks', 'get_task', 'find_events', 'get_event', 'find_free_time', 'find_changes', 'create_tasks', 'update_tasks', 'complete_tasks', 'create_events', 'update_event', 'schedule_tasks', 'create_list', 'delete_items', 'undo_change']) {
    assert.ok(names.includes(n), n);
  }
});

test('argument checking gives actionable errors', () => {
  const schema = CORE_TOOLS.find((t) => t.name === 'create_tasks').inputSchema;
  assert.throws(() => checkArgs(schema, {}), /tasks is required/);
  assert.throws(() => checkArgs(schema, { tasks: [] }), /at least 1/);
  assert.throws(() => checkArgs(schema, { tasks: [{ title: 'x', priority: 'urgent' }] }), /priority must be one of/);
  assert.throws(() => checkArgs(schema, { tasks: [{ title: 'x', colour: 'red' }] }), /unknown field "colour"/);
  assert.throws(() => checkArgs(schema, { tasks: [{ title: 5 }] }), /must be string/);
  const r = call('create_tasks', { tasks: 'buy milk' });
  assert.equal(r.isError, true);
  assert.match(text(r), /Today is \w{3} \d{4}-\d{2}-\d{2}/, 'errors include the date and zone');
  assert.deepEqual(call('no_such_tool', {}).protocolError.code, -32602);
});

test('argument names that exist on Object.prototype are unknown fields too', () => {
  for (const k of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'constructor']) {
    const none = call('get_context', { [k]: 'x' });
    assert.equal(none.isError, true, k);
    assert.match(text(none), new RegExp(`arguments takes no arguments \\(got "${k}"\\)`));
    const some = call('find_tasks', { [k]: 1 });
    assert.equal(some.isError, true, k);
    assert.match(text(some), new RegExp(`unknown field "${k}"\\. Allowed: query, list,`));
  }
  assert.throws(() => checkArgs(CORE_TOOLS.find((t) => t.name === 'create_tasks').inputSchema, { tasks: [{ title: 'x', toString: 'y' }] }), /unknown field "toString"/);
  assert.equal(call('get_context', {}).isError, false);
});

test('every string and array in the tool schemas has an explicit size limit', () => {
  const walk = (sch, path) => {
    const types = [sch.type].flat();
    if (types.includes('string')) assert.ok(sch.maxLength > 0 || sch.enum, `${path} needs maxLength`);
    if (types.includes('array')) assert.ok(sch.maxItems > 0, `${path} needs maxItems`);
    if (sch.items) walk(sch.items, `${path}[]`);
    for (const [k, v] of Object.entries(sch.properties || {})) walk(v, `${path}.${k}`);
  };
  for (const t of CORE_TOOLS) walk(t.inputSchema, t.name);
  // Schemas without limits (a future tool file) still get the defaults.
  assert.throws(() => checkArgs({ type: 'string' }, 'x'.repeat(ARG_LIMITS.maxLength + 1)), /too long \(max 20000 characters\)/);
  assert.throws(() => checkArgs({ type: 'array' }, new Array(ARG_LIMITS.maxItems + 1).fill(1)), /at most 200 items/);
  checkArgs({ type: 'string' }, 'x'.repeat(ARG_LIMITS.maxLength));
});

test('oversized arguments are refused at once, before any date or repeat parsing', () => {
  const ro = core.ai.createClient({ kind: 'other', access: 'read' });
  const huge = 'mon '.repeat(25000); // 100 KB that the date parser would chew on for seconds
  let r;
  assert.ok(fastest(() => (r = call('find_tasks', { due_from: huge }, ro))) < 50, 'a read-only key cannot stall the server');
  assert.equal(r.isError, true);
  assert.match(text(r), /due_from is too long \(max 64 characters\)/);
  const labels = Array.from({ length: 60000 }, (_, i) => `l${i}`);
  assert.ok(fastest(() => (r = call('find_tasks', { labels }, ro))) < 50);
  assert.match(text(r), /labels takes at most 20 items/);
  const spaced = `weekly on a${' '.repeat(64000)}!`;
  assert.ok(fastest(() => (r = call('create_tasks', { tasks: [{ title: 'x', repeat: spaced }] }))) < 50);
  assert.match(text(r), /repeat is too long \(max 200 characters\)/);
  assert.ok(fastest(() => (r = call('create_events', { events: [{ title: 'x', start: huge }] }))) < 50);
  assert.match(text(r), /start is too long/);
  // The parsers refuse long input themselves too, for tool files that call them directly.
  const c = clock();
  for (const fn of [() => parseDate(huge, c), () => parseTime(huge, c), () => parseWhen(huge, c), () => parseRepeat(spaced, c)]) {
    assert.ok(fastest(() => assert.throws(fn, (err) => err instanceof ToolError && /too long/.test(err.message))) < 50);
  }
  assert.ok(fastest(() => assert.throws(() => parseLabels(labels), /At most 20 labels/)) < 50);
  // Normal input is untouched.
  assert.equal(parseDate('tomorrow', c), day(1));
  assert.deepEqual(parseLabels(['@Home', 'home', ' errands ']), ['home', 'errands']);
  core.ai.deleteClient(ro.id);
});

test('get_context lists lists, calendars and the clock', () => {
  const r = call('get_context', {});
  assert.equal(r.isError, false);
  const d = data(r);
  assert.equal(d.today, today);
  assert.ok(d.time_zone);
  assert.deepEqual(d.lists.map((l) => l.name), ['Inbox', 'Work', 'Home']);
  assert.deepEqual(d.calendars.map((c) => c.name), ['Personal', 'Work']);
  assert.equal(d.access, 'write');
});

test('create_tasks: fields, natural language, repeats, steps and partial failure', () => {
  const r = call('create_tasks', {
    tasks: [
      { title: 'Write report', list: 'work', date: 'tomorrow', time: '14:00', duration_minutes: 90, priority: 'p1', labels: ['@Deep work'], steps: ['Outline', 'Draft'] },
      { text: 'Call mom tomorrow 6pm p2 @phone #Home' },
      { title: 'Water plants', repeat: 'every mon, thu' },
      { title: 'New list task', text: 'Plan trip #Travel' },
      { title: 'Bad', date: '31/31/2026' },
      { title: 'Nowhere', list: 'Nope' },
    ],
  });
  assert.equal(r.isError, false);
  const d = data(r);
  assert.equal(d.created.length, 4);
  assert.equal(d.failed.length, 2);
  assert.match(d.failed[0].error, /YYYY-MM-DD/);
  assert.match(d.failed[1].error, /No list named "Nope".*Work/);
  assert.match(d.change_id, /^chg_/);
  const [report, mom, water, trip] = d.created;
  assert.equal(report.list, 'Work');
  assert.equal(report.date, day(1));
  assert.equal(report.time, '14:00');
  assert.equal(report.priority, 'P1');
  assert.deepEqual(report.labels, ['deep-work']);
  assert.equal(report.steps_total, 2);
  assert.equal(mom.title, 'Call mom');
  assert.equal(mom.time, '18:00');
  assert.equal(mom.list, 'Home');
  assert.equal(mom.priority, 'P2');
  assert.deepEqual(mom.labels, ['phone']);
  assert.equal(water.repeat, 'Weekly on Mon, Thu');
  assert.ok([1, 4].includes(parseYmd(water.date).getDay()), 'a repeating task without a date gets its first date');
  assert.equal(trip.title, 'New list task');
  assert.equal(trip.list, 'Travel', '#NewList in text creates the list');
  // Retrying the same call does not duplicate.
  const again = call('create_tasks', { tasks: [{ title: 'Write report', list: 'Work', date: 'tomorrow' }] });
  assert.equal(again.isError, true);
  assert.match(text(again), /allow_duplicates/);
  assert.equal(call('create_tasks', { tasks: [{ title: 'Write report', list: 'Work', date: 'tomorrow' }], allow_duplicates: true }).isError, false);
  // Writes were broadcast as ops + activity.
  assert.ok(events.some(([e, p]) => e === 'ops' && p.origin === `ai:${client.id}` && p.ops.some((o) => o.c === 'tasks')));
  assert.ok(events.some(([e, p]) => e === 'ai' && p.type === 'activity' && p.entry.tool === 'create_tasks'));
});

test('find_tasks filters, sorts and pages', () => {
  const all = data(call('find_tasks', { limit: 100 }));
  assert.ok(all.total >= 5);
  const work = data(call('find_tasks', { list: 'Work' }));
  assert.ok(work.tasks.every((t) => t.list === 'Work'));
  assert.ok(data(call('find_tasks', { labels: ['phone'] })).tasks.every((t) => t.labels.includes('phone')));
  assert.ok(data(call('find_tasks', { priority: ['p1'] })).tasks.every((t) => t.priority === 'P1'));
  assert.equal(data(call('find_tasks', { query: 'mom call' })).total, 1);
  const p1 = data(call('find_tasks', { limit: 2 }));
  assert.equal(p1.tasks.length, 2);
  assert.ok(p1.next_cursor);
  const p2 = data(call('find_tasks', { limit: 2, cursor: p1.next_cursor }));
  assert.notEqual(p2.tasks[0].task_id, p1.tasks[0].task_id);
  assert.equal(call('find_tasks', { cursor: 'garbage!' }).isError, true);
  const ranged = data(call('find_tasks', { due_from: 'tomorrow', due_to: 'tomorrow' }));
  assert.ok(ranged.tasks.every((t) => t.date === day(1) || t.deadline === day(1)));
});

test('update_tasks: partial updates, null clears, labels and steps', () => {
  const t = data(call('find_tasks', { query: 'Write report', limit: 1 })).tasks[0];
  const full = data(call('get_task', { task_id: t.task_id })).task;
  const stepId = full.steps[0].step_id;
  const r = call('update_tasks', {
    tasks: [
      { task_id: t.task_id, time: null, add_labels: ['urgent'], remove_labels: ['deep-work'], update_steps: [{ step_id: stepId, done: true }], add_steps: ['Review'], notes: 'From AI' },
      { task_id: 'missing', title: 'x' },
    ],
  });
  assert.equal(r.isError, false);
  const u = data(r).updated[0];
  assert.equal(u.time, null);
  assert.equal(u.date, day(1), 'clearing time keeps the date');
  assert.deepEqual(u.labels, ['urgent']);
  assert.equal(u.steps_done, 1);
  assert.equal(u.steps_total, 3);
  assert.equal(data(r).failed.length, 1);
  const after = data(call('get_task', { task_id: t.task_id })).task;
  assert.equal(after.notes, 'From AI');
  assert.equal(call('update_tasks', { tasks: [{ task_id: t.task_id, update_steps: [{ step_id: 'nope', done: true }] }] }).isError, true);
});

test('complete_tasks: plain, repeating (advances + logs a copy), undated repeating, reopen', () => {
  const water = data(call('find_tasks', { query: 'Water plants' })).tasks[0];
  const r = call('complete_tasks', { task_ids: [water.task_id] });
  assert.equal(r.isError, false);
  assert.match(text(r), /comes back on/);
  const next = data(call('get_task', { task_id: water.task_id })).task;
  assert.equal(next.done, false);
  assert.ok(next.date > water.date || (next.date > today && water.date <= today));
  const copies = data(call('find_tasks', { status: 'done', query: 'Water plants' })).tasks;
  assert.equal(copies.length, 1);
  // A repeating task with no date at all still moves forward (audit fix).
  const id = core.store.transaction((tx) => tx.put('tasks', { id: 'norep', title: 'Stretch', repeat: { freq: 'day', interval: 1 }, createdAt: 1, updatedAt: 1 })).result.id;
  call('complete_tasks', { task_ids: [id] });
  assert.equal(core.store.get('tasks', id).date, day(1));
  // Plain task + reopen.
  const mom = data(call('find_tasks', { query: 'Call mom' })).tasks[0];
  call('complete_tasks', { task_ids: [mom.task_id] });
  assert.equal(core.store.get('tasks', mom.task_id).done, true);
  assert.match(text(call('complete_tasks', { task_ids: [mom.task_id] })), /already done/);
  call('complete_tasks', { task_ids: [mom.task_id], done: false });
  assert.equal(core.store.get('tasks', mom.task_id).done, false);
  assert.equal(call('complete_tasks', { task_ids: ['ghost'] }).isError, true);
});

test('create_events: timed, all-day, natural language, repeats, duplicates and overlaps', () => {
  const mon = nextWeekday(1);
  const r = call('create_events', {
    events: [
      { title: 'Standup', start: `${mon}T09:30`, duration_minutes: 15, repeat: 'every weekday', calendar: 'Work' },
      { title: 'Design review', start: `${mon}T09:00`, end: '10:00', calendar: 'work' },
      { title: 'Offsite', all_day: true, date: day(20), end_date: day(21) },
      { text: 'Lunch with Sam tomorrow 12:30-1:30pm at Cafe Luna' },
      { title: 'Late show', start: `${day(3)}T22:00`, end: '01:00' },
      { title: 'Broken', start: `${day(3)}T10:00`, end: `${day(3)}T09:00` },
      { title: 'Rrule', start: `${mon}T18:00`, repeat: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4' },
    ],
  });
  assert.equal(r.isError, false);
  const d = data(r);
  assert.equal(d.created.length, 6);
  assert.equal(d.failed.length, 1);
  assert.match(d.failed[0].error, /after start/);
  assert.ok(d.warnings.some((w) => /Design review.*overlaps.*Standup|Standup.*overlaps/i.test(w)), 'overlap warning');
  const [standup, review, offsite, lunch, late, rr] = d.created;
  assert.equal(standup.repeat, 'Weekdays');
  assert.equal(standup.calendar, 'Work');
  assert.equal(review.end, `${mon}T10:00`);
  assert.equal(offsite.all_day, true);
  assert.equal(offsite.end, day(21));
  assert.equal(lunch.title, 'Lunch with Sam');
  assert.equal(lunch.start, `${day(1)}T12:30`);
  assert.equal(lunch.end, `${day(1)}T13:30`);
  assert.equal(lunch.location, 'Cafe Luna');
  assert.equal(late.end, `${day(4)}T01:00`, 'end before start means the next day');
  const rrEvent = core.store.get('events', rr.event_id);
  assert.deepEqual(rrEvent.repeat.days, [1, 3]);
  assert.ok(rrEvent.until, 'COUNT becomes an until date');
  const dup = call('create_events', { events: [{ title: 'standup', start: `${mon}T09:30`, calendar: 'Work' }] });
  assert.equal(dup.isError, true);
  assert.match(text(dup), /already starts/);
});

test('find_events expands repeats; get_event checks occurrences', () => {
  const mon = nextWeekday(1);
  const r = data(call('find_events', { from: mon, to: addDaysYmd(mon, 6), query: 'standup' }));
  assert.equal(r.total, 5, 'Mon-Fri');
  assert.ok(r.events.every((e) => e.occurrence && e.event_id));
  const id = r.events[0].event_id;
  assert.equal(call('get_event', { event_id: id, occurrence: addDaysYmd(mon, 1) }).isError, false);
  const sat = call('get_event', { event_id: id, occurrence: addDaysYmd(mon, 5) });
  assert.equal(sat.isError, true);
  assert.match(text(sat), /Nearby occurrences/);
  assert.equal(call('find_events', { from: day(0), to: day(500) }).isError, true, 'range limit');
});

test('update_event: this / following / all on a series', () => {
  const mon = nextWeekday(1);
  const series = data(call('find_events', { from: mon, to: mon, query: 'standup' })).events[0];
  const wed = addDaysYmd(mon, 2);
  // this: Wednesday moves to 10:00 as its own event
  let r = call('update_event', { event_id: series.event_id, occurrence: wed, scope: 'this', start: `${wed}T10:00` });
  assert.equal(r.isError, false, text(r));
  let base = core.store.get('events', series.event_id);
  assert.ok(base.exdates.includes(wed));
  const detached = core.store.all('events').find((e) => e.seriesId === series.event_id);
  assert.equal(detached.start, `${wed}T10:00`);
  assert.equal(detached.end, `${wed}T10:15`, 'length kept');
  // following: from Thursday on, standup is at 11:00 in a new series
  const thu = addDaysYmd(mon, 3);
  r = call('update_event', { event_id: series.event_id, occurrence: thu, scope: 'following', start: `${thu}T11:00` });
  assert.equal(r.isError, false, text(r));
  base = core.store.get('events', series.event_id);
  assert.equal(base.until, wed);
  const newer = core.store.all('events').find((e) => e.id !== series.event_id && e.title === 'Standup' && e.repeat);
  assert.equal(newer.start, `${thu}T11:00`);
  // all: move the whole (original) series one day later; exdates move with it
  r = call('update_event', { event_id: series.event_id, scope: 'all', date: addDaysYmd(mon, 1) });
  assert.equal(r.isError, false, text(r));
  base = core.store.get('events', series.event_id);
  assert.equal(base.start.slice(0, 10), addDaysYmd(mon, 1));
  assert.ok(base.exdates.includes(addDaysYmd(wed, 1)));
  assert.deepEqual(base.repeat.days, [1, 2, 3, 4, 5], 'a weekdays pattern stays weekdays');
  assert.equal(base.until, addDaysYmd(wed, 1));
  // Errors
  assert.equal(call('update_event', { event_id: series.event_id, scope: 'this' }).isError, true, 'occurrence required');
  assert.equal(call('update_event', { event_id: series.event_id, occurrence: thu, scope: 'this', repeat: 'daily' }).isError, true);
  assert.equal(call('update_event', { event_id: 'nope', title: 'x' }).isError, true);
});

test('find_free_time and schedule_tasks (dry run first)', () => {
  const mon = nextWeekday(1);
  const free = data(call('find_free_time', { from: mon, to: mon, duration_minutes: 60, working_hours: { start: '09:00', end: '12:00' } }));
  assert.ok(free.slots.length >= 1);
  for (const s of free.slots) assert.ok(s.minutes >= 60 && s.start >= `${mon}T09:00` && s.end <= `${mon}T12:00`);
  const t = data(call('create_tasks', { tasks: [{ title: 'Deep work block', duration_minutes: 45 }] })).created[0];
  const dry = call('schedule_tasks', { items: [{ task_id: t.task_id }], from: mon, to: mon });
  assert.equal(dry.isError, false, text(dry));
  assert.equal(data(dry).dry_run, true);
  assert.equal(core.store.get('tasks', t.task_id).time, null, 'dry run changes nothing');
  const p = data(dry).placements[0];
  const wet = call('schedule_tasks', { items: [{ task_id: t.task_id }], from: mon, to: mon, dry_run: false });
  assert.equal(data(wet).placements[0].time, p.time);
  const stored = core.store.get('tasks', t.task_id);
  assert.equal(stored.date, mon);
  assert.equal(stored.duration, 45);
  assert.match(data(wet).change_id, /^chg_/);
  assert.equal(call('schedule_tasks', { items: [{ task_id: t.task_id }], from: mon, to: mon, working_hours: { start: '09:00', end: '09:10' } }).isError, true);
});

test('get_overview shows overdue, events, tasks and free time', () => {
  core.store.transaction((tx) => tx.put('tasks', { id: 'late1', title: 'Late thing', date: day(-2), createdAt: 1, updatedAt: 1 }));
  const r = call('get_overview', { days: 2 });
  assert.equal(r.isError, false);
  const d = data(r);
  assert.equal(d.days.length, 2);
  assert.ok(d.overdue.some((t) => t.task_id === 'late1'));
  assert.match(text(r), /Overdue tasks/);
  assert.ok(d.days[1].events.some((e) => e.title === 'Lunch with Sam'));
});

test('create_list and delete_items (lists need move_tasks_to; series take their edited occurrences)', () => {
  assert.equal(call('create_list', { name: 'Errands', color: 'orange' }).isError, false);
  assert.equal(call('create_list', { name: 'errands' }).isError, true);
  assert.equal(call('create_list', { name: 'Inbox' }).isError, true);
  const home = call('delete_items', { items: [{ type: 'list', id: 'lhome' }] });
  assert.equal(home.isError, true);
  assert.match(text(home), /move_tasks_to/);
  const r = call('delete_items', { items: [{ type: 'list', id: 'lhome', move_tasks_to: 'Work' }] });
  assert.equal(r.isError, false);
  assert.equal(core.store.get('lists', 'lhome'), null);
  assert.ok(core.store.all('tasks').filter((t) => t.title === 'Call mom').every((t) => t.listId === 'lwork'));
  const series = core.store.all('events').find((e) => e.title === 'Standup' && e.exdates?.length);
  const d = call('delete_items', { items: [{ type: 'event', id: series.id }] });
  assert.equal(d.isError, false);
  assert.ok(!core.store.all('events').some((e) => e.seriesId === series.id), 'detached occurrences deleted too');
  const lunch = core.store.all('events').find((e) => e.title === 'Lunch with Sam');
  const one = call('delete_items', { items: [{ type: 'event', id: lunch.id, occurrence: day(9) }] });
  assert.equal(one.isError, true, 'a single event has no other occurrences');
});

test('undo_change restores, skips items edited since, and can be redone', () => {
  const created = call('create_tasks', { tasks: [{ title: 'Undo me' }, { title: 'Edit me later' }] });
  const changeId = data(created).change_id;
  const [a, b] = data(created).created;
  call('update_tasks', { tasks: [{ task_id: b.task_id, title: 'Edited' }] });
  const u = call('undo_change', { change_id: changeId });
  assert.equal(u.isError, false, text(u));
  assert.equal(data(u).restored, 1);
  assert.equal(data(u).skipped.length, 1);
  assert.equal(core.store.get('tasks', a.task_id), null);
  assert.ok(core.store.get('tasks', b.task_id));
  assert.equal(call('undo_change', { change_id: changeId }).isError, true, 'already undone');
  const redo = call('undo_change', { change_id: data(u).change_id });
  assert.equal(redo.isError, false);
  assert.ok(core.store.get('tasks', a.task_id), 'undoing the undo brings it back');
  const ch = data(call('find_changes', { limit: 5 })).changes;
  assert.ok(ch.some((c) => c.change_id === changeId && c.undone));
  assert.equal(call('undo_change', { change_id: 'chg_nope' }).isError, true);
});

test('undo data is kept in its own file; ai.json only holds summaries', () => {
  const notes = 'x'.repeat(10000);
  const r = call('create_tasks', { tasks: [{ title: 'Kept for undo', notes }] });
  const id = data(r).change_id;
  assert.match(text(r), /undo_change reverts this/);
  assert.equal(data(r).undoable, undefined);
  const file = join(core.dataDir, 'changes', `${id}.json`);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).after[0].item.notes === notes);
  const raw = readFileSync(join(core.dataDir, 'ai.json'), 'utf8');
  assert.ok(!raw.includes(notes.slice(0, 100)), 'no item contents in ai.json');
  const rec = JSON.parse(raw).changes.find((c) => c.changeId === id);
  assert.equal(rec.undoable, true);
  assert.equal(rec.before, undefined);
  assert.equal(data(call('find_changes', { limit: 1 })).changes[0].undoable, true);
  const u = call('undo_change', { change_id: id });
  assert.equal(u.isError, false, text(u));
  assert.equal(data(u).restored, 1);
});

test('a change too big to keep undo data for is listed, but never offered for undo', () => {
  const limit = core.ai.maxUndoBytes;
  core.ai.maxUndoBytes = 2000;
  try {
    const r = call('create_tasks', { tasks: [{ title: 'Big one', notes: 'n'.repeat(5000) }] });
    assert.equal(r.isError, false);
    const id = data(r).change_id;
    assert.match(text(r), new RegExp(`change_id=${id} \\(too large to undo\\)`));
    assert.equal(data(r).undoable, false);
    const act = events.filter(([e, p]) => e === 'ai' && p.type === 'activity').at(-1)[1].entry;
    assert.equal(act.tool, 'create_tasks');
    assert.equal(act.changeId, null, 'the activity list offers no Undo for it');
    assert.ok(!existsSync(join(core.dataDir, 'changes', `${id}.json`)));
    const listed = data(call('find_changes', { limit: 2 })).changes.find((c) => c.change_id === id);
    assert.equal(listed.undoable, false);
    const u = call('undo_change', { change_id: id });
    assert.equal(u.isError, true);
    assert.match(text(u), /too large to keep undo data/);
    assert.ok(core.store.get('tasks', data(r).created[0].task_id), 'nothing was touched');
  } finally {
    core.ai.maxUndoBytes = limit;
  }
});

test('reads are logged right away but saved lazily (no ai.json rewrite per read)', () => {
  core.close();
  const file = join(core.dataDir, 'ai.json');
  const before = readFileSync(file, 'utf8');
  const r = call('get_context', {});
  assert.equal(r.isError, false);
  assert.equal(readFileSync(file, 'utf8'), before, 'a read did not rewrite ai.json');
  assert.equal(core.ai.recentActivity(1)[0].tool, 'get_context', 'it is in the activity list at once');
  assert.ok(events.some(([e, p]) => e === 'ai' && p.type === 'activity' && p.entry.tool === 'get_context'), 'and pushed to browsers');
  core.close();
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).activity.some((a) => a.tool === 'get_context'), 'and saved on close');
});

test('access: read-only credentials and modes', () => {
  const ro = core.ai.createClient({ kind: 'chatgpt', access: 'read' });
  assert.equal(call('get_overview', {}, ro).isError, false);
  const w = call('create_tasks', { tasks: [{ title: 'x' }] }, ro);
  assert.equal(w.isError, true);
  assert.match(text(w), /read-only/);
  core.ai.setMode('read');
  assert.match(text(call('create_list', { name: 'Nope' })), /read-only/);
  core.ai.setMode('off');
  assert.match(text(call('get_overview', {})), /AI access is turned off in ecosys/);
  core.ai.setMode('write');
  core.ai.deleteClient(ro.id);
  assert.match(text(call('get_overview', {}, ro)), /removed/);
});

test('moving a weekly series moves its weekday', () => {
  const mon = nextWeekday(1);
  const e = data(call('create_events', { events: [{ title: 'Piano', start: `${mon}T17:00`, repeat: 'weekly' }] })).created[0];
  assert.deepEqual(core.store.get('events', e.event_id).repeat.days, [1]);
  call('update_event', { event_id: e.event_id, scope: 'all', date: addDaysYmd(mon, 1) });
  const moved = core.store.get('events', e.event_id);
  assert.deepEqual(moved.repeat.days, [2]);
  assert.equal(moved.start, `${addDaysYmd(mon, 1)}T17:00`);
});

test('model helpers: dates, times, repeats, free slots', () => {
  const c = clock();
  assert.equal(parseDate('today', c), today);
  assert.equal(parseDate('2026-02-28', c), '2026-02-28');
  assert.throws(() => parseDate('2026-02-30', c), ToolError);
  assert.throws(() => parseDate('soonish', c), /YYYY-MM-DD/);
  assert.deepEqual(parseWhen('2026-12-01T09:15', c), { date: '2026-12-01', time: '09:15' });
  assert.deepEqual(parseWhen('2026-12-01', c), { date: '2026-12-01', time: null });
  const z = parseWhen('2026-12-01T17:00:00Z', c);
  assert.match(z.time, /^\d{2}:\d{2}$/);
  assert.deepEqual(parseRepeat('every weekday', c).rule, { freq: 'week', interval: 1, days: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseRepeat('every 2 weeks on mon, thu', c).rule, { freq: 'week', interval: 2, days: [1, 4] });
  assert.equal(parseRepeat('monthly on the 15th', c).rule.monthDay, 15);
  assert.equal(parseRepeat('daily after completion', c).rule.from, 'done');
  assert.equal(parseRepeat('none', c).rule, null);
  assert.equal(parseRepeat({ freq: 'year', interval: 1 }, c, '2026-03-04').rule.monthDay, 4);
  assert.throws(() => parseRepeat('whenever I feel like it', c), /not a pattern/);
  assert.equal(parseRepeat('FREQ=DAILY;INTERVAL=3', c).rule.interval, 3);
  // free slots skip busy time and weekends
  const busy = [[Date.UTC(2026, 10, 23, 10, 0) / 60000, Date.UTC(2026, 10, 23, 11, 0) / 60000]];
  const slots = freeSlots(busy, '2026-11-21T00:00', '2026-11-24T00:00', { duration: 30, workStart: '09:00', workEnd: '12:00', max: 5 });
  assert.deepEqual(slots.map((s) => [s.start, s.end]), [['2026-11-23T09:00', '2026-11-23T10:00'], ['2026-11-23T11:00', '2026-11-23T12:00']]);
});

test('event occurrences are DST-proof (wall-clock arithmetic)', () => {
  const st = {
    all: (c) => (c === 'events' ? [{ id: 'e', title: 'Daily 9', calendarId: 'x', allDay: false, start: '2026-03-07T09:00', end: '2026-03-07T10:00', repeat: { freq: 'day', interval: 1 }, exdates: [] }] : []),
    get: () => null,
  };
  const inst = instancesBetween(st, '2026-03-07', '2026-03-10');
  assert.deepEqual(inst.map((i) => i.start), ['2026-03-07T09:00', '2026-03-08T09:00', '2026-03-09T09:00', '2026-03-10T09:00']);
  assert.ok(inst.every((i) => i.end.endsWith('T10:00')));
});
