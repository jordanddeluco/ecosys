// When the browser blocks localStorage (privacy settings, some private modes) the store must keep
// working in memory instead of throwing at load time (which left a blank page). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  get() {
    throw new Error('SecurityError: The operation is insecure.');
  },
});

const { db, settings, seedIfEmpty, registerSeeder, storageAvailable, resetData, importData, exportData } = await import('../shared/store.js');
const { seed } = await import('../shared/seed.js');
const { validateItem } = await import('../shared/sanitize.js'); // with the notes data model, which store.js registers

test('store loads and reports storage as unavailable', () => {
  assert.equal(storageAvailable(), false);
  assert.deepEqual(db.all('tasks'), []);
  assert.equal(typeof settings.get().theme, 'string');
});

test('first run seeds sample data in memory', () => {
  registerSeeder(seed);
  seedIfEmpty();
  assert.ok(db.all('tasks').length > 5);
  assert.ok(db.all('events').length > 3);
  assert.ok(db.all('notes').length >= 3);
  assert.ok(db.all('folders').length >= 1);
  const before = db.all('tasks').length;
  seedIfEmpty(); // already seeded this session
  assert.equal(db.all('tasks').length, before);
});

test('writes, settings, reset and import all work without storage', () => {
  const t = db.insert('tasks', { title: 'In memory' });
  assert.equal(db.update('tasks', t.id, { done: true }).done, true);
  settings.set({ theme: 'dark' });
  assert.equal(settings.get().theme, 'dark');
  const backup = exportData();
  resetData();
  assert.equal(db.all('tasks').length, 0);
  assert.ok(db.all('calendars').length >= 2);
  importData(backup);
  assert.ok(db.get('tasks', t.id));
});

// The samples went through a reset and a backup round trip above, so this also shows that they survive both.
test('sample notes are valid block notes, and a checklist item links a real task that links back to it', () => {
  const notes = db.all('notes');
  assert.ok(notes.length >= 3);
  for (const n of notes) {
    assert.ok(n.v === 1 && Array.isArray(n.blocks) && n.blocks.length > 0, `${n.id}: a stage-2 block note`);
    assert.equal(JSON.stringify(validateItem('notes', JSON.parse(JSON.stringify(n)))), JSON.stringify(n), `${n.id}: a valid note in its stored form`);
  }
  const note = notes.find((n) => n.blocks.some((b) => b.t === 'check' && b.task));
  assert.ok(note, 'a sample note has a checklist item linked to a task');
  const item = note.blocks.find((b) => b.t === 'check' && b.task);
  const task = db.get('tasks', item.task);
  assert.ok(task, 'the linked task exists');
  assert.deepEqual(task.source, { app: 'notes', noteId: note.id, blockId: item.id }, 'the task links back to that checklist item');
  const glyph = String.fromCharCode(0x2318);
  const noteText = JSON.stringify(notes.map((n) => n.blocks));
  assert.ok(!db.all('tasks').some((t) => t.title.includes(glyph) || t.notes.includes(glyph)) && !noteText.includes(glyph), 'no command-key glyph in sample text');
});
