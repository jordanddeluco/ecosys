// QA regressions for the mini calendar (shared/minical.js) that need no browser:
//   - the month heading is not a live region: callers redraw the whole calendar on every month change,
//     and a region that is replaced is never read, so they announce the month themselves (monthTitle)
//   - a day outside the current year says its year ("Friday, January 1, 2027"), so paging into
//     another year is not ambiguous for screen readers
// The browser side (the date picker's announcement) is in tests/e2e/qa-shell-js-desktop.test.mjs.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { miniCalendar, monthTitle } from '../shared/minical.js';

const labels = (html) => [...html.matchAll(/data-date="(\d{4}-\d{2}-\d{2})"[^>]*aria-label="([^"]*)"/g)].map((m) => ({ date: m[1], label: m[2] }));
const now = new Date();
const thisYear = now.getFullYear();

test('the month heading is plain text, not a live region that gets replaced', () => {
  const html = miniCalendar({ month: now });
  assert.doesNotMatch(html, /aria-live/);
  assert.match(html, new RegExp(`<strong>${monthTitle(now)}</strong>`));
});

test('monthTitle names the month and year, whatever day it is given', () => {
  assert.equal(monthTitle(new Date(2026, 11, 31)), monthTitle(new Date(2026, 11, 1)));
  assert.match(monthTitle(new Date(2026, 11, 15)), /2026/);
  assert.match(monthTitle(new Date(2026, 11, 15)), /December|Dec/);
});

test('days in the current year are named without the year', () => {
  const html = miniCalendar({ month: new Date(thisYear, 5, 1) }); // June: every cell is in this year
  const ls = labels(html);
  assert.ok(ls.length >= 28);
  for (const { label } of ls) assert.doesNotMatch(label, new RegExp(String(thisYear)), label);
});

test('days in another year carry the year, including the next month’s overflow days', () => {
  const next = labels(miniCalendar({ month: new Date(thisYear + 1, 0, 1) }));
  for (const { date, label } of next) {
    const y = +date.slice(0, 4);
    if (y === thisYear) assert.doesNotMatch(label, new RegExp(String(thisYear)), label);
    else assert.match(label, new RegExp(String(y)), label);
  }
  // December of this year: its trailing January days are next year's and say so.
  const dec = labels(miniCalendar({ month: new Date(thisYear, 11, 1) }));
  const jan = dec.filter((x) => x.date.startsWith(`${thisYear + 1}-`));
  for (const { label } of jan) assert.match(label, new RegExp(String(thisYear + 1)), label);
  const decDays = dec.filter((x) => x.date.startsWith(`${thisYear}-12`));
  assert.ok(decDays.length === 31);
  for (const { label } of decDays) assert.doesNotMatch(label, new RegExp(String(thisYear)), label);
});

test('a mark still ends the label after the year', () => {
  const d = `${thisYear + 1}-01-15`;
  const html = miniCalendar({ month: new Date(thisYear + 1, 0, 1), marks: new Set([d]), markLabel: 'has events' });
  const l = labels(html).find((x) => x.date === d);
  assert.match(l.label, new RegExp(`${thisYear + 1}, has events$`));
});
