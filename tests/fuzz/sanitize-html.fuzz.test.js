// Property/fuzz tests for shared/sanitize.js HTML handling: sanitizeHtml, htmlToText, cleanHref,
// escapeHtml, decodeEntities. Thousands of generated hostile documents (grammar-based, mutated XSS
// vectors, character soup) are checked by an independent output checker (lib/html-check.js).
//
//   node --test tests/fuzz/                     (whole fuzz suite)
//   FUZZ_SEED=123 FUZZ_RUNS=5 node --test tests/fuzz/sanitize-html.fuzz.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml, htmlToText, cleanHref, escapeHtml, decodeEntities, NOTE_TAGS, NOTE_CLASSES, LINK_ATTRS, NOTE_HTML_MAX } from '../../shared/sanitize.js';
import { SEED, runs, forAll, fail, check, assume, shrinkString, show, reproduce } from './lib/harness.js';
import { hostileHtml, mutateVector, charSoup, canonicalHtml, text as randomText, hostileUrl, XSS_VECTORS } from './lib/html-gen.js';
import { checkSanitized, textOf, browserScheme } from './lib/html-check.js';

console.log(`# sanitize-html fuzz: seed ${SEED} (reproduce: ${reproduce()})`);

const CHECK_OPTS = { allowedTags: NOTE_TAGS, noteClasses: NOTE_CLASSES, linkAttrs: LINK_ATTRS };

/** The security + well-formedness contract, then idempotence. */
function safeAndStable(input, opts) {
  let out;
  try {
    out = opts ? sanitizeHtml(input, opts) : sanitizeHtml(input);
  } catch (err) {
    fail('throws', `sanitizeHtml threw ${err?.name}: ${err?.message}`);
  }
  const maxLength = opts?.maxLength ?? NOTE_HTML_MAX;
  const problem = checkSanitized(out, { ...CHECK_OPTS, maxLength });
  if (problem) fail(problem.kind, `${problem.message}\n  output: ${show(out, 400)}`);
  const again = opts ? sanitizeHtml(out, opts) : sanitizeHtml(out);
  check(again === out, 'idempotent', () => `sanitizeHtml(sanitizeHtml(x)) !== sanitizeHtml(x)\n  once:  ${show(out, 300)}\n  twice: ${show(again, 300)}`);
  return out;
}

const HTML_DISPLAY = (v) => show(v, 500);

function property(t, name, n, gen, prop = (x) => safeAndStable(x)) {
  const r = forAll(name, { runs: runs(n), gen, prop, shrink: shrinkString, display: HTML_DISPLAY });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
}

test('sanitizeHtml: known XSS vectors produce only allowlisted, well-formed, idempotent markup', () => {
  for (const v of XSS_VECTORS) {
    try {
      safeAndStable(v);
    } catch (err) {
      err.message += `\n  vector: ${show(v)}`;
      throw err;
    }
  }
});

test('sanitizeHtml: grammar-generated hostile documents are made safe (no script/style/iframe/object/embed, no on*, no javascript:/data: URLs)', (t) => {
  property(t, 'sanitize.hostile', 5000, (rng) => hostileHtml(rng));
});

test('sanitizeHtml: mutated XSS vectors are made safe', (t) => {
  property(t, 'sanitize.mutated', 4000, (rng) => mutateVector(rng));
});

test('sanitizeHtml: random character soup is made safe', (t) => {
  property(t, 'sanitize.soup', 3000, (rng) => charSoup(rng));
});

test('sanitizeHtml: hostile <a href> values never keep a dangerous scheme', (t) => {
  property(t, 'sanitize.href', 4000, (rng) => {
    const url = hostileUrl(rng);
    const q = rng.pick(['"', "'", '']);
    const v = q ? url.replaceAll(q, '') : url.replace(/[\s>]/g, '');
    return `<a ${rng.pick(['href', 'HREF', 'href ', 'href\n'])}=${q}${v}${q}${rng.pick(['', ' x', ' onclick=alert(1)'])}>${randomText(rng, 2)}</a>`;
  });
});

test('sanitizeHtml: output length respects maxLength and stays idempotent at that limit', (t) => {
  property(
    t,
    'sanitize.maxLength',
    4000,
    (rng) => ({ html: rng.chance(0.5) ? hostileHtml(rng) : canonicalHtml(rng), maxLength: rng.pick([0, 1, 2, 3, 5, 8, 13, 21, 40, 64, 100, 150, 257, 400, rng.int(0, 600)]) }),
    ({ html, maxLength }) => safeAndStable(html, { maxLength }),
  );
});

