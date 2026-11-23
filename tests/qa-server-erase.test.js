// QA (server fix, second pass): Erase everything leaves no undo that brings erased data back, however
// the data store reports the replace and whatever happens around it.
//  - Every replace the request carries forgets the AI history of its collection, also when the store
//    leaves it out of `applied` (a collection that was empty already: nothing to change there).
//  - The replace and the forgetting run under one hold of the data lock, and a tool's change is
//    recorded under the same hold as its transaction: a change made by another process (the stdio
//    bridge) lands wholly before the erase (and is forgotten) or wholly after it.
//  - Should the history not be cleared (ai.json can't be written), an undo of a change made before the
//    erase is still refused, and find_changes doesn't list it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { DataStore } from '../server/store.mjs';
import { COLLECTIONS } from '../server/validate.mjs';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
const ERASE = COLLECTIONS.map((c) => ({ op: 'replace', c, items: [] })); // Settings, Erase everything

async function withCore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-erase-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  core.store.importData({ data: {}, settings: {} });
  const client = core.ai.createClient({ kind: 'claude', access: 'write' });
  const call = (name, args = {}) => {
    const r = core.callTool(name, args, { client });
    return { isError: r.isError, text: r.content[0].text, data: r.structuredContent };
  };
  try {
    await fn({ core, call, dir });
  } finally {
    core.close();
  }
}

test('every replace in the request forgets its collection\'s AI history, whatever the store reports as applied', async () => {
  // A store that leaves replaces which changed nothing out of `applied` (an empty collection replaced
  // by [] is one; it is the usual Erase everything of a collection an assistant had emptied).
  const real = DataStore.prototype.applyOps;
  DataStore.prototype.applyOps = function (ops) {
    const out = real.call(this, ops);
    return { ...out, applied: out.applied.filter((o) => o.op !== 'replace' || o.items.length) };
  };
  try {
    await withCore(async ({ core, call }) => {
      const id = call('create_tasks', { tasks: [{ title: 'Old private task' }] }).data.created[0].task_id;
      const del = call('delete_items', { items: [{ type: 'task', id }] });
      assert.equal(core.store.all('tasks').length, 0, 'control: the collection is empty before the erase');
      core.store.applyOps(ERASE);
      assert.throws(() => core.undo(del.data.change_id), /No change with id|can't be undone/);
      assert.deepEqual(core.store.all('tasks'), [], 'the erased task stays erased');
      assert.equal(call('find_changes', {}).data.changes.length, 0);
      assert.ok(!core.ai.recentActivity(50).some((a) => /Old private task/.test(a.summary)), 'every collection was erased: the activity list is empty');
    });
  } finally {
    DataStore.prototype.applyOps = real;
  }
});

test('a replace the store refused forgets nothing', async () => {
  await withCore(async ({ core, call }) => {
    const t = call('create_tasks', { tasks: [{ title: 'Still undoable' }] });
    const out = core.store.applyOps([{ op: 'replace', c: 'tasks', items: 'not a list' }]);
    assert.equal(out.rejected.length, 1, 'control: refused');
    assert.ok(core.ai.change(t.data.change_id), 'its history stays');
  });
});

test('the erase and the forgetting share one hold of the data lock, as a tool\'s change and its record do', async () => {
  await withCore(async ({ core, call, dir }) => {
    const lockFile = join(dir, 'lock');
    const held = { forget: null, record: null, undoRecord: null };
    const forget = core.ai.forgetChanges.bind(core.ai);
    core.ai.forgetChanges = (...a) => {
      held.forget = existsSync(lockFile);
      return forget(...a);
    };
    const addChange = core.ai.addChange.bind(core.ai);
    let slot = 'record';
    core.ai.addChange = (...a) => {
      held[slot] = existsSync(lockFile);
      return addChange(...a);
    };
    const made = call('create_tasks', { tasks: [{ title: 'Locked in' }] });
    assert.equal(held.record, true, 'the change was recorded before its transaction let go of the lock');
    slot = 'undoRecord';
    call('undo_change', { change_id: made.data.change_id });
    assert.equal(held.undoRecord, true, 'an undo is recorded under the same hold as well');
    core.store.applyOps(ERASE);
    assert.equal(held.forget, true, 'the history was forgotten before the erase let go of the lock');
    assert.equal(existsSync(lockFile), false, 'and the lock is free again');
  });
});

test('when the history can\'t be cleared, an undo of a change made before the erase is refused and find_changes leaves it out', async () => {
  await withCore(async ({ core, call }) => {
    call('create_tasks', { tasks: [{ title: 'Kept task' }] });
    const id = call('create_tasks', { tasks: [{ title: 'Old private task' }] }).data.created[0].task_id;
    const del = call('delete_items', { items: [{ type: 'task', id }] });
    core.ai.forgetChanges = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); // ai.json is read-only
    };
    core.store.applyOps(ERASE);
    assert.ok(core.ai.change(del.data.change_id), 'control: the history is still there');
    assert.throws(() => core.undo(del.data.change_id), /was made before this data was erased or replaced in ecosys .*so it can't be undone/);
    const r = call('undo_change', { change_id: del.data.change_id });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /Old private task/, 'the refusal does not repeat what was erased');
    assert.deepEqual(core.store.all('tasks'), [], 'nothing came back');
    const ch = call('find_changes', { limit: 50 });
    assert.equal(ch.data.changes.length, 0, ch.text);
    assert.doesNotMatch(ch.text, /Old private task/);
    // A change made after the erase can be undone as usual.
    const fresh = call('create_tasks', { tasks: [{ title: 'After the erase' }] });
    assert.equal(call('undo_change', { change_id: fresh.data.change_id }).isError, false);
  });
});
