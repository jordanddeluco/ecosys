// QA fix (notes-core, data cross request): Send to Tasks reads a date range in a checklist item whole,
// in the Notes app (notes/core/notes.js sendBlocksToTasks) and over MCP (notes_send_to_tasks) alike:
// "Prep slides dec 3-5" becomes "Prep slides", planned for Dec 3 and due Dec 5. Before, both read only
// the first day and left "-5" in the task's title ("Prep slides -5").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i], get length() { return mem.size; } };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const N = await import('../notes/core/notes.js');
const { db } = await import('../shared/store.js');
const { parse } = await import('../shared/nlp.js');
const { createCore } = await import('../server/core.mjs');
const { fmtDay } = await import('../server/model.mjs');

const silent = { warn() {}, error() {}, info() {}, log() {} };
const ITEMS = ['Prep slides dec 3-5', 'Pack for the trip from dec 20 to dec 23 #travel', 'Call Sam tomorrow 3pm', 'Order 20-28 page binders'];
const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-nc-ranges-'));
let core;
let claude;
before(async () => {
  core = await createCore({ dataDir: dir, log: silent });
  claude = core.ai.createClient({ kind: 'claude' });
});
after(() => {
  core?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});
const ok = (name, args) => {
  const r = core.callTool(name, args, { client: claude });
  assert.equal(r.isError, false, `${name}: ${r.content[0].text}`);
  return { text: r.content[0].text, data: r.structuredContent };
};
const pick = (t) => ({ title: t.title, date: t.date ?? null, time: t.time ?? null, deadline: t.deadline ?? null });

test('the Notes app: an item with a date range is planned for the first day and due on the last', () => {
  const n = N.createNote({ blocks: [{ id: 'h', t: 'h1', c: [['Trip prep']] }, ...ITEMS.map((text, i) => ({ id: `c${i}`, t: 'check', in: 0, ck: false, c: [[text]] }))] });
  const made = N.sendBlocksToTasks(n.id, ITEMS.map((_, i) => `c${i}`));
  assert.equal(made.length, ITEMS.length);
  const slides = made.find((t) => t.title === 'Prep slides');
  assert.ok(slides, `titles: ${made.map((t) => t.title).join(' | ')}`);
  const want = parse('Prep slides dec 3-5', { mode: 'task', now: new Date(), ranges: true });
  assert.ok(want.deadline && want.deadline > want.date, 'control: the parser reads the range');
  assert.deepEqual([slides.date, slides.deadline], [want.date, want.deadline]);
  const trip = made.find((t) => t.title.startsWith('Pack for the trip'));
  assert.equal(trip.title, 'Pack for the trip');
  assert.ok(trip.deadline > trip.date);
  assert.deepEqual(trip.tags, ['travel'], 'the note tag still becomes a label');
  assert.equal(made.find((t) => t.title === 'Order 20-28 page binders')?.deadline ?? null, null, 'two bare numbers are not a range');
  // The items now read as their tasks' titles and link to them.
  const blocks = db.get('notes', n.id).blocks;
  assert.deepEqual(blocks.filter((b) => b.task).map((b) => b.c[0][0]), made.map((t) => t.title));
});

test('notes_send_to_tasks reads an item exactly as the Notes app does, and says when it is due', () => {
  const created = ok('notes_create', { markdown: `# Trip prep\n\n${ITEMS.map((t) => `- [ ] ${t}`).join('\n')}` });
  const r = ok('notes_send_to_tasks', { id: created.data.id });
  const server = r.data.tasks.map((t) => pick(core.store.get('tasks', t.task_id)));
  const app = ITEMS.map((text) => {
    const p = parse(text.replace(/\s*#\w+/g, ''), { mode: 'task', now: new Date(), ranges: true });
    return pick({ ...p, title: p.title || text });
  });
  assert.deepEqual(server, app, 'the same title, date, time and deadline as in the app');
  const slides = r.data.tasks.find((t) => t.title === 'Prep slides');
  assert.equal(slides.deadline, server[0].deadline);
  assert.ok(r.text.includes(`- "Prep slides" ${fmtDay(server[0].date)} | deadline ${fmtDay(server[0].deadline)} | "Inbox" | task_id=${slides.task_id}`), r.text);
  assert.ok(!/ \| deadline /.test(r.text.split('\n').find((l) => l.startsWith('- "Call Sam"'))), 'no deadline, no deadline field');
});
