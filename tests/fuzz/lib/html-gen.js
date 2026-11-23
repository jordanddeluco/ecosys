// Generators of hostile (and of canonical) notes HTML for the sanitizer fuzz tests.
//
//   hostileHtml(rng)     grammar-based documents mixing allowed, dangerous, raw-text and unknown
//                        elements, event handlers, obfuscated javascript:/data: URLs, comments,
//                        CDATA, entities, control characters, unicode, truncation and mutations
//   mutateVector(rng)    a known XSS vector with random edits
//   charSoup(rng)        random characters from an alphabet rich in markup syntax
//   canonicalHtml(rng)   well-formed allowlisted HTML in the sanitizer's own output form
//                        (must come back unchanged: canonical documents are fixed points)

export const ALLOWED_TAGS = ['p', 'br', 'div', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'hr', 'span'];
const RAW_TEXT_TAGS = ['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'textarea', 'title', 'plaintext'];
const DROP_TAGS = ['svg', 'math', 'template', 'object', 'applet', 'select', 'head', 'frameset', 'audio', 'video', 'canvas', 'map', 'datalist'];
const VOID_TAGS = ['img', 'image', 'input', 'embed', 'link', 'meta', 'base', 'source', 'track', 'wbr', 'area', 'col', 'param', 'keygen', 'frame', 'isindex', 'br', 'hr'];
const OTHER_TAGS = [
  'form', 'button', 'body', 'html', 'table', 'tbody', 'tr', 'td', 'th', 'details', 'summary', 'marquee', 'font', 'center', 'section', 'article', 'label', 'option',
  'optgroup', 'fieldset', 'legend', 'dialog', 'portal', 'slot', 'bgsound', 'blink', 'x', 'xss', 'foo-bar', 'foreignObject', 'foreignobject', 'animate', 'set', 'use',
  'mglyph', 'mtext', 'annotation-xml', 'desc', 'h4', 'h6', 'sub', 'sup', 'ins', 'kbd', 'samp', 'tt', 'q', 'abbr', 'cite', 'var', 'small', 'big', 'nobr', 'ruby',
  'rt', 'listing', 'layer', 'ilayer', 'animatetransform', 'feimage', 'discard', 'svg:script', 'math:mi', 'a:b', 'x-script', 'scriptx', 'stylex', 'a1', 'p1', 'li2',
];
const EVENT_ATTRS = [
  'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onbegin', 'ontoggle', 'onanimationstart', 'onpointerenter', 'onstart', 'onfinish',
  'onbeforeprint', 'onhashchange', 'onwheel', 'oncopy', 'onauxclick', 'onx', 'ONLOAD', 'oNeRrOr', 'onfocusin', 'onscrollend', 'onpageshow', 'onsubmit', 'oninput',
];
const URL_ATTRS = ['href', 'src', 'srcdoc', 'action', 'formaction', 'data', 'poster', 'background', 'lowsrc', 'dynsrc', 'xlink:href', 'codebase', 'cite', 'longdesc', 'ping', 'srcset', 'xmlns', 'manifest', 'HREF', 'Href'];
const OTHER_ATTRS = [
  'style', 'class', 'id', 'name', 'title', 'alt', 'rel', 'target', 'type', 'value', 'data-checked', 'data-task', 'data-event', 'data-note', 'data-x', 'contenteditable',
  'autofocus', 'tabindex', 'is', 'slot', 'nonce', 'http-equiv', 'content', 'open', 'hidden', 'dir', 'lang', 'xml:lang', 'CLASS', 'Data-Task', 'data-ref', 'data-hl',
];
export const NOTE_CLASS_LIST = ['checklist', 'checked', 'todo', 'hl'];

export const XSS_VECTORS = [
  '<script>alert(1)</script>', '<SCRIPT SRC=//evil.example/x.js></SCRIPT>', '<script/x>alert(1)</script>', '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<<script>script>alert(1)<</script>/script>', '<script>document.write("</scr"+"ipt><img src=x onerror=alert(1)>")</script>', '<script><!--</script><img src=x onerror=alert(1)>-->',
  '<img src=x onerror=alert(1)>', '<img src=x onerror="alert(1)"//>', '<IMG SRC="javascript:alert(1);">', '<img """><script>alert(1)</script>">', '<body onload=alert(1)>',
  '<p onclick="alert(1)">click</p>', '<b onmouseover=alert(1)>x</b>', '<a href="https://ok.example" onfocus=alert(1) autofocus>x</a>', '<div/onmouseover="alert(1)">x</div>',
  '<span\tonmouseover=alert(1)>x</span>', '<p/onclick=alert(1)>x', '<details open ontoggle=alert(1)>', '<input autofocus onfocus=alert(1)>', '<video><source onerror=alert(1)></video>',
  '<svg onload=alert(1)>', '<svg><script>alert(1)</script></svg>', '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>', '<svg><style><img src=x onerror=alert(1)></style></svg>',
  '<svg/><img src=x onerror=alert(1)>', '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<math href="javascript:alert(1)">x</math>', '<a href="javascript:alert(1)">x</a>', '<a href="JaVaScRiPt:alert(1)">x</a>', '<a href=" javascript:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>', '<a href="java\nscript:alert(1)">x</a>', '<a href="&#106;avascript:alert(1)">x</a>', '<a href="&#x6A;avascript:alert(1)">x</a>',
  '<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058alert(1)">x</a>', '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="jav&Tab;ascript:alert(1)">x</a>', '<a href="jav&NewLine;ascript:alert(1)">x</a>', '<a href="&#14;javascript:alert(1)">x</a>', '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>', '<a href="DATA:text/html,<script>alert(1)</script>">x</a>', '<a href="//evil.example">x</a>',
  '<a href=javascript:alert(1)>x</a>', "<a href='javascript:alert(1)'>x</a>", '<a href="http://ok.example" href="javascript:alert(1)">x</a>',
  '<a href="https://ok.example/"onmouseover="alert(1)">x</a>', '<a href="https://ok.example/?q=&quot;&gt;&lt;script&gt;">x</a>', '<style>@import "http://evil.example/x.css";</style>',
  '<p style="background:url(javascript:alert(1))">x</p>', '<span style=x:expression(alert(1))>x</span>', '<link rel=stylesheet href="http://evil.example/x.css">',
  '<iframe src="javascript:alert(1)"></iframe>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>', '<object data="javascript:alert(1)"></object>', '<embed src="javascript:alert(1)">',
  '<form action="javascript:alert(1)"><button>go</button></form>', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', '<base href="javascript:alert(1)//">',
  '<template><img src=x onerror=alert(1)></template>', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>', '<textarea><img src=x onerror=alert(1)></textarea>',
  '<title><img src=x onerror=alert(1)></title>', '<xmp><img src=x onerror=alert(1)></xmp>', '<plaintext><img src=x onerror=alert(1)>', '<select><option><img src=x onerror=alert(1)></option></select>',
  '<!--><img src=x onerror=alert(1)>-->', '<!-- --!><img src=x onerror=alert(1)> -->', '<!--[if gte IE 4]><script>alert(1)</script><![endif]-->', '<![CDATA[<img src=x onerror=alert(1)>]]>',
  '<?xml version="1.0"?><img src=x onerror=alert(1)>', '<p class="checked" onclick=alert(1)>x</p>', '<p title="a"onclick=alert(1)>x</p>', '<p ="onclick=alert(1)">x</p>',
  '<li data-checked="true\\" onclick=alert(1)">x</li>', '<span data-note="x\\" onmouseover=alert(1) a="">x</span>', '<span data-task="abc onmouseover=alert(1)">x</span>',
  '<a href="ecosys:task/abc123">t</a><a href="ecosys:task/<script>">bad</a>', '<noembed><img src=x onerror=alert(1)></noembed>', '<noframes><img src=x onerror=alert(1)></noframes>',
  '<style><img src=x onerror=alert(1)></style>', '<a href="javas&#99;ript:alert(1)">x</a>', '<a href="\u0001javascript:alert(1)">x</a>', '<a href=" javascript:alert(1)">x</a>',
  '<a href="j&#x61;vascript:alert(1)">x</a>', '<a href="&#x6a&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3a;alert(1)">x</a>', '<a href="javascript:/*--></title></style></textarea></script><svg/onload=alert(1)>">x</a>',
  '<a href=&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)>x</a>', '<a href="feed:javascript:alert(1)">x</a>', '<a href="ecosys:javascript:alert(1)">x</a>',
  '<a href="https:javascript:alert(1)">x</a>', '<a href="http://\u0000javascript:alert(1)">x</a>', '<math><mi xlink:href="data:x,<script>alert(1)</script>">x</mi></math>',
  '<isindex type=image src=1 onerror=alert(1)>', '<frameset onload=alert(1)>', '<table background="javascript:alert(1)">', '<object type="text/x-scriptlet" data="http://evil.example/x.sct"></object>',
  '<img src="x` `<script>alert(1)</script>"` `>', '<a href="https://x.example/" title="`"onmouseover=alert(1)">x</a>', '<a href="https://x.example/\' onclick=alert(1) x=\'">x</a>',
  '<p><svg><p><style><img src=x onerror=alert(1)></style></p></svg></p>', '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
  '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">', '<math><mtext><h1><a><h6></a></h6><mglyph><svg><mtext><style><a title="</style><img src onerror=alert(1)>"></style></h1>',
  '<noscript><style></noscript><img src=x onerror=alert(1)>', '<script>alert(1)</script\t>', '<script>alert(1)</script/>', '<script>alert(1)</SCRIPT >', '<scRipt>alert(1)</sCript>',
  '<iframe><iframe></iframe><img src=x onerror=alert(1)></iframe>', '<textarea></textarea><img src=x onerror=alert(1)></textarea>', '<a href="mailto:x@y.z?subject=<script>">m</a>',
  '<span class="hl" onclick=alert(1)>x</span>', '<del datetime="x" onmouseover=alert(1)>x</del>', '<mark style="color:red">x</mark>', '<ul class="checklist"><li data-checked onclick=1>t</li></ul>',
  '<div>'.repeat(80) + 'deep' + '</div>'.repeat(80), '<b><i><u>deep', '</p></p></p>x<p>', '<a href="https://a.example"><a href="https://b.example">x</a></a>', '<h1><h2>x</h2></h1>',
];

const HOSTILE_SCHEMES = ['javascript', 'JaVaScRiPt', 'JAVASCRIPT', 'vbscript', 'VBScript', 'data', 'DATA', 'livescript', 'mocha', 'jar', 'view-source', 'file', 'blob', 'about', 'ws', 'ftp', 'feed', 'chrome', 'filesystem', 'intent', 'ms-its', 'mhtml', 'x-javascript', 'jscript', 'tel', 'sms'];
const PAYLOADS = ['alert(1)', '//evil.example/x', 'text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'text/html,<script>alert(1)</script>', 'msgbox(1)', '/*--></title></style></textarea></script><svg/onload=alert(1)>', 'void(0)', '%0aalert(1)', 'x'];
const GOOD_URLS = [
  'https://example.com/a?b=1&c=2', 'http://x.example', 'https://ex.example/path#frag', 'mailto:a@b.example', 'mailto:a@b.example?subject=hi&body=x', 'ecosys:task/abc123', 'ecosys:note/n_1#b2',
  'ecosys://day/2026-11-22', 'https://ex.example/"onmouseover="alert(1)', "https://ex.example/'><script>", 'https://ex.example/<script>', 'https://ex.example/%3Cscript%3E', 'https://xn--80ak6aa92e.com/',
  'HTTPS://EXAMPLE.COM/', 'https:\\\\evil.example', 'https://ex.example/&amp;x', 'https:', 'http://', 'https://', 'https:///x', 'mailto:', '//evil.example', '/relative', '?q=1', '#frag', '',
  'tel:+15551234', 'https://ex.example/‮', 'https://ex.example/\ud800', 'https://ex.example/\u{1F600}', 'ecosys:<script>', 'ecosys:' + 'a'.repeat(310), 'https://' + 'a'.repeat(2100) + '.example',
];
const WS_CHARS = ['\t', '\n', '\r', '\f', ' ', '\u0000', '\u0001', '\u0008', '\u000b', '\u000e', '\u001f', '\u007f', ' ', String.fromCharCode(0x2028), String.fromCharCode(0x2029), '​', '﻿', '　', '᠎'];
const NAMED_ENTITIES = ['&amp;', '&lt;', '&gt;', '&quot;', '&apos;', '&nbsp;', '&colon;', '&Tab;', '&NewLine;', '&copy;', '&hellip;', '&euro;', '&bogus;', '&notin;', '&not', '&amp', '&lt', '&#', '&#x', '&;', '& ', '&&'];

export function caseMix(rng, s) {
  if (!rng.chance(0.3)) return s;
  let out = '';
  for (const ch of s) out += rng.chance(0.5) ? ch.toUpperCase() : ch.toLowerCase();
  return out;
}

/** One character encoded as a decimal/hex reference, with or without ';' and with padding zeros. */
function encodeChar(rng, ch) {
  return encodeNum(rng, ch.codePointAt(0));
}

/** A decimal/hex character reference for any number (also invalid ones such as 0, surrogates, > 0x10FFFF). */
function encodeNum(rng, cp) {
  const zeros = '0'.repeat(rng.small(7));
  const semi = rng.chance(0.7) ? ';' : '';
  return rng.chance(0.5) ? `&#${zeros}${cp}${semi}` : `&#${rng.chance(0.5) ? 'x' : 'X'}${zeros}${cp.toString(16)}${semi}`;
}

function obfuscate(rng, s, p = 0.25) {
  let out = '';
  for (const ch of s) {
    const r = rng.float();
    if (r < p * 0.4) out += encodeChar(rng, ch);
    else if (r < p * 0.6) out += rng.pick(WS_CHARS) + ch;
    else if (r < p * 0.7 && ch === ':') out += rng.pick(['&colon;', '&#58;', '&#x3a;', '&#X3A', '%3a']);
    else if (r < p * 0.8) out += rng.pick(['&Tab;', '&NewLine;', '&#9;', '&#10;', '&#13;', '&#x09;']) + ch;
    else out += ch;
  }
  return out;
}

export function hostileUrl(rng) {
  return rng.weighted([
    [6, () => obfuscate(rng, `${caseMix(rng, rng.pick(HOSTILE_SCHEMES))}:${rng.pick(PAYLOADS)}`)],
    [2, () => `${rng.repeat(rng.small(4), () => rng.pick(WS_CHARS)).join('')}${rng.pick(HOSTILE_SCHEMES)}:${rng.pick(PAYLOADS)}`],
    [1, () => `${rng.pick(['https', 'http', 'mailto', 'ecosys'])}:${rng.pick(HOSTILE_SCHEMES)}:${rng.pick(PAYLOADS)}`],
    [4, () => rng.pick(GOOD_URLS)],
    [1, () => obfuscate(rng, rng.pick(GOOD_URLS), 0.15)],
    [1, () => rng.pick(['', ' ', 'x', '#', 'javascript', 'javascript:', ':', 'java script:alert(1)', 'javas\u0000cript:alert(1)', '\u0000', 'ja​vascript:alert(1)', 'ｊａｖａｓｃｒｉｐｔ:alert(1)'])],
  ]);
}

function attrName(rng) {
  return rng.weighted([
    [4, () => rng.pick(EVENT_ATTRS)],
    [4, () => rng.pick(URL_ATTRS)],
    [5, () => rng.pick(OTHER_ATTRS)],
    [1, () => `on${caseMix(rng, rng.pick(['error', 'load', 'click', 'mouseover', 'x']))}`],
    [1, () => rng.pick(['=', '"', "'", '/', 'a"b', 'x=y', '<', 'on\u0000error', 'o\nnerror', '`', 'xmlns:xlink', ' onerror', 'href\u0000'])],
  ]);
}

function attrValue(rng, name) {
  const n = name.toLowerCase();
  if (/href|src|action|data$|poster|background|xlink|cite|codebase|ping|manifest/.test(n)) return hostileUrl(rng);
  if (n.startsWith('on')) return rng.pick(['alert(1)', 'alert`1`', 'javascript:alert(1)', "eval(atob('YWxlcnQoMSk='))", '', '"', "'><script>alert(1)</script>"]);
  if (n === 'style') return rng.pick(['background:url(javascript:alert(1))', 'x:expression(alert(1))', 'behavior:url(x.htc)', 'color:red', '-moz-binding:url(x)', '']);
  if (n === 'class') return rng.sample([...NOTE_CLASS_LIST, 'evil', 'x', '"', 'hl"onclick=1', 'checked&#32;todo', 'CHECKED', 'hl todo', ''], rng.int(0, 5)).join(rng.pick([' ', '  ', '\t', '\n', '&#9;', ' ']));
  if (n === 'data-checked') return rng.pick(['true', 'false', '', '1', '0', 'TRUE', ' true ', 'maybe', 'true" onclick="x', '&#116;rue']);
  if (/data-(task|event|note)/.test(n)) return rng.pick(['abc123', 'a_b-C', 'x'.repeat(40), 'x'.repeat(41), '', 'a b', '"><img src=x>', '../x', ' abc ', '&#97;bc', 'abc&quot;onclick=1']);
  return text(rng, rng.int(0, 12));
}

function attribute(rng) {
  const name = attrName(rng);
  const value = attrValue(rng, name);
  const sep = rng.weighted([[10, ' '], [2, '\t'], [2, '\n'], [2, '/'], [2, ''], [1, '\f'], [1, '\r'], [1, ' / ']]);
  return sep + rng.weighted([
    [5, () => `${name}="${value.replace(/"/g, rng.chance(0.5) ? '&quot;' : '"')}"`],
    [3, () => `${name}='${value.replace(/'/g, rng.chance(0.5) ? '&#39;' : "'")}'`],
    [2, () => `${name}=${value.replace(/[\s>]/g, '')}`],
    [1, () => name],
    [1, () => `${name} = "${value}"`],
    [0.5, () => `${name}=\`${value}\``],
    [0.5, () => `${name}="${value}`], // unterminated
  ]);
}

const attrs = (rng) => rng.repeat(rng.small(5), attribute).join('');

/** Random text: words, entities, markup characters, controls and unicode (incl. lone surrogates). */
export function text(rng, len = rng.int(0, 20)) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += rng.weighted([
      [10, () => rng.pick(['a', 'hello', 'x', 'note', 'Todo', ' ', ' ', '  ', 'world', '1', 'script', 'javascript:alert(1)', 'onerror=', 'href'])],
      [3, () => rng.pick(NAMED_ENTITIES)],
      [2, () => encodeNum(rng, (rng.pick([60, 62, 38, 34, 39, 0, 1, 0xd800, 0xdfff, 0x110000, 0x1f600, 9, 10, 13, 65, 0x202e, 0xfeff, 99999999])))],
      [3, () => rng.pick(['<', '>', '&', '"', "'", '=', '/', '!', '-', '?', '`', '\\', ';', '#'])],
      [2, () => rng.pick(WS_CHARS)],
      [2, () => rng.pick(['😀', '\ud800', '\udfff', '́', 'é', 'é', '‮', '⁦', '中文', 'עברית', '\u{1F468}‍\u{1F469}', '\u0000', '\u0085', '�', '￾'])],
    ]);
  }
  return out;
}

