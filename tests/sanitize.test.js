// XSS and validation tests for shared/sanitize.js. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeHtml, htmlToText, cleanHref, decodeEntities, escapeHtml, NOTE_TAGS, NOTE_HTML_MAX, ITEM_JSON_MAX,
  isId, isYmd, isHHMM, isDateTime, clampInt, cleanString, cleanLine, cleanTags, cleanColor,
  validateItem, validateCollection, validateSettingsPatch, validateSnapshot, validateOp, validateOps, validateRepeat,
  extendSchema, schemaFields, SETTINGS_DEFAULTS,
} from '../shared/sanitize.js';

const ATTRS = new Set(['href', 'rel', 'class', 'data-checked', 'data-task', 'data-event', 'data-note']);
const TAG_RE = /<\/?([a-z0-9]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*>/g;

/** Independent check of the output: only allowlisted tags/attributes, safe hrefs, no stray markup. */
function assertSafe(out, input) {
  const ctx = `\n  input:  ${JSON.stringify(input)}\n  output: ${JSON.stringify(out)}`;
  const rest = out.replace(TAG_RE, (m, name, attrs) => {
    assert.ok(NOTE_TAGS.has(name), `tag <${name}> not allowed${ctx}`);
    for (const [, an, av] of attrs.matchAll(/\s+([a-z-]+)="([^"]*)"/g)) {
      assert.ok(ATTRS.has(an), `attribute ${an} not allowed${ctx}`);
      if (an === 'href') assert.match(av.replace(/&amp;/g, '&'), /^(https?:\/\/|mailto:|ecosys:)/i, `bad href${ctx}`);
    }
    return '';
  });
  assert.ok(!/[<>]/.test(rest), `stray markup${ctx}`);
  assert.ok(!/<[^>]*(javascript:|vbscript:|data:|\son[a-z]+=|style=|src=)/i.test(out), `script-ish content inside a tag${ctx}`);
  assert.equal(sanitizeHtml(out), out, `not idempotent${ctx}`);
}

