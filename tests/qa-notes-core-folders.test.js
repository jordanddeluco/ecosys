// QA fix (notes-core): the Notes app accepts two folders of the same name side by side. An assistant
// asking for a folder named like one hidden from it now gets a visible folder of that name beside the
// hidden one (server/tools-notes.mjs), so the hidden folder stays a secret. Before, the folder dialog
// (which renames on every save, a colour change too) refused it with "There's already a folder named
// …", and dragging it to another place in the list renamed it "… 2".
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i], get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const N = await import('../notes/core/notes.js');
const { db } = await import('../shared/store.js');

const folder = (name, extra = {}) => db.insert('folders', { name, parentId: null, color: 'iris', order: 0, sort: null, sortDir: null, groupByDate: null, view: null, aiHidden: false, ...extra });

test('a folder beside a hidden folder of the same name can be saved, recoloured and reordered without a rename', () => {
  const hidden = folder('Therapy', { aiHidden: true, order: 0 });
  const visible = folder('Therapy', { order: 1 }); // as notes_create {folder: "Therapy"} leaves it
  const other = folder('Work', { order: 2 });
  // The folder dialog's Save (renameFolder with the name it already has, then the colour).
  assert.equal(N.renameFolder(visible.id, 'Therapy').name, 'Therapy');
  assert.equal(N.renameFolder(visible.id, '  Therapy ').name, 'Therapy');
  assert.equal(N.updateFolder(visible.id, { color: 'teal' }).color, 'teal');
  // Dragging it above the hidden one (same parent): its place changes, its name doesn't.
  N.moveFolder(visible.id, null, 0);
  assert.equal(N.getFolder(visible.id).name, 'Therapy');
  assert.equal(N.getFolder(visible.id).order, 0);
  // A real rename to a name in use is still refused, and moving into another folder still
  // makes the name unique there.
  folder('Diary');
  assert.throws(() => N.renameFolder(visible.id, 'diary'), /already a folder named "diary"/);
  N.createFolder({ name: 'Therapy', parentId: other.id });
  N.moveFolder(visible.id, other.id);
  assert.equal(N.getFolder(visible.id).name, 'Therapy 2');
  assert.equal(N.getFolder(hidden.id).name, 'Therapy', 'the hidden folder is never touched');
});
