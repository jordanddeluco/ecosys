// QA (server fix): the AI connection store and change history stay true to what is on disk.
//  - A connection change whose save fails (a full disk, a read-only ai.json) takes no effect: memory
//    goes back to the file, so a new key never works and a removed one is still listed.
//  - A browser replacing whole collections (Erase everything, Start over, a restored backup) leaves no
//    AI change history for them: no undo brings an erased item back, find_changes names none of them,
//    and erasing everything empties the activity list. Changes to other collections stay undoable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIStore } from '../server/ai-store.mjs';
import { createCore } from '../server/core.mjs';
import { COLLECTIONS } from '../server/validate.mjs';

const silent = { error() {}, warn() {}, info() {}, log() {} };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ecosys-qa-aihist-'));
  dirs.push(d);
  return d;
};
const failNextSave = (store) => {
  const real = store.save;
  store.save = function () {
    store.save = real;
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  };
};

test('AIStore: a connection created, changed or removed while the save fails does not take effect', () => {
  const dir = tempDir();
  const ai = new AIStore({ dir, log: silent });
  const keep = ai.createClient({ kind: 'claude', access: 'read' });
  failNextSave(ai);
  assert.throws(() => ai.createClient({ kind: 'grok' }), /EPERM/);
  assert.deepEqual(ai.state.clients.map((c) => c.id), [keep.id], 'the unsaved connection is not there');
  failNextSave(ai);
  assert.throws(() => ai.updateClient(keep.id, { access: 'write', rotate: true }), /EPERM/);
  assert.equal(ai.get(keep.id).access, 'read');
  assert.equal(ai.byToken(keep.token)?.id, keep.id, 'its key still works, as the file says');
  failNextSave(ai);
  assert.throws(() => ai.deleteClient(keep.id), /EPERM/);
  assert.ok(ai.get(keep.id), 'the removal that failed left it in place');
  // Read activity that was waiting is kept for the next save.
  ai.addActivity({ client: keep, tool: 'get_context', summary: 'Looked' }, { defer: true });
  failNextSave(ai);
  assert.throws(() => ai.setMode('read'), /EPERM/);
  assert.equal(ai.mode(), 'write');
  ai.flush();
  assert.ok(new AIStore({ dir, log: silent }).state.activity.some((a) => a.summary === 'Looked'));
});

async function withCore(fn) {
  const dir = tempDir();
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

test('after Erase everything no undo brings erased items back, and find_changes and the activity list are empty', async () => {
  await withCore(async ({ core, call, dir }) => {
    const id = call('create_tasks', { tasks: [{ title: 'Old private task' }] }).data.created[0].task_id;
    const del = call('delete_items', { items: [{ type: 'task', id }] });
    assert.ok(del.data.change_id);
    assert.ok(readdirSync(join(dir, 'changes')).length > 0, 'control: undo data on disk');
    core.store.applyOps(COLLECTIONS.map((c) => ({ op: 'replace', c, items: [] }))); // Settings, Erase everything
    assert.throws(() => core.undo(del.data.change_id), /No change with id/);
    assert.equal(call('undo_change', { change_id: del.data.change_id }).isError, true);
    assert.deepEqual(core.store.all('tasks'), [], 'the erased task stays erased');
    assert.equal(call('find_changes', {}).data.changes.length, 0);
    assert.doesNotMatch(call('find_changes', {}).text, /Old private task/);
    assert.deepEqual(readdirSync(join(dir, 'changes')).filter((n) => n.endsWith('.json')), [], 'no undo data is left');
    assert.ok(!core.ai.recentActivity(50).some((a) => /Old private task/.test(a.summary)), 'the activity list names none of it');
  });
});

test('replacing one collection forgets only the changes that touched it', async () => {
  await withCore(async ({ core, call }) => {
    const t = call('create_tasks', { tasks: [{ title: 'Task to keep undoable' }] });
    const list = call('create_list', { name: 'QA list' });
    core.store.applyOps([{ op: 'replace', c: 'lists', items: [] }]); // a restored backup without lists
    assert.ok(core.ai.change(t.data.change_id), 'the task change stays');
    assert.equal(core.ai.change(list.data.change_id), null, 'the list change is forgotten');
    const entry = core.ai.recentActivity(50).find((a) => a.tool === 'create_list');
    assert.ok(entry && entry.changeId === null, 'its activity entry stays, without an Undo');
    assert.equal(call('undo_change', { change_id: t.data.change_id }).isError, false, 'the task change can still be undone');
    assert.ok(!existsSync(join(core.dataDir, 'changes', `${list.data.change_id}.json`)));
  });
});