const VECTORS = [
  // script & friends
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<script/x>alert(1)</script>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<<script>script>alert(1)<</script>/script>',
  '<script>document.write("</scr"+"ipt><img src=x onerror=alert(1)>")</script>',
  '<script><!--</script><img src=x onerror=alert(1)>-->',
  // event handlers
  '<img src=x onerror=alert(1)>',
  '<img src=x onerror="alert(1)"//>',
  '<IMG SRC="javascript:alert(1);">',
  '<img """><script>alert(1)</script>">',
  '<body onload=alert(1)>',
  '<p onclick="alert(1)">click</p>',
  '<b onmouseover=alert(1)>x</b>',
  '<a href="https://ok.example" onfocus=alert(1) autofocus>x</a>',
  '<div/onmouseover="alert(1)">x</div>',
  '<span\tonmouseover=alert(1)>x</span>',
  '<p/onclick=alert(1)>x',
  '<details open ontoggle=alert(1)>',
  '<input autofocus onfocus=alert(1)>',
  '<video><source onerror=alert(1)></video>',
  '<audio src=x onerror=alert(1)>',
  '<marquee onstart=alert(1)>x</marquee>',
  // svg / math / foreign content
  '<svg onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<svg><style><img src=x onerror=alert(1)></style></svg>',
  '<svg/><img src=x onerror=alert(1)>',
  '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<math href="javascript:alert(1)">x</math>',
  '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
  // javascript: / data: URLs and encodings
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="java\nscript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#x6A;avascript:alert(1)">x</a>',
  '<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="jav&Tab;ascript:alert(1)">x</a>',
  '<a href="jav&NewLine;ascript:alert(1)">x</a>',
  '<a href="&#14;javascript:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="DATA:text/html,<script>alert(1)</script>">x</a>',
  '<a href="//evil.example">x</a>',
  '<a href="/relative">x</a>',
  '<a href=javascript:alert(1)>x</a>',
  "<a href='javascript:alert(1)'>x</a>",
  '<a href="http://ok.example" href="javascript:alert(1)">x</a>',
  '<a href="https://ok.example/"onmouseover="alert(1)">x</a>',
  '<a href="https://ok.example/?q=&quot;&gt;&lt;script&gt;">x</a>',
  // style / css
  '<style>@import "http://evil.example/x.css";</style>',
  '<p style="background:url(javascript:alert(1))">x</p>',
  '<div style="behavior:url(x.htc)">x</div>',
  '<span style=x:expression(alert(1))>x</span>',
  '<link rel=stylesheet href="http://evil.example/x.css">',
  // iframes, objects, forms, meta, base
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<form action="javascript:alert(1)"><button>go</button></form>',
  '<form><input type=submit formaction=javascript:alert(1)></form>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<base href="javascript:alert(1)//">',
  '<isindex action=javascript:alert(1) type=image>',
  '<template><img src=x onerror=alert(1)></template>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<textarea><img src=x onerror=alert(1)></textarea>',
  '<title><img src=x onerror=alert(1)></title>',
  '<xmp><img src=x onerror=alert(1)></xmp>',
  '<plaintext><img src=x onerror=alert(1)>',
  '<select><option><img src=x onerror=alert(1)></option></select>',
  // comments / CDATA / processing instructions
  '<!--><img src=x onerror=alert(1)>-->',
  '<!-- --!><img src=x onerror=alert(1)> -->',
  '<!--[if gte IE 4]><script>alert(1)</script><![endif]-->',
  '<![CDATA[<img src=x onerror=alert(1)>]]>',
  '<?xml version="1.0"?><img src=x onerror=alert(1)>',
  '<!DOCTYPE html><p>x</p>',
  // attribute injection / malformed
  '<p class="checked" onclick=alert(1)>x</p>',
  '<p class=" x" onclick=alert(1) y="">x</p>',
  '<a href="https://ok.example/" title=""><img src=x onerror=alert(1)>">x</a>',
  '<p title="a"onclick=alert(1)>x</p>',
  '<p ="onclick=alert(1)">x</p>',
  '<li data-checked="true\\" onclick=alert(1)">x</li>',
  '<span data-note="x\\" onmouseover=alert(1) a="">x</span>',
  '<span data-task="abc onmouseover=alert(1)">x</span>',
  '<b><i><u>deep',
  '</p></p></p>x<p>',
  '<p><p><p>x',
  '<ul><li><ul><li>x</ul></ul>',
  '<a href="https://a.example"><a href="https://b.example">x</a></a>',
  '<h1><h2>x</h2></h1>',
  '<div><p>a<ul><li>b</li></ul></p></div>',
  '<p>a</b>c</i>d</p>',
  '<img src="x" alt="<script>alert(1)</script>">',
  '<p>a < b > c & d</p>',
  '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
  '<p>&#60;script&#62;alert(1)&#60;/script&#62;</p>',
  '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
  '<a href="https://x.example',
  '<p class="checked',
  '<p\x00 onclick=alert(1)>x</p>',
  '<scr\x00ipt>alert(1)</scr\x00ipt>',
  '<\x00script>alert(1)</script>',
  '<p>x</p\x00>',
  '<div>'.repeat(200) + 'deep' + '</div>'.repeat(200),
  '<a href="ecosys:task/abc123">t</a><a href="ecosys:task/<script>">bad</a>',
  '<a href="mailto:me@example.com?subject=hi">mail</a>',
];

test('XSS vectors: output only contains allowlisted markup and is idempotent', () => {
  for (const v of VECTORS) assertSafe(sanitizeHtml(v), v);
});

