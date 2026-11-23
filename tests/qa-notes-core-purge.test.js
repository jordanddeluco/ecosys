// QA fix (notes-core): purgeExpiredNotes (server/tools-notes.mjs) deletes only notes the apps count as
// deleted (a trashedAt after 0: the apps show a note whose trashedAt is 0) and reads the notes again
// under the data lock, after a reload, so a note another process restored meanwhile is kept. Before,
// it took trashedAt 0 as "deleted in 1970" and chose the notes from this process's copy before taking
// the lock (server/core.mjs purgeNotesTrash wrapped it to cover both; called directly, it did not).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { purgeExpiredNotes } from '../server/tools-notes.mjs';
import { loadValidators } from '../server/validate.mjs';
import { DataStore } from '../server/store.mjs';

const DAY = 86400000;
const silent = { warn() {}, error() {}, info() {}, log() {} };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

/** A data folder whose data.json holds these notes (as a browser would have synced them). */
function dataWith(notes) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-purge-'));
  dirs.push(dir);
  const note = (n) => ({ v: 1, rev: 1, blocks: [{ id: `${n.id}b`, t: 'p', c: [[n.id]] }], folderId: null, createdAt: 1, updatedAt: 1, editedAt: 1, trashedAt: null, ...n });
  writeFileSync(join(dir, 'data.json'), JSON.stringify({ format: 1, rev: 7, initialized: true, data: { tasks: [], lists: [], events: [], calendars: [], notes: notes.map(note), folders: [] }, settings: {} }));
  return dir;
}
const noteIds = (dir) => JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')).data.notes.map((n) => n.id).sort();
const open = async (dir) => new DataStore({ dir, validators: await loadValidators({ log: silent }), log: silent });

test('a note whose trashedAt is 0 is not deleted (the apps show it)', async () => {
  const dir = dataWith([{ id: 'zero', trashedAt: 0 }, { id: 'old', trashedAt: Date.now() - 31 * DAY }, { id: 'live' }]);
  const store = await open(dir);
  assert.equal(store.get('notes', 'zero').trashedAt, 0, 'loaded as the browser synced it');
  assert.equal(purgeExpiredNotes(store), 1);
  assert.deepEqual(noteIds(dir), ['live', 'zero']);
});

test('a note another process restored after this one loaded is kept', async () => {
  const dir = dataWith([{ id: 'back', trashedAt: Date.now() - 40 * DAY }, { id: 'gone', trashedAt: Date.now() - 40 * DAY }]);
  const store = await open(dir);
  // Another process (the stdio bridge, or a browser tab through the server) restores "back".
  const disk = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'));
  disk.data.notes.find((n) => n.id === 'back').trashedAt = null;
  disk.rev = 8;
  writeFileSync(join(dir, 'data.json'), JSON.stringify(disk));
  assert.ok(store.get('notes', 'back').trashedAt > 0, 'this process still has the old copy');
  assert.equal(purgeExpiredNotes(store), 1);
  assert.deepEqual(noteIds(dir), ['back']);
});

test('nothing expired: nothing is written', async () => {
  const dir = dataWith([{ id: 'recent', trashedAt: Date.now() - 2 * DAY }, { id: 'live' }]);
  const store = await open(dir);
  const rev = store.rev;
  assert.equal(purgeExpiredNotes(store), 0);
  assert.equal(store.rev, rev);
  assert.equal(purgeExpiredNotes(store, { now: Date.now() + 29 * DAY }), 1, 'and it goes once its 30 days are up');
  assert.deepEqual(noteIds(dir), ['live']);
});
