// QA (server fix, second pass): assistants can manage calendars and lists, and know their working hours.
//  - create_calendar adds a calendar ("put these in a new Fitness calendar"); update_list and
//    update_calendar rename or recolor one. Names stay unique, the Inbox stays built in, every change
//    can be undone, and read-only connections are not offered these tools.
//  - Working hours: get_context says when they are only the default (no setting yet), and get_overview,
//    find_free_time, plan_tasks and schedule_tasks take working_hours for the user's own; a setting that
//    makes no range (an end before the start) falls back to 09:00-17:00.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, effectiveSettings } from '../server/core.mjs';
import { createValidators } from '../server/validate.mjs';
import { addDaysYmd } from '../shared/dates.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

async function withCore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-cal-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  core.store.importData({ data: { calendars: [{ id: 'cw', name: 'Work', color: 'blue', visible: true, order: 0, createdAt: 1, updatedAt: 1 }], lists: [{ id: 'lh', name: 'Home', color: 'green', icon: '', order: 0, createdAt: 1, updatedAt: 1 }] }, settings: {} });
  const client = core.ai.createClient({ kind: 'claude', access: 'write' });
  const reader = core.ai.createClient({ kind: 'chatgpt', access: 'read' });
  const as = (who) => (name, args = {}) => {
    const r = core.callTool(name, args, { client: who });
    return { isError: r.isError, text: r.content[0].text, data: r.structuredContent };
  };
  const call = as(client);
  const today = call('get_context').data.today;
  try {
    await fn({ core, call, read: as(reader), today, reader });
  } finally {
    core.close();
  }
}
const ok = (r) => {
  assert.equal(r.isError, false, r.text);
  return r;
};

test('create_calendar adds a calendar events can go in; duplicates are refused; undo removes it', async () => {
  await withCore(async ({ core, call, today }) => {
    const r = ok(call('create_calendar', { name: 'Fitness', color: 'green' }));
    const id = r.data.calendar.calendar_id;
    assert.match(r.text, new RegExp(`^Created calendar "Fitness" \\(green\\) id=${id}`));
    assert.deepEqual(core.store.get('calendars', id), { ...core.store.get('calendars', id), name: 'Fitness', color: 'green', visible: true });
    const ev = ok(call('create_events', { events: [{ title: 'Gym', start: `${addDaysYmd(today, 1)}T07:00`, duration_minutes: 60, calendar: 'Fitness' }] }));
    assert.equal(ev.data.created[0].calendar_id, id);
    assert.match(call('create_calendar', { name: 'fitness' }).text, /A calendar named "Fitness" already exists \(id=\w+\)/);
    assert.ok(ok(call('get_context')).data.calendars.some((c) => c.calendar_id === id && c.name === 'Fitness'));
    ok(call('undo_change', { change_id: r.data.change_id }));
    assert.equal(core.store.get('calendars', id), null);
  });
});

test('update_list and update_calendar rename and recolor; the Inbox stays built in; undo puts names back', async () => {
  await withCore(async ({ core, call }) => {
    const l = ok(call('update_list', { list: 'Home', name: 'Household', color: 'teal' }));
    assert.match(l.text, /^Updated list "Household" \(was "Home"\) \(teal\) id=lh/);
    assert.deepEqual([core.store.get('lists', 'lh').name, core.store.get('lists', 'lh').color], ['Household', 'teal']);
    assert.match(call('update_list', { list: 'inbox', name: 'Main' }).text, /The Inbox is built in/);
    assert.match(call('update_list', { list: 'lh', name: 'Inbox' }).text, /"Inbox" is built in; pick another name/);
    assert.match(call('update_list', { list: 'Nowhere', name: 'X' }).text, /No list named "Nowhere"/);
    assert.match(call('update_list', { list: 'lh' }).text, /Send name and\/or color/);
    const c = ok(call('update_calendar', { calendar: 'Work', color: 'red' }));
    assert.equal(c.data.calendar.color, 'red');
    assert.equal(core.store.get('calendars', 'cw').name, 'Work', 'only the color changed');
    ok(call('create_calendar', { name: 'Family' }));
    assert.match(call('update_calendar', { calendar: 'cw', name: 'family' }).text, /A calendar named "Family" already exists/);
    const same = ok(call('update_calendar', { calendar: 'cw', color: 'red' }));
    assert.match(same.text, /already looks like that; nothing changed/);
    assert.equal(same.data.change_id, undefined, 'nothing changed: no change to undo');
    ok(call('undo_change', { change_id: l.data.change_id }));
    assert.deepEqual([core.store.get('lists', 'lh').name, core.store.get('lists', 'lh').color], ['Home', 'green']);
  });
});

test('read-only connections are not offered the calendar and list tools, and can\'t call them', async () => {
  await withCore(async ({ core, read, reader }) => {
    const names = core.mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { client: reader, transport: 'stdio' }).body.result.tools.map((t) => t.name);
    for (const n of ['create_calendar', 'update_list', 'update_calendar']) assert.ok(!names.includes(n), n);
    assert.match(read('create_calendar', { name: 'Nope' }).text, /read-only/);
  });
});

test('without shared/sanitize.js, the built-in validator keeps the settings the server reads, and no prototype names', () => {
  const v = createValidators(null);
  const out = v.settings({ toString: 'x', valueOf: 'y', scheduleWorkStart: '07:00', scheduleWorkEnd: '25:00', notesAi: 'read', uiTimeZone: 'Europe/Paris', weekStart: 1 });
  assert.deepEqual(out, { scheduleWorkStart: '07:00', notesAi: 'read', uiTimeZone: 'Europe/Paris', weekStart: 1 });
  assert.ok(!Object.hasOwn(out, 'toString'));
});

test('working hours: the default is marked as such, a call can use the user\'s own, and a setting that is no range falls back', async () => {
  await withCore(async ({ core, call, today }) => {
    const ctx = ok(call('get_context'));
    assert.deepEqual(ctx.data.working_hours, { start: '09:00', end: '17:00', default: true });
    assert.match(ctx.text, /Working hours 09:00-17:00 \(the default: when the user keeps other hours, pass working_hours to find_free_time, plan_tasks and schedule_tasks\)\./);
    const day = addDaysYmd(today, 1);
    const ov = ok(call('get_overview', { date: day, working_hours: { start: '07:00', end: '15:00' } }));
    assert.match(ov.text, /Free in working hours 07:00-15:00: 07:00-15:00 \(8h\)/);
    core.store.applyOps([{ op: 'settings', patch: { scheduleWorkStart: '07:30', scheduleWorkEnd: '15:30' } }]);
    const set = ok(call('get_context'));
    assert.deepEqual(set.data.working_hours, { start: '07:30', end: '15:30' });
    assert.match(set.text, /Working hours 07:30-15:30\. /);
    assert.match(ok(call('get_overview', { date: day })).text, /Free in working hours 07:30-15:30/);
    assert.deepEqual([effectiveSettings({ scheduleWorkStart: '18:00', scheduleWorkEnd: '09:00' })].map((s) => [s.workStart, s.workEnd, s.workHoursSet]), [['09:00', '17:00', false]]);
    assert.deepEqual([effectiveSettings({ scheduleWorkStart: '25:00', scheduleWorkEnd: 'soon' })].map((s) => [s.workStart, s.workEnd, s.workHoursSet]), [['09:00', '17:00', false]]);
    assert.deepEqual([effectiveSettings({ scheduleWorkStart: '06:00' })].map((s) => [s.workStart, s.workEnd, s.workHoursSet]), [['06:00', '17:00', true]]);
  });
});
