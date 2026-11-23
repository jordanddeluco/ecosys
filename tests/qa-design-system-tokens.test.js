// QA regression (design system): the colour tokens in shared/ui.css meet WCAG AA in every theme and accent.
// The test reads ui.css itself, applies its top-level token rules to <html data-theme data-accent> the way
// the cascade does (specificity, then order), resolves var() and color-mix(in srgb …), and measures contrast
// against the theme's surfaces, hovered and highlighted menu rows included (with the tokens those rows
// redeclare). Run with: npm test
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../shared/ui.css', import.meta.url), 'utf8');
const THEMES = ['light', 'dim', 'dark'];
const ACCENTS = ['iris', 'blue', 'violet', 'pink', 'orange', 'green', 'yellow'];
const SURFACES = ['--bg', '--bg-side', '--surface-1', '--surface-2', '--surface-3'];

// ---------------------------------------------------------------- a tiny cascade for the root element

/** Top-level style rules (rules inside @media and other at-rules are left out): [{ selectors, decls, order }]. */
function topLevelRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') {
      if (depth === 0) {
        prelude = src.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        if (!prelude.startsWith('@')) {
          const decls = [...src.slice(start, i).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()]);
          if (decls.length) rules.push({ selectors: prelude.split(',').map((s) => s.trim()), decls, order: rules.length });
        }
        start = i + 1;
      }
    }
  }
  return rules;
}

