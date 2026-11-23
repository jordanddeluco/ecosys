// QA (server fix): task tools as assistants really use them.
//  - find_tasks filters by when tasks were finished (completed_from / completed_to), and get_overview
//    lists what was finished each day.
//  - "Not done after all": reopening a repeating task right after completing it takes the completion
//    back (date and steps restored, the done copy removed), also when the task was edited since.
//  - complete_tasks mirrors the task's linked checklist items in notes, in the same change, but only
//    in notes the assistant may change (never one hidden from AI, in a hidden folder or deleted, and
//    none while notes access is Read or Off).
//  - Inputs models send: priority "P1" as results print it, "now" as a date-time.
//  - plan_tasks proposes time blocks read-only; spread puts each task on the emptiest day.
//  - update_tasks is not idempotent (add_steps appends again on a retry), and says so.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { validYmd, parseWhen, parseDate, clock } from '../server/model.mjs';
import { addDaysYmd, parseYmd } from '../shared/dates.js';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
const DAY = 86400000;

async function withCore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-tasks-'));
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
    await fn({ core, call, today, client });
  } finally {
    core.close();
  }
}
const ok = (r) => {
  assert.equal(r.isError, false, r.text);
  return r;
};
const task = (t) => ({ notes: '', listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null, checklist: [], done: false, completedAt: null, order: 1, createdAt: 1, updatedAt: 1, ...t });

test('find_tasks completed_from / completed_to: by when tasks were finished, whatever their planned day', async () => {
  await withCore(async ({ core, call, today }) => {
    const now = Date.now();
    core.store.applyOps([
      { op: 'put', c: 'tasks', item: task({ id: 'qaUndated', title: 'QA finished undated', done: true, completedAt: now - DAY }) },
      { op: 'put', c: 'tasks', item: task({ id: 'qaOld', title: 'QA finished long ago', date: today, done: true, completedAt: now - 25 * DAY }) },
      { op: 'put', c: 'tasks', item: task({ id: 'qaOpen', title: 'QA still open', date: today }) },
    ]);
    const r = ok(call('find_tasks', { completed_from: addDaysYmd(today, -6), completed_to: today, query: 'QA' }));
    assert.deepEqual(r.data.tasks.map((t) => t.title), ['QA finished undated'], 'status done is implied');
    assert.match(r.text, /completed .+ to .+/);
    assert.equal(ok(call('find_tasks', { completed_from: addDaysYmd(today, -30), query: 'QA' })).data.total, 2);
    assert.equal(call('find_tasks', { completed_from: today, status: 'open' }).isError, true, 'open tasks have no completion day');
    assert.equal(call('find_tasks', { completed_from: today, completed_to: addDaysYmd(today, -1) }).isError, true);
    const def = core.tools.find((t) => t.name === 'find_tasks');
    assert.match(def.description, /completed_from\/completed_to filter when tasks were finished/);
  });
});

test('get_overview lists the titles finished that day', async () => {
  await withCore(async ({ call, today }) => {
    const id = ok(call('create_tasks', { tasks: [{ title: 'QA overview finished', date: addDaysYmd(today, 9) }] })).data.created[0].task_id;
    ok(call('complete_tasks', { task_ids: [id] }));
    const r = ok(call('get_overview', {}));
    assert.match(r.text, /Completed that day \(1\):\n- "QA overview finished" \| done \d\d:\d\d \| id=/);
    assert.deepEqual(r.data.days[0].completed.map((t) => t.title), ['QA overview finished']);
  });
});

test('reopening a repeating task right after completing it takes the completion back', async () => {
  await withCore(async ({ core, call, today }) => {
    const date = addDaysYmd(today, 3);
    const id = ok(call('create_tasks', { tasks: [{ title: 'QA water plants', date, repeat: 'weekly', steps: ['Kitchen', 'Balcony'] }] })).data.created[0].task_id;
    const t0 = core.store.get('tasks', id);
    ok(call('update_tasks', { tasks: [{ task_id: id, update_steps: [{ step_id: t0.checklist[0].id, done: true }] }] }));
    ok(call('complete_tasks', { task_ids: [id] }));
    assert.notEqual(core.store.get('tasks', id).date, date, 'control: completing moved it on');
    const re = ok(call('complete_tasks', { task_ids: [id], done: false }));
    const t = core.store.get('tasks', id);
    assert.equal(t.date, date, re.text);
    assert.deepEqual(t.checklist.map((s) => s.done), [true, false], 'the steps are as they were');
    assert.equal(core.store.all('tasks').filter((x) => x.repeatOf === id).length, 0, 'the logged done copy is gone');
    assert.match(re.text, /reopened: its completion was taken back, so it is due .+ again/);
  });
});

