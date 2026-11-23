// QA fix round 2 (schedule): the logo port's follow-ups (PORT.md §7). Schedule's page has the 180px home-screen
// icon iOS asks for (it ignores SVG), and every glyph Schedule draws exists in shared/icons.js under its new
// name: deadline, duration, no-date, done, text-lines, sidebar; none of the old names the alias block keeps
// alive (target, hourglass, circle-slash, sparkle, sun, bolt). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { hasIcon } = await import('../shared/icons.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../schedule/index.html');
const app = read('../schedule/app.js');
const OLD = ['target', 'hourglass', 'circle-slash', 'sparkle', 'sun', 'bolt'];

test('schedule/index.html links the 180px apple-touch-icon', () => {
  assert.match(html, /<link rel="apple-touch-icon" href="\.\.\/shared\/icons\/schedule-180\.png" \/>/);
  assert.match(html, /<link rel="icon" href="\.\.\/shared\/icons\/schedule\.svg"/, 'the SVG favicon stays');
});

test('every glyph Schedule draws exists, under its new name', () => {
  const names = new Set();
  for (const m of app.matchAll(/\bicon\(\s*'([a-z0-9-]+)'/g)) names.add(m[1]);
  for (const m of app.matchAll(/\bicon:\s*'([a-z0-9-]+)'/g)) names.add(m[1]);
  for (const m of app.matchAll(/\bicon:\s*s\.\w+\s*\?\s*'([a-z0-9-]+)'\s*:\s*'([a-z0-9-]+)'/g)) names.add(m[1]).add(m[2]);
  assert.ok(names.size > 25, `found the glyph names (${names.size})`);
  const missing = [...names].filter((n) => !hasIcon(n));
  assert.deepEqual(missing, [], 'no glyph falls back to the plain circle');
  const old = [...names].filter((n) => OLD.includes(n));
  assert.deepEqual(old, [], 'no old name (drawn through the alias block)');
  for (const n of ['deadline', 'duration', 'no-date', 'done', 'text-lines', 'sidebar', 'menu']) assert.ok(names.has(n) || app.includes(`'${n}'`), `uses ${n}`);
});

test('descriptions use the text-lines glyph; "Mark completed" uses done', () => {
  // (assert.ok, so a failure doesn't print the whole of app.js)
  assert.ok(!/icon\('list'\)\}(<span class="notes"|<textarea)/.test(app), 'the list glyph means a list (Tasks), not a description');
  assert.equal(app.match(/icon\('text-lines'\)\}<span class="notes">/g)?.length, 2, 'event and task cards');
  assert.ok(/icon\('text-lines'\)\}<textarea/.test(app), 'the editor’s description');
  assert.ok(/'Mark completed', icon: 'done'/.test(app), 'the task menu');
});