/** Specificity (as one number) of a compound selector if it matches <html> with these attributes, else -1. */
function matchRoot(selector, attrs) {
  if (/[\s>+~.#]/.test(selector.replace(/\[[^\]]*\]/g, ''))) return -1; // combinators, classes, ids: not the root
  let spec = 0;
  let rest = selector;
  const attrMatches = (name, value) => attrs[name] === value;
  for (;;) {
    let m;
    if ((m = /^:root/.exec(rest))) spec += 10;
    else if ((m = /^html/.exec(rest))) spec += 1;
    else if ((m = /^\[([\w-]+)=['"]?([^'"\]]*)['"]?\]/.exec(rest))) {
      if (!attrMatches(m[1], m[2])) return -1;
      spec += 10;
    } else if ((m = /^:not\(\[([\w-]+)=['"]?([^'"\]]*)['"]?\]\)/.exec(rest))) {
      if (attrMatches(m[1], m[2])) return -1;
      spec += 10;
    } else if (!rest) return spec;
    else return -1;
    rest = rest.slice(m[0].length);
  }
}

const RULES = topLevelRules(CSS);

/** The declarations that win for `match(selector) → specificity | -1`: name → raw value. */
function cascade(match) {
  const won = new Map(); // name → { spec, order, value }
  for (const r of RULES) {
    const spec = Math.max(...r.selectors.map(match));
    if (spec < 0) continue;
    for (const [name, value] of r.decls) {
      const prev = won.get(name);
      if (!prev || spec > prev.spec || (spec === prev.spec && r.order >= prev.order)) won.set(name, { spec, order: r.order, value });
    }
  }
  return new Map([...won].map(([k, v]) => [k, v.value]));
}

/** The custom properties <html data-theme=… data-accent=…> ends up with: name → raw value. */
function tokensFor(theme, accent) {
  const attrs = { 'data-theme': theme, 'data-accent': accent };
  return cascade((s) => matchRoot(s, attrs));
}

// ---------------------------------------------------------------- a menu row in a state (hover, hl, focus)

const ROW_STATES = { hover: [':hover'], hl: ['.hl'], focus: [':focus', ':focus-visible'] };

/**
 * Specificity of a selector that matches a `.menu-item` in `state` (optionally under a root selector such as
 * [data-theme='dim']), else -1. Only descendant combinators and the state's own class or pseudo-classes.
 */
function matchRow(selector, attrs, state) {
  const parts = selector.trim().split(/\s+/);
  const subject = parts.pop();
  let spec = 0;
  for (const p of parts) {
    const s = matchRoot(p, attrs);
    if (s < 0) return -1;
    spec += s;
  }
  const simple = subject.match(/\.[\w-]+|:[\w-]+|\[[^\]]+\]|[^.:[]+/g) || [];
  if (!simple.includes('.menu-item')) return -1;
  for (const t of simple) {
    if (t !== '.menu-item' && !ROW_STATES[state].includes(t)) return -1;
    spec += 10;
  }
  return spec;
}

/**
 * The custom properties a menu row in `state` has: what it inherits from the root (var() already resolved
 * there, as inherited custom properties are) with the row's own declarations on top.
 */
function rowTokensFor(theme, accent, state) {
  const root = tokensFor(theme, accent);
  const out = new Map();
  for (const [k, v] of root) {
    try {
      const c = resolveColor(v, root);
      out.set(k, `rgb(${c[0]} ${c[1]} ${c[2]} / ${c[3]})`);
    } catch {
      out.set(k, v); // not a colour (fonts, shadows …)
    }
  }
  const attrs = { 'data-theme': theme, 'data-accent': accent };
  for (const [k, v] of cascade((s) => matchRow(s, attrs, state))) out.set(k, v);
  return out;
}

// ---------------------------------------------------------------- colours: [r, g, b, a], sRGB 0–255

const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };

/** Split a comma list at depth 0. */
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function resolveColor(expr, tokens, seen = new Set()) {
  const s = expr.trim();
  let m;
  if ((m = /^var\((--[\w-]+)\s*(?:,\s*(.+))?\)$/s.exec(s))) {
    if (seen.has(m[1])) throw new Error(`var() cycle at ${m[1]}`);
    const raw = tokens.get(m[1]) ?? m[2];
    if (raw === undefined) throw new Error(`${m[1]} is not defined`);
    return resolveColor(raw, tokens, new Set([...seen, m[1]]));
  }
  if (NAMED[s]) return NAMED[s];
  if ((m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s))) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+))?\s*\)$/.exec(s))) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  if ((m = /^color-mix\(\s*in srgb\s*,(.*)\)$/s.exec(s))) {
    const [a, b] = splitArgs(m[1]).map((part) => {
      const pm = /^(.*?)\s+([\d.]+)%$/s.exec(part);
      return pm ? { c: resolveColor(pm[1], tokens, seen), p: +pm[2] / 100 } : { c: resolveColor(part, tokens, seen), p: null };
    });
    const pa = a.p ?? (b.p === null ? 0.5 : 1 - b.p);
    const pb = b.p ?? 1 - pa;
    // Premultiplied mixing (CSS Color 5); a transparent side only thins the alpha.
    const alpha = a.c[3] * pa + b.c[3] * pb;
    if (!alpha) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (a.c[i] * a.c[3] * pa + b.c[i] * b.c[3] * pb) / alpha).concat(alpha);
  }
  throw new Error(`cannot read colour ${JSON.stringify(s)}`);
}

