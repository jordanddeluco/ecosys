// QA fix (model, logo and launcher port, identity PORT.md section 7.4): the smart lists used stock
// glyphs that other places use for other things (Upcoming the plain calendar of every date chip,
// Completed the check-circle of "Complete"). They now draw their own glyphs from the custom set:
// Upcoming 'upcoming', Completed 'done'. The Tasks sidebar and palette read them from SMART_LISTS.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
const ls = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => ls });

const M = await import('../shared/model.js');
const { icon, hasIcon } = await import('../shared/icons.js');

const glyph = (name) => icon(name).replace(/^<svg[^>]*>|<\/svg>$/g, '');

test('each smart list draws its own glyph from the custom set', () => {
  const byId = Object.fromEntries(M.SMART_LISTS.map((s) => [s.id, s.icon]));
  assert.deepEqual(byId, { inbox: 'inbox', today: 'today', upcoming: 'upcoming', important: 'star', completed: 'done' });
  for (const s of M.SMART_LISTS) assert.ok(hasIcon(s.icon), `${s.id}: "${s.icon}" is in shared/icons.js`);
  const drawn = M.SMART_LISTS.map((s) => glyph(s.icon));
  assert.equal(new Set(drawn).size, drawn.length, 'no two smart lists look the same');
  assert.notEqual(glyph('upcoming'), glyph('calendar'), 'Upcoming is not the plain date glyph');
  assert.notEqual(glyph('done'), glyph('check-circle'), "Completed is not the Complete action's glyph");
  assert.notEqual(glyph('upcoming'), glyph('circle'), 'a real glyph, not the unknown-name circle');
  assert.notEqual(glyph('done'), glyph('circle'));
});
