// QA fix (notes-core, second pass): folder paths in the notes tools.
//   - Two folders moved into each other (a parent cycle) made notes_structure list "Recipes/Travel" and
//     "Travel/Recipes", each counting the other's notes, and notes_create {folder:"Travel"} made a third
//     "Travel". The tools now see the folder tree the Notes app shows (schema.js folderParents).
//   - folder "Notes/Notes" made a top-level folder named "Notes" (the default folder's reserved name),
//     answered as 'in "Notes" (new folder "Notes")'. It is refused, as the Notes app refuses it.
//   - Choosing a new folder's colour rebuilt the folder lookup once per folder (seconds at 2,000).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';

const silent = { warn() {}, error() {}, info() {}, log() {} };
const now = Date.now();
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

async function server(ops = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-paths-'));
  dirs.push(dir);
  const core = await createCore({ dataDir: dir, log: silent });
  if (ops.length) for (let i = 0; i < ops.length; i += 900) core.store.applyOps(ops.slice(i, i + 900));
  const client = core.ai.createClient({ kind: 'claude' });
  const call = (name, args) => {
    const r = core.callTool(name, args, { client });
    return { isError: !!r.isError, text: r.content[0].text, data: r.structuredContent || null };
  };
  return { core, call };
}
const folder = (item) => ({ op: 'put', c: 'folders', item: { color: 'blue', order: 0, aiHidden: false, createdAt: now, updatedAt: now, ...item } });
const note = (id, title, folderId) => ({ op: 'put', c: 'notes', item: { id, v: 1, rev: 1, folderId, blocks: [{ id: 'a', t: 'h1', c: [[title]] }], createdAt: now, updatedAt: now, editedAt: now, editedBy: 'user' } });

test('folders moved into each other: the assistant sees the tree the Notes app shows, with sane paths and counts', async () => {
  // Travel was made first, so the Notes app shows it at the top level with Recipes inside.
  const { core, call } = await server([
    folder({ id: 'fr', name: 'Recipes', parentId: 'ft', createdAt: now - 1000 }),
    folder({ id: 'ft', name: 'Travel', parentId: 'fr', createdAt: now - 2000 }),
    note('n1', 'Lasagne', 'fr'),
    note('n2', 'Lisbon hotels', 'ft'),
  ]);
  const st = call('notes_structure', {});
  assert.deepEqual(st.data.folders.map((f) => [f.path, f.count]), [['Travel', 2], ['Travel/Recipes', 1]]);
  assert.match(st.text, /- "Travel" \(2 notes, blue\) id=ft\n- "Travel\/Recipes" \(1 note, blue\) id=fr/);
  assert.deepEqual(call('notes_list', { folder: 'Travel' }).data.notes.map((n) => n.folder).sort(), ['Travel', 'Travel/Recipes']);
  assert.deepEqual(call('notes_list', { folder: 'Travel/Recipes' }).data.notes.map((n) => n.id), ['n1']);
  // Paths name the existing folders: nothing new is made.
  const a = call('notes_create', { markdown: '# Porto', folder: 'Travel' });
  const b = call('notes_create', { markdown: '# Risotto', folder: 'Travel/Recipes' });
  assert.deepEqual([a.isError, b.isError], [false, false], `${a.text}\n${b.text}`);
  assert.deepEqual([core.store.get('notes', a.data.id).folderId, core.store.get('notes', b.data.id).folderId], ['ft', 'fr']);
  assert.deepEqual([a.data.created_folders, b.data.created_folders], [[], []]);
  assert.equal(core.store.all('folders').length, 2);
  assert.match(b.text, /in "Travel\/Recipes" id=/);
  // A note moved there by path, and search by folder, see the same tree.
  const moved = call('notes_update', { id: a.data.id, ifRev: a.data.rev, folder: 'travel/recipes' });
  assert.equal(moved.isError, false, moved.text);
  assert.equal(core.store.get('notes', a.data.id).folderId, 'fr');
  assert.ok(call('notes_search', { query: 'in:"Travel/Recipes" porto' }).data.results.some((r) => r.id === a.data.id));
  core.close();
});

