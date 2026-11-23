// QA regressions for tasks/tasks.css that need no browser (the rendered colours are measured in
// tests/e2e/qa-tasks-a11y.test.mjs):
//   - a fill under a white (--on-accent) glyph is --accent-fill, never the raw accent (2.2:1 with yellow)
//   - the Important star: --control-line unset (not the decorative --text-4), --accent-fill set
//   - past events step back in colour, not opacity (opacity took their text to 1.7–2.2:1)
//   - the details pane's text fields keep a focus ring; the note's is drawn inside the card that clips it
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../tasks/tasks.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as [selector text, declarations] (rules inside @media too, at-rule preludes left out). */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push([m[1].trim(), m[2].trim()]);
  return out;
}
const R = rules(CSS);
const decl = (body, prop) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim() ?? null;
const rule = (selector) => R.find(([s]) => s.split(',').map((x) => x.trim()).includes(selector))?.[1] ?? null;

test('a fill under a white glyph is --accent-fill, never the raw accent', () => {
  const white = R.filter(([, b]) => decl(b, 'color') === 'var(--on-accent)');
  assert.ok(white.length >= 3, 'the + fills are found');
  for (const [s, b] of white) assert.equal(decl(b, 'background'), 'var(--accent-fill)', `${s}`);
  for (const s of ['.add-row:hover .plus', '.add-row.inline:hover .plus', '.sugg-row .add:hover']) assert.equal(decl(rule(s) || '', 'background'), 'var(--accent-fill)', s);
});

test('the Important star: --control-line unset, --accent-fill set', () => {
  assert.equal(decl(rule('.star'), 'color'), 'var(--control-line)');
  assert.equal(decl(rule('.star.on'), 'color'), 'var(--accent-fill)');
});

test('past events step back in colour, not opacity', () => {
  for (const [s, b] of R) {
    if (!/\.event-row\.past\b/.test(s) || /\.bar\b/.test(s)) continue; // the colour bar may fade
    assert.ok([null, '1'].includes(decl(b, 'opacity')), `${s} dims its text with opacity`);
  }
  for (const s of ['.event-row.past .when', '.event-row.past .what', '.event-row.past .where']) assert.equal(decl(rule(s) || '', 'color'), 'var(--text-3)', s);
});

test("the details pane's text fields keep a focus ring; the note's is drawn inside its card", () => {
  for (const s of ['.dp-title textarea:focus-visible', '.dp-note:focus-visible', '.step input:focus-visible', '.tag-input:focus-visible']) {
    const bodies = R.filter(([sel]) => sel.split(',').map((x) => x.trim()).includes(s)).map(([, b]) => b);
    assert.ok(bodies.length, `${s} has a rule`);
    for (const b of bodies) assert.notEqual(decl(b, 'outline'), 'none', `${s} must not hide its ring`);
    assert.ok(bodies.some((b) => /^2px solid var\(--focus-color\)$/.test(decl(b, 'outline') || '')), `${s} draws the shared 2px ring`);
  }
  // .dp-card clips its content (overflow: hidden) and the note fills it: an outward ring would be cut off.
  assert.equal(decl(rule('.dp-card'), 'overflow'), 'hidden');
  const note = R.filter(([sel]) => sel === '.dp-note:focus-visible').map(([, b]) => b);
  assert.ok(note.some((b) => parseFloat(decl(b, 'outline-offset')) < 0), "the note's ring is inset");
});