const SPECIALS = [
  '<!-- x -->', '<!-->', '<!--->', '<!---->', '<!-- --!>', '<!-- -- >', '<!--', '<!-- <script>alert(1)</script> -->', '<!--[if IE]><script>alert(1)</script><![endif]-->',
  '<![CDATA[<script>alert(1)</script>]]>', '<!DOCTYPE html>', '<!doctype x [<!ENTITY x "y">]>', '<?xml version="1.0"?>', '<?php echo 1 ?>', '<!x>', '<!>', '</ x>', '</>', '<//x>', '</ >',
  '<\\/script>', '<!--><script>alert(1)</script>-->', '<!---><img src=x onerror=alert(1)>-->', '<!-- --!><img src=x onerror=alert(1)>', '--!>', '-->', '< script>', '<<script>',
  '<</script>', '<a<b>', '<p<p>', '</p\u0000>', '<p\u0000>', '<\u0000script>', '<!--\u0000-->', '<!-- a -- b -->', '<!--->-->', '</br>', '</hr>', '<br/>', '<hr/>', '<br />', '</br/>',
];

function tagName(rng) {
  let name = rng.weighted([
    [10, () => rng.pick(ALLOWED_TAGS)],
    [5, () => rng.pick(RAW_TEXT_TAGS)],
    [3, () => rng.pick(DROP_TAGS)],
    [3, () => rng.pick(VOID_TAGS)],
    [3, () => rng.pick(OTHER_TAGS)],
  ]);
  name = caseMix(rng, name);
  if (rng.chance(0.04)) {
    const at = rng.int(0, name.length);
    name = name.slice(0, at) + rng.pick(['\u0000', '\t', '\n', '/', '<', '>', '"', "'", '=', ' ', '​', '\u000b', '\f', '\u0001']) + name.slice(at);
  }
  return name;
}

