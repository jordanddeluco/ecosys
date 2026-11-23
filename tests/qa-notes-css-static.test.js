// QA regression (notes/notes.css): static checks of the fixes for the Notes design and accessibility review.
// They read the stylesheets the way the browser uses them and state each rule:
//   - the AI colour (--n-ai) resolves in layers appended to <body> (version history tint, AI version glyph)
//   - highlight fills come from editor.css in every theme (notes.css no longer overrides them)
//   - print uses Light's colours whatever the theme, and those values stay in step with ui.css / editor.css
//   - rows brought into view stop below the sticky date header (and above the phone's bottom bar)
//   - the search chips are one sideways-scrolling row with edge fades, never four wrapped lines; a chip
//     scrolled into view (keyboard focus) stops with its focus ring clear of the fade
//   - the ten folder colours fit one row in the dialog; small dialogs are full-width sheets on phones
//   - Windows Contrast themes outline the open, picked and focused rows and cards, and keep marks readable
//   - text contrast: the Today tile's weekday, quiet text on an accent-tinted row
//   - the folder disclosure is a 24px target; the phone Quick Note head is an iOS sheet head
// The browser-side measurements are in tests/e2e/qa-notes-css-layout.test.mjs.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const NOTES = read('notes/notes.css');
const UI = read('shared/ui.css');
const EDITOR = read('notes/editor/editor.css');

/** Rules of a stylesheet: [{ prelude, body, children }] (children: the rules inside @media / @supports). */
function parse(css) {
  const out = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        prelude = css.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const body = css.slice(start, i);
        const p = prelude.replace(/\s+/g, ' ');
        out.push({ prelude: p, body, children: /^@(media|supports)\b/.test(p) ? parse(body) : [] });
        start = i + 1;
      }
    } else if (ch === ';' && depth === 0) {
      start = i + 1; // a statement at-rule (@import …;)
    }
  }
  return out;
}
/** Declarations of a rule body: Map(prop → value), the last one winning. */
function decls(body) {
  const m = new Map();
  let depth = 0;
  let cur = '';
  for (const ch of `${body};`) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) {
      const i = cur.indexOf(':');
      if (i > 0) m.set(cur.slice(0, i).trim(), cur.slice(i + 1).trim().replace(/\s+/g, ' '));
      cur = '';
    } else cur += ch;
  }
  return m;
}
const selectors = (r) => r.prelude.split(',').map((s) => s.trim());
/** Plain rules (not inside an at-rule) whose selector list contains `sel` exactly. */
const top = (css, sel) => parse(css).filter((r) => !r.prelude.startsWith('@') && selectors(r).includes(sel));
/** Rules inside at-rules whose prelude matches `at`. */
const inside = (css, at) => parse(css).filter((r) => at.test(r.prelude)).flatMap((r) => r.children);
const withSel = (rules, sel) => rules.filter((r) => selectors(r).includes(sel));
/** The value `prop` gets from the rules for `sel` (the last declaration wins). */
const valueOf = (rules, prop) => rules.map((r) => decls(r.body).get(prop)).filter((v) => v !== undefined).at(-1);
const px = (v) => {
  const s = String(v || '').trim();
  return /^-?[\d.]+px$/.test(s) ? parseFloat(s) : s === '0' ? 0 : NaN;
};
const norm = (v) => String(v || '').replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / ').trim().toLowerCase();

