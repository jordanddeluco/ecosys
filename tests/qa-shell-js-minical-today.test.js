// QA regressions for the mini calendar's Today control (shared/minical.js), no browser needed:
//   - where there is room beside the month (the date picker, Notes' day picker) it is the word "Today",
//     a quiet text button, not a bare dot
//   - a compact calendar (Home's tile) keeps a dot there, named "Go to today", so a long month such as
//     "September 2026" stays on one line in its narrow head
//   - showToday: false (Schedule's sidebar, which has Today in its toolbar) leaves it out
// The date picker in the browser is checked in tests/e2e/qa-shell-js-followups.test.mjs.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { miniCalendar } from '../shared/minical.js';

const todayButton = (html) => /<button\b[^>]*data-mc="today"[^>]*>([\s\S]*?)<\/button>/.exec(html);
const month = new Date(2026, 8, 1); // September: the longest month name

test('a regular calendar says "Today" in words', () => {
  const m = todayButton(miniCalendar({ month }));
  assert.ok(m, 'a Today button');
  assert.equal(m[1].trim(), 'Today');
  assert.match(m[0], /class="btn btn-ghost btn-sm mc-today"/);
  assert.doesNotMatch(m[0], /<svg/, 'no glyph');
  // Named for what it does ("Go to today": the date picker's quick dates have a "Today" that picks the
  // date), and the name still contains the visible word (WCAG 2.5.3 label in name).
  assert.match(m[0], /aria-label="Go to today"/, 'named for what it does, containing the visible word');
});

test('a compact calendar keeps a named dot, so the month stays on one line', () => {
  const m = todayButton(miniCalendar({ month, compact: true }));
  assert.ok(m, 'a Today button');
  assert.match(m[0], /class="icon-btn sm mc-today"/);
  assert.match(m[0], /aria-label="Go to today"/);
  assert.match(m[0], /data-tip="Today"/);
  assert.match(m[1], /<svg/);
});

test('showToday: false leaves it out, compact or not', () => {
  assert.equal(todayButton(miniCalendar({ month, showToday: false })), null);
  assert.equal(todayButton(miniCalendar({ month, compact: true, showToday: false })), null);
});

test('the previous and next buttons are there either way', () => {
  for (const compact of [false, true]) {
    const html = miniCalendar({ month, compact });
    assert.match(html, /data-mc="prev"[^>]*aria-label="Previous month"/);
    assert.match(html, /data-mc="next"[^>]*aria-label="Next month"/);
  }
});