function rawElement(rng) {
  const tag = rng.pick(RAW_TEXT_TAGS);
  const inner = rng
    .repeat(rng.int(0, 4), () =>
      rng.pick(['<img src=x onerror=alert(1)>', `</${tag}x>`, `</${tag}`, `<\\/${tag}>`, `</${caseMix(rng, tag)} >`, `</${tag}\t>`, `</${tag}/>`, '<!--', '-->', text(rng, 3), '<b>bold</b>', `<${tag}>`]),
    )
    .join('');
  const close = rng.weighted([[5, `</${tag}>`], [2, `</${caseMix(rng, tag)}>`], [1, `</${tag} foo="bar">`], [1, `</${tag}`], [1, '']]);
  return `<${caseMix(rng, tag)}${attrs(rng)}>${inner}${close}`;
}

function node(rng, depth) {
  if (depth > 6) return text(rng, rng.int(0, 4));
  return rng.weighted([
    [30, () => text(rng)],
    [25, () => {
      const name = tagName(rng);
      const open = `<${name}${attrs(rng)}${rng.chance(0.08) ? '/' : ''}>`;
      const kids = rng.repeat(rng.small(4), () => node(rng, depth + 1)).join('');
      const close = rng.weighted([[7, `</${name}>`], [2, ''], [1, `</${tagName(rng)}>`], [0.5, `</${name}${attrs(rng)}>`], [0.3, `</${name}`]]);
      return open + kids + close;
    }],
    [6, () => rawElement(rng)],
    [6, () => rng.pick(SPECIALS)],
    [4, () => `</${tagName(rng)}${rng.chance(0.2) ? attrs(rng) : ''}>`],
    [6, () => (rng.chance(0.5) ? rng.pick(XSS_VECTORS) : mutateString(rng, rng.pick(XSS_VECTORS)))],
    [3, () => charSoup(rng, rng.int(1, 30))],
    [1, () => rng.pick(['<b>', '<div>', '<li>', '<a href="https://x.example">', '<p>', '<ul>', '<svg>', '<h1>']).repeat(rng.int(1, 90))],
  ]);
}

