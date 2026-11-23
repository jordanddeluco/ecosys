// QA (design review of Notes): static checks that pin open design bugs found in the browser review.
// Each test is a `todo` until its fix lands: it reads the CSS / JS the way the browser would use it and
// states the rule the fix has to meet. Run with: npm test
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const NOTES_CSS = read('notes/notes.css');
const EDITOR_CSS = read('notes/editor/editor.css');
const EDITOR_JS = readFileSync(new URL('../notes/editor/index.js', import.meta.url), 'utf8');
const APP_JS = readFileSync(new URL('../notes/app.js', import.meta.url), 'utf8');

/** Top-level rules of a stylesheet (at-rule blocks are returned whole as one rule): [{ prelude, body }]. */
function rules(css) {
  const out = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth === 0) {
        prelude = css.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        out.push({ prelude, body: css.slice(start, i) });
        start = i + 1;
      }
    }
  }
  return out;
}
const declares = (body, prop) => new RegExp(`(^|[;{\\s])${prop.replace(/[-]/g, '\\-')}\\s*:`).test(body);
const ruleFor = (css, selectorPart) => rules(css).filter((r) => !r.prelude.startsWith('@') && r.prelude.split(',').some((s) => s.trim() === selectorPart));

describe('notes design (QA)', () => {
  test('layers appended to <body> (version history, quick note, info sheet) can resolve --n-ai', { todo: 'Version history never tints changed blocks: --n-ai is defined only on .nshell' }, () => {
    // .s-changed (history diff), .n-hrow .i (AI version glyph) are rendered inside modals appended to <body>,
    // outside .nshell, so --n-ai must be declared on :root (or html), not only on .nshell.
    const rootRules = rules(NOTES_CSS).filter((r) => !r.prelude.startsWith('@') && r.prelude.split(',').some((s) => /^(:root|html)(\[[^\]]+\])*$/.test(s.trim())));
    assert.ok(rootRules.some((r) => declares(r.body, '--n-ai')), 'notes.css declares --n-ai only on .nshell; modals on <body> get no colour');
  });

  test('highlight fills follow the theme (editor.css per-theme tokens are not overridden)', { todo: 'Highlights in Dim and Lights out lose their designed fills (notes.css .nshell overrides editor.css)' }, () => {
    const shell = ruleFor(NOTES_CSS, '.nshell');
    for (const hl of ['purple', 'pink', 'orange', 'mint', 'blue']) {
      assert.ok(!shell.some((r) => declares(r.body, `--hl-${hl}-bg`)), `.nshell re-declares --hl-${hl}-bg for every theme, overriding editor.css's dark/dim values`);
    }
  });

  test('checked circles and picked rows fill with --accent-fill under --on-accent, like Tasks', { todo: 'Checked checklist circles and selection ticks use --accent / #fff instead of --accent-fill / --on-accent' }, () => {
    const ring = rules(EDITOR_CSS).find((r) => r.prelude.includes(".ne-b[data-checked='true'] .ne-ck-ring"));
    assert.ok(ring && /var\(--accent-fill\)/.test(ring.body), 'editor.css: the checked circle fills with --accent (2.8:1 under a white tick with orange, 3.0:1 with blue)');
    const pick = rules(NOTES_CSS).find((r) => r.prelude.includes(".nrow-pick[aria-checked='true']"));
    assert.ok(pick && /var\(--accent-fill\)/.test(pick.body) && !/#fff\b/i.test(pick.body), 'notes.css: a picked row draws a white tick on --accent (1.9:1 with yellow)');
  });

  test('print turns dark-theme colours back into paper colours', { todo: 'Printing from Dim or Lights out prints highlights, links and tags in pale dark-theme colours' }, () => {
    const print = rules(NOTES_CSS).filter((r) => /^@media\s+print/.test(r.prelude)).map((r) => r.body).join('\n');
    assert.ok(/--accent-text\s*:/.test(print), '@media print does not reset --accent-text (links, tags, chips print pale)');
    assert.ok(/--hl-[a-z]+-fg\s*:/.test(print), '@media print does not reset the --hl-*-fg tokens (highlighted words print pale on white)');
  });

  test('the open row is never scrolled under the sticky date header', { todo: 'J/K and arrow keys hide the open row under the sticky date-group header' }, () => {
    const list = ruleFor(NOTES_CSS, '.n-list');
    const pad = list.map((r) => /scroll-padding(?:-top)?\s*:\s*(\d+)px/.exec(r.body)?.[1]).find(Boolean);
    assert.ok(Number(pad) >= 34, '.n-list needs scroll-padding-top ≥ the 34px sticky .ngroup header');
  });

  test('chips never break between their glyph and their label', { todo: 'Note, task, event and date chips wrap mid-chip (bar or icon stranded at the end of a line)' }, () => {
    const chip = ruleFor(EDITOR_CSS, '.ne-chip');
    assert.ok(chip.some((r) => /white-space\s*:\s*nowrap|box-decoration-break\s*:\s*clone/.test(r.body)), '.ne-chip has neither white-space: nowrap nor box-decoration-break: clone');
  });

  test('closing an editor with the keyboard bar up clears the phone shell’s kb-up state', { todo: 'Phone: the note bottom bar disappears for good after leaving a note while typing' }, () => {
    const destroy = EDITOR_JS.slice(EDITOR_JS.indexOf('  destroy() {'), EDITOR_JS.indexOf('/** True when two docs differ only in the cached labels of chips. */'));
    const tellsApp = /editor:accessory/.test(destroy);
    const appClears = /classList\.(remove\(\s*['"]kb-up['"]|toggle\(\s*['"]kb-up['"]\s*,\s*false)/.test(APP_JS);
    assert.ok(tellsApp || appClears, 'destroy() hides the accessory bar without dispatching editor:accessory {visible:false}, and app.js never clears .kb-up');
  });

  test('@ date suggestions stay open while a day or month name is being typed', { todo: '@fri never offers Friday: the date list closes on the first letter of most day and month names' }, () => {
    const src = /const DATE_WORDS = (\/.*\/[a-z]*);/.exec(EDITOR_JS)?.[1];
    assert.ok(src, 'DATE_WORDS not found');
    const DATE_WORDS = new Function(`return ${src}`)();
    const base = ['today', 'tomorrow', 'next monday'];
    const words = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const closes = [];
    for (const w of words) {
      for (let n = 1; n <= w.length; n++) {
        const q = w.slice(0, n);
        const kept = base.some((b) => b.startsWith(q) || b.includes(` ${q}`)) || DATE_WORDS.test(q);
        if (!kept) closes.push(q);
      }
    }
    assert.deepEqual([...new Set(closes)], [], 'typing these after @ closes the list before the name is complete');
  });
});
