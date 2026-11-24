// QA regression (design system, shared/ui.css): the logo family and the look tokens that go with it. Every app logo
// has the logo's own corners (15 of its 64 units, as setFavicon and shared/icons draw the tile) at every size; on Dim
// and Lights out a faint rim keeps a dark tile's edge, at one class's weight so Home's launcher keeps its own; the app
// switcher is one row of five from CSS alone; the Today glyph draws no date number; a native select's chevron is each
// theme's --text-3; and Yellow's hovered fill lightens away from its dark labels in every theme.
// The browser side is in tests/e2e/qa-design-system-logos.test.mjs. Run with: npm test
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const CSS = read('shared/ui.css');
const SHELL = read('shared/shell.js');

/** Style rules with the at-rules around them: [{ prelude, selectors: string[], at: string[], decls: Map<prop, value> }]. */
function parseCss(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') {
      stack.push({ prelude: src.slice(start, i).trim(), body: i + 1 });
      start = i + 1;
    } else if (src[i] === '}') {
      const b = stack.pop();
      if (b && !b.prelude.startsWith('@') && stack.every((s) => s.prelude.startsWith('@'))) {
        const decls = new Map();
        for (const m of src.slice(b.body, i).matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) decls.set(m[1], m[2].trim());
        const prelude = b.prelude.replace(/\s+/g, ' ');
        rules.push({ prelude, selectors: prelude.split(',').map((s) => s.trim()), at: stack.map((s) => s.prelude.replace(/\s+/g, ' ')), decls });
      }
      start = i + 1;
    }
  }
  return rules;
}
const RULES = parseCss(CSS);
const TOP = RULES.filter((r) => !r.at.length);
/** Declarations of the top-level rules naming exactly `selector`. */
function declsFor(selector) {
  const rules = TOP.filter((r) => r.selectors.includes(selector));
  assert.ok(rules.length, `ui.css has a top-level rule for ${selector}`);
  return new Map(rules.flatMap((r) => [...r.decls]));
}
/** The body of a top-level function in shell.js (up to the first line that is just "}"). */
function fnBody(name) {
  const at = SHELL.search(new RegExp(`\\nfunction ${name}\\(|\\nexport function ${name}\\(`));
  assert.ok(at >= 0, `shell.js has ${name}()`);
  return SHELL.slice(at, SHELL.indexOf('\n}\n', at));
}