/** A whole hostile document (sometimes truncated or mutated). */
export function hostileHtml(rng) {
  let doc = rng.repeat(rng.int(1, 8), () => node(rng, 0)).join('');
  if (rng.chance(0.15)) doc = doc.slice(0, rng.int(0, doc.length));
  if (rng.chance(0.15)) doc = mutateString(rng, doc, rng.int(1, 6));
  return doc;
}

const SOUP = '<<<>>>///===""\'\'!!--??&&;;##xX::aAscriptSCRIPThrefjavascripton =\t\n\r\f\u0000\u0001 𐀀' + String.fromCharCode(0x2028) + 'img src onerror<!-- -->`\\';
export function charSoup(rng, len = rng.int(0, 200)) {
  let out = '';
  for (let i = 0; i < len; i++) out += rng.chance(0.15) ? rng.pick(['script', 'href', 'onerror', 'javascript:', '<a ', '</', '<!--', '-->', '&#', '&#x', 'style', '<svg', '<img']) : SOUP[rng.int(0, SOUP.length - 1)];
  return out;
}

/** Random edits: delete, insert markup/whitespace/entities, duplicate, swap, case flips. */
export function mutateString(rng, s, edits = rng.int(1, 4)) {
  let cur = s;
  for (let e = 0; e < edits; e++) {
    const at = rng.int(0, cur.length);
    cur = rng.weighted([
      [3, () => cur.slice(0, at) + cur.slice(at + rng.int(1, 4))],
      [3, () => cur.slice(0, at) + rng.pick(['<', '>', '/', '"', "'", '=', ' ', '\t', '\n', '\u0000', '&', ';', '!', '-', '`', 'on', 'x', '&#', ' ']) + cur.slice(at)],
      [2, () => {
        const len = rng.int(1, 12);
        return cur.slice(0, at) + cur.slice(at, at + len) + cur.slice(at);
      }],
      [1, () => (at + 1 < cur.length ? cur.slice(0, at) + cur[at + 1] + cur[at] + cur.slice(at + 2) : cur)],
      [1, () => cur.slice(0, at) + cur.slice(at, at + 8).toUpperCase() + cur.slice(at + 8)],
      [1, () => (at < cur.length ? cur.slice(0, at) + encodeChar(rng, cur[at]) + cur.slice(at + 1) : cur)],
    ]);
  }
  return cur;
}