test('dangerous elements are removed with their content', () => {
  assert.equal(sanitizeHtml('<script>alert(1)</script><p>ok</p>'), '<p>ok</p>');
  assert.equal(sanitizeHtml('<style>p{color:red}</style>text'), 'text');
  assert.equal(sanitizeHtml('<svg><style><img src=x onerror=alert(1)></style></svg><p>after</p>'), '<p>after</p>');
  assert.equal(sanitizeHtml('<iframe srcdoc="<script>alert(1)</script>"></iframe>x'), 'x');
  assert.equal(sanitizeHtml('<template><b>hidden</b></template>shown'), 'shown');
  assert.equal(sanitizeHtml('<textarea><b>x</b></textarea>y'), 'y');
  assert.equal(sanitizeHtml('<img src=x onerror=alert(1)>'), '');
  assert.equal(sanitizeHtml('<!-- <b>x</b> -->y'), 'y');
  assert.equal(sanitizeHtml('<plaintext><b>x</b>'), '');
  assert.equal(sanitizeHtml('<svg/><b>x</b>'), '<b>x</b>');
});

test('unknown elements are unwrapped, text is kept', () => {
  assert.equal(sanitizeHtml('<section><font color=red>hi</font></section>'), 'hi');
  assert.equal(sanitizeHtml('<form><button>go</button></form>'), 'go');
});

test('attributes: href schemes, class allowlist, data-checked, link ids', () => {
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeHtml('<a href="data:text/html,x">x</a>'), '<a>x</a>');
  assert.equal(sanitizeHtml('<a href="https://example.com/?a=1&b=2" onclick=x>ok</a>'), '<a href="https://example.com/?a=1&amp;b=2" rel="noopener noreferrer">ok</a>');
  assert.equal(sanitizeHtml('<a href="mailto:a@b.co">m</a>'), '<a href="mailto:a@b.co">m</a>');
  assert.equal(sanitizeHtml('<a href="ecosys:note/abc_1">n</a>'), '<a href="ecosys:note/abc_1">n</a>');
  assert.equal(sanitizeHtml('<ul class="checklist evil"><li data-checked class="checked x">t</li></ul>'), '<ul class="checklist"><li class="checked" data-checked="true">t</li></ul>');
  assert.equal(sanitizeHtml('<li data-checked="false">t</li>'), '<li data-checked="false">t</li>');
  assert.equal(sanitizeHtml('<li data-checked="maybe">t</li>'), '<li>t</li>');
  assert.equal(sanitizeHtml('<span data-task="abc123" data-event="x y" data-note="n1" style="x" title="t">s</span>'), '<span data-task="abc123" data-note="n1">s</span>');
  assert.equal(sanitizeHtml('<p title="><img src=x onerror=1>">q</p>'), '<p>q</p>');
  assert.equal(sanitizeHtml('<p class="todo hl hl">x</p>'), '<p class="todo hl">x</p>');
});

