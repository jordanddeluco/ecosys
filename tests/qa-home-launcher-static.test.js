// QA for Home as an app launcher and the app logos, with no browser (the flows are in
// tests/e2e/qa-home-launcher.test.mjs). Replaces tests/qa-home-cross.test.js, whose tiles are gone:
//   - home.js lists the apps from shell.js APPS plus AI, draws every icon with appIcon(), and has no switcher button,
//     no counts and no previews (no model.js, minical.js or notes imports)
//   - home.css: each icon's glow is its logo's own colour (the light stop of its tile in appIcon), the greeting has no
//     glow, nothing loops forever, and the press still answers under Reduce motion
//   - the logos draw no text (nothing depends on a font or the date), and the static icon files carry both cuts, with a
//     small cut identical to the tab icon setFavicon() sets, so the tab never changes when the page's JS runs
//   - the manifests list an "any" icon and a separate full-bleed "maskable" one
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.ECOSYS_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** appIcon() and setFavicon() from shell.js, evaluated on their own (they need only `gid`, `$` and document). */
function logoApi() {
  const shell = read('shared/shell.js');
  const start = shell.indexOf('export function appIcon(');
  const doc = shell.lastIndexOf('/**', start);
  const fav = shell.indexOf('export function setFavicon(id) {');
  const end = shell.indexOf('\n}\n', fav) + 3;
  assert.ok(start > 0 && fav > start && end > fav, 'shell.js has appIcon() followed by setFavicon()');
  const block = shell.slice(doc, end).replace(/export /g, '');
  return new Function(
    `let gid = 0; let link = null; const $ = () => link;
     const document = { head: { append: (l) => (link = l) }, createElement: () => ({}) };
     ${block}
     return { appIcon, favicon: (id) => { setFavicon(id); return decodeURIComponent(link.href.replace('data:image/svg+xml,', '')); } };`,
  )();
}
const LOGOS = [['home', 'ecosys'], ['tasks', 'tasks'], ['schedule', 'schedule'], ['notes', 'notes'], ['ai', 'ai']];

test('home.js: the apps from APPS plus AI, drawn with appIcon(), no switcher, no previews', () => {
  const js = read('home.js');
  assert.match(js, /APPS\.filter\(\(a\) => a\.id !== 'home'\)/, 'every app but Home, from shell.js APPS');
  assert.match(js, /\{ id: 'ai', name: 'AI' \}/, 'AI is the last app');
  assert.match(js, /<span class="launch-icon app-icon">\$\{appIcon\(app\.id\)\}<\/span>/, 'every icon is the app logo');
  assert.doesNotMatch(js, /switcherButton|data-app-switcher/, 'the page is the switcher: no switcher button in its header');
  assert.doesNotMatch(js, /from '\.\/shared\/(model|minical|sanitize)\.js'|notes\/core/, 'no counts or previews: Home reads no data');
  assert.match(js, /data-open-ai aria-haspopup="dialog"/, 'AI opens Connect AI (a dialog)');
  assert.match(js, /`AI assistants, \$\{cap\.said\}`/, "AI's accessible name starts with its visible words");
});

test("home.css: each glow is its logo's colour, no glow on the greeting, nothing loops", () => {
  const css = strip(read('home.css'));
  const { appIcon } = logoApi();
  for (const id of ['tasks', 'schedule', 'notes', 'ai']) {
    const lit = /<stop offset="0" stop-color="#([0-9a-f]{6})"\/>/.exec(appIcon(id))?.[1];
    const rgb = [0, 2, 4].map((i) => parseInt(lit.slice(i, i + 2), 16)).join(' ');
    assert.match(css, new RegExp(`\\.launch-app\\[data-app='${id}'\\]\\s*\\{\\s*--hue:\\s*${rgb};`), `${id}'s glow is #${lit}, its tile's light stop`);
  }
  assert.doesNotMatch(/\.home-greeting\s*\{([^}]*)\}/.exec(css)?.[1] || '', /text-shadow/, 'the greeting is plain type, like the apps’ headings');
  assert.doesNotMatch(css, /\binfinite\b/);
  assert.match(css, /\.launch-app:active \.launch-icon\s*\{[^}]*filter:\s*brightness/, 'a press dims the icon, so Reduce motion (no scale) still answers a tap');
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\)/, 'no frosted header where less transparency is asked for');
});

test('the logos draw no text and stay within the family (one tile gradient, ids unique per call)', () => {
  const { appIcon } = logoApi();
  const ids = new Set();
  for (const [id] of LOGOS) {
    for (const small of [false, true]) {
      const svg = appIcon(id, { small });
      assert.doesNotMatch(svg, /<text|<image|<filter|href=/, `${id}${small ? ' (small)' : ''}: shapes only`);
      assert.match(svg, /^<svg viewBox="0 0 64 64" aria-hidden="true"><defs>/);
      assert.match(svg, /<rect width="64" height="64" fill="url\(#ecg\d+\)"\/>/, 'the first rect is the full-bleed tile (setFavicon rounds it)');
      const g = /id="(ecg\d+)"/.exec(svg)[1];
      assert.ok(!ids.has(g), 'a new gradient id on every call');
      ids.add(g);
      assert.ok(svg.length < 1700, `${id}: ${svg.length} bytes`);
    }
  }
  assert.equal(appIcon('nope').replace(/ecg\d+/g, ''), appIcon('home').replace(/ecg\d+/g, ''), 'an unknown app gets the Home mark');
});

test('shared/icons: each file holds both cuts, and its small cut is the tab icon setFavicon() sets', () => {
  const { favicon } = logoApi();
  const norm = (s) => s.replace(/ecg\d+/g, 'X').replace(/id="s"/g, 'id="X"').replace(/url\(#s\)/g, 'url(#X)');
  for (const [id, file] of LOGOS) {
    const svg = read(`shared/icons/${file}.svg`).trim();
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64"><style>\.s\{display:none\}@media \(max-width:31\.9px\)\{\.l\{display:none\}\.s\{display:inline\}\}<\/style>/, `${file}.svg switches to the small cut under 32px`);
    const small = /<g class="s">([\s\S]*)<\/g><\/svg>$/.exec(svg)?.[1];
    const tab = /^<svg[^>]*>([\s\S]*)<\/svg>$/.exec(favicon(id))?.[1];
    assert.equal(norm(small), norm(tab), `${file}.svg's small cut equals setFavicon('${id}')`);
    assert.doesNotMatch(svg, /<text/);
    const mask = read(`shared/icons/${file}-maskable.svg`);
    assert.match(mask, /<rect width="64" height="64" fill="url\(#l\)"\/>/, `${file}-maskable.svg is full bleed (no rounded corners)`);
    assert.match(mask, /scale\(0\.86\)/, 'its glyph sits inside the maskable safe zone');
  }
});

test('manifests: an "any" icon and a separate full-bleed "maskable" one', () => {
  const check = (path, prefix, name) => {
    const icons = JSON.parse(read(path)).icons;
    assert.deepEqual(icons.map((i) => [i.src, i.purpose]), [[`${prefix}${name}.svg`, 'any'], [`${prefix}${name}-maskable.svg`, 'maskable']], path);
    for (const i of icons) assert.ok(existsSync(join(ROOT, dirname(path), i.src)), `${path}: ${i.src} exists`);
  };
  check('manifest.webmanifest', 'shared/icons/', 'ecosys');
  for (const app of ['tasks', 'schedule', 'notes']) check(`${app}/manifest.webmanifest`, '../shared/icons/', app);
});