test('a repeating task edited after its completion is reopened too, keeping the edit (see qa-server-reopen.test.js)', async () => {
  await withCore(async ({ core, call, today }) => {
    const date = addDaysYmd(today, 4);
    const id = ok(call('create_tasks', { tasks: [{ title: 'QA chore', date, repeat: 'weekly' }] })).data.created[0].task_id;
    ok(call('complete_tasks', { task_ids: [id] }));
    core.store.applyOps([{ op: 'put', c: 'tasks', item: { ...core.store.get('tasks', id), title: 'QA chore (renamed)', updatedAt: Date.now() + 5000 } }]);
    const re = ok(call('complete_tasks', { task_ids: [id], done: false }));
    const t = core.store.get('tasks', id);
    assert.equal(t.date, date, re.text);
    assert.equal(t.title, 'QA chore (renamed)', 'the edit made since stays');
    const line = re.text.split('\n').find((l) => l.includes('QA chore'));
    assert.equal(/\bid=([^\s|)]+)/.exec(line.replace(/"(?:[^"\\]|\\.)*"/g, '""'))?.[1], id, 'the one id= on the line is the task\'s own');
  });
});

test('complete_tasks checks and unchecks the linked checklist items of notes the assistant may change', async () => {
  await withCore(async ({ core, call, today }) => {
    const id = ok(call('create_tasks', { tasks: [{ title: 'QA linked task', date: addDaysYmd(today, 5) }] })).data.created[0].task_id;
    const t = Date.now() - 60000;
    const note = (nid, extra = {}) => ({
      id: nid, v: 1, rev: 1, folderId: null, pinned: false, day: null, event: null, aiHidden: false, aiPrev: null, locked: null, editedBy: 'user', editedAt: t, createdAt: t, updatedAt: t, trashedAt: null, trashedFrom: null,
      blocks: [{ id: `${nid}h`, t: 'h1', c: [['Plan']] }, { id: `${nid}c`, t: 'check', ck: false, task: id, c: [['QA linked task']] }],
      ...extra,
    });
    core.store.applyOps([
      { op: 'put', c: 'folders', item: { id: 'fhid', name: 'Private', parentId: null, color: 'blue', order: 0, aiHidden: true, createdAt: t, updatedAt: t } },
      { op: 'put', c: 'notes', item: note('nvis') },
      { op: 'put', c: 'notes', item: note('nhid', { aiHidden: true }) },
      { op: 'put', c: 'notes', item: note('nfold', { folderId: 'fhid' }) },
      { op: 'put', c: 'notes', item: note('ntrash', { trashedAt: t, trashedFrom: null }) },
    ]);
    const ck = (nid) => core.store.get('notes', nid).blocks.find((b) => b.task === id).ck;
    const done = ok(call('complete_tasks', { task_ids: [id] }));
    assert.equal(ck('nvis'), true, 'a visible note follows');
    assert.equal(core.store.get('notes', 'nvis').rev, 2, 'a system change: rev + 1');
    assert.equal(core.store.get('notes', 'nvis').editedAt, t, 'the edit time is kept');
    assert.deepEqual(['nhid', 'nfold', 'ntrash'].map(ck), [false, false, false], 'hidden, in a hidden folder or deleted: left alone');
    assert.doesNotMatch(done.text, /nvis|nhid|note/i, 'results never mention notes');
    ok(call('complete_tasks', { task_ids: [id], done: false }));
    assert.equal(ck('nvis'), false, 'reopening unchecks it');
    // Notes access Read: an assistant changes no note.
    core.store.applyOps([{ op: 'settings', patch: { notesAi: 'read' } }]);
    ok(call('complete_tasks', { task_ids: [id] }));
    assert.equal(ck('nvis'), false);
    // undo_change of the visible mirror puts both back.
    core.store.applyOps([{ op: 'settings', patch: { notesAi: 'edit' } }]);
    ok(call('complete_tasks', { task_ids: [id], done: false }));
    const again = ok(call('complete_tasks', { task_ids: [id] }));
    assert.equal(ck('nvis'), true);
    ok(call('undo_change', { change_id: again.data.change_id }));
    assert.equal(ck('nvis'), false);
    assert.equal(core.store.get('tasks', id).done, false);
  });
});