describe('notes.css (QA fixes)', () => {
  test('--n-ai is on :root, so layers appended to <body> (version history, Quick Note, sheets) get the AI colour', () => {
    const root = top(NOTES, ':root');
    assert.equal(valueOf(root, '--n-ai'), 'var(--c-purple)', ':root declares --n-ai: var(--c-purple)');
    assert.equal(valueOf(top(NOTES, '.nshell'), '--n-ai'), undefined, '.nshell must not re-declare --n-ai (one source)');
    // the users of the token that live outside .nshell
    for (const sel of ['.s-changed', '.n-hrow .i']) assert.match(valueOf(top(NOTES, sel), sel === '.s-changed' ? 'background' : 'color'), /var\(--n-ai\)/, `${sel} uses --n-ai`);
    // text in the AI colour takes the deeper shade (Light's purple is 4.4:1 on white, 4.1:1 on the sidebar)
    assert.match(valueOf(root, '--n-ai-text') || '', /^color-mix\(in srgb, var\(--n-ai\) \d+%, var\(--text\)\)$/, ':root declares --n-ai-text');
    for (const sel of ['.n-ai-item .badge', '.n-cap-ai']) assert.equal(valueOf(top(NOTES, sel), 'color'), 'var(--n-ai-text)', `${sel} is text: it uses --n-ai-text`);
  });

  test('highlight fills follow the theme: notes.css leaves the --hl-* tokens to editor.css', () => {
    for (const r of parse(NOTES).filter((x) => !x.prelude.startsWith('@'))) {
      for (const prop of decls(r.body).keys()) assert.ok(!/^--hl-/.test(prop), `${r.prelude} declares ${prop}, overriding editor.css's light/dark two-tones`);
    }
    const dark = parse(EDITOR).find((r) => selectors(r).includes("[data-theme='dark']") && selectors(r).includes("[data-theme='dim']"));
    assert.ok(dark && decls(dark.body).has('--hl-mint-bg'), 'editor.css still defines the dark/dim highlight fills');
  });

  test('print restores Light: accent text, highlights, danger, AI purple, in step with ui.css and editor.css', () => {
    const print = inside(NOTES, /^@media print/);
    const root = withSel(print, ':root[data-theme]');
    assert.ok(root.length, '@media print has a :root[data-theme] rule');
    const p = decls(root.map((r) => r.body).join(';'));
    // the light values to mirror
    const light = decls(parse(UI).filter((r) => selectors(r).includes(':root') && (selectors(r).includes("[data-theme='light']") || /--accent-text/.test(r.body))).map((r) => r.body).join(';'));
    const edLight = decls(top(EDITOR, ':root').map((r) => r.body).join(';'));
    const own = new Set(['color-scheme', '--bg', '--bg-side', '--surface-1', '--surface-2', '--surface-3', '--text', '--text-2', '--text-3', '--text-4', '--fill', '--separator', '--border']);
    const needed = ['--accent-text', '--danger-text', '--tone-overdue', '--c-purple', '--ne-code-bg', ...['purple', 'pink', 'orange', 'mint', 'blue'].flatMap((h) => [`--hl-${h}-fg`, `--hl-${h}-bg`])];
    for (const t of needed) assert.ok(p.has(t), `@media print resets ${t} (it prints pale from Dim and Lights out otherwise)`);
    for (const [t, v] of p) {
      if (own.has(t)) continue;
      const want = light.get(t) ?? edLight.get(t);
      assert.ok(want !== undefined, `${t} in the print block has no Light value in ui.css / editor.css to mirror`);
      assert.equal(norm(v), norm(want), `print ${t} is "${v}" but Light's is "${want}"`);
    }
    // per-accent shades: the text shades Light uses, and Light's Iris / Violet (the dark themes brighten them)
    const accentRule = (css, a) => decls(parse(css).filter((r) => selectors(r).includes(`[data-accent='${a}']`)).map((r) => r.body).join(';'));
    for (const a of ['blue', 'pink', 'orange', 'green', 'yellow']) {
      const pr = decls(withSel(print, `:root[data-theme][data-accent='${a}']`).map((r) => r.body).join(';'));
      assert.equal(norm(pr.get('--accent-text')), norm(accentRule(UI, a).get('--accent-text')), `print ${a}: --accent-text matches Light's`);
    }
    for (const a of ['iris', 'violet']) {
      const pr = decls(withSel(print, `:root[data-theme][data-accent='${a}']`).map((r) => r.body).join(';'));
      assert.equal(norm(pr.get('--accent')), norm(accentRule(UI, a).get('--accent')), `print ${a}: --accent is Light's`);
    }
    const yellowFill = decls(parse(UI).filter((r) => selectors(r).includes("[data-theme='light'][data-accent='yellow']")).map((r) => r.body).join(';')).get('--accent-fill');
    const prYellow = decls(withSel(print, ":root[data-theme][data-accent='yellow']").map((r) => r.body).join(';'));
    assert.equal(norm(prYellow.get('--accent-fill')), norm(yellowFill), "print yellow: --accent-fill is Light's deeper gold");
    // nothing on-screen-only prints
    const hidden = withSel(print, '.n-quick-scrim');
    assert.ok(hidden.some((r) => /display:\s*none/.test(r.body)), 'the Quick Note scrim is hidden in print');
  });

  test('rows brought into view clear the sticky date header (and the phone bottom bar)', () => {
    const group = top(NOTES, '.ngroup');
    const h = px(valueOf(group, 'height'));
    const mt = px(valueOf(group, 'margin-top')) || 0;
    assert.ok(h > 0, '.ngroup has a fixed height');
    const pad = px(valueOf(top(NOTES, '.n-list'), 'scroll-padding-top'));
    assert.ok(pad >= h + mt, `.n-list scroll-padding-top (${pad}px) covers the sticky .ngroup (${h}px + ${mt}px margin)`);
    const phone = top(NOTES, ".nshell[data-cols='1'] .n-list");
    assert.match(valueOf(phone, 'scroll-padding-bottom') || '', /\d+px/, 'phone list: scroll-padding-bottom keeps rows above the floating search bar');
  });

  test('search chips are one sideways-scrolling row with edge fades on every screen', () => {
    for (const r of parse(NOTES)) {
      const all = r.prelude.startsWith('@') ? r.children : [r];
      for (const x of all) if (selectors(x).some((s) => /\.n-schips$/.test(s))) assert.ok(!/flex-wrap:\s*wrap/.test(x.body), `${x.prelude} wraps the chips (four lines, ~160px, on desktop)`);
    }
    const base = top(NOTES, '.n-schips');
    assert.equal(valueOf(base, 'overflow-x'), 'auto');
    // A chip scrolled into view (keyboard focus) stops with its focus ring clear of the edge fade.
    const kf = parse(NOTES).find((r) => r.prelude === '@keyframes n-edge-fade');
    const fadeLen = Math.max(...[...(kf?.body || '').matchAll(/--n-fade-[se]:\s*([\d.]+)px/g)].map((m) => Number(m[1])));
    const ring = decls(top(UI, ':focus-visible').map((r) => r.body).join(';'));
    const ringOut = px(String(ring.get('outline') || '').split(' ')[0]) + px(ring.get('outline-offset'));
    assert.ok(fadeLen > 0 && ringOut > 0, `the fade (${fadeLen}px) and the focus ring (${ringOut}px) are read from the stylesheets`);
    const pad = px(valueOf(base, 'scroll-padding-inline'));
    assert.ok(pad >= fadeLen + ringOut, `.n-schips scroll-padding-inline (${pad}px) covers the ${fadeLen}px fade and the ${ringOut}px focus ring`);
    const fade = inside(NOTES, /^@supports \(animation-timeline: scroll\(\)\)/);
    const f = decls(withSel(fade, '.n-schips').map((r) => r.body).join(';'));
    assert.match(f.get('mask-image') || '', /var\(--n-fade-s\).*var\(--n-fade-e\)/, 'the mask fades each edge by its own scroll-driven length');
    assert.match(f.get('animation-timeline') || '', /scroll\(self inline\)/);
    assert.match(NOTES, /@property --n-fade-s\s*\{[^}]*initial-value:\s*0px/, '--n-fade-s is registered (0px: no fade when nothing is scrolled out)');
    assert.match(NOTES, /@property --n-fade-e\s*\{[^}]*initial-value:\s*0px/);
  });

  test('the ten folder colours fit one row in the 400px dialog, five per row on the narrowest phones', () => {
    const c = top(NOTES, '.n-colors');
    assert.equal(valueOf(c, 'display'), 'grid');
    assert.match(valueOf(c, 'grid-template-columns'), /repeat\(10, 28px\)/);
    // the dialog body: min(400px, …) minus 2 × 20px padding, minus the 2 × 2px row padding
    assert.ok(10 * 28 + 9 * 6 <= 400 - 40 - 4, 'ten 28px swatches with at least 6px between them fit the dialog');
    const narrow = parse(NOTES).filter((r) => /^@media \(max-width: 379px\)/.test(r.prelude)).flatMap((r) => r.children);
    assert.match(valueOf(withSel(narrow, '.n-colors'), 'grid-template-columns') || '', /repeat\(5, 28px\)/, 'under 380px: two rows of five');
    const phone = parse(NOTES).filter((r) => /^@media \(max-width: 640px\)/.test(r.prelude)).flatMap((r) => r.children);
    for (const sel of ['.n-smallmodal', '.n-sendmodal', '.n-histmodal']) assert.equal(valueOf(withSel(phone, sel), 'width'), '100%', `${sel} is a full-width sheet on phones`);
  });

  test('Windows Contrast themes: open, picked and focused rows and cards are outlined; marks stay readable', () => {
    const fc = inside(NOTES, /^@media \(forced-colors: active\)/);
    const outline = (sel) => valueOf(withSel(fc, sel), 'outline') || '';
    for (const sel of ['.nrow:focus-visible', '.ncard:focus-visible .ncard-page', ".n-hrow[aria-selected='true']", ".n-schip[aria-pressed='true']", '.n-search:focus-within']) {
      assert.match(outline(sel), /2px solid Highlight/, `${sel} gets a Highlight outline`);
    }
    for (const sel of ['.nrow.open', '.nrow.picked', '.ncard.open .ncard-page']) assert.match(outline(sel), /solid CanvasText/, `${sel} gets a CanvasText outline`);
    for (const sel of ['.nrow-title mark', '.s-hl']) {
      const d = decls(withSel(fc, sel).map((r) => r.body).join(';'));
      assert.equal(d.get('forced-color-adjust'), 'none', `${sel} keeps its own colours`);
      assert.equal(d.get('background'), 'Mark', `${sel} uses the system Mark colour`);
    }
    assert.match(outline('.s-changed'), /dashed/, 'a changed block in Version history is outlined (its tint is dropped)');
  });

  test('text contrast: the Today tile weekday and quiet text on accent-tinted rows', () => {
    assert.equal(valueOf(top(NOTES, '.dh-wd'), 'color'), 'var(--danger-text)', '.dh-wd: --now is 3.6:1 at 10px; --danger-text is 4.5:1+');
    for (const sel of ['.n-list:focus-within .nrow.open', '.nrow.n-draft', '.nrow.picked']) {
      assert.equal(valueOf(top(NOTES, sel), '--text-3'), 'var(--text-2)', `${sel}: --text-3 steps up to --text-2 on the accent tint`);
    }
    assert.equal(valueOf(top(NOTES, ".nshell[data-cols='1'] .nrow.open"), '--text-3'), 'inherit', 'phone: the untinted open row keeps the normal quiet text');
  });

  test('the folder disclosure is a 24px target, and the phone Quick Note head is an iOS sheet head', () => {
    const w = px(valueOf(top(NOTES, '.n-disclose'), 'width'));
    const before = top(NOTES, '.n-disclose::before');
    const reach = -px(valueOf(before, 'left'));
    assert.equal(valueOf(top(NOTES, '.n-disclose'), 'position'), 'relative');
    assert.ok(w + reach >= 24, `desktop: ${w}px + ${reach}px reach ≥ 24px (WCAG 2.5.8)`);
    assert.equal(px(valueOf(before, 'right')), 0, 'the reach never covers the folder link on its right');
    const phone = top(NOTES, ".nshell[data-cols='1'] .n-disclose");
    assert.ok(px(valueOf(phone, 'width')) >= 24 && px(valueOf(phone, 'height')) >= 44, 'phone: the disclosure is 24px wide and the full row tall');

    const q = parse(NOTES).filter((r) => /^@media \(max-width: 699px\)/.test(r.prelude)).flatMap((r) => r.children);
    assert.equal(valueOf(withSel(q, '.n-quick-head'), 'display'), 'grid', 'phone: the Quick Note head is a grid, not a wrapping row');
    assert.match(valueOf(withSel(q, ".n-quick-head > [data-quick='done']"), 'grid-area') || '', /^1 \/ 3$/, 'Done sits top right');
    assert.match(valueOf(withSel(q, ".n-quick-head > [data-quick='open']"), 'grid-area') || '', /^1 \/ 1$/, 'Open in Notes sits top left');
    assert.match(valueOf(withSel(q, '.n-quick-head > .segmented'), 'grid-area') || '', /^2 \/ 1 \/ 3 \/ -1$/, 'the destination control spans the second row');
    assert.equal(valueOf(withSel(q, '.n-quick > .grabber'), 'display'), 'block', 'phone: the sheet shows its grabber');
    const scrimZ = Number(valueOf(top(NOTES, '.n-quick-scrim'), 'z-index'));
    const sheetZ = Number(valueOf(top(NOTES, '.n-quick'), 'z-index'));
    assert.ok(scrimZ < sheetZ, `the scrim (${scrimZ}) sits under the sheet (${sheetZ})`);
    assert.equal(valueOf(top(NOTES, '.n-quick-scrim'), 'display'), 'none', 'desktop: Quick Note floats and dims nothing');
    assert.equal(valueOf(withSel(q, '.n-quick-scrim'), 'display'), 'block', 'phone: the scrim shows');
  });
});
