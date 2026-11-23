// QA regression (design system, shared/ui.css): how the pickers sit. On a phone a sheet opened from a sheet (the
// date sheet's Time row) brings a scrim that covers and dims the sheet beneath, so a tap on that sheet's visible top
// can't pick from it; shell.js writes every sheet scrim's z-index inline, so the stacking rule beats it. On a desktop
// the date picker is a panel, not a list: it shows all of itself (about 580px at most) instead of a menu's 520px. In a
// menu hint a punctuation key keeps its keycap only as the whole shortcut; inside a chord it is plain text.
// The browser side is in tests/e2e/qa-design-system-pickers.test.mjs. Run with: npm test
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const CSS = read('shared/ui.css');
const SHELL = read('shared/shell.js');

/** Style rules with the at-rules around them: [{ selectors: string[], at: string[], decls: Map<prop, value> }]. */
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
        rules.push({ selectors: b.prelude.split(',').map((s) => s.replace(/\s+/g, ' ').trim()), at: stack.map((s) => s.prelude.replace(/\s+/g, ' ')), decls });
      }
      start = i + 1;
    }
  }
  return rules;
}
const RULES = parseCss(CSS);
const PHONE = /\(max-width:\s*640px\)/;
/** Declarations of the rules naming exactly `selector`: top level (at = null) or inside an at-rule matching `at`. */
function declsFor(selector, at) {
  const rules = RULES.filter((r) => r.selectors.includes(selector) && (at === null ? !r.at.length : r.at.some((a) => at.test(a))));
  assert.ok(rules.length, `ui.css has a rule for ${selector}${at ? ` inside ${at}` : ' at the top level'}`);
  return new Map(rules.flatMap((r) => [...r.decls]));
}
/** The body of a top-level function in shell.js (up to the first line that is just "}"). */
function fnBody(name) {
  const at = SHELL.search(new RegExp(`\\nfunction ${name}\\(|\\nexport function ${name}\\(`));
  assert.ok(at >= 0, `shell.js has ${name}()`);
  return SHELL.slice(at, SHELL.indexOf('\n}\n', at));
}
const zOf = (v) => {
  const m = /^(\d+)\s*(!important)?$/.exec(v || '');
  assert.ok(m, `a plain z-index (got ${JSON.stringify(v)})`);
  return { z: +m[1], important: !!m[2] };
};

describe('ui.css: a sheet opened from a sheet (phones)', () => {
  test("shell.js appends a sheet's scrim just before the sheet, with z-index 69 written inline", () => {
    const body = fnBody('openPopover');
    assert.match(body, /scrim\.className = 'scrim pop-scrim'/, 'a sheet comes with a .pop-scrim');
    const z = /scrim\.style\.zIndex = '(\d+)'/.exec(body);
    assert.ok(z, "openPopover() writes the scrim's z-index inline");
    assert.equal(+z[1], 69, 'one sheet: its scrim under the menus (70)');
    const scrimAt = body.indexOf('document.body.append(scrim)');
    const sheetAt = body.indexOf('document.body.append(el)');
    assert.ok(scrimAt >= 0 && sheetAt > scrimAt, 'the scrim goes into <body> first, so a second sheet\'s scrim follows the first sheet');
  });

  test('the second scrim covers the sheet beneath, the second sheet covers its scrim, and one sheet keeps 69 and 70', () => {
    const menuZ = zOf(declsFor('.menu', null).get('z-index')).z;
    const inline = +/scrim\.style\.zIndex = '(\d+)'/.exec(fnBody('openPopover'))[1];
    assert.ok(inline < menuZ, `a lone scrim (${inline}) stays under its sheet (${menuZ})`);
    const scrim = zOf(declsFor('.menu.as-sheet ~ .pop-scrim', PHONE).get('z-index'));
    assert.ok(scrim.important, "!important: the scrim's z-index is written inline");
    assert.ok(scrim.z > menuZ, `a scrim after a sheet (${scrim.z}) is above that sheet (${menuZ})`);
    const top = zOf(declsFor('.menu.as-sheet ~ .pop-scrim ~ .menu.as-sheet', PHONE).get('z-index'));
    assert.ok(top.z > scrim.z, `and the sheet over it (${top.z}) is above that scrim (${scrim.z})`);
    for (const r of RULES.filter((x) => x.selectors.some((s) => s.includes('.as-sheet ~')))) {
      assert.ok(r.at.some((a) => PHONE.test(a)), 'stacked sheets only exist where pickers are sheets (640px and below)');
    }
    assert.ok(top.z < zOf(declsFor('.toasts', null).get('z-index')).z, 'toasts stay above every picker');
  });
});

