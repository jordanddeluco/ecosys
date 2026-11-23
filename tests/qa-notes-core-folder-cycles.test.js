// QA fix (notes-core, second pass): two browsers that move two folders into each other at about the
// same time store a parent cycle (each move was fine where it was made). Before, folderTree() walked
// down from top-level folders only, so both folders (and their notes) vanished from the sidebar, could
// not be renamed, moved or deleted, and moving one of them crashed (subtreeDepth recursed forever).
// Now every view cuts a cycle at the same folder (schema.js folderParents: the one created first, then
// the smallest id, is shown at the top level), so both folders show, each once, and can be handled.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i], get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const N = await import('../notes/core/notes.js');
const S = await import('../notes/core/schema.js');
const { db } = await import('../shared/store.js');

beforeEach(() => {
  for (const n of db.all('notes').slice()) db.remove('notes', n.id);
  for (const f of db.all('folders').slice()) db.remove('folders', f.id);
});

/** Travel (made first) and Recipes, each with a note, then moved into each other from two browsers. */
function cycle() {
  const t = Date.now();
  const travel = N.createFolder({ name: 'Travel' });
  const recipes = N.createFolder({ name: 'Recipes' });
  N.createNote({ folderId: recipes.id, blocks: [{ t: 'h1', c: [['Lasagne']] }] });
  N.createNote({ folderId: travel.id, blocks: [{ t: 'h1', c: [['Lisbon hotels']] }] });
  db.put('folders', { ...db.get('folders', recipes.id), parentId: travel.id, createdAt: t - 1000, updatedAt: t });
  db.put('folders', { ...db.get('folders', travel.id), parentId: recipes.id, createdAt: t - 2000, updatedAt: t + 1 });
  return { recipes: db.get('folders', recipes.id), travel: db.get('folders', travel.id) };
}

test('both folders of a cycle show in the folder tree, once each, cut at the one made first, with sane counts', () => {
  const { recipes, travel } = cycle();
  const tree = N.folderTree();
  assert.deepEqual(
    tree.map((e) => [e.folder.name, e.depth, e.path, e.own, e.count]),
    [
      ['Travel', 0, 'Travel', 1, 2],
      ['Recipes', 1, 'Travel/Recipes', 1, 1],
    ],
  );
  // The same tree everywhere: paths, depth, nesting and lookups by path.
  assert.equal(S.folderPath(recipes.id, db.all('folders')), 'Travel/Recipes');
  assert.equal(S.folderPath(travel.id, db.all('folders')), 'Travel');
  assert.equal(S.folderDepth(recipes.id, db.all('folders')), 2);
  assert.deepEqual([...S.descendantIds(travel.id, db.all('folders'))].sort(), [recipes.id, travel.id].sort());
  assert.deepEqual([...S.descendantIds(recipes.id, db.all('folders'))], [recipes.id]);
  assert.equal(S.resolveFolderPath('Travel/Recipes', db.all('folders'))?.id, recipes.id);
  assert.equal(S.resolveFolderPath('travel', db.all('folders'))?.id, travel.id);
  assert.deepEqual(Object.fromEntries(S.folderParents(db.all('folders'))), { [travel.id]: null, [recipes.id]: travel.id });
  assert.equal(N.listNotes({ view: 'folder', folderId: travel.id }).length, 2);
});

test('the cut is the same in every order and on a tie (then the smallest id)', () => {
  const t = 1795000000000;
  const f = (id, parentId, createdAt) => ({ id, name: id.toUpperCase(), parentId, createdAt, updatedAt: t + 99 });
  const three = [f('a1', 'c3', t), f('b2', 'a1', t - 5), f('c3', 'b2', t)];
  for (const list of [three, [...three].reverse(), [three[1], three[2], three[0]]]) {
    assert.deepEqual(Object.fromEntries(S.folderParents(list)), { a1: 'c3', b2: null, c3: 'b2' });
    assert.equal(S.folderPath('a1', list), 'B2/C3/A1');
  }
  const tie = [f('zz', 'yy', t), f('yy', 'zz', t)];
  assert.deepEqual(Object.fromEntries(S.folderParents(tie)), { yy: null, zz: 'yy' });
  assert.deepEqual(Object.fromEntries(S.folderParents([...tie].reverse())), { yy: null, zz: 'yy' });
  // A folder under a cycle hangs where its parent is shown; missing and self parents are top level.
  const more = [...tie, f('kid', 'zz', t), f('lost', 'gone', t), f('self', 'self', t)];
  assert.deepEqual(Object.fromEntries(S.folderParents(more)), { yy: null, zz: 'yy', kid: 'zz', lost: null, self: null });
  assert.equal(S.folderPath('kid', more), 'YY/ZZ/KID');
});

test('folders of a cycle can be renamed, moved (no endless recursion) and deleted; moving one to the top level ends the cycle', () => {
  const { recipes, travel } = cycle();
  assert.equal(N.renameFolder(recipes.id, 'Cooking').name, 'Cooking');
  assert.equal(N.updateFolder(recipes.id, { color: 'teal' }).color, 'teal');
  assert.equal(N.renameFolder(travel.id, 'Trips').name, 'Trips');
  assert.deepEqual(N.folderTree().map((e) => e.path), ['Trips', 'Trips/Cooking'], 'edits never turn the tree around');
  // Moving the inner one into the outer one (where it is shown) is a reorder; the other way is refused.
  N.moveFolder(recipes.id, travel.id, 5);
  assert.equal(db.get('folders', recipes.id).order, 5);
  assert.throws(() => N.moveFolder(travel.id, recipes.id), /can't go inside itself/);
  // To the top level: stored without a parent, so the cycle is gone for good.
  N.moveFolder(travel.id, null);
  assert.equal(db.get('folders', travel.id).parentId, null);
  assert.equal(db.get('folders', recipes.id).parentId, travel.id);
  assert.deepEqual(N.folderTree().map((e) => e.path), ['Trips', 'Trips/Cooking']);
  // Deleting the folder shown at the top deletes the one shown inside it too, as in any tree.
  const again = cycle();
  const undo = N.deleteFolder(again.travel.id);
  assert.equal(undo.count, 2);
  assert.ok(!db.get('folders', again.travel.id) && !db.get('folders', again.recipes.id));
  undo();
  assert.equal(N.folderTree().filter((e) => e.folder.id === again.travel.id || e.folder.id === again.recipes.id).length, 2);
});

test('a new folder beside the one shown at the top level gets a name of its own, and "Notes" stays reserved there', () => {
  const { travel } = cycle();
  assert.equal(N.createFolder({ name: 'Travel' }).name, 'Travel 2');
  assert.throws(() => N.renameFolder(travel.id, 'Notes'), /default folder/);
});

test('a cycle with a folder hidden from AI shows all of it as hidden, as the AI tools treat it', () => {
  const { recipes, travel } = cycle();
  N.setFolderAiHidden(recipes.id, true); // the one shown inside
  const hidden = Object.fromEntries(N.folderTree().map((e) => [e.folder.id, e.aiHidden]));
  assert.deepEqual(hidden, { [travel.id]: true, [recipes.id]: true });
  assert.equal(S.folderHiddenFromAi(travel.id, db.all('folders')), true);
  assert.equal(N.isHiddenFromAi(N.listNotes({ view: 'folder', folderId: travel.id }).find((n) => n.title === 'Lisbon hotels')), true);
});
