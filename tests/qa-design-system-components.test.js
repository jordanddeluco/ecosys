// QA regression (design system, shared/ui.css): the shared components other apps asked for, and the contract
// between shell.js and ui.css behind them. On phones the date, time and repeat pickers are bottom sheets:
// shell.js adds .as-sheet below the width ui.css lays it out at, and since place() keeps writing a popover's
// position inline, the sheet rule overrides every one of those inline styles. A punctuation key keeps its
// keycap in a menu hint (where other keycaps are plain text), a small circle takes a near miss on a touch
// screen, the primary sidebar action is one shared pill, and empty-state text has no one-word last line.
// The browser side is in tests/e2e/qa-design-system-components.test.mjs. Run with: npm test
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
  const stack = []; // { prelude, body } for every open block
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
/** The rules naming this exact selector (optionally only those inside an at-rule matching `at`). */
const rulesFor = (selector, at) => RULES.filter((r) => r.selectors.includes(selector) && (at === undefined ? true : at === null ? !r.at.length : r.at.some((a) => at.test(a))));
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** The body of a top-level function in shell.js (up to the first line that is just "}"). */
function fnBody(name) {
  const at = SHELL.search(new RegExp(`\\nfunction ${name}\\(|\\nexport function ${name}\\(`));
  assert.ok(at >= 0, `shell.js has ${name}()`);
  const end = SHELL.indexOf('\n}\n', at);
  return SHELL.slice(at, end);
}

describe('ui.css: phone sheets for the pickers (with shell.js)', () => {
  const phoneMq = /\(max-width:\s*640px\)/;

  test("shell.js and ui.css agree on when a picker is a sheet (640px and below)", () => {
    const m = /const phoneLayout = \(\) => matchMedia\('([^']+)'\)/.exec(SHELL);
    assert.ok(m, 'shell.js decides with a phoneLayout() media query');
    assert.match(m[1], phoneMq, 'shell.js adds .as-sheet at 640px and below');
    assert.match(SHELL, /asSheet \? ' as-sheet' : ''/, "openPopover() marks a sheet with the class 'as-sheet'");
    const sheet = rulesFor('.menu.as-sheet');
    assert.ok(sheet.length, 'ui.css lays out .menu.as-sheet');
    for (const r of sheet) assert.ok(r.at.some((a) => phoneMq.test(a)), `.menu.as-sheet only applies in the same phone range (found in: ${r.at.join(' ') || 'top level'})`);
  });

  test('the sheet overrides every inline style place() and openPopover() write, and sits along the bottom edge', () => {
    const inline = new Set();
    for (const body of [fnBody('place'), fnBody('openPopover')]) for (const m of body.matchAll(/\bel\.style\.(\w+)\s*=/g)) inline.add(kebab(m[1]));
    assert.ok(inline.has('left') && inline.has('top'), `place() positions the popover inline (found ${[...inline].join(', ')})`);
    const decls = new Map(rulesFor('.menu.as-sheet', /\(max-width:\s*640px\)/).flatMap((r) => [...r.decls]));
    for (const prop of inline) assert.match(decls.get(prop) || '', /!important\s*$/, `.menu.as-sheet sets ${prop} with !important (place() writes it inline)`);
    assert.match(decls.get('left'), /^0(px)?\b/, 'from the left edge');
    assert.match(decls.get('right') || '', /^0(px)?$/, 'to the right edge');
    assert.match(decls.get('top'), /^auto\b/, 'not at the inline top');
    assert.match(decls.get('bottom') || '', /^0(px)?$/, 'along the bottom edge');
    assert.equal(decls.get('width'), '100%', 'the width of the screen');
    assert.equal(decls.get('max-width'), 'none', "not capped at a popover's width");
    assert.match(decls.get('padding') || '', /safe-area-inset-bottom/, 'clear of the home indicator');
    assert.match(decls.get('animation') || '', /\bsheet-up\b/, 'slides up as the other sheets do');
  });

  test('rows, days and fields in a sheet are sized for touch, and fields do not make iOS zoom in', () => {
    const px = (sel, prop) => {
      const v = rulesFor(sel, /\(max-width:\s*640px\)/).map((r) => r.decls.get(prop)).find(Boolean);
      assert.ok(v, `${sel} sets ${prop} in the phone range`);
      return parseFloat(v);
    };
    assert.ok(px('.as-sheet .menu-item', 'min-height') >= 44, 'menu rows are 44px+');
    assert.ok(px('.as-sheet .tp-row', 'min-height') >= 44, 'time rows are 44px+');
    assert.ok(px('.as-sheet .menu-item', 'font-size') >= 16, 'row text 16px+');
    assert.ok(px('.as-sheet .dp-type .input', 'font-size') >= 16, "the date field's text is 16px+ (iOS zooms into smaller fields)");
    assert.ok(px('.as-sheet .tp-type .input', 'font-size') >= 16, "the time field's text is 16px+");
    assert.ok(px('.as-sheet .mc-day', 'height') >= 40, 'calendar days are 40px+ tall');
    assert.ok(px('.as-sheet .mc-day span', 'width') >= 36, 'and their circles 36px+');
  });
});

describe('ui.css: shared components', () => {
  test('a punctuation key keeps its keycap in a menu hint (shell.js marks it .kbd-punct)', () => {
    assert.match(fnBody('keycap'), /kbd-punct/, 'keycap() marks a lone punctuation mark');
    const plain = rulesFor('.menu-item .hint .kbd', null);
    assert.ok(plain.some((r) => r.decls.get('background') === 'none'), 'menu hints draw keycaps as plain text');
    const cap = rulesFor('.menu-item .hint .kbd.kbd-punct', null);
    assert.equal(cap.length, 1, 'one rule gives a punctuation key its cap back (more specific than the plain-text rule)');
    const d = cap[0].decls;
    assert.match(d.get('background') || '', /var\(--fill\)/, 'with the keycap fill');
    assert.ok(parseFloat(d.get('min-width')) >= 18 && parseFloat(d.get('height')) >= 18, 'and a cap-sized box');
  });

  test('a small circle takes taps around it on a touch screen only', () => {
    assert.ok(rulesFor('.check', null).some((r) => r.decls.get('position') === 'relative'), '.check is the containing block of its hit area');
    const hit = rulesFor('.check.sm::before');
    assert.ok(hit.length, '.check.sm::before is drawn');
    for (const r of hit) assert.ok(r.at.some((a) => /\(pointer:\s*coarse\)/.test(a)), 'only for a coarse pointer (a mouse keeps the drawn size)');
    const d = new Map(hit.flatMap((r) => [...r.decls]));
    assert.equal(d.get('position'), 'absolute');
    assert.ok(parseFloat(d.get('inset')) <= -6, 'at least 6px around the circle');
    assert.ok(d.has('content'), 'with content, so it exists');
  });

  test('the primary sidebar action is one shared pill, defined in ui.css', () => {
    for (const sel of ['.create-wrap', '.create-btn', '.create-btn:hover', '.create-btn:active', '.create-btn .i', "[data-theme='dark'] .create-btn"]) {
      assert.ok(rulesFor(sel, null).length, `ui.css defines ${sel} for every app`);
    }
    const btn = new Map(rulesFor('.create-btn', null).flatMap((r) => [...r.decls]));
    assert.equal(btn.get('border-radius'), 'var(--r-pill)', 'a pill');
    assert.equal(btn.get('height'), '44px', 'a 44px target');
  });

  test("empty-state text has no one-word last line", () => {
    assert.ok(rulesFor('.empty p', null).some((r) => r.decls.get('text-wrap') === 'balance'), '.empty p { text-wrap: balance }');
  });
});