test('entities are preserved in text; bare & and < are escaped', () => {
  assert.equal(sanitizeHtml('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
  assert.equal(sanitizeHtml('&amp; &nbsp; &#169; &#x1F600; &copy;'), '&amp; &nbsp; &#169; &#x1F600; &copy;');
  assert.equal(sanitizeHtml('&bogus'), '&amp;bogus');
  assert.equal(sanitizeHtml('&lt;script&gt;'), '&lt;script&gt;');
});

test('malformed markup becomes well-formed', () => {
  assert.equal(sanitizeHtml('<p>unclosed <b>bold'), '<p>unclosed <b>bold</b></p>');
  assert.equal(sanitizeHtml('<p>a<div>b</div></p>'), '<p>a</p><div>b</div>');
  assert.equal(sanitizeHtml('<ul><li>one<li>two</ul>'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(sanitizeHtml('<p><p>x'), '<p></p><p>x</p>');
  assert.equal(sanitizeHtml('<a href="https://a.example">1<a href="https://b.example">2</a>'), '<a href="https://a.example" rel="noopener noreferrer">1</a><a href="https://b.example" rel="noopener noreferrer">2</a>');
  assert.equal(sanitizeHtml('<h1>a<h2>b</h2>'), '<h1>a</h1><h2>b</h2>');
  assert.equal(sanitizeHtml('x</b></p>y'), 'xy');
  assert.equal(sanitizeHtml('<b><i>x</b>y</i>'), '<b><i>x</i></b>y');
  assert.equal(sanitizeHtml('<br/><hr/></br>'), '<br><hr>');
  assert.equal(sanitizeHtml('<p>x<'), '<p>x&lt;</p>');
  assert.equal(sanitizeHtml('<p>x<b'), '<p>x</p>');
  assert.equal(sanitizeHtml('<P CLASS="TODO">x</P>'), '<p>x</p>');
});

test('nesting depth is bounded and long input is capped', () => {
  const deep = sanitizeHtml('<div>'.repeat(500) + 'x');
  assert.ok((deep.match(/<div>/g) || []).length <= 64);
  assert.ok(sanitizeHtml('a'.repeat(600000)).length <= NOTE_HTML_MAX);
  assert.equal(sanitizeHtml(null), '');
  assert.equal(sanitizeHtml(42), '42');
});

const timed = (fn) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

test('comments are skipped in linear time (no quadratic scan for a missing terminator)', () => {
  for (const s of ['<!---->'.repeat(70000), '<!--a--!>'.repeat(50000), '<!-- -- -->'.repeat(45000), '<!--x'.repeat(100000)]) {
    let out;
    const ms = timed(() => (out = sanitizeHtml(s)));
    assert.equal(out, '');
    assert.ok(ms < 200, `${JSON.stringify(s.slice(0, 12))}... took ${ms.toFixed(0)} ms`);
  }
  assert.ok(timed(() => htmlToText('<!---->'.repeat(20000))) < 200);
  assert.equal(sanitizeHtml('<!-- a --!>b<!-- c -->d<!--->e<!-->f'), 'bdef');
});

test('the length limit applies to the output, which stays well-formed and idempotent', () => {
  // escaping makes output longer than input: the cut must not be undone by the next validation
  const raw = { id: 'n1', title: 'T', body: '<p>' + 'if (a < b) return;\n'.repeat(25000) + '</p><p>THE END</p>' };
  const once = validateItem('notes', raw);
  assert.ok(once.body.length <= NOTE_HTML_MAX);
  assert.ok(once.body.endsWith('</p>'));
  assert.deepEqual(validateItem('notes', once), once);
  assert.ok(JSON.stringify(once).length <= ITEM_JSON_MAX);
  const lone = sanitizeHtml('<'.repeat(500000));
  assert.ok(lone.length <= NOTE_HTML_MAX && /^(&lt;)+$/.test(lone));
  assert.equal(sanitizeHtml(lone), lone);
  // every cut point: at most maxLength, never half an entity or surrogate pair, and a fixed point
  const samples = ['<p>unclosed <b>bold', '<ul><li>one<li>two</ul>', 'a &amp; b &lt; c &#x1F600; d', 'x < y > z & w', '<h1>a<h2>b</h2>',
    '<a href="https://a.example/?q=1&b=2">l</a> tail', '😀😀<b>😀</b>', '<div><p>a<ul><li>b</li></ul></p></div>', '<b><i><u>deep</u></i></b>x<hr>y'];
  for (const x of samples) {
    const whole = sanitizeHtml(x);
    for (let m = 0; m <= whole.length + 2; m++) {
      const a = sanitizeHtml(x, { maxLength: m });
      assert.ok(a.length <= m, `over the limit: m=${m} ${JSON.stringify(a)}`);
      assert.equal(sanitizeHtml(a, { maxLength: m }), a, `not a fixed point: m=${m} ${JSON.stringify(x)}`);
      assert.equal(sanitizeHtml(a), a);
      assertSafe(a, x);
    }
  }
});

test('validated notes always fit the server record limit, even when JSON escaping doubles them', () => {
  const body = ('"' + String.fromCharCode(92) + '\n').repeat(150000);
  const n = validateItem('notes', { id: 'n2', title: 'Quotes', body });
  assert.ok(n.body.length > 100000, 'only the end is cut');
  assert.ok(JSON.stringify(n).length <= ITEM_JSON_MAX);
  assert.deepEqual(validateItem('notes', n), n);
  assert.ok(JSON.stringify(validateItem('notes', { id: 'n3', body: '<p>' + 'x'.repeat(390000) + '</p>' })).length <= ITEM_JSON_MAX);
});

test('control characters are removed and unpaired surrogates replaced, so text survives UTF-8 storage', () => {
  assert.equal(sanitizeHtml('a\u0001b\u0007c\u007f\ud800d\udc00e😀\tf'), 'abc�d�e😀\tf');
  assert.equal(cleanString('x\udc00y\ud83d'), 'x�y�');
  assert.equal(cleanString('ab😀', 3), 'ab', 'a cut never leaves half an emoji');
  assert.equal(cleanLine('😀 ok'), '😀 ok');
});

test('htmlToText', () => {
  assert.equal(htmlToText('<h1>T</h1><ul><li>a</li><li>b &amp; c</li></ul><p>x&nbsp;y</p>'), 'T\n- a\n- b & c\nx y');
  assert.equal(htmlToText('<script>alert(1)</script>Hi<br>there'), 'Hi\nthere');
});

test('cleanHref, decodeEntities, escapeHtml', () => {
  assert.equal(cleanHref('  https://ok.example/a  '), 'https://ok.example/a');
  assert.equal(cleanHref('https:'), null);
  assert.equal(cleanHref('javascript:alert(1)'), null);
  assert.equal(cleanHref('jav&#x0A;ascript:alert(1)'), null);
  assert.equal(cleanHref('ftp://x.example'), null);
  assert.equal(decodeEntities('&#106;&#x61;&colon;&unknown;'), 'ja:&unknown;');
  assert.equal(escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

// ---------------------------------------------------------------- validators

test('primitive validators', () => {
  assert.ok(isId('abc123def4567890') && isId('L1') && isId('a_b-c'));
  assert.ok(!isId('') && !isId('a b') && !isId('"><img>') && !isId('x'.repeat(41)) && !isId(5) && !isId(null));
  assert.ok(isYmd('2026-02-28') && isYmd('2024-02-29'));
  assert.ok(!isYmd('2026-02-29') && !isYmd('2026-13-01') && !isYmd('1') && !isYmd('0099-01-01') && !isYmd('2026-1-1'));
  assert.ok(isHHMM('00:00') && isHHMM('23:59') && !isHHMM('24:00') && !isHHMM('9:00') && !isHHMM('09:60'));
  assert.ok(isDateTime('2026-11-22T09:30') && !isDateTime('2026-11-22 09:30') && !isDateTime('2026-11-22T9:30'));
  assert.equal(clampInt('60', 5, 1440), 60);
  assert.equal(clampInt(5e9, 2, 7), 7);
  assert.equal(clampInt('x', 0, 3, 0), 0);
  assert.equal(cleanString('a\u0000b\u0007c', 10), 'abc');
  assert.equal(cleanString('abcdef', 3), 'abc');
  assert.equal(cleanString({}, 3), '');
  assert.equal(cleanString(200)('xyz'), 'xyz');
  assert.equal(cleanLine('a\nb\tc'), 'a b c');
  assert.deepEqual(cleanTags(['a', ' a ', '', 5, {}, 'b']), ['a', '5', 'b']);
  assert.equal(cleanColor('red'), 'red');
  assert.equal(cleanColor('"><x>'), 'iris');
});

test('validateRepeat', () => {
  assert.deepEqual(validateRepeat({ freq: 'week', interval: '2', days: [5, 1, 1, 9], from: 'done', x: 1 }), { freq: 'week', interval: 2, days: [1, 5], from: 'done' });
  assert.deepEqual(validateRepeat({ freq: 'month', monthDay: 31 }), { freq: 'month', interval: 1, monthDay: 31 });
  assert.equal(validateRepeat({ freq: 'hourly' }), null);
  assert.equal(validateRepeat('daily'), null);
});

test('validateItem: tasks are rebuilt from the schema (XSS payloads in typed fields are dropped)', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const t = validateItem('tasks', {
    id: 'abc', title: 'Hi\nthere', priority: evil, done: evil, time: evil, duration: evil, date: '1', deadline: '2026-11-31',
    listId: evil, tags: ['x', evil], checklist: [{ id: evil, title: 's', done: 'true' }, 'junk'], someday: true, evening: true,
    repeat: { freq: 'day' }, extra: 'drop me', createdAt: 'yesterday', completedAt: -5,
  });
  assert.equal(t.title, 'Hi there');
  assert.equal(t.priority, 0);
  assert.equal(t.done, false);
  assert.equal(t.time, null);
  assert.equal(t.duration, null);
  assert.equal(t.date, null);
  assert.equal(t.deadline, null);
  assert.equal(t.listId, null);
  assert.equal(t.completedAt, null);
  assert.ok(Number.isFinite(t.createdAt));
  assert.ok(isId(t.checklist[0].id) && t.checklist[0].done === true && t.checklist.length === 1);
  assert.ok(!('someday' in t) && !('evening' in t) && !('extra' in t));
  assert.deepEqual(t.tags, ['x', evil]); // plain text; escaped where rendered
  assert.equal(validateItem('tasks', { id: evil, title: 'x' }), null);
  assert.equal(validateItem('tasks', null), null);
  assert.equal(validateItem('tasks', ['id']), null);
  assert.equal(validateItem('nope', { id: 'a' }), null);
});

test('validateItem: prototype keys never survive', () => {
  const raw = JSON.parse('{"id":"a1","title":"t","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const t = validateItem('tasks', raw);
  assert.ok(!Object.hasOwn(t, '__proto__') && !Object.hasOwn(t, 'constructor'));
  assert.equal({}.polluted, undefined);
  const s = validateSettingsPatch(JSON.parse('{"__proto__":{"polluted":true},"theme":"dark","taskSort":{"__proto__":"date","today":"date"}}'));
  assert.deepEqual(Object.keys(s), ['theme', 'taskSort']);
  assert.deepEqual(Object.keys(s.taskSort), ['today']);
  assert.equal({}.polluted, undefined);
});

test('validateItem: events', () => {
  assert.equal(validateItem('events', { id: 'e1', start: 5, end: 6 }), null);
  assert.equal(validateItem('events', { id: 'e1', start: 'soon' }), null);
  const e = validateItem('events', { id: 'e1', start: '2026-11-22T10:00', end: '2026-11-22T09:00', exdates: ['2026-11-29', 'x', '2026-11-29'], until: '2026-01-01' });
  assert.equal(e.end, '2026-11-22T11:00');
  assert.deepEqual(e.exdates, ['2026-11-29']);
  assert.equal(e.until, '2026-11-22');
  const a = validateItem('events', { id: 'e2', allDay: true, start: '2026-11-22T00:00', end: '2026-11-20' });
  assert.equal(a.start, '2026-11-22');
  assert.equal(a.end, '2026-11-22');
  const late = validateItem('events', { id: 'e3', start: '2026-11-22T23:30', end: '2026-11-22T23:00' });
  assert.equal(late.end, '2026-11-23T00:30');
});

test('validateItem: lists, calendars, notes, folders', () => {
  assert.deepEqual(
    Object.keys(validateItem('lists', { id: 'l1', name: 123, color: 'nope', icon: '<b>' })),
    ['id', 'name', 'color', 'icon', 'order', 'createdAt', 'updatedAt'],
  );
  const l = validateItem('lists', { id: 'l1', name: 123, color: 'nope', icon: '<b>' });
  assert.equal(l.name, '123');
  assert.equal(l.color, 'iris');
  assert.equal(l.icon, '');
  assert.equal(validateItem('calendars', { id: 'c1', name: 'Work' }).visible, true);
  const n = validateItem('notes', { id: 'n1', title: 'T', body: '<p onclick=x>hi<script>bad()</script></p>', folderId: 'f1', pinned: 'true' });
  assert.equal(n.body, '<p>hi</p>');
  assert.equal(n.pinned, true);
  assert.equal(n.trashedAt, null);
  assert.equal(validateItem('folders', { id: 'f1', parentId: '../x' }).parentId, null);
});

test('extendSchema adds fields; schemaFields lists them', () => {
  extendSchema('notes', { locked: (v) => v === true });
  assert.ok(schemaFields('notes').includes('locked'));
  assert.equal(validateItem('notes', { id: 'n1', locked: true }).locked, true);
  assert.throws(() => extendSchema('notes', { __proto__x: 1 }));
  assert.throws(() => extendSchema('nope', {}));
});

test('validateCollection dedupes ids and drops junk', () => {
  const r = validateCollection('tasks', [{ id: 'a', title: '1' }, { id: 'a', title: '2' }, null, 5, { title: 'no id' }, { id: 'b' }]);
  assert.deepEqual(r.items.map((t) => t.title), ['1', '']);
  assert.equal(r.dropped, 4);
  assert.deepEqual(validateCollection('tasks', 'x'), { items: [], dropped: 0 });
  assert.equal(validateCollection('tasks', [{ id: 'a' }, { id: 'b' }, { id: 'c' }], { max: 2 }).items.length, 2);
});

test('validateSettingsPatch: allowlist with type checks', () => {
  const s = validateSettingsPatch({
    theme: 'dark', accent: '"><x>', weekStart: 1, timeFormat: '13h', scheduleDays: 5e9, scheduleView: 'days', dayStartHour: '9',
    hiddenTaskLists: 5, taskSort: { today: 'bogus', inbox: 'date', 'tag:home': 'alpha' }, completionSound: 'false',
    notesView: 'grid', aiPanelOpen: true, uiDensity: { x: 1 }, evil: 1, defaultEventMinutes: -3,
  });
  assert.deepEqual(s, { theme: 'dark', weekStart: 1, scheduleView: 'days', dayStartHour: 9, taskSort: { inbox: 'date', 'tag:home': 'alpha' }, completionSound: false, notesView: 'grid', aiPanelOpen: true });
  assert.deepEqual(validateSettingsPatch(null), {});
  assert.deepEqual(validateSettingsPatch({ hiddenTaskLists: ['inbox', 'L1', '"><x>', 'L1'] }), { hiddenTaskLists: ['inbox', 'L1'] });
  for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) assert.deepEqual(validateSettingsPatch({ [k]: v }), { [k]: v }, `default ${k} must validate`);
});

test('validateSnapshot handles backups and server state', () => {
  const backup = { app: 'ecosys', version: 1, tasks: [{ id: 't1', title: 'x' }, { id: 'bad id' }], lists: 'nope', settings: { theme: 'dim', junk: 1 } };
  const r = validateSnapshot(backup);
  assert.deepEqual(Object.keys(r.data), ['tasks']);
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.settings, { theme: 'dim' });
  const s = validateSnapshot({ data: { events: [] }, settings: {} }, { all: true });
  assert.deepEqual(Object.keys(s.data), ['tasks', 'lists', 'events', 'calendars', 'notes', 'folders']);
  assert.throws(() => validateSnapshot('x'));
});

test('validateOp / validateOps', () => {
  assert.deepEqual(validateOp({ op: 'del', c: 'tasks', id: 't1', extra: 1 }), { op: 'del', c: 'tasks', id: 't1' });
  assert.equal(validateOp({ op: 'del', c: 'users', id: 't1' }), null);
  assert.equal(validateOp({ op: 'del', c: 'tasks', id: '../x' }), null);
  assert.equal(validateOp({ op: 'put', c: 'tasks', item: { id: '"><x>' } }), null);
  assert.equal(validateOp({ op: 'put', c: '__proto__', item: { id: 'a' } }), null);
  assert.equal(validateOp({ op: 'settings', patch: { evil: 1 } }), null);
  assert.deepEqual(validateOp({ op: 'settings', patch: { theme: 'dark' } }), { op: 'settings', patch: { theme: 'dark' } });
  assert.equal(validateOp({ op: 'replace', c: 'tasks', items: [{ id: 'a' }, { id: 'a' }] }).items.length, 1);
  assert.equal(validateOp({ op: 'eval' }), null);
  assert.equal(validateOps([{ op: 'del', c: 'tasks', id: 'a' }, null, { op: 'x' }]).length, 1);
  assert.deepEqual(validateOps('x'), []);
});