test('sanitizeHtml: canonical allowlisted documents are fixed points (legitimate notes survive unchanged)', (t) => {
  const r = forAll('sanitize.canonical', {
    runs: runs(3000),
    gen: (rng) => canonicalHtml(rng),
    prop: (html) => {
      assume(html.length <= NOTE_HTML_MAX);
      const out = sanitizeHtml(html);
      check(out === html, 'changed', () => `canonical HTML was changed\n  in:  ${show(html, 300)}\n  out: ${show(out, 300)}`);
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('sanitizeHtml: plain text (no < or &) is preserved exactly', (t) => {
  const r = forAll('sanitize.text', {
    runs: runs(3000),
    // eslint-disable-next-line no-control-regex
    gen: (rng) => randomText(rng, rng.int(0, 40)).replace(/[<&\u0000-\u0008\u000B\u000E-\u001F\u007F]/g, '').toWellFormed(),
    prop: (s) => {
      // eslint-disable-next-line no-control-regex
      assume(!s.includes('<') && !s.includes('&') && !/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(s) && s.isWellFormed());
      const out = sanitizeHtml(s);
      check(textOf(out) === s, 'text-lost', () => `text changed: ${show(s)} → ${show(out)}`);
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('sanitizeHtml: JSON-like non-string inputs never throw', () => {
  for (const v of [null, undefined, 0, -0, 42, NaN, Infinity, true, false, [], ['<script>alert(1)</script>'], {}, { a: '<img src=x onerror=alert(1)>' }, [1, [2, '<img onerror=1>']], 1e308, '']) {
    const out = sanitizeHtml(v);
    assert.equal(typeof out, 'string');
    const problem = checkSanitized(out, CHECK_OPTS);
    assert.equal(problem, null, `input ${show(v)} → ${show(out)}: ${problem?.message}`);
  }
});

test('htmlToText: never throws, ignores markup, collapses blank lines and is unaffected by pre-sanitizing', (t) => {
  const r = forAll('htmlToText', {
    runs: runs(3000),
    gen: (rng) => rng.weighted([[3, () => hostileHtml(rng)], [2, () => canonicalHtml(rng)], [1, () => charSoup(rng)]]),
    prop: (html) => {
      let txt;
      try {
        txt = htmlToText(html);
      } catch (err) {
        fail('throws', `htmlToText threw ${err?.message}`);
      }
      check(typeof txt === 'string', 'type', `returned ${typeof txt}`);
      check(txt === txt.trim(), 'trim', () => `not trimmed: ${show(txt, 200)}`);
      check(!txt.includes('\n\n'), 'blank-lines', () => `blank line kept: ${show(txt, 200)}`);
      check(htmlToText(sanitizeHtml(html)) === txt, 'presanitize', 'htmlToText(sanitizeHtml(x)) differs from htmlToText(x)');
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('cleanHref: returns null or a trimmed http/https/mailto/ecosys URL without control characters', (t) => {
  const r = forAll('cleanHref', {
    runs: runs(5000),
    gen: (rng) => (rng.chance(0.8) ? hostileUrl(rng) : charSoup(rng, rng.int(0, 60))),
    prop: (raw) => {
      let u;
      try {
        u = cleanHref(raw);
      } catch (err) {
        fail('throws', `cleanHref threw ${err?.message}`);
      }
      if (u === null) return;
      check(typeof u === 'string', 'type', `returned ${typeof u}`);
      check(['http', 'https', 'mailto', 'ecosys'].includes(browserScheme(u)), 'scheme', () => `scheme ${browserScheme(u)} kept: ${show(u)}`);
      // eslint-disable-next-line no-control-regex
      check(!/[\u0000-\u001F\u007F]/.test(u), 'ctrl', () => `control character kept: ${show(u)}`);
      // eslint-disable-next-line no-control-regex
      check(!/^[\u0000- ]|[\u0000- ]$/.test(u), 'trim', () => `not trimmed: ${show(u)}`);
      check(u.length <= 2048, 'length', `length ${u.length}`);
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('escapeHtml: output has no raw markup characters and decodes back to the input', (t) => {
  const r = forAll('escapeHtml', {
    runs: runs(3000),
    gen: (rng) => (rng.chance(0.5) ? randomText(rng, rng.int(0, 30)) : charSoup(rng, rng.int(0, 60))),
    prop: (s) => {
      const e = escapeHtml(s);
      check(!/[<>"']/.test(e), 'raw', () => `raw markup character in ${show(e)}`);
      check(!/&(?!(?:amp|lt|gt|quot|#39);)/.test(e), 'amp', () => `bare & in ${show(e)}`);
      const back = e.replace(/&(amp|lt|gt|quot|#39);/g, (m, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[n]);
      check(back === s, 'roundtrip', () => `${show(s)} → ${show(e)} → ${show(back)}`);
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

test('decodeEntities: never throws and never creates lone surrogates from references', (t) => {
  const r = forAll('decodeEntities', {
    runs: runs(3000),
    gen: (rng) => randomText(rng, rng.int(0, 30)).replace(/[\ud800-\udfff]/g, 'x'),
    prop: (s) => {
      let d;
      try {
        d = decodeEntities(s);
      } catch (err) {
        fail('throws', `decodeEntities threw ${err?.message}`);
      }
      check(typeof d === 'string', 'type', `returned ${typeof d}`);
      check(d.isWellFormed(), 'surrogate', () => `${show(s)} decoded to a lone surrogate: ${show(d)}`);
    },
    shrink: shrinkString,
  });
  t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
});

// The fuzz tests are only as good as the checker: make sure it rejects what it must reject.
test('checker self-test: lib/html-check.js flags unsafe or malformed output and accepts canonical output', () => {
  const BAD = {
    '<script>alert(1)</script>': 'deny-tag',
    '<img src=x>': 'stray-lt',
    '<img src="x">': 'deny-tag',
    '<p onclick="alert(1)">x</p>': 'deny-attr',
    '<p style="x">x</p>': 'deny-attr',
    '<a href="javascript:alert(1)">x</a>': 'href-scheme',
    '<a href=" javascript:alert(1)">x</a>': 'href-scheme',
    '<a href="java&#x09;script:alert(1)">x</a>': 'attr-amp',
    '<a href="data:text/html,x">x</a>': 'href-scheme',
    '<a href="//evil.example">x</a>': 'href-scheme',
    '<a href="https://ok.example">x</a>': 'rel',
    '<p href="https://ok.example">x</p>': 'href-tag',
    '<b>x': 'unclosed',
    '<b>x</i>': 'mismatch',
    '</b>': 'mismatch',
    '<br></br>': 'void-closed',
    '<p><div>x</div></p>': 'p-block',
    '<li><li>x</li></li>': 'li-li',
    '<h1><h2>x</h2></h1>': 'h-h',
    '<a><a>x</a></a>': 'a-a',
    'a < b': 'stray-lt',
    'a > b': 'stray-gt',
    'a & b': 'bare-amp',
    '&amp': 'bare-amp',
    '<P>x</P>': 'tag-name',
    '<section>x</section>': 'tag',
    '<p class="evil">x</p>': 'class',
    '<li data-checked="maybe">x</li>': 'data-checked',
    '<span data-task="a b">x</span>': 'link-id',
    '<p title="x">y</p>': 'attr',
    '<p class="hl" class="hl">x</p>': 'dup-attr',
    [`x${String.fromCharCode(1)}y`]: 'text-ctrl',
    [`x${String.fromCharCode(0xd800)}y`]: 'surrogate',
    [`${'<b>'.repeat(65)}x${'</b>'.repeat(65)}`]: 'depth',
  };
  for (const [out, kind] of Object.entries(BAD)) {
    const p = checkSanitized(out, CHECK_OPTS);
    assert.ok(p, `checker accepted ${show(out)}`);
    assert.equal(p.kind, kind, `checker reported ${p.kind} (expected ${kind}) for ${show(out)}: ${p.message}`);
  }
  const GOOD = [
    '', 'plain &amp; &lt;b&gt; &nbsp; &#169; &#x1F600;', '<p>x</p><div><p>y</p></div>', '<ul class="checklist"><li class="checked" data-checked="true">t</li></ul>',
    '<a href="https://example.com/?a=1&amp;b=2" rel="noopener noreferrer">x</a>', '<a href="mailto:a@b.co">m</a>', '<a href="ecosys:note/abc_1">n</a>', '<span data-task="abc123" data-note="n1">s</span>',
    '<p>a<br>b</p><hr>', '<h1>t</h1><h2>s</h2>', `${'<b>'.repeat(64)}x${'</b>'.repeat(64)}`,
  ];
  for (const out of GOOD) assert.equal(checkSanitized(out, CHECK_OPTS), null, `checker rejected canonical ${show(out)}: ${checkSanitized(out, CHECK_OPTS)?.message}`);
});