const over = (top, below) => [0, 1, 2].map((i) => top[i] * top[3] + below[i] * (1 - top[3])).concat(1);
const lum = (c) => {
  const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// ---------------------------------------------------------------- the contract

function failuresFor(theme, accent) {
  const t = tokensFor(theme, accent);
  const c = (name) => resolveColor(`var(${name})`, t);
  const out = [];
  const need = (label, fg, bg, min) => {
    const r = contrast(over(fg, bg), bg);
    if (r < min) out.push(`${label}: ${r.toFixed(2)}:1 (needs ${min}:1)`);
  };
  for (const s of SURFACES) {
    const bg = c(s);
    assert.equal(bg[3], 1, `${s} must be opaque in ${theme}`);
    for (const text of ['--text', '--text-2', '--text-3']) need(`${text} on ${s}`, c(text), bg, 4.5);
    need(`--control-line on ${s}`, c('--control-line'), bg, 3);
    need(`--accent-text on ${s}`, c('--accent-text'), bg, 4.5);
    need(`--focus-color ring next to ${s}`, c('--focus-color'), bg, 3);
  }
  // Accent text on its own tints: the current sidebar row, tint buttons and their hover, today in the mini month.
  const soft = c('--accent-soft');
  need('--accent-text on the current sidebar row', c('--accent-text'), over(soft, c('--bg-side')), 4.5);
  need('--accent-text on a tint button', c('--accent-text'), over(soft, c('--bg')), 4.5);
  need('--accent-text on a hovered tint button', c('--accent-text'), over(resolveColor('color-mix(in srgb, var(--accent) 24%, transparent)', t), c('--bg')), 4.5);
  need('--accent-text on today (accent-softer)', c('--accent-text'), over(c('--accent-softer'), c('--bg')), 4.5);
  // Labels on filled controls, hovered too.
  need('--on-accent on --accent-fill', c('--on-accent'), c('--accent-fill'), 4.5);
  need('--on-accent on --accent-hover', c('--on-accent'), c('--accent-hover'), 4.5);
  // A filled state (an on switch, a checked box, the selected day) stands 3:1 off what it sits on (WCAG 1.4.11).
  // Dim's menus (surface-3) are the exception: no fill can be both 4.5:1 under white labels and 3:1 against
  // them, as that takes white at 13.5:1 on the menu; there the labels win. Checked, so a darker one ends it.
  const fillSurfaces = ['--bg', '--bg-side', '--bg-grouped', '--surface-1', '--surface-2', '--surface-3'];
  for (const s of fillSurfaces) {
    if (theme === 'dim' && s === '--surface-3') {
      const room = contrast(c('--on-accent'), c(s));
      if (c('--on-accent')[0] === 255 && room >= 13.5) out.push(`white is ${room.toFixed(2)}:1 on Dim's ${s}: fills can now clear it too, so check it`);
      continue;
    }
    need(`--accent-fill against ${s} (a filled state)`, c('--accent-fill'), c(s), 3);
  }
  if (c('--focus-color')[3] !== 1) out.push(`--focus-color is see-through (alpha ${c('--focus-color')[3]}); the ring must be opaque`);
  // Priority colours: the "P2" label and ring on the page, and a done ring's tick cut out in the page colour.
  for (const p of ['--p1', '--p2', '--p3']) {
    need(`${p} on --bg`, c(p), c('--bg'), 4.5);
    need(`${p} on --surface-1`, c(p), c('--surface-1'), 3);
  }
  // Status and date words ("Overdue", "Connected", "Tomorrow" …).
  for (const s of ['--danger-text', '--success-text', '--warning-text', '--tone-overdue', '--tone-today', '--tone-tomorrow', '--tone-week']) {
    need(`${s} on --bg`, c(s), c('--bg'), 4.5);
    need(`${s} on --surface-1`, c(s), c('--surface-1'), 4.5);
  }
  for (const s of ['--danger-text', '--success-text', '--warning-text', '--tone-overdue']) need(`${s} on --bg-side`, c(s), c('--bg-side'), 4.5);
  return out;
}

/**
 * Text on menu rows (menus, the palette, the time list, Notes' editor menus): a hovered row gets --hover, a
 * highlighted or keyboard-focused one --accent-softer (Notes' rows: --hover), over the menu (surface-2 in
 * Light, surface-3 in Dim and Lights out) or the palette sheet (surface-1). Shortcut hints, durations and
 * subtitles (--text-3), the chosen time (--accent-text) and Delete (--danger-text) stay 4.5:1 on all of them.
 */
function rowFailures(theme, accent) {
  const t = tokensFor(theme, accent);
  const c = (name, map = t) => resolveColor(`var(${name})`, map);
  const menu = theme === 'light' ? c('--surface-2') : c('--surface-3');
  const sheet = c('--surface-1');
  const hovered = [over(c('--hover'), menu), over(c('--hover'), sheet)];
  const marked = [over(c('--accent-softer'), menu), over(c('--accent-softer'), sheet), ...hovered];
  const out = [];
  for (const [state, label, bgs] of [['hover', 'a hovered row', hovered], ['hl', 'a highlighted row', marked], ['focus', 'a focused row', marked]]) {
    const rt = rowTokensFor(theme, accent, state);
    for (const fg of ['--text', '--text-2', '--text-3', '--accent-text', '--danger-text']) {
      const worst = Math.min(...bgs.map((bg) => contrast(over(c(fg, rt), bg), bg)));
      if (worst < 4.5) out.push(`${fg} on ${label}: ${worst.toFixed(2)}:1 (needs 4.5:1)`);
    }
    // The keyboard ring keeps the root's colour (the row's own --accent-text never reaches it).
    const ring = c('--focus-color', rt);
    if (state !== 'hover' && Math.min(...[menu, sheet].map((bg) => contrast(ring, bg))) < 3) out.push(`the focus ring on ${label} is under 3:1`);
  }
  return out;
}

describe('ui.css tokens meet WCAG AA', () => {
  test('the cascade reader finds the theme and accent rules', () => {
    assert.equal(tokensFor('dark', 'iris').get('--bg'), '#000000');
    assert.equal(tokensFor('dim', 'blue').get('--accent'), '#1d9bf0');
    assert.equal(tokensFor('dark', 'iris').get('--accent'), '#6866ff', 'the [data-theme][data-accent] rule outranks [data-accent]');
    assert.deepEqual(resolveColor('color-mix(in srgb, #ffffff 50%, transparent)', new Map()), [255, 255, 255, 0.5]);
  });

  for (const theme of THEMES) {
    for (const accent of ACCENTS) {
      test(`${theme} theme, ${accent} accent`, () => {
        const fails = failuresFor(theme, accent);
        assert.deepEqual(fails, [], `${theme}/${accent}:\n  ${fails.join('\n  ')}`);
      });
    }
  }

  test('the row reader finds the menu-row rules, and menus still sit where the row checks assume', () => {
    const src = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(src, /\n\.menu \{[^}]*background: var\(--surface-2\)/, 'menus are surface-2 in Light');
    assert.match(src, /\[data-theme='dark'\] \.menu, \[data-theme='dim'\] \.menu \{ background: var\(--surface-3\); \}/, 'and surface-3 in Dim and Lights out');
    assert.equal(matchRow('.menu-item:hover', {}, 'hover'), 20);
    assert.equal(matchRow(".menu-item.hl", {}, 'hover'), -1);
    assert.equal(matchRow("[data-theme='dim'] .menu-item.hl", { 'data-theme': 'dim' }, 'hl'), 30);
    assert.equal(matchRow("[data-theme='dim'] .menu-item.hl", { 'data-theme': 'dark' }, 'hl'), -1);
    assert.equal(matchRow('.palette-list .menu-item:hover', {}, 'hover'), -1, 'a row inside a particular list is not every row');
  });

  for (const theme of THEMES) {
    test(`${theme} theme: text on hovered, highlighted and focused menu rows`, () => {
      const fails = ACCENTS.flatMap((accent) => rowFailures(theme, accent).map((f) => `${accent}: ${f}`));
      assert.deepEqual(fails, [], `${theme}:\n  ${fails.join('\n  ')}`);
    });
  }

  test('--text-4 stays decorative: no control edge or out-of-month day uses it', () => {
    const rule = (sel) => {
      const m = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(CSS.replace(/\/\*[\s\S]*?\*\//g, ''));
      assert.ok(m, `rule ${sel} not found`);
      return m[2];
    };
    assert.match(rule('.check'), /border:\s*1\.6px solid var\(--control-line\)/);
    assert.match(rule('.check-field .cf-box'), /inset 0 0 0 1\.6px var\(--control-line\)/);
    assert.match(rule('.mc-day.out'), /color:\s*var\(--text-3\)/);
  });
});
