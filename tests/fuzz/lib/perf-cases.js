// Pathological 1 MB inputs for the sanitizer performance tests (built inside the perf worker).
// Each case: { name, fn: 'sanitizeHtml' | 'htmlToText' | 'cleanHref', build(seed) → string, opts? }.
import { makeRng } from './harness.js';
import { hostileHtml } from './html-gen.js';

export const MB = 1 << 20;
const C = (n) => String.fromCharCode(n);
export const fill = (unit, total = MB) => unit.repeat(Math.ceil(total / unit.length)).slice(0, total);
/** pre + unit… + post, exactly `total` characters long. */
export const wrap = (pre, unit, post, total = MB) => pre + fill(unit, Math.max(0, total - pre.length - post.length)) + post;

function hostileMegabyte(seed) {
  const rng = makeRng(seed ^ 0x9e3779b9);
  const parts = [];
  let len = 0;
  while (len < MB) {
    const d = hostileHtml(rng);
    parts.push(d);
    len += d.length;
  }
  return parts.join('').slice(0, MB);
}

/** Inputs shared by sanitizeHtml (default and uncapped output) and htmlToText. */
const HTML_INPUTS = {
  'plain text': () => fill('lorem ipsum dolor '),
  'run of "<"': () => fill('<'),
  'run of ">"': () => fill('>'),
  'run of "&"': () => fill('&'),
  'run of "&#"': () => fill('&#'),
  'run of "&#x"': () => fill('&#x'),
  'unterminated "&amp"': () => fill('&amp'),
  'long entity names': () => fill(`&${'a'.repeat(40)}`),
  'valid entities': () => fill('&#x41;&amp;&nbsp;'),
  'open tag never closed': () => wrap('<a', ' b', ''),
  'run of "<a "': () => fill('<a '),
  'run of "<p x="': () => fill('<p x='),
  'run of unterminated double quotes': () => fill('<p x="'),
  'single-quoted attributes': () => fill("<p x='y' "),
  'one tag, many attributes': () => wrap('<p ', 'a=1 ', '>x</p>'),
  'one tag, duplicate attributes': () => wrap('<p ', 'class=hl ', '>x</p>'),
  'one long attribute value': () => wrap('<p title="', 'x', '">y</p>'),
  'class with many tokens': () => wrap('<p class="', 'hl ', '">x</p>'),
  'class with long whitespace': () => wrap('<p class="hl', ' ', 'todo">x</p>'),
  'href: x + spaces + x': () => wrap('<a href="x', ' ', 'x">y</a>'),
  'href: x + &#32; refs + x': () => wrap('<a href="x', '&#32;', 'x">y</a>'),
  'href: x + space/control mix + x': () => wrap('<a href="x', ` ${C(1)}`, 'x">y</a>'),
  'href: trailing spaces': () => wrap('<a href="https://ok.example/', ' ', '">y</a>'),
  'href: leading spaces': () => wrap('<a href="', ' ', 'https://ok.example/">y</a>'),
  'href: tabs': () => wrap('<a href="x', '\t', 'x">y</a>'),
  'href: very long valid URL': () => wrap('<a href="https://ex.example/', 'a', '">y</a>'),
  'data-task: long value': () => wrap('<span data-task="', 'a', '">x</span>'),
  'data-checked: long whitespace': () => wrap('<li data-checked="', ' ', 'true">x</li>'),
  'run of "<!--"': () => fill('<!--'),
  'run of empty comments': () => fill('<!---->'),
  'run of "<!-- --!>"': () => fill('<!-- --!>'),
  'unterminated comment of dashes': () => wrap('<!--', '-', ''),
  'unterminated comment of "--!"': () => wrap('<!--', '--!', ''),
  'run of bogus comments': () => fill('<!x'),
  'unclosed doctype': () => wrap('<!DOCTYPE', ' x', ''),
  'run of "<?x"': () => fill('<?x'),
  'run of "</ "': () => fill('</ '),
  'run of "</b>"': () => fill('</b>'),
  'unclosed end tag': () => wrap('</b', ' x', ''),
  'nested <b>': () => fill('<b>'),
  'nested <div>': () => fill('<div>'),
  'run of <p>': () => fill('<p>'),
  'run of <li>': () => fill('<li>'),
  'run of <ul><li>': () => fill('<ul><li>'),
  'run of links': () => fill('<a href="https://a.example">'),
  'run of headings': () => fill('<h1><h2>'),
  'mixed nesting': () => fill('<div><b><a href="https://x.example"><li><p>'),
  'run of <svg>': () => fill('<svg>'),
  '<svg> then self-closing svgs': () => wrap('<svg>', '<svg/>', ''),
  'run of <template>': () => fill('<template>'),
  '<script> + fake end tags': () => wrap('<script>', '</scrip', ''),
  'script pairs': () => fill('<script>x</script>'),
  'run of <style>': () => fill('<style>'),
  '<textarea> + fake end tags': () => wrap('<textarea>', '</textareax', ''),
  '<xmp> + almost end tags': () => wrap('<xmp>', '</xmp', ''),
  '<plaintext> + markup': () => wrap('<plaintext>', '<b>', ''),
  'NUL-separated markup': () => fill(`${C(0)}<${C(0)}b${C(0)}>`),
  'two-byte text and tags': () => fill(`${C(0xe9)}<b>${C(0x4e2d)}</b>`),
  'lone surrogates': () => fill(`${C(0xd800)}x`),
  'CRLF': () => fill('\r\n'),
  'run of <br>': () => fill('<br>'),
  'spaces then a letter': () => wrap('', ' ', 'x'),
  'spaces/tabs then a letter': () => wrap('', ' \t', 'x'),
  'deep nesting then text': () => fill('<b>', MB / 2) + fill('x', MB / 2),
  'generated hostile soup': (seed) => hostileMegabyte(seed),
};

export const CASES = [
  ...Object.entries(HTML_INPUTS).map(([name, build]) => ({ name: `sanitizeHtml | ${name}`, fn: 'sanitizeHtml', build })),
  ...Object.entries(HTML_INPUTS).map(([name, build]) => ({ name: `sanitizeHtml (maxLength 2 MB) | ${name}`, fn: 'sanitizeHtml', build, opts: { maxLength: 2 * MB } })),
  ...[
    'plain text', 'spaces then a letter', 'spaces/tabs then a letter', 'run of <li>', 'run of <p>', 'run of <br>', 'valid entities', 'mixed nesting', 'href: x + spaces + x', 'CRLF', 'generated hostile soup',
  ].map((name) => ({ name: `htmlToText | ${name}`, fn: 'htmlToText', build: HTML_INPUTS[name] })),
  { name: 'cleanHref | x + spaces + x', fn: 'cleanHref', build: () => wrap('x', ' ', 'x') },
  { name: 'cleanHref | https + spaces + x', fn: 'cleanHref', build: () => wrap('https://ok.example/', ' ', 'x') },
  { name: 'cleanHref | long URL', fn: 'cleanHref', build: () => wrap('https://ok.example/', 'a', '') },
  { name: 'cleanHref | many references', fn: 'cleanHref', build: () => fill('&#106;') },
];
