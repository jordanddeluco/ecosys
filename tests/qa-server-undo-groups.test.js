// QA (server fix, second pass): undo_change takes back items that belong together together, or none.
//  - A repeating task and the done copy its completion logged: when the task was edited after the
//    completion, undoing the completion used to delete the copy and leave the task moved on (the
//    completion was lost). Now both are left alone, and the result says why.
//  - A series split with update_event scope "following", or one day edited on its own (scope "this"):
//    when the series was edited since, undoing the edit used to delete the new series (or the edited
//    day) and keep the shortened series, so those days were gone. Now both are left alone.
//  - Unchanged items are still taken back together, as before.
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
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-undo-groups-'));
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
/** The user edits a record in an app (a browser sync). */
const userEdit = (core, c, id, patch) => core.store.applyOps([{ op: 'put', c, item: { ...core.store.get(c, id), ...patch, updatedAt: Date.now() + 5000 } }]);
const copiesOf = (core, id) => core.store.all('tasks').filter((x) => x.repeatOf === id);

test('undoing a repeating task\'s completion after the task was edited leaves the task and its logged completion alone', async () => {
  await withCore(async ({ core, call, today }) => {
    const date = addDaysYmd(today, 3);
    const id = call('create_tasks', { tasks: [{ title: 'Water plants', date, repeat: 'weekly' }] }).data.created[0].task_id;
    const done = call('complete_tasks', { task_ids: [id] });
    const moved = core.store.get('tasks', id).date;
    userEdit(core, 'tasks', id, { notes: 'use the green can' });
    const u = call('undo_change', { change_id: done.data.change_id });
    assert.equal(u.isError, true, u.text);
    assert.match(u.text, /Nothing was undone: 1 item\(s\) were changed again after \S+ \("Water plants"\), and what goes with them was left as it is too \(the logged completion of "Water plants"\)/);
    assert.equal(copiesOf(core, id).length, 1, 'the completion is still logged');
    assert.equal(core.store.get('tasks', id).date, moved, 'and the task is where that completion put it');
    assert.equal(core.store.get('tasks', id).notes, 'use the green can');
  });
});

test('undoing a completion of an unchanged repeating task still takes both back', async () => {
  await withCore(async ({ core, call, today }) => {
    const date = addDaysYmd(today, 3);
    const id = call('create_tasks', { tasks: [{ title: 'Water plants', date, repeat: 'weekly' }] }).data.created[0].task_id;
    const done = call('complete_tasks', { task_ids: [id] });
    const u = call('undo_change', { change_id: done.data.change_id });
    assert.equal(u.isError, false, u.text);
    assert.equal(core.store.get('tasks', id).date, date);
    assert.equal(copiesOf(core, id).length, 0);
  });
});

test('of several tasks completed in one call, only the edited one (with its completion) is left alone', async () => {
  await withCore(async ({ core, call, today }) => {
    const date = addDaysYmd(today, 3);
    const [a, b] = call('create_tasks', { tasks: [{ title: 'Water plants', date, repeat: 'weekly' }, { title: 'Take out bins', date, repeat: 'weekly' }] }).data.created.map((t) => t.task_id);
    const done = call('complete_tasks', { task_ids: [a, b] });
    userEdit(core, 'tasks', a, { title: 'Water the plants' });
    const u = call('undo_change', { change_id: done.data.change_id });
    assert.equal(u.isError, false, u.text);
    assert.match(u.text, /restored 2 item\(s\)/);
    assert.match(u.text, /Also left alone, as they go with those: the logged completion of "Water (the )?plants"/);
    assert.equal(core.store.get('tasks', b).date, date, 'the other task is back');
    assert.equal(copiesOf(core, b).length, 0);
    assert.equal(copiesOf(core, a).length, 1, 'the edited one keeps its completion');
  });
});

test('undoing a series split after the first part was edited keeps both parts', async () => {
  await withCore(async ({ core, call, today }) => {
    const start = addDaysYmd(today, 5);
    const ev = call('create_events', { events: [{ title: 'Daily sync', start: `${start}T09:00`, duration_minutes: 15, repeat: 'daily', calendar: 'Work' }] }).data.created[0].event_id;
    const cut = addDaysYmd(start, 3);
    const split = call('update_event', { event_id: ev, occurrence: cut, scope: 'following', start: `${cut}T10:00` });
    assert.equal(split.isError, false, split.text);
    userEdit(core, 'events', ev, { title: 'Daily sync (renamed)' });
    const before = call('find_events', { from: start, to: addDaysYmd(start, 9), query: 'Daily sync' }).data.total;
    const u = call('undo_change', { change_id: split.data.change_id });
    assert.equal(u.isError, true, u.text);
    assert.match(u.text, /and what goes with them was left as it is too \(event "Daily sync"\)/);
    assert.equal(call('find_events', { from: start, to: addDaysYmd(start, 9), query: 'Daily sync' }).data.total, before, 'no day of the series was lost');
  });
});

test('undoing a one-day edit (scope this) after the series was edited keeps that day', async () => {
  await withCore(async ({ core, call, today }) => {
    const start = addDaysYmd(today, 5);
    const ev = call('create_events', { events: [{ title: 'Standup', start: `${start}T09:00`, duration_minutes: 15, repeat: 'daily', calendar: 'Work' }] }).data.created[0].event_id;
    const day = addDaysYmd(start, 2);
    const one = call('update_event', { event_id: ev, occurrence: day, scope: 'this', start: `${day}T11:00` });
    userEdit(core, 'events', ev, { location: 'Room 4' });
    const u = call('undo_change', { change_id: one.data.change_id });
    assert.equal(u.isError, true, u.text);
    assert.match(u.text, /the separately edited occurrence "Standup"/);
    const that = call('find_events', { from: day, to: day, query: 'Standup' }).data.events;
    assert.equal(that.length, 1, 'the day still has its standup');
    assert.equal(that[0].start, `${day}T11:00`);
  });
});
