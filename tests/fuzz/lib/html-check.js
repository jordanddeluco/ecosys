// Independent checker for sanitizeHtml() output. It does not reuse the sanitizer's tokenizer: it
// re-reads the output with a strict grammar of its own and checks the security contract
// (build-spec section 6) plus the structural guarantees the sanitizer documents:
//
//   - only allowlisted tags; never script/style/iframe/object/embed/svg/math/img/form/... even if a
//     builder extends NOTE_TAGS by mistake; tag names lowercase
//   - only allowlisted attributes, always double-quoted, values without raw " < >, every & a
//     reference; no on* handlers, no style/src/srcdoc/action/formaction
//   - href only on <a>, scheme http/https/mailto/ecosys after the browser's own clean-up (strip
//     leading C0/space, remove tab/newline), no control characters; rel only on http(s) links
//   - class tokens from the allowlist, data-checked only true/false on <li>, data-task/-event/-note ids
//   - text: no raw < or >, every & starts a complete character reference, no C0 controls other
//     than tab/LF/FF/CR, no lone surrogates
//   - well-formed: end tags match, void br/hr never closed, all elements closed, depth <= 64, and
//     the implied-end-tag rules hold (no block inside <p>, no <li> directly in <li>, no <a> in <a>,
//     no heading directly in a heading), so a browser builds exactly this tree.

