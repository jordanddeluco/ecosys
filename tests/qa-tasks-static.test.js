// QA regressions for the tasks app that need no browser:
//   - glyphs: the logo family's names (upcoming, done, tomorrow, deadline, duration, sidebar), never the
//     emoji look-alikes they replaced (sun, target, hourglass) nor the hamburger for the sidebar toggle
//   - the page has an apple-touch-icon (iOS ignores SVG icons)
//   - long lists: rows skip layout and paint out of view (content-visibility), with a clip margin so the
//     circle's focus ring and the drop line are not cut off at the row's edge
//   - Upcoming draws its later months in pages ("Show later"), never every future task at once
//   - quick add reads date ranges ("dec 3-5": planned Dec 3, deadline Dec 5)
// The behaviour itself is covered in the browser by tests/e2e/qa-tasks-redraw, qa-tasks-keys, qa-tasks-links.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const APP = read('tasks/app.js');
const CSS = read('tasks/tasks.css').replace(/\/\*[\s\S]*?\*\//g, '');
const HTML = read('tasks/index.html');
const ICONS = read('shared/icons.js');

test('glyphs come from the logo family, not the emoji look-alikes', () => {
  for (const name of ['sun', 'target', 'hourglass']) {
    assert.doesNotMatch(APP, new RegExp(`icon\\('${name}'|icon: '${name}'`), `tasks still draws the old "${name}" glyph`);
  }
  for (const name of ['upcoming', 'done', 'tomorrow', 'deadline', 'duration', 'sidebar']) {
    assert.match(ICONS, new RegExp(`^\\s*'?${name}'?: '`, 'm'), `shared/icons.js has "${name}"`);
    assert.match(APP, new RegExp(`icon\\('${name}'|icon: '${name}'|\\['${name}', '`), `tasks uses "${name}"`);
  }
  assert.match(APP, /\['upcoming', 'Upcoming', icon\('upcoming'\)\]/, 'the tab bar draws Upcoming with its own glyph');
  assert.match(APP, /label: t\.done \? 'Mark as not done' : 'Complete', icon: 'done'/, 'Complete uses the Tasks check');
  assert.match(APP, /emptyState\(icon\('done'\), 'Nothing completed yet'/, 'the empty Completed view uses the Tasks check');
  assert.match(APP, /class="icon-btn menu-toggle"[^`]*\$\{icon\('sidebar'\)\}/, 'the sidebar button draws the sidebar glyph');
});

test('the page has an apple-touch-icon', () => {
  assert.match(HTML, /<link rel="apple-touch-icon" href="\.\.\/shared\/icons\/tasks-180\.png"/);
});

test('rows skip layout out of view, without clipping what they draw past their edges', () => {
  const block = /@supports\s*\(content-visibility:\s*auto\)[^{]*\{\s*\.task\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(block, 'a .task rule inside @supports (content-visibility: auto)');
  const body = block[1];
  assert.match(body, /content-visibility:\s*auto/);
  assert.match(body, /contain-intrinsic-size:\s*auto\s+\d+px/, 'an estimated height, remembered once drawn (auto)');
  const margin = /overflow-clip-margin:\s*(\d+)px/.exec(body);
  assert.ok(margin && +margin[1] >= 6, 'a clip margin that covers the 2px ring at its 2px offset past the row edge');
  assert.match(CSS, /@supports\s*\(content-visibility:\s*auto\)\s*and\s*\(overflow-clip-margin:/, 'only where the clip margin is supported');
});

test('Upcoming draws its later months in pages', () => {
  assert.match(APP, /const LATER_FIRST = \d+;/);
  assert.match(APP, /data-more-later>Show later<\/button>/);
  assert.match(APP, /if \(i < state\.upLimit\) g\.tasks\.push\(t\)/, 'only the first later tasks are drawn');
});

test('quick add reads date ranges', () => {
  assert.match(APP, /parse\(cTitle\.value, \{[^}]*ranges: true[^}]*\}\)/);
});