describe('ui.css: app logos', () => {
  test("every size has the logo's own corners: 15 of its 64 units, as setFavicon() rounds the tile", () => {
    const fav = /rx="([\d.]+)"/.exec(fnBody('setFavicon'));
    assert.ok(fav, 'setFavicon() rounds the tile with an rx');
    const logo = +fav[1] / 64;
    const r = declsFor('.app-icon').get('border-radius');
    const pct = /^([\d.]+)%$/.exec(r || '');
    assert.ok(pct, `.app-icon's radius is a share of its size, so every size gets the same shape (got ${r})`);
    assert.ok(Math.abs(+pct[1] / 100 - logo) < 0.002, `${r} is the logo's ${(logo * 100).toFixed(2)}%`);
    // No size of logo gets corners of its own (Home's launcher draws its icons itself, in home.css).
    const sized = TOP.filter((x) => x.selectors.some((s) => /\.app-icon(?![\w-])/.test(s) && !/::after$/.test(s)) && x.decls.has('border-radius'));
    assert.deepEqual(sized.map((x) => x.prelude), ['.app-icon'], 'only .app-icon sets the corners');
  });

  test('a faint rim on Dim and Lights out only, which an app that draws its own edge outranks', () => {
    assert.equal(declsFor('.app-icon').get('position'), 'relative', 'the logo holds its rim');
    const rim = TOP.filter((x) => /\.app-icon::after$/.test(x.prelude));
    assert.equal(rim.length, 1, 'one rim rule');
    const { prelude, decls } = rim[0];
    assert.match(prelude, /^:where\(/, "inside :where(), so the rule weighs one class: home.css's [data-theme] .launch-icon::after wins");
    const themes = [...prelude.matchAll(/\[data-theme='(\w+)'\]/g)].map((m) => m[1]).sort();
    assert.deepEqual(themes, ['dark', 'dim'], 'Dim and Lights out, not Light (bright tiles stand off white on their own)');
    assert.match(decls.get('box-shadow') || '', /^inset 0 0 0 1px rgb\(255 255 255 \/ 0?\.\d+\)$/, 'a 1px white inset edge');
    assert.ok(+/\/ (0?\.\d+)\)/.exec(decls.get('box-shadow'))[1] <= 0.2, 'faint');
    assert.equal(decls.get('content'), "''");
    assert.equal(decls.get('position'), 'absolute');
    assert.equal(decls.get('inset'), '0');
    assert.equal(decls.get('border-radius'), 'inherit', 'it follows the corners');
    assert.equal(decls.get('pointer-events'), 'none', 'and never takes a click');
    // Specificity as [ids, classes + attributes + pseudo-classes, elements + pseudo-elements], :where() weighing nothing.
    const spec = (sel) => {
      const s = sel.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '');
      return [(s.match(/#[\w-]+/g) || []).length, (s.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):(?!where)[\w-]+/g) || []).length, (s.match(/::[\w-]+|(?:^|[\s>+~])[a-z][\w-]*/gi) || []).length];
    };
    const outranks = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    assert.deepEqual(spec(prelude), [0, 1, 1], 'the rim weighs one class and its ::after');
    // Any app logo rule that draws its own edge (Home's launcher and brand mark today) outranks it, whatever the order.
    const own = parseCss(read('home.css')).flatMap((r) => (r.decls.has('box-shadow') ? r.selectors.filter((s) => /::after$/.test(s)) : []));
    for (const sel of own) assert.ok(outranks(spec(sel), spec(prelude)) > 0, `${sel} outranks the shared rim`);
  });

  test('the app switcher is one row of six from ui.css alone (shell.js needs no inline grid)', () => {
    const s = declsFor('.switcher');
    assert.equal(s.get('width'), '398px', 'six 62px tiles, their gaps and the padding');
    assert.equal(s.get('min-width'), '0', "and nothing wider: on a narrow phone the menu's max-width wins");
    assert.equal(declsFor('.switcher-grid').get('grid-template-columns'), 'repeat(6, minmax(0, 1fr))', 'Home, Tasks, Schedule, Notes, Photos and AI in one row');
  });

  test('the Today glyph draws no date number, in ui.css or in todayGlyph()', () => {
    assert.ok(!RULES.some((r) => r.selectors.some((s) => /\.today-glyph\b.*\bb$/.test(s))), 'no .today-glyph b rule is left');
    assert.doesNotMatch(fnBody('todayGlyph'), /<b>/, 'todayGlyph() draws the today glyph, not a font-drawn date');
  });
});

describe('ui.css: theme tokens that go with the logos', () => {
  const THEMES = { light: "[data-theme='light']", dark: "[data-theme='dark']", dim: "[data-theme='dim']" };
  const themeDecls = (sel) => new Map(TOP.filter((r) => r.selectors.includes(sel) && r.decls.has('--text-3')).flatMap((r) => [...r.decls]));

  test("a native select's chevron is drawn in each theme's --text-3, focused too", () => {
    for (const [name, sel] of Object.entries(THEMES)) {
      const d = themeDecls(sel);
      const text3 = (d.get('--text-3') || '').toLowerCase();
      assert.match(text3, /^#[0-9a-f]{6}$/, `${name} sets --text-3`);
      const arrow = d.get('--select-arrow') || '';
      assert.match(arrow, /^url\("data:image\/svg\+xml,.*"\)$/, `${name} sets --select-arrow`);
      assert.equal(/stroke='%23([0-9a-f]{6})'/i.exec(arrow)?.[1].toLowerCase(), text3.slice(1), `${name}: the chevron is ${text3}`);
    }
    for (const sel of ['select.input', 'select.input:focus']) {
      assert.equal(declsFor(sel).get('background-image'), 'var(--select-arrow)', `${sel} draws the theme's chevron (.input:focus's background shorthand would drop it)`);
    }
    assert.doesNotMatch(CSS, /8a8c99/i, 'no fixed grey chevron');
  });

  test("Yellow's hovered fill lightens away from its dark labels in Light, Dim and Lights out", () => {
    assert.equal(declsFor("[data-accent='yellow']").get('--on-accent'), '#1a1400', 'Yellow labels its fills in near-black');
    for (const theme of ['light', 'dark', 'dim']) {
      const sel = `[data-theme='${theme}'][data-accent='yellow']`;
      const hover = TOP.filter((r) => r.selectors.includes(sel) && r.decls.has('--accent-hover')).map((r) => r.decls.get('--accent-hover')).pop();
      assert.match(hover || '', /^color-mix\(in srgb, var\(--accent-fill\) \d+%, white\)$/, `${theme}: a hovered Yellow fill mixes toward white (got ${hover})`);
    }
    assert.match(declsFor(':root').get('--accent-hover') || '', /black\)$/, 'every other accent (white labels) deepens on hover');
  });
});
