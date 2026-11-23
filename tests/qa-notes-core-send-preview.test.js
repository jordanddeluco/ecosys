// QA fix (notes-core, verifier of the second pass): the Send to Tasks dialog previewed an item with its
// own parse (nlp.js on the raw text, lists included), while Send itself (notes/core/notes.js
// sendBlocksToTasks) reads a date range whole and #tags as labels: "Prep slides dec 3-5" showed as
// "Prep slides -5 · Thu, Dec 3" and was made as "Prep slides", Dec 3, Deadline Dec 5. taskFromBlock is
// now the one reading of an item for both (the dialog previews with it once the notes-app cross
// request lands): the preview is what Send makes, title, date, time, deadline, repeat and labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i], get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const N = await import('../notes/core/notes.js');
const { db } = await import('../shared/store.js');
const { parse } = await import('../shared/nlp.js');

const ITEMS = ['Prep slides dec 3-5 #work', 'Call Sam tomorrow 3pm', 'Water the plants every friday', 'Plain item', '#errands'];
const pick = (t) => ({ title: t.title, date: t.date ?? null, time: t.time ?? null, deadline: t.deadline ?? null, repeat: t.repeat ? JSON.stringify(t.repeat) : null, tags: t.tags || [] });

test('taskFromBlock previews exactly what Send to Tasks makes of each item', () => {
  db.insert('lists', { name: 'Work', color: 'blue', order: 0 }); // a list named like the tag: the tag stays a label
  const n = N.createNote({ blocks: [{ id: 'h', t: 'h1', c: [['Prep']] }, ...ITEMS.map((text, i) => ({ id: `c${i}`, t: 'check', in: 0, ck: false, c: [[text]] }))] });
  const preview = ITEMS.map((_, i) => N.taskFromBlock(db.get('notes', n.id).blocks[i + 1]));
  const made = N.sendBlocksToTasks(n.id, ITEMS.map((_, i) => `c${i}`));
  assert.deepEqual(made.map(pick), preview.map(pick));
  const slides = preview[0];
  const range = parse('Prep slides dec 3-5', { mode: 'task', now: new Date(), ranges: true });
  assert.deepEqual([slides.title, slides.date, slides.deadline, slides.tags], ['Prep slides', range.date, range.deadline, ['work']]);
  assert.equal(made[0].listId ?? null, null, 'Inbox, not the list named like the tag');
  assert.ok(preview[2].repeat, 'a repeat is read');
  assert.equal(preview[4].title, '#errands', 'a line of only a tag keeps its text as the title');
});

test('taskFromBlock: nothing for a divider, a code block or an empty line', () => {
  assert.equal(N.taskFromBlock({ id: 'a', t: 'hr' }), null);
  assert.equal(N.taskFromBlock({ id: 'b', t: 'code', c: [['npm test tomorrow']] }), null);
  assert.equal(N.taskFromBlock({ id: 'c', t: 'check', in: 0, ck: false, c: [['   ']] }), null);
  assert.equal(N.taskFromBlock(null), null);
  assert.equal(N.taskFromBlock({ id: 'd', t: 'p', c: [['Book flights friday']] }).title, 'Book flights');
});