export const DENY_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'img', 'image', 'form', 'input', 'button', 'textarea', 'select', 'option', 'link', 'meta', 'base',
  'template', 'frame', 'frameset', 'applet', 'video', 'audio', 'source', 'track', 'canvas', 'noscript', 'noembed', 'noframes', 'plaintext', 'xmp', 'title', 'isindex',
  'portal', 'html', 'head', 'body', 'param', 'keygen', 'marquee', 'details', 'dialog', 'slot', 'map', 'area', 'table',
]);
const DENY_ATTR = /^(on|style$|src$|srcdoc$|srcset$|action$|formaction$|xlink:|xmlns|data$|poster$|background$|lowsrc$|dynsrc$|ping$|id$|name$|target$|form$|is$)/;
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'pre', 'blockquote', 'hr']);
const HEADINGS = new Set(['h1', 'h2', 'h3']);
const VOID = new Set(['br', 'hr']);
const ID_RE = /^[a-z0-9_-]{1,40}$/i;
const REF_RE = /&(?:#\d{1,8}|#[xX][0-9a-fA-F]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const ATTR_ENT_RE = /&(?:amp|quot|lt|gt|#39|#x27);/y;
const TAG_RE = /<(\/?)([^\s/>"'=<]*)((?:\s[^\s=/>"'<]+="[^"<>]*")*)\s*(\/?)>/y;
const ATTR_RE = /\s([^\s=/>"'<]+)="([^"<>]*)"/g;
// eslint-disable-next-line no-control-regex
const BAD_TEXT_CTRL = /[\u0000-\u0008\u000B\u000E-\u001F\u007F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const decodeAttr = (v) => v.replace(/&(amp|quot|lt|gt|#39|#x27);/g, (m, n) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'", '#x27': "'" })[n]);

/** What a browser treats as the URL scheme of an href value (after HTML decoding). */
export function browserScheme(decoded) {
  // URL parser: strip leading/trailing C0 control or space, remove ASCII tab and newline anywhere.
  // eslint-disable-next-line no-control-regex
  const u = decoded.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Returns null when `out` satisfies the contract, else {kind, message, at}.
 * opts: { allowedTags (Set), noteClasses (Set), linkAttrs (Set), maxLength, maxDepth }
 */
export function checkSanitized(out, { allowedTags, noteClasses, linkAttrs, maxLength = Infinity, maxDepth = 64 } = {}) {
  const bad = (kind, message, at) => ({ kind, message: `${message} at ${at}: …${JSON.stringify(out.slice(Math.max(0, at - 40), at + 60))}…`, at });
  if (typeof out !== 'string') return { kind: 'type', message: `output is ${typeof out}`, at: 0 };
  if (out.length > maxLength) return { kind: 'length', message: `output length ${out.length} > maxLength ${maxLength}`, at: maxLength };
  if (LONE_SURROGATE.test(out)) return bad('surrogate', 'lone surrogate in output', out.search(LONE_SURROGATE));
  const stack = [];
  let i = 0;
  const n = out.length;
  while (i < n) {
    const c = out[i];
    if (c === '<') {
      TAG_RE.lastIndex = i;
      const m = TAG_RE.exec(out);
      if (!m) return bad('stray-lt', 'raw "<" that does not start a well-formed tag', i);
      const [whole, slash, name, attrText, selfClose] = m;
      if (!/^[a-z][a-z0-9]*$/.test(name)) return bad('tag-name', `tag name ${JSON.stringify(name)} is not lowercase ASCII`, i);
      if (DENY_TAGS.has(name)) return bad('deny-tag', `forbidden element <${name}>`, i);
      if (allowedTags && !allowedTags.has(name)) return bad('tag', `element <${name}> is not allowlisted`, i);
      if (selfClose) return bad('self-close', `self-closing syntax <${name}/>`, i);
      if (slash) {
        if (attrText) return bad('end-attrs', `end tag </${name}> has attributes`, i);
        if (VOID.has(name)) return bad('void-closed', `void element closed: </${name}>`, i);
        const top = stack.pop();
        if (top !== name) return bad('mismatch', `end tag </${name}> but the open element is ${top ? `<${top}>` : 'none'}`, i);
      } else {
        const seen = new Set();
        let href = null;
        let rel = null;
        for (const [, an, av] of attrText.matchAll(ATTR_RE)) {
          if (seen.has(an)) return bad('dup-attr', `duplicate attribute ${an}`, i);
          seen.add(an);
          if (DENY_ATTR.test(an)) return bad('deny-attr', `forbidden attribute ${an}="${av}"`, i);
          for (let k = av.indexOf('&'); k >= 0; k = av.indexOf('&', k + 1)) {
            ATTR_ENT_RE.lastIndex = k;
            if (!ATTR_ENT_RE.test(av)) return bad('attr-amp', `attribute ${an} has an "&" that is not an escape`, i);
          }
          const v = decodeAttr(av);
          // eslint-disable-next-line no-control-regex
          if (/[\u0000-\u001F\u007F]/.test(v)) return bad('attr-ctrl', `control character in attribute ${an}`, i);
          if (an === 'href') {
            if (name !== 'a') return bad('href-tag', `href on <${name}>`, i);
            const scheme = browserScheme(v);
            if (!['http', 'https', 'mailto', 'ecosys'].includes(scheme)) return bad('href-scheme', `href scheme ${JSON.stringify(scheme)} (${JSON.stringify(v.slice(0, 80))})`, i);
            // eslint-disable-next-line no-control-regex
            if (/^[\u0000- ]|[\u0000- ]$/.test(v)) return bad('href-space', 'href keeps leading/trailing space or control characters', i);
            href = v;
          } else if (an === 'rel') {
            if (name !== 'a' || v !== 'noopener noreferrer') return bad('rel', `rel="${v}" on <${name}>`, i);
            rel = v;
          } else if (an === 'class') {
            const toks = v.split(' ');
            if (!v || toks.some((t) => !t) || new Set(toks).size !== toks.length) return bad('class', `class="${v}" is not a clean token list`, i);
            if (noteClasses && toks.some((t) => !noteClasses.has(t))) return bad('class', `class token outside the allowlist in "${v}"`, i);
          } else if (an === 'data-checked') {
            if (name !== 'li' || (v !== 'true' && v !== 'false')) return bad('data-checked', `data-checked="${v}" on <${name}>`, i);
          } else if (an === 'data-task' || an === 'data-event' || an === 'data-note' || (linkAttrs && linkAttrs.has(an))) {
            if (!ID_RE.test(v)) return bad('link-id', `${an}="${v}" is not an id`, i);
          } else {
            return bad('attr', `attribute ${an} is not allowlisted`, i);
          }
        }
        if (rel && !/^https?:/i.test(href || '')) return bad('rel', 'rel without an http(s) href', i);
        if (href && /^https?:/i.test(href) && !rel) return bad('rel', 'http(s) link without rel="noopener noreferrer"', i);
        if (BLOCK.has(name) && stack.includes('p')) return bad('p-block', `<${name}> inside <p> (a browser would close the <p>)`, i);
        if (name === 'li' && stack.lastIndexOf('li') > Math.max(stack.lastIndexOf('ul'), stack.lastIndexOf('ol'))) return bad('li-li', '<li> directly inside <li>', i);
        if (HEADINGS.has(name) && HEADINGS.has(stack[stack.length - 1])) return bad('h-h', `<${name}> directly inside a heading`, i);
        if (name === 'a' && stack.includes('a')) return bad('a-a', '<a> inside <a>', i);
        if (!VOID.has(name)) {
          stack.push(name);
          if (stack.length > maxDepth) return bad('depth', `nesting depth ${stack.length} > ${maxDepth}`, i);
        }
      }
      i += whole.length;
      continue;
    }
    if (c === '>') return bad('stray-gt', 'raw ">" in text', i);
    if (c === '&') {
      REF_RE.lastIndex = i;
      const m = REF_RE.exec(out);
      if (!m) return bad('bare-amp', '"&" in text that does not start a complete character reference', i);
      i += m[0].length;
      continue;
    }
    if (BAD_TEXT_CTRL.test(c)) return bad('text-ctrl', `control character U+${c.charCodeAt(0).toString(16).padStart(4, '0')} in text`, i);
    i++;
  }
  if (stack.length) return bad('unclosed', `unclosed elements at the end: ${stack.join(' > ')}`, n);
  return null;
}

/** Text content of canonical output (tags removed, references decoded) — for data-preservation checks. */
export function textOf(out) {
  return out
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d{1,8}|#[xX][0-9a-fA-F]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, r) => {
      if (r === 'amp') return '&';
      if (r === 'lt') return '<';
      if (r === 'gt') return '>';
      if (r === 'quot') return '"';
      if (r[0] === '#') {
        const cp = r[1] === 'x' || r[1] === 'X' ? parseInt(r.slice(2), 16) : parseInt(r.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
      }
      return m;
    });
}
