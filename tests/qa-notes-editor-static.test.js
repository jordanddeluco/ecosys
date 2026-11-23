// QA fixes in the notes editor (notes/editor): checks that need no browser. The one name table for block
// types, the words that keep the @ date list open while a date is typed, and the stylesheet rules behind
// the chip, checklist, link, placeholder, phone-sheet and Windows Contrast (forced colours) fixes. The
// behaviour itself is covered in the browser by tests/e2e/qa-notes-editor-a11y-flows.test.mjs.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const M = await import(new URL('notes/editor/model.js', ROOT));
const EDITOR_JS = read('notes/editor/index.js');
const TOOLBAR_JS = read('notes/editor/toolbar.js');
const MENUS_JS = read('notes/editor/menus.js');
const CSS = read('notes/editor/editor.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level rules of a stylesheet; an at-rule block is one rule ({ prelude: '@media …', body }). */
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
const ALL = rules(CSS);
/** Bodies of the top-level rules whose selector list holds `sel` exactly. */
const bodiesFor = (sel, list = ALL) => list.filter((r) => !r.prelude.startsWith('@') && r.prelude.split(',').some((s) => s.trim() === sel)).map((r) => r.body);
const FORCED = rules(ALL.filter((r) => /^@media\s*\(\s*forced-colors\s*:\s*active\s*\)/.test(r.prelude)).map((r) => r.body).join('\n'));

/** DATE_WORDS and maybeDate as index.js defines them (index.js itself needs a browser to import). */
function dateWords() {
  const from = EDITOR_JS.indexOf('const DATE_WORDS = ');
  const fn = EDITOR_JS.indexOf('function maybeDate(q) {');
  assert.ok(from >= 0 && fn > from, 'DATE_WORDS and maybeDate are defined in notes/editor/index.js');
  const to = EDITOR_JS.indexOf('\n}\n', fn) + 2;
  return new Function(`${EDITOR_JS.slice(from, to)}\nreturn { DATE_WORDS, maybeDate };`)();
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

describe('notes editor QA fixes (static)', () => {
  test('one sentence-case name table for block types, used by the slash menu, Turn into and the Aa panel', () => {
    assert.deepEqual(M.TYPE_NAMES, {
      h1: 'Title', h2: 'Heading', h3: 'Subheading', p: 'Body', code: 'Code block', quote: 'Quote',
      bullet: 'Bulleted list', dash: 'Dashed list', num: 'Numbered list', check: 'Checklist', hr: 'Divider',
    });
    assert.match(EDITOR_JS, /id: 'mono', label: TYPE_NAMES\.code/, 'the slash menu takes its labels from TYPE_NAMES');
    assert.match(TOOLBAR_JS, /cmd: 'mono', t: 'code', label: TYPE_NAMES\.code/, 'Turn into and the Aa panel take theirs from TYPE_NAMES');
    const dir = new URL('notes/editor/', ROOT);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      for (const old of ['Monostyled', 'Block Quote', 'Bulleted List', 'Dashed List', 'Numbered List']) {
        assert.ok(!src.includes(`'${old}'`), `${f} still labels a block type '${old}'`);
      }
    }
  });

  test('@ dates: every prefix of a day or month name keeps the list open; names that are no date close it', () => {
    const { DATE_WORDS, maybeDate } = dateWords();
    for (const w of [...DAYS, ...MONTHS, 'next', 'this', 'in', 'on', 'the']) {
      for (let n = 1; n <= w.length; n++) {
        assert.ok(DATE_WORDS.test(w.slice(0, n)), `"@${w.slice(0, n)}" closes the date list`);
        assert.ok(maybeDate(w.slice(0, n)), `maybeDate("${w.slice(0, n)}")`);
      }
    }
    for (const w of ['3', '12/5', '15th', 'Fri', 'SEPT']) assert.ok(maybeDate(w), `maybeDate("${w}")`);
    for (const w of ['mark', 'sam', 'john', 'dave', 'decide', 'monkey', 'frank', 'satisfy', 'online', 'inbox', 'last']) {
      assert.ok(!maybeDate(w), `"@${w}" is a name or a word, not a date: the list closes`);
    }
  });

  test('@ dates: a phrase stays open while it can still become a date (nlp.js reads it only when complete)', () => {
    const { maybeDate } = dateWords();
    for (const q of ['dec ', 'dec 3', 'next ', 'next f', 'next fri', 'next week', 'in 2', 'in 2 w', 'in 2 weeks', 'the 1', 'the 15th', 'on fri', 'this weekend', '5 dec', 'fri 3pm', 'on the 15th']) {
      assert.ok(maybeDate(q), `"@${q}" closes the list before the date is complete`);
    }
    for (const q of [' fri', 'next  fri', 'next meeting', 'dec 3 at noon please', 'fr 3', 'mark my words', 'decide later']) {
      assert.ok(!maybeDate(q), `"@${q}" is prose: the list closes`);
    }
  });

  test('chips and inline code keep their fill on every line, and a chip glyph stays with its word', () => {
    assert.ok(bodiesFor('.ne-chip').some((b) => /(^|[;\s])box-decoration-break\s*:\s*clone/.test(b)), '.ne-chip: box-decoration-break: clone');
    assert.ok(bodiesFor('.ne-nb').some((b) => /white-space\s*:\s*nowrap/.test(b)), '.ne-nb (glyph + first word) never wraps');
    assert.ok(bodiesFor('.ne-chip-day').some((b) => /white-space\s*:\s*nowrap/.test(b)), 'a date chip never wraps');
    assert.ok(bodiesFor('.ne-doc code').some((b) => /(^|[;\s])box-decoration-break\s*:\s*clone/.test(b)), 'inline code keeps its fill when it wraps');
  });

  test('checked circles fill with --accent-fill under the --on-accent tick, like Tasks', () => {
    assert.ok(bodiesFor(".ne-b[data-checked='true'] .ne-ck-ring").some((b) => /fill\s*:\s*var\(--accent-fill\)/.test(b)), 'checklist circle');
    assert.ok(bodiesFor('.ne-tc-svg.done circle').some((b) => /fill\s*:\s*var\(--accent-fill\)/.test(b)), 'task chip circle');
  });

  test('links to notes are underlined, not set apart by colour alone (WCAG 1.4.1)', () => {
    for (const sel of ['.ne-doc a.ne-ref', '.ne-chip-note']) {
      const b = bodiesFor(sel).join(';');
      assert.match(b, /text-decoration\s*:\s*underline/, `${sel} is underlined`);
      assert.doesNotMatch(b, /text-decoration\s*:\s*none/, `${sel} has no text-decoration: none`);
    }
  });

  test('the placeholder is no content for screen readers; list markers have alt text', () => {
    const ph = bodiesFor(".ne-b.is-empty > .ne-tx[data-ph]::before").join(';');
    assert.match(ph, /content\s*:\s*attr\(data-ph\)\s*\/\s*''/, 'the placeholder has empty alt text');
    assert.match(ph, /content\s*:\s*attr\(data-ph\)\s*;/, 'with a plain fallback first');
    assert.match(bodiesFor(".ne-b[data-type='bullet']::before").join(';'), /content\s*:[^;]*\/\s*'Bullet'/, 'bullets say "Bullet"');
    assert.match(bodiesFor(".ne-b[data-type='dash']::before").join(';'), /content\s*:[^;]*\/\s*'Dash'/, 'dashes say "Dash"');
    assert.match(EDITOR_JS, /setAttribute\('aria-placeholder'/, 'the empty textbox carries aria-placeholder');
  });

  test('Windows Contrast themes: highlights use Mark, markers and states keep a system colour', () => {
    assert.ok(FORCED.length, 'editor.css has a @media (forced-colors: active) block');
    const hl = bodiesFor('mark.ne-hl', FORCED).join(';');
    assert.match(hl, /forced-color-adjust\s*:\s*none/, 'highlights opt out of the forced (transparent) fill');
    assert.match(hl, /background\s*:\s*Mark/, 'highlights use Mark');
    assert.match(hl, /color\s*:\s*MarkText/, 'with MarkText');
    for (const sel of [".ne-b[data-type='bullet']::before", ".ne-b[data-type='dash']::before", ".ne-b[data-type='quote']::before"]) {
      assert.match(bodiesFor(sel, FORCED).join(';'), /background\s*:\s*CanvasText/, `${sel} stays visible`);
    }
    assert.match(bodiesFor(".ne-b[data-checked='true'] .ne-ck-ring", FORCED).join(';'), /fill\s*:\s*Highlight/, 'a checked circle is filled');
    assert.match(bodiesFor(".ne-tb-btn[aria-pressed='true']", FORCED).join(';'), /outline\s*:/, 'a pressed toolbar button has an edge');
    assert.match(bodiesFor('.ne-chip-task', FORCED).join(';'), /border\s*:/, 'chips have an edge');
  });

  test('date suggestions show their dates in the text font (monospace is for Markdown hints)', () => {
    assert.match(bodiesFor(".ne-pop[data-kind='date'] .ne-opt-hint").join(';'), /var\(--font-sans\)/);
    assert.match(MENUS_JS, /this\.node\.dataset\.kind = kind/, 'the list carries data-kind');
  });

  test('the Aa style row scrolls, so its focus ring sits inside the button, and a focused style scrolls clear of the fade', () => {
    const ring = bodiesFor('.ne-aa-style:focus-visible').join(';');
    assert.match(ring, /outline-offset\s*:\s*-\d/, '.ne-aa-style:focus-visible has an inset ring (a scroller clips one drawn outside)');
    assert.match(bodiesFor('.ne-aa-styles').join(';'), /overflow-x\s*:\s*auto/, 'the row is a scroller (why the ring must be inset)');
    assert.match(bodiesFor('.ne-aa-styles').join(';'), /scroll-padding-inline\s*:\s*28px/, 'scroll-padding as wide as the edge fade');
    assert.match(TOOLBAR_JS, /styles\.addEventListener\('focusin', \(e\) => e\.target\.scrollIntoView\?\.\(\{ block: 'nearest', inline: 'nearest' \}\)\)/, 'a focused style scrolls into view');
  });

  test('Send to Tasks has one glyph: both checklist-menu items draw send-task (the shared one, or the editor’s copy)', () => {
    assert.doesNotMatch(EDITOR_JS, /'arrow-up-right'|'inbox'/, 'no older Send glyph left in the editor');
    const menu = EDITOR_JS.slice(EDITOR_JS.indexOf('  openCheckMenu(point, id) {'), EDITOR_JS.indexOf('  // ---------------------------------------------------------------- pointer'));
    assert.equal((menu.match(/label: 'Send to Tasks', \.\.\.sendIcon\(\)/g) || []).length, 1, 'Send to Tasks');
    assert.equal((menu.match(/label: `Send unchecked to Tasks \(\$\{unchecked\.length\}\)`, \.\.\.sendIcon\(\)/g) || []).length, 1, 'Send unchecked to Tasks');
    assert.match(EDITOR_JS, /const sendIcon = \(\) => \(hasIcon\('send-task'\) \? \{ icon: 'send-task' \} : \{ iconHtml: svgMarkup\('send-task', \{ size: 18 \}\) \}\);/);
    assert.match(read('notes/editor/icons.js'), /'send-task': \['M3\.2 11\.9 6\.4 15\.1 11\.6 8\.9', 'M14\.4 11\.9h6\.4M17\.8 8\.9l3 3-3 3'\]/, 'the editor’s copy is the audit’s check-to-arrow');
  });

  test('svgMarkup: the editor’s glyph as the trusted markup a shared menu takes, from constant path data only', async () => {
    const { svgMarkup } = await import(new URL('notes/editor/icons.js', ROOT));
    const m = svgMarkup('send-task', { size: 18 });
    assert.equal(
      m,
      '<svg class="i ne-i" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.2 11.9 6.4 15.1 11.6 8.9"/><path d="M14.4 11.9h6.4M17.8 8.9l3 3-3 3"/></svg>',
      'the shared icon()’s shape: class i, 24 grid, 1.8 stroke at 18px, hidden from screen readers',
    );
    assert.match(svgMarkup('note', { size: 14 }), /stroke-width="2\.2".*<circle cx="15\.6" cy="15\.2" r="1\.7" fill="currentColor" stroke="none"\/><\/svg>$/, 'the small-size stroke rule and solid dots, as svgIcon draws them');
    assert.equal(svgMarkup('no-such-glyph'), svgMarkup('no-such-glyph').replace(/<path[^>]*>/g, ''), 'an unknown name draws nothing (no input reaches the markup)');
    assert.equal(svgMarkup('x', { size: '18"><script>' }).includes('<script'), false, 'numbers stay numbers');
  });

  test('the link field says what it did (Link added / updated / removed), as the link card’s Remove does', () => {
    const ui = EDITOR_JS.slice(EDITOR_JS.indexOf('  linkUI() {'), EDITOR_JS.indexOf('  /** Close the note picker'));
    assert.match(ui, /onApply: \(h\) => \{[^}]*if \(this\.apply\(C\.setLink\(this\.doc, sel, h\), 'format'\)\) this\.announce\(!h \? 'Link removed' : href \? 'Link updated' : 'Link added'\);/);
  });

  test('a caret hint names its link or chip by what it points at, not by its offset (linkNth)', () => {
    const from = EDITOR_JS.indexOf('function linkNth(runs, ext) {');
    assert.ok(from >= 0, 'linkNth is defined in notes/editor/index.js');
    const linkNth = new Function(`${EDITOR_JS.slice(from, EDITOR_JS.indexOf('\n}\n', from) + 2)}\nreturn linkNth;`)();
    const A = { href: 'https://a.example/' };
    // 'x ' 0–2 · one 2–5 · ' and ' · t+wo 10–13 (one link in two runs) · ' or ' · bee 17–20 · ' ' · three 21–26
    const runs = [['x '], ['one', '', A], [' and '], ['t', '', A], ['wo', 'i', A], [' or '], ['bee', '', { href: 'https://b.example/' }], [' '], ['three', 'b', A]];
    const at = (off) => linkNth(runs, M.linkExtent(runs, off));
    assert.deepEqual([at(3), at(12), at(24), at(18)], [0, 1, 2, 0], 'the 1st, 2nd and 3rd link to a.example, the 1st to b.example');
    const typed = [['Some typing x '], ...runs.slice(1)];
    assert.equal(linkNth(typed, M.linkExtent(typed, 16)), 0, 'text typed before a link does not change its name');
    assert.match(EDITOR_JS, /key = `l:\$\{b\.id\}:\$\{ext\.href \|\| ext\.ref\}#\$\{linkNth\(b\.c, ext\)\}`/, 'links: block, target and which one');
    assert.match(EDITOR_JS, /key = `c:\$\{b\.id\}:\$\{near\.ref\}#\$\{near\.nth\}`/, 'chips: block, ref and which one');
    assert.match(EDITOR_JS, /if \(key && !typed\) this\.announce\(`\$\{what\}\. Alt\+F10 for options\.`, \{ hint: true \}\);/, 'a caret that typing moved is no arrival');
  });

  test('phone sheets sit flush on the keyboard bar, and the Aa style row fades when it scrolls', () => {
    const sheet = bodiesFor('.ne-aa.docked').join(';');
    assert.match(sheet, /border-radius\s*:\s*\S+\s+\S+\s+0\s+0/, 'rounded top corners only');
    assert.match(TOOLBAR_JS, /r\.top - this\.node\.offsetHeight\)/, 'the docked Aa panel leaves no gap above the bar');
    assert.match(MENUS_JS, /bottom - h\)/, 'the + sheet leaves no gap above the bar');
    for (const f of ['end', 'start', 'both']) assert.ok(bodiesFor(`.ne-aa-styles[data-fade='${f}']`).some((b) => /mask-image/.test(b)), `fade ${f}`);
  });
});