describe('ui.css: the date picker on a desktop', () => {
  test("is a panel that place() never shrinks, so CSS lets it be as tall as it is (not a menu's 520px)", () => {
    const list = /const list = !!el\.querySelector\('([^']+)'\)/.exec(fnBody('place'));
    assert.ok(list, 'place() tells lists from panels');
    const picker = fnBody('openDatePicker') + read('shared/minical.js');
    for (const role of list[1].split(',').map((s) => /\[role="(\w+)"\]/.exec(s)?.[1])) {
      assert.ok(role, `place() looks for a role (${list[1]})`);
      assert.ok(!picker.includes(`role="${role}"`), `the date picker has no ${role} role, so place() leaves its height to CSS`);
    }
    const menuCap = declsFor('.menu', null).get('max-height');
    assert.match(menuCap, /520px/, 'menus are capped at 520px');
    const cap = declsFor('.menu.dp-pop', null).get('max-height');
    assert.ok(cap, '.menu.dp-pop sets its own max-height');
    const px = /min\(\s*(\d+)px/.exec(cap);
    if (px) assert.ok(+px[1] >= 580, `its cap (${cap}) clears the tallest picker: a six-week month with Later this week, Time and No date (579px)`);
    else assert.match(cap, /^calc\(100d?vh - \d+px\)$/, `its cap (${cap}) is the window`);
  });

  test('on a phone the sheet rule still sets the height (88dvh, over the inline styles)', () => {
    assert.match(declsFor('.menu.as-sheet', PHONE).get('max-height') || '', /^\d+dvh !important$/);
  });
});

describe('ui.css: punctuation keycaps in menu hints', () => {
  test('a lone punctuation key keeps its cap', () => {
    const d = declsFor('.menu-item .hint .kbd.kbd-punct', null);
    assert.match(d.get('background') || '', /var\(--fill\)/);
    assert.ok(parseFloat(d.get('height')) >= 18);
  });

  test('inside a chord (after a modifier or its "+") it is plain text like the keys around it', () => {
    const plain = declsFor('.menu-item .hint .kbd', null);
    assert.equal(plain.get('background'), 'none', 'menu hints draw keycaps as plain text');
    for (const sel of ['.menu-item .hint .kbd + .kbd.kbd-punct', '.menu-item .hint .kbd-plus + .kbd.kbd-punct']) {
      const d = declsFor(sel, null);
      assert.equal(d.get('background'), 'none', `${sel}: no fill`);
      assert.equal(d.get('min-width'), '0', `${sel}: no cap width`);
      assert.equal(d.get('height'), 'auto', `${sel}: no cap height`);
      assert.equal(d.get('padding'), '0', `${sel}: no cap padding`);
      assert.equal(d.get('color'), plain.get('color'), `${sel}: the hint's colour, as its neighbours`);
    }
    const keys = fnBody('keys');
    assert.match(keys, /kbd-plus/, 'keys() puts a "+" between a modifier and the next key (outside macOS)');
    assert.match(keys, /keycap\(tok\)/, 'and draws each key with keycap(), the one that marks .kbd-punct');
  });
});