test('priority "P1" (as results print it) and "now" are accepted', async () => {
  await withCore(async ({ core, call, today }) => {
    const r = ok(call('create_tasks', { tasks: [{ title: 'QA printed priority', date: addDaysYmd(today, 6), priority: 'P1' }] }));
    assert.equal(core.store.get('tasks', r.data.created[0].task_id).priority, 3);
    ok(call('update_tasks', { tasks: [{ task_id: r.data.created[0].task_id, priority: 'P3' }] }));
    assert.equal(ok(call('find_tasks', { priority: ['P3'], query: 'QA printed' })).data.total, 1);
    ok(call('find_free_time', { from: 'now', to: addDaysYmd(today, 3) }));
    const c = clock();
    assert.deepEqual(parseWhen('now', c), { date: c.today, time: c.time });
    assert.equal(parseDate('Now', c), c.today);
  });
});

test('validYmd keeps to the years data can hold (1000-9999), whatever ymd() formats', () => {
  for (const s of ['0999-12-31', '0491-05-01', '0100-01-01', '0001-01-01']) assert.equal(validYmd(s), false, s);
  for (const s of ['1000-01-01', '2026-02-28', '9999-12-31']) assert.equal(validYmd(s), true, s);
  assert.equal(validYmd('2026-02-30'), false);
});

test('plan_tasks proposes read-only; spread puts each task on the day with the most free time', async () => {
  await withCore(async ({ core, call, today }) => {
    let mon = addDaysYmd(today, 8);
    while (parseYmd(mon).getDay() !== 1) mon = addDaysYmd(mon, 1);
    const fri = addDaysYmd(mon, 4);
    // Monday is busy from 10:00 to 16:00; the other weekdays are free.
    ok(call('create_events', { events: [{ title: 'QA all-hands', start: `${mon}T10:00`, end: `${mon}T16:00`, calendar: 'Work' }] }));
    const ids = ok(call('create_tasks', { tasks: [1, 2, 3, 4].map((n) => ({ title: `QA plan ${n}`, duration_minutes: 60 })) })).data.created.map((t) => t.task_id);
    const items = ids.map((task_id) => ({ task_id }));
    const packed = ok(call('plan_tasks', { items, from: mon, to: fri }));
    // Monday's two free hours (09:00, 16:00) first, then Tuesday morning.
    assert.deepEqual(packed.data.placements.map((p) => `${p.date} ${p.time}`), [`${mon} 09:00`, `${mon} 16:00`, `${addDaysYmd(mon, 1)} 09:00`, `${addDaysYmd(mon, 1)} 10:00`], 'the default fills the earliest free slots');
    const spread = ok(call('plan_tasks', { items, from: mon, to: fri, spread: true }));
    const days = spread.data.placements.map((p) => p.date);
    assert.equal(new Set(days).size, 4, `four tasks on four days: ${days.join(', ')}`);
    assert.ok(!days.includes(mon), 'the busy Monday gets none while other days have more room');
    assert.ok(ids.every((id) => core.store.get('tasks', id).date === null), 'plan_tasks changed nothing');
    const applied = ok(call('schedule_tasks', { items, from: mon, to: fri, spread: true, dry_run: false }));
    assert.deepEqual(applied.data.placements.map((p) => p.date), days, 'schedule_tasks applies the same plan');
    // A read-only connection may plan.
    const reader = core.ai.createClient({ kind: 'chatgpt', access: 'read' });
    assert.equal(core.callTool('plan_tasks', { items, from: mon, to: fri }, { client: reader }).isError, false);
    const def = (n) => core.tools.find((t) => t.name === n);
    assert.equal(def('plan_tasks').write, false);
    assert.equal(def('plan_tasks').annotations.readOnlyHint, true);
    assert.equal(def('update_tasks').annotations.idempotentHint, false, 'add_steps appends again on a retry');
  });
});
