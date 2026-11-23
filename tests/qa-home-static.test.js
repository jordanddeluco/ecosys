// QA regressions for Home that need no browser (the flows are in tests/e2e/qa-home-tiles.test.mjs):
//   - Home's install colours match the other apps' (Lights out is black everywhere), and its shortcuts
//     point at real routes
//   - home.css runs no endless animation (an infinite glow drift kept the glass tile re-rendering every
//     frame) and keeps Lights out black
//   - home.css leaves the mini month's today to ui.css (its own copy of today's tint cancelled the hover)
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const manifest = (p) => JSON.parse(read(p));

test("Home's manifest uses the same splash and title-bar colour as Tasks, Schedule and Notes", () => {
  const home = manifest('manifest.webmanifest');
  for (const app of ['tasks', 'schedule', 'notes']) {
    const m = manifest(`${app}/manifest.webmanifest`);
    assert.equal(home.background_color, m.background_color, `background_color, as in ${app}`);
    assert.equal(home.theme_color, m.theme_color, `theme_color, as in ${app}`);
  }
  assert.equal(home.theme_color, '#000000');
  assert.equal(home.start_url, './');
  for (const s of home.shortcuts) assert.match(s.url, /^(tasks|schedule|notes)\//, `shortcut ${s.name} opens an app`);
});

test('home.css: no endless animation, and Lights out is black', () => {
  const css = read('home.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /\binfinite\b/, 'an infinite animation keeps the page rendering every frame');
  const dark = /html\.home-page\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(dark, /--bg:\s*#000(000)?\s*;/, "Lights out's --bg");
  assert.match(dark, /--home-base:\s*#000(000)?\s*;/, "Lights out's page gradient is plain black");
});

test("home.css leaves the mini month's today to ui.css, so today answers hover as in Schedule", () => {
  const css = read('home.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // A '.sched-cal .mc-day.today:not(.sel) span' tint here had the same specificity as ui.css's hover rule and
  // loaded later, so it won: today kept its resting tint under the pointer, in Home's mini month only.
  assert.doesNotMatch(css, /\.mc-day\.today/, "today's tint and hover come from ui.css (.mc-day.today rules)");
  assert.match(read('shared/ui.css'), /\.mc-day\.today:not\(\.sel\):hover span\s*\{/, 'ui.css still draws the hover');
});
