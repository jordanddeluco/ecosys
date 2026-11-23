// QA (schedule, cross-area round): schedule.css keeps the shared design system's rules. Today's markers
// carry white text on the AA accent fill; Windows Contrast themes (forced colours) still show items, checked
// calendars, today and the now line; the phone's top bar buttons are 44px touch targets; up to 1280px the
// calendar moves over for the open Tasks panel (it covers nothing) while on a phone it is a sheet; and the
// sidebar's Create pill is the shared one in ui.css, not a copy. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../schedule/schedule.css', import.meta.url), 'utf8');
const UI = readFileSync(new URL('../shared/ui.css', import.meta.url), 'utf8');

/** Style rules with the @media they sit in ('' at the top level): [{ media, selectors, decls: Map }]. */
function rules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') {
      stack.push(src.slice(start, i).trim());
      start = i + 1;
    } else if (src[i] === '}') {
      const prelude = stack.pop();
      if (prelude !== undefined && !prelude.startsWith('@')) {
        const decls = new Map([...src.slice(start, i).matchAll(/([\w-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()]));
        out.push({ media: stack.filter((p) => p.startsWith('@')).join(' '), selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decls });
      }
      start = i + 1;
    }
  }
  return out;
}
const ALL = rules(CSS);
const find = (media, selector) => ALL.filter((r) => r.media === media && r.selectors.includes(selector));
const decl = (media, selector, prop) => find(media, selector).map((r) => r.decls.get(prop)).filter(Boolean).at(-1);

const TODAY = ['.day-head.today .dnum', '.mcell.today .mnum', '.day-pop .dp-date.today button', '.ym-day.today', '.ag-day.today .ag-date .n'];

test("today's markers fill with --accent-fill (AA under white text), never the plain accent", () => {
  for (const s of TODAY) {
    assert.equal(decl('', s, 'background'), 'var(--accent-fill)', s);
    assert.equal(decl('', s, 'color'), 'var(--on-accent)', s);
  }
  const plain = ALL.filter((r) => r.selectors.some((s) => TODAY.includes(s)) && r.decls.get('background') === 'var(--accent)');
  assert.deepEqual(plain.map((r) => r.selectors.join(', ')), []);
});

test('forced colours: items get a border, calendars keep their checked colour, today an outline, the now line Highlight', () => {
  const FC = '@media (forced-colors: active)';
  for (const s of ['.ev', '.ad-item', '.mitem']) assert.match(decl(FC, s, 'border') || '', /^1px solid CanvasText$/, s);
  assert.equal(decl(FC, '.cal-box', 'box-shadow'), 'none', 'the inset-shadow outline is dropped there, so…');
  assert.match(decl(FC, '.cal-box', 'border') || '', /solid ButtonText/, '…an unchecked calendar has a border');
  assert.equal(decl(FC, ".cal-item[aria-checked='true'] .cal-box", 'forced-color-adjust'), 'none');
  assert.equal(decl(FC, ".cal-item[aria-checked='true'] .cal-box", 'background'), 'var(--cc)');
  for (const s of TODAY) assert.match(decl(FC, s, 'outline') || '', /^2px solid Highlight$/, s);
  assert.equal(decl(FC, '.now-line', 'background'), 'Highlight');
  assert.equal(decl(FC, '.now-line', 'forced-color-adjust'), 'none');
});

test("the phone's top bar buttons (Main menu, Today, Previous, Next) are 44px touch targets", () => {
  const PHONE = '@media (max-width: 640px)';
  for (const s of ['.cal-top .icon-btn', '.cal-top .today-btn']) {
    assert.equal(decl(PHONE, s, 'width'), '44px', s);
    assert.equal(decl(PHONE, s, 'height'), '44px', s);
  }
  // Nothing narrower later in the phone block (it used to set 34px on .today-btn and .nav-arrows .icon-btn).
  const small = ALL.filter((r) => r.media === PHONE && r.selectors.some((s) => /today-btn$|nav-arrows \.icon-btn$|menu-toggle$/.test(s)) && /^(?:[0-3]\d|4[0-3])px$/.test(r.decls.get('width') || r.decls.get('height') || ''));
  assert.deepEqual(small.map((r) => r.selectors.join(', ')), []);
});

test('up to 1280px the calendar moves over for the open Tasks panel; on a phone the panel is a sheet over it', () => {
  const MID = '@media (max-width: 1280px)';
  const PHONE = '@media (max-width: 640px)';
  const w = decl(MID, '.taskpanel', 'width');
  assert.ok(w, 'the panel has a width there');
  assert.equal(decl(MID, '.shell.has-panel .view', 'margin-right'), w, 'the view gives up exactly the panel’s width');
  assert.equal(decl(MID, '.taskpanel', 'top'), 'var(--header-h)', 'below the top bar, whose buttons stay usable');
  assert.equal(decl(PHONE, '.shell.has-panel .view', 'margin-right'), '0', 'the phone sheet covers the calendar (a modal) instead');
});

test("the sidebar's Create pill is the shared one in ui.css, not a copy", () => {
  assert.ok(rules(UI).some((r) => r.media === '' && r.selectors.includes('.create-btn')), 'ui.css draws the pill');
  assert.deepEqual(ALL.filter((r) => r.selectors.some((s) => /\.create-(?:btn|wrap)\b/.test(s))).map((r) => r.selectors.join(', ')), []);
});