export const mutateVector = (rng) => mutateString(rng, rng.pick(XSS_VECTORS), rng.int(1, 5));

// ---------------------------------------------------------------- canonical documents

const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'pre', 'blockquote', 'hr']);
const HEADINGS = new Set(['h1', 'h2', 'h3']);
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const CANON_URLS = ['https://example.com/a?b=1&c=2', 'http://x.example', 'https://ex.example/p#f', 'mailto:a@b.example', 'ecosys:task/abc123', 'ecosys:note/n_1#b2', 'https://ex.example/a"b<c>d', 'https://ex.example/&amp;'];
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function canonicalText(rng) {
  let out = '';
  for (let i = rng.int(1, 12); i > 0; i--) {
    out += rng.weighted([
      [10, () => rng.pick(['note', 'Hello', ' ', 'x', 'é', '中文', '😀', 'a b', '"q"', "it's", '=', '/', '\n', '\t', '#tag'])],
      [2, () => rng.pick(['&lt;', '&gt;', '&amp;', '&nbsp;', '&#169;', '&#x1F600;', '&copy;', '&bogus;', '&lt;script&gt;'])],
    ]);
  }
  return out;
}

function canonicalAttrs(rng, tag) {
  const parts = [];
  if (tag === 'a' && rng.chance(0.8)) {
    const url = rng.pick(CANON_URLS);
    parts.push(`href="${escAttr(url)}"`);
    if (/^https?:/i.test(url)) parts.push('rel="noopener noreferrer"');
  }
  if (rng.chance(0.25)) {
    const cls = rng.sample(NOTE_CLASS_LIST, rng.int(1, 3));
    parts.push(`class="${cls.join(' ')}"`);
  }
  if (tag === 'li' && rng.chance(0.4)) parts.push(`data-checked="${rng.pick(['true', 'false'])}"`);
  for (const n of ['data-task', 'data-event', 'data-note']) {
    if (rng.chance(0.08)) parts.push(`${n}="${rng.repeat(rng.int(1, 12), () => ID_CHARS[rng.int(0, ID_CHARS.length - 1)]).join('')}"`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

/** Well-formed allowlisted HTML exactly as sanitizeHtml writes it (so sanitizeHtml must return it unchanged). */
export function canonicalHtml(rng, stack = [], budget = { nodes: rng.int(1, 40) }) {
  let out = '';
  const n = rng.int(0, 5);
  for (let i = 0; i < n && budget.nodes > 0; i++) {
    budget.nodes--;
    if (rng.chance(0.4) || stack.length >= 8) {
      out += canonicalText(rng);
      continue;
    }
    const top = stack[stack.length - 1];
    const options = ALLOWED_TAGS.filter((t) => {
      if (BLOCK.has(t) && stack.includes('p')) return false;
      if (t === 'li' && stack.lastIndexOf('li') > Math.max(stack.lastIndexOf('ul'), stack.lastIndexOf('ol'))) return false;
      if (HEADINGS.has(t) && HEADINGS.has(top)) return false;
      if (t === 'a' && stack.includes('a')) return false;
      return true;
    });
    const tag = rng.pick(options);
    if (tag === 'br' || tag === 'hr') {
      out += `<${tag}${canonicalAttrs(rng, tag)}>`;
      continue;
    }
    out += `<${tag}${canonicalAttrs(rng, tag)}>${canonicalHtml(rng, [...stack, tag], budget)}</${tag}>`;
  }
  return out;
}