test('a parent cycle with a folder hidden from AI hides all of it, and asking for its names reveals nothing', async () => {
  const { core, call } = await server([
    folder({ id: 'fr', name: 'Recipes', parentId: 'ft', createdAt: now - 1000, aiHidden: true }),
    folder({ id: 'ft', name: 'Travel', parentId: 'fr', createdAt: now - 2000 }),
    note('n1', 'Lasagne', 'fr'),
    note('n2', 'Lisbon hotels', 'ft'),
  ]);
  assert.deepEqual(call('notes_structure', {}).data.folders, []);
  assert.deepEqual(call('notes_list', {}).data.notes, []);
  const made = call('notes_create', { markdown: '# Probe', folder: 'Travel' });
  assert.equal(made.isError, false, made.text);
  const twin = core.store.get('folders', core.store.get('notes', made.data.id).folderId);
  assert.deepEqual([twin.name, twin.parentId, twin.aiHidden], ['Travel', null, false], 'a visible folder of that name beside the hidden one');
  assert.deepEqual(made.data.created_folders, ['Travel']);
  core.close();
});

test('folder "Notes/Notes" is refused like any top-level folder named "Notes"; "Notes" alone is the default folder', async () => {
  const { core, call } = await server();
  for (const path of ['Notes/Notes', 'notes/NOTES/Sub', 'Notes', '/notes/']) {
    const r = call('notes_create', { markdown: `# In ${path}`, folder: path });
    if (/^\/?notes\/?$/i.test(path)) {
      assert.equal(r.isError, false, r.text);
      assert.equal(core.store.get('notes', r.data.id).folderId, null, `${path}: the default folder`);
      continue;
    }
    assert.equal(r.isError, true, `${path}: ${r.text}`);
    assert.match(r.text, /top-level folder named "Notes", the name of the default folder\. Nothing was saved\./);
    assert.match(r.text, /pass folder "Notes" \(or leave folder out\)/);
  }
  const note = call('notes_create', { markdown: '# Plain' });
  const moved = call('notes_update', { id: note.data.id, ifRev: note.data.rev, folder: 'Notes/notes' });
  assert.equal(moved.isError, true, moved.text);
  assert.equal(core.store.all('folders').length, 0, 'no folder was made');
  // Below the top level the name is free, as in the Notes app.
  const sub = call('notes_create', { markdown: '# Sub', folder: 'Work/Notes' });
  assert.equal(sub.isError, false, sub.text);
  assert.deepEqual(sub.data.created_folders, ['Work', 'Work/Notes']);
  core.close();
});

test('a new folder\'s colour is chosen without one lookup per folder: 2,000 folders cost about what 250 do', async () => {
  const time = async (count) => {
    const ops = [];
    for (let i = 0; i < count; i++) ops.push(folder({ id: `f${i}`, name: `F${i}`, parentId: null, order: i, aiHidden: i % 2 === 0 }));
    const { core, call } = await server(ops);
    call('notes_list', {}); // warm up
    let best = Infinity;
    for (let i = 0; i < 4; i++) {
      const t = performance.now();
      const r = call('notes_create', { markdown: `# probe ${i}`, folder: `New ${i}/Deeper/Deepest` });
      best = Math.min(best, performance.now() - t);
      assert.equal(r.isError, false, r.text);
    }
    core.close();
    return best;
  };
  const small = await time(250);
  const large = await time(2000);
  // 8 times the folders: about 8 times the work at most (the old code did about 64 times).
  assert.ok(large < Math.max(small * 24, 60), `2,000 folders: ${large.toFixed(1)} ms; 250 folders: ${small.toFixed(1)} ms`);
});
