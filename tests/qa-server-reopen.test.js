// QA (server fix, second pass): "not done after all" on a repeating task.
//  - Within two days of completing it, complete_tasks done:false takes that completion back even when
//    the task was edited since: it is due as before, its steps are checked as they were then (a step
//    checked or added since keeps that), the edit stays, and the logged completion goes.
//  - An older completion is not taken back, and the result never sends the model to undo_change (that
//    takes back the whole complete_tasks call, and leaves an edited task moved on while it deletes the
//    logged completion): it says which update_tasks call puts the task back, and that delete_items
//    removes the logged completion. One id= per line, the task's own.
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
const DAY = 86400000;

async function withCore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-reopen-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  core.store.importData({ data: {}, settings: {} });
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
const ok = (r) => {
  assert.equal(r.isError, false, r.text);
  return r;
};
const userEdit = (core, id, patch) => core.store.applyOps([{ op: 'put', c: 'tasks', item: { ...core.store.get('tasks', id), ...patch, updatedAt: Date.now() + 5000 } }]);
const firstBareId = (line) => /\bid=([^\s|)]+)/.exec(line.replace(/"(?:[^"\\]|\\.)*"/g, '""'))?.[1] ?? null;

test('reopening right after completing takes the completion back even when the task was edited since, keeping the edit', async () => {
  await withCore(async ({ core, call, today }) => {
    const date = addDaysYmd(today, 3);
    const id = ok(call('create_tasks', { tasks: [{ title: 'Water plants', date, repeat: 'weekly', steps: ['Kitchen', 'Balcony', 'Hall'] }] })).data.created[0].task_id;
    const steps = core.store.get('tasks', id).checklist;
    ok(call('update_tasks', { tasks: [{ task_id: id, update_steps: [{ step_id: steps[0].id, done: true }] }] }));
    ok(call('complete_tasks', { task_ids: [id] }));
    // After completing: the user adds a note and a step, and checks "Hall" for next week.
    const t1 = core.store.get('tasks', id);
    userEdit(core, id, { notes: 'use the green can', checklist: [...t1.checklist.map((s) => (s.title === 'Hall' ? { ...s, done: true } : s)), { id: 'stepNew', title: 'Porch', done: false }] });
    const re = ok(call('complete_tasks', { task_ids: [id], done: false }));
    const t = core.store.get('tasks', id);
    assert.equal(t.date, date, re.text);
    assert.equal(t.notes, 'use the green can', 'the edit made since stays');
    assert.deepEqual(t.checklist.map((s) => [s.title, s.done]), [['Kitchen', true], ['Balcony', false], ['Hall', true], ['Porch', false]], 'steps as they were when it was completed, plus what changed since');
    assert.equal(core.store.all('tasks').filter((x) => x.repeatOf === id).length, 0, 'the logged completion is gone');
    assert.match(re.text, /"Water plants" reopened: its completion was taken back, so it is due \w{3} \S+ again/);
    assert.equal(firstBareId(re.text.split('\n').find((l) => l.includes('Water plants'))), id);
  });
});

test('a completion older than two days is not taken back, and the result says how to put the task back without undo_change', async () => {
  await withCore(async ({ core, call, today }) => {
    const was = addDaysYmd(today, -4);
    const next = addDaysYmd(today, 3);
    const now = Date.now();
    // Completed three days ago (as the apps log it): the task moved on, a done copy stayed behind.
    const made = ok(call('create_tasks', { tasks: [{ title: 'Water plants', date: next, repeat: 'weekly' }] })).data.created[0].task_id;
    const t0 = core.store.get('tasks', made);
    core.store.applyOps([
      { op: 'del', c: 'tasks', id: made },
      { op: 'put', c: 'tasks', item: { ...t0, id: 'qaWeekly', updatedAt: now - 3 * DAY } },
      { op: 'put', c: 'tasks', item: { ...t0, id: 'qaWeeklyDone', date: was, repeat: null, repeatOf: 'qaWeekly', done: true, completedAt: now - 3 * DAY, createdAt: now - 3 * DAY, updatedAt: now - 3 * DAY } },
    ]);
    const re = ok(call('complete_tasks', { task_ids: ['qaWeekly'], done: false }));
    assert.equal(core.store.get('tasks', 'qaWeekly').date, next, 'nothing changed');
    assert.ok(core.store.get('tasks', 'qaWeeklyDone'), 'the logged completion stays');
    const line = re.text.split('\n').find((l) => l.includes('Water plants'));
    assert.match(line, /is more than 2 days old, so it was not taken back; it is kept as a separate done task \(task_id qaWeeklyDone\)/);
    assert.match(line, new RegExp(`call update_tasks with date ${was}; delete_items with that task_id removes the logged completion`));
    assert.doesNotMatch(re.text, /undo_change/, 'undo_change would take back the whole complete_tasks call');
    assert.equal(firstBareId(line), 'qaWeekly', 'the one id= on the line is the task\'s own');
    // Following that advice puts it back.
    ok(call('update_tasks', { tasks: [{ task_id: 'qaWeekly', date: was }] }));
    ok(call('delete_items', { items: [{ type: 'task', id: 'qaWeeklyDone' }] }));
    assert.equal(core.store.get('tasks', 'qaWeekly').date, was);
  });
});

test('each reopen takes back one completion: the latest', async () => {
  await withCore(async ({ core, call, today }) => {
    const id = ok(call('create_tasks', { tasks: [{ title: 'Vitamins', date: today, repeat: 'daily' }] })).data.created[0].task_id;
    ok(call('complete_tasks', { task_ids: [id] }));
    const afterFirst = core.store.get('tasks', id).date;
    ok(call('complete_tasks', { task_ids: [id] }));
    assert.equal(core.store.all('tasks').filter((x) => x.repeatOf === id).length, 2, 'control: two completions');
    ok(call('complete_tasks', { task_ids: [id], done: false }));
    assert.equal(core.store.get('tasks', id).date, afterFirst, 'the second completion was taken back');
    assert.equal(core.store.all('tasks').filter((x) => x.repeatOf === id).length, 1, 'the first is still logged');
  });
});
