// When shared/store.js loads before notes/core/schema.js has registered the note fields (another
// module imported the store first), notes/core/notes.js reloads the notes with the full validators
// and never writes a stripped copy back. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const P = 'ecosys:v1:';
const blocks = [
  { id: 'b1', t: 'h1', c: [['Kept note']] },
  { id: 'b2', t: 'check', in: 0, ck: true, c: [['with a checklist']] },
];
const mem = new Map([
  [`${P}notes`, JSON.stringify([{ id: 'n1', v: 1, rev: 3, blocks, title: 'Kept note', tags: [], links: [], folderId: 'f1', pinned: true, editedBy: 'user', editedAt: 5, createdAt: 1, updatedAt: 5 }])],
  [`${P}folders`, JSON.stringify([{ id: 'f1', name: 'Work', parentId: null, color: 'blue', order: 0, aiHidden: true, createdAt: 1, updatedAt: 1 }])],
]);
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i], get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

// The store first, as an app that imports shared/shell.js before the notes modules would.
const { db, setSyncAdapter } = await import('../shared/store.js');
const pushed = [];
setSyncAdapter({ push: (ops) => pushed.push(...ops), pending: () => [] });
const N = await import('../notes/core/notes.js');

test('notes and folders come back with every field, and nothing stripped is saved or synced', () => {
  const n = N.getNote('n1');
  assert.deepEqual(n.blocks, blocks);
  assert.equal(n.rev, 3);
  assert.equal(n.pinned, true);
  assert.equal(db.get('folders', 'f1').aiHidden, true);
  const stored = JSON.parse(mem.get(`${P}notes`));
  assert.deepEqual(stored[0].blocks, blocks, 'localStorage keeps the blocks');
  assert.equal(pushed.length, 0, 'recovery is not pushed to the server');
  assert.ok(N.isHiddenFromAi(n));
});
