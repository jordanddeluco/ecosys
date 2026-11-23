// notes editor: clipboard. Paste/drop HTML is parsed into an inert DOMParser document and walked through
// the notes allowlist (notes-spec §4 "Sanitization allowlist") into model blocks — its nodes are never
// adopted, rendered, serialized or re-parsed. Copy writes Markdown (text/plain) and HTML rendered from the
// model with data-* attributes, so pasting back into ecosys loses nothing.

import {
  LIST, MAX_BLOCKS, MAX_TEXT, HL_COLORS, isRef, safeHref, normBlock, normRuns, mkRun, isAtom, rMarks, rAttrs, blockText, isText,
} from './model.js';

export const MAX_PASTE = 2_000_000;

// ------------------------------------------------------------------ HTML → blocks

const DROP = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'HEAD', 'TITLE', 'META', 'LINK', 'FORM',
  'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'CANVAS', 'VIDEO', 'AUDIO', 'FRAME', 'FRAMESET', 'APPLET', 'MAP', 'DATALIST', 'OPTION',
  'OPTGROUP', 'DIALOG', 'PICTURE', 'SOURCE', 'TRACK', 'PARAM', 'BASE', 'AREA', 'XMP', 'PLAINTEXT', 'NOEMBED', 'NOFRAMES',
]);
const BLOCKISH = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'DD', 'DT', 'DL',
  'CENTER', 'DETAILS', 'SUMMARY', 'HGROUP', 'BODY', 'HTML', 'FIELDSET', 'LEGEND', 'CAPTION',
]);
const HEAD = { H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h3', H5: 'h3', H6: 'h3' };
const OUR_TYPES = new Set(['p', 'h1', 'h2', 'h3', 'bullet', 'dash', 'num', 'check', 'quote', 'code', 'hr']);
const CHECK_LINE = /^\s*(?:☐|☑|☒|✓|✔|-\s\[[ xX]\]|\[[ xX]\])\s*/;

/** Parse HTML into an inert document (no scripts run, nothing is loaded). */
function parseInert(html) {
  return new DOMParser().parseFromString(quietHandlers(html), 'text/html');
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
const isWs = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/**
 * Rename inline event-handler attributes (onclick= → data-x-onclick=) and a <base>'s href before
 * parsing. Nothing in the inert document can run or load, and attributes are never copied; this only
 * keeps Chrome from logging CSP reports (script-src for handlers, base-uri for <base href>) while it
 * parses pasted web content. Comments and raw text are delimited the way the HTML tokenizer does it;
 * their contents are discarded anyway, so handler-like text inside them is renamed too, in case a parser
 * ends them somewhere else (foreign content, script escapes).
 */
export function quietHandlers(html) {
  const s = String(html || '');
  // Handlers follow whitespace, "/" (<svg/onload=…>) or a closing quote (<a b="x"onclick=…>).
  if (!/[\s/"']on[a-z]/i.test(s) && !/<base/i.test(s)) return s;
  const loose = (t) => t.replace(/([\s/"'])(on[a-z])/gi, '$1data-x-$2').replace(/(<base\b[^>]*?[\s/"'])href/gi, '$1data-x-href');
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    i = lt;
    if (s.startsWith('<!--', i)) {
      // "<!-->" and "<!--->" are complete (empty) comments; otherwise the first "-->" or "--!>" ends one.
      let stop;
      if (s[i + 4] === '>') stop = i + 5;
      else if (s[i + 4] === '-' && s[i + 5] === '>') stop = i + 6;
      else {
        const a = s.indexOf('-->', i + 4);
        const b = s.indexOf('--!>', i + 4);
        const end = a < 0 ? b : b < 0 ? a : Math.min(a, b);
        stop = end < 0 ? n : end + (end === b ? 4 : 3);
      }
      out += loose(s.slice(i, stop));
      i = stop;
      continue;
    }
    const c = s[i + 1] || '';
    if (!/[a-zA-Z]/.test(c)) {
      // End tags (their attributes are ignored), doctype, bogus comments (<!x…>, <?…>, </ …>): up to
      // the next '>'. Only the bogus comments' discarded text gets the loose renaming.
      const gt = c === '/' || c === '!' || c === '?' ? s.indexOf('>', i) : -1;
      const stop = gt < 0 ? i + 1 : gt + 1;
      const endTag = c === '/' && /[a-zA-Z]/.test(s[i + 2] || '');
      out += endTag ? s.slice(i, stop) : loose(s.slice(i, stop));
      i = stop;
      continue;
    }
    // A start tag: name, then attributes (quoted values may contain '>').
    let j = i + 1;
    while (j < n && !isWs(s[j]) && s[j] !== '/' && s[j] !== '>') j++;
    const name = s.slice(i + 1, j).toLowerCase();
    let tag = s.slice(i, j);
    while (j < n && s[j] !== '>') {
      if (isWs(s[j]) || s[j] === '/') {
        tag += s[j++];
        continue;
      }
      let k = j;
      while (k < n && !isWs(s[k]) && s[k] !== '/' && s[k] !== '>' && s[k] !== '=') k++;
      let attr = s.slice(j, k);
      if (k === j) {
        tag += s[j++];
        continue;
      }
      if (/^on/i.test(attr)) attr = `data-x-${attr}`;
      else if (name === 'base' && /^href$/i.test(attr)) attr = 'data-x-href'; // never sets a base URL
      tag += attr;
      j = k;
      let w = j;
      while (w < n && isWs(s[w])) w++;
      if (s[w] === '=') {
        tag += s.slice(j, w + 1);
        j = w + 1;
        while (j < n && isWs(s[j])) tag += s[j++];
        const q = s[j];
        if (q === '"' || q === "'") {
          const e = s.indexOf(q, j + 1);
          const stop = e < 0 ? n : e + 1;
          tag += s.slice(j, stop);
          j = stop;
        } else {
          let e = j;
          while (e < n && !isWs(s[e]) && s[e] !== '>') e++;
          tag += s.slice(j, e);
          j = e;
        }
      }
    }
    if (j < n) tag += '>';
    out += tag;
    i = j + 1;
    if (RAW_TEXT.has(name)) {
      // Raw text is not markup (in HTML content): through to the matching end tag. Inside <svg>/<math>
      // the same tags hold markup, so handler-like text in it is renamed too (it is all dropped).
      const re = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
      re.lastIndex = i;
      const m = re.exec(s);
      const stop = m ? m.index : n;
      out += loose(s.slice(i, stop));
      i = stop;
    }
  }
  return out;
}

/**
 * Clipboard HTML → blocks.
 * opts.refOk(ref) may reject chips whose target does not exist; opts.hl is the default highlight colour.
 */
export function htmlToBlocks(html, { refOk = () => true, hl = 'purple' } = {}) {
  const src = String(html || '').slice(0, MAX_PASTE);
  const docu = parseInert(src);
  const blocks = [];
  let cur = null;
  let total = 0;
  const listStack = [];
  let quote = 0;

  const flush = () => {
    if (!cur) return;
    // A <br> at the very end of a block is the paragraph's own line end.
    const last = cur.c[cur.c.length - 1];
    if (last && !isAtom(last) && last[0].endsWith('\n')) last[0] = last[0].slice(0, -1);
    // Trim the collapsed whitespace at both ends of the line.
    if (cur.t !== 'code') {
      while (cur.c.length && !isAtom(cur.c[0]) && /^ /.test(cur.c[0][0])) {
        cur.c[0][0] = cur.c[0][0].replace(/^ +/, '');
        if (!cur.c[0][0]) cur.c.shift();
        else break;
      }
      let l = cur.c[cur.c.length - 1];
      while (l && !isAtom(l) && / $/.test(l[0])) {
        l[0] = l[0].replace(/ +$/, '');
        if (!l[0]) {
          cur.c.pop();
          l = cur.c[cur.c.length - 1];
        } else break;
      }
    }
    if (cur.c.length || cur.explicit) {
      if (blocks.length < MAX_BLOCKS) blocks.push(cur);
    }
    cur = null;
  };
  const start = (t, fields = {}, explicit = false) => {
    flush();
    cur = { t, ...fields, c: [], explicit };
  };
  const ctxType = () => (quote > 0 ? 'quote' : 'p');
  const ensure = () => {
    if (!cur) cur = { t: ctxType(), c: [], explicit: false };
  };
  const pushText = (text, marks, attrs, pre) => {
    if (!text) return;
    let t = text.replace(/\u00a0/g, ' ');
    if (!pre) {
      t = t.replace(/[\t\n\r\f ]+/g, ' ');
      ensure();
      const prev = cur.c[cur.c.length - 1];
      const atLineStart = !prev || (!isAtom(prev) && /[\n ]$/.test(prev[0]));
      if (atLineStart) t = t.replace(/^ /, '');
      if (!t) return;
    } else ensure();
    if (total + t.length > MAX_TEXT * 50) return;
    total += t.length;
    cur.c.push([t, marks, attrs]);
  };

  const styleMarks = (n, marks, attrs) => {
    let m = marks;
    let a = attrs;
    const st = n.style;
    if (!st) return [m, a];
    const fw = st.fontWeight;
    if (fw === 'bold' || fw === 'bolder' || (/^\d+$/.test(fw) && +fw >= 600)) m += 'b';
    if (/^(normal|[1-5]00)$/.test(fw) && n.tagName === 'B') m = m.replace('b', ''); // Google Docs wrapper
    if (st.fontStyle === 'italic' || st.fontStyle === 'oblique') m += 'i';
    const deco = `${st.textDecorationLine || ''} ${st.textDecoration || ''}`;
    if (/underline/.test(deco)) m += 'u';
    if (/line-through/.test(deco)) m += 's';
    if (n.dataset && n.dataset.hl && HL_COLORS.includes(n.dataset.hl)) a = { ...(a || {}), hl: n.dataset.hl };
    return [m, a];
  };

  const wordList = (n) => {
    const st = n.getAttribute && n.getAttribute('style');
    const m = st && /mso-list:\s*l\d+\s+level(\d+)/i.exec(st);
    return m ? Math.min(6, Math.max(0, +m[1] - 1)) : null;
  };

  const walk = (node, marks, attrs, pre) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        pushText(ch.data, marks, attrs, pre);
        continue;
      }
      if (ch.nodeType === 8) {
        // Word's conditional comments wrap list glyphs; their content is never ours.
        continue;
      }
      if (ch.nodeType !== 1) continue;
      const tag = ch.tagName.toUpperCase();
      if (tag === 'INPUT' && (ch.getAttribute('type') || '').toLowerCase() === 'checkbox') {
        if (cur && LIST.has(cur.t)) {
          cur.t = 'check';
          cur.ck = ch.hasAttribute('checked');
        }
        continue;
      }
      if (DROP.has(tag)) continue;
      const st = ch.getAttribute('style') || '';
      if (/mso-list:\s*Ignore/i.test(st)) continue;
      if (tag === 'BR') {
        if (pre) pushText('\n', marks, attrs, true);
        else {
          ensure();
          cur.c.push(['\n', marks, attrs]);
        }
        continue;
      }
      if (tag === 'IMG') {
        const href = safeHref(ch.getAttribute('src') || '');
        if (href && /^https?:/i.test(href)) pushText(ch.getAttribute('alt') || 'Image', marks, { ...(attrs || {}), href }, pre);
        continue;
      }
      if (tag === 'HR') {
        flush();
        blocks.push({ t: 'hr' });
        continue;
      }
      // Our own copy output carries exact types.
      const ours = ch.dataset && OUR_TYPES.has(ch.dataset.type) ? ch.dataset.type : null;
      if (tag === 'PRE' || (ours === 'code' && tag !== 'CODE')) {
        start('code', {}, true);
        const lang = ch.dataset?.lang || /language-([\w+-]{1,20})/.exec(ch.querySelector('code')?.className || '')?.[1];
        if (lang) cur.lang = lang;
        walk(ch, '', null, true);
        flush();
        continue;
      }
      if (tag === 'UL' || tag === 'OL') {
        flush();
        const startAt = tag === 'OL' && /^\d+$/.test(ch.getAttribute('start') || '') ? +ch.getAttribute('start') : null;
        listStack.push({ ordered: tag === 'OL', start: startAt, first: true, check: /contains-task-list/.test(ch.className || '') });
        walk(ch, marks, attrs, pre);
        listStack.pop();
        flush();
        continue;
      }
      if (tag === 'LI') {
        const L = listStack[listStack.length - 1];
        if (!L && !ours) {
          start(ctxType());
          walk(ch, marks, attrs, pre);
          flush();
          continue;
        }
        let t = ours && LIST.has(ours) ? ours : L?.ordered ? 'num' : 'bullet';
        const fields = { in: Math.min(6, Math.max(0, ch.dataset?.in != null ? +ch.dataset.in || 0 : listStack.length - 1)) };
        if (/task-list-item/.test(ch.className || '')) t = 'check';
        if (ours === 'check' || ch.dataset?.checked != null) {
          t = 'check';
          fields.ck = ch.dataset.checked === 'true';
        }
        if (t === 'num' && L?.first && L.start != null && L.start !== 1) fields.start = L.start;
        if (L) L.first = false;
        start(t, fields, true);
        cur.li = true;
        walk(ch, marks, attrs, pre);
        flush();
        continue;
      }
      if (cur && cur.li && (tag === 'P' || tag === 'DIV')) {
        // Loose lists (<li><p>…</p></li>): paragraphs stay in the item, as soft breaks after the first.
        if (cur.c.length) cur.c.push(['\n', marks, attrs]);
        walk(ch, marks, attrs, pre);
        continue;
      }
      if (HEAD[tag] || BLOCKISH.has(tag) || tag === 'BLOCKQUOTE' || tag === 'TABLE' || tag === 'TR' || tag === 'TBODY' || tag === 'THEAD' || tag === 'TFOOT' || (ours && tag !== 'SPAN' && tag !== 'A' && tag !== 'CODE')) {
        if (tag === 'BLOCKQUOTE') {
          flush();
          quote++;
          walk(ch, marks, attrs, pre);
          quote--;
          flush();
          continue;
        }
        if (tag === 'TABLE' || tag === 'TBODY' || tag === 'THEAD' || tag === 'TFOOT') {
          flush();
          walk(ch, marks, attrs, pre);
          flush();
          continue;
        }
        if (tag === 'TR') {
          start(ctxType(), {}, true);
          let firstCell = true;
          for (const cell of ch.children) {
            if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
            if (!firstCell) pushText(' | ', marks, attrs, true);
            firstCell = false;
            walk(cell, marks, attrs, false);
          }
          flush();
          continue;
        }
        const level = wordList(ch);
        if (level !== null) {
          // Word list paragraph: the glyph span (mso-list:Ignore) tells numbered from bulleted.
          const glyph = ch.querySelector('[style*="mso-list"]');
          const g = (glyph?.textContent || '').trim();
          const t = /^\(?[0-9a-zA-Z]{1,4}[.)]/.test(g) ? 'num' : /^[☐☑☒]/.test(g) ? 'check' : 'bullet';
          start(t, { in: level, ...(t === 'check' ? { ck: /^[☑☒]/.test(g) } : {}) }, true);
          walk(ch, marks, attrs, pre);
          flush();
          continue;
        }
        let t = HEAD[tag] || (ours && ours !== 'hr' ? ours : ctxType());
        const fields = {};
        if (ours && LIST.has(ours)) fields.in = Math.min(6, Math.max(0, +ch.dataset.in || 0));
        if (ours === 'check') fields.ck = ch.dataset.checked === 'true';
        if (t === 'p' && quote > 0) t = 'quote';
        start(t, fields, tag === 'P' || !!HEAD[tag] || !!ours);
        walk(ch, marks, attrs, pre);
        flush();
        continue;
      }
      if (tag === 'TD' || tag === 'TH') {
        walk(ch, marks, attrs, pre);
        continue;
      }
      // Inline elements.
      let m = marks;
      let a = attrs;
      if (tag === 'B' || tag === 'STRONG') {
        const id = ch.getAttribute('id') || '';
        if (!(tag === 'B' && /^docs-internal-guid/.test(id))) m += 'b';
      } else if (tag === 'I' || tag === 'EM' || tag === 'CITE' || tag === 'DFN' || tag === 'VAR') m += 'i';
      else if (tag === 'U' || tag === 'INS') m += 'u';
      else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') m += 's';
      else if ((tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') && !pre) m += 'c';
      else if (tag === 'MARK') a = { ...(a || {}), hl: HL_COLORS.includes(ch.dataset?.hl) ? ch.dataset.hl : hl };
      if (tag === 'A' || tag === 'SPAN') {
        const ref = ch.dataset?.ref;
        if (ref && isRef(ref) && refOk(ref)) {
          if (ch.dataset.atom != null) {
            const label = (ch.textContent || '').replace(/\s+/g, ' ').trim();
            if (label) {
              ensure();
              const at = { ref, atom: 1 };
              if (a?.hl) at.hl = a.hl;
              cur.c.push([label, '', at]);
            }
            continue;
          }
          a = { ...(a || {}), ref };
        } else if (tag === 'A') {
          const href = safeHref(ch.getAttribute('href') || '');
          if (href) a = { ...(a || {}), href };
        }
      }
      [m, a] = styleMarks(ch, m, a);
      walk(ch, m, a, pre);
    }
  };
  walk(docu.body || docu.documentElement, '', null, false);
  flush();
  // Plain-text checklist lines ("☐ milk", "- [ ] eggs", "[x] done").
  for (const b of blocks) {
    if (b.t !== 'p' && b.t !== 'bullet' && b.t !== 'dash') continue;
    const text = b.c.map((r) => r[0]).join('');
    const m = CHECK_LINE.exec(text);
    if (!m || !m[0].trim()) continue;
    b.ck = /[☑☒✓✔xX]/.test(m[0]);
    b.in = b.in || 0;
    b.t = 'check';
    let cut = m[0].length;
    while (cut > 0 && b.c.length) {
      const r = b.c[0];
      if (r[0].length <= cut) {
        cut -= r[0].length;
        b.c.shift();
      } else {
        b.c[0] = [r[0].slice(cut), r[1], r[2]];
        cut = 0;
      }
    }
  }
  return finish(blocks);
}

function finish(raw) {
  const used = new Set();
  const out = [];
  for (const b of raw) {
    if (out.length >= MAX_BLOCKS) break;
    const n = normBlock(b, used);
    if (n) out.push(n);
  }
  // Drop leading / trailing empty Body lines the HTML structure produced.
  while (out.length > 1 && isText(out[0]) && out[0].t === 'p' && !blockText(out[0])) out.shift();
  while (out.length > 1 && isText(out[out.length - 1]) && out[out.length - 1].t === 'p' && !blockText(out[out.length - 1])) out.pop();
  return out;
}

// ------------------------------------------------------------------ plain text → blocks

const LIST_MARK = /^\s*(?:[-*+•]\s+\[[ xX]\]\s+|\[[ xX]?\]\s+|[☐☑☒]\s*|[-*+•]\s+|\d{1,9}[.)]\s+)/;

/** "Looks like Markdown": block markers at a line start, **bold** or [text](url). */
export function looksLikeMarkdown(text) {
  return /^(?:#{1,3} |[*-] |\d+[.)] |- \[[ xX]\] |> |```)/m.test(text) || /\*\*[^*\n]+\*\*/.test(text) || /\[[^\]\n]+\]\([^)\s]+\)/.test(text);
}

/**
 * Plain text → blocks: one block per line (blank lines kept). Inside a list or checklist item the lines
 * become items of that type, with their own markers stripped.
 */
export function textToBlocks(text, { type = 'p', indent = 0 } = {}) {
  const src = String(text || '').slice(0, MAX_PASTE).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const raw = [];
  for (const line of lines.slice(0, MAX_BLOCKS)) {
    if (LIST.has(type)) {
      const m = LIST_MARK.exec(line);
      const body = m ? line.slice(m[0].length) : line.replace(/^\s+/, '');
      const ck = type === 'check' && !!m && /[xX☑☒]/.test(m[0]);
      raw.push({ t: type, in: indent, ...(type === 'check' ? { ck } : {}), c: [[body]] });
    } else raw.push({ t: 'p', c: [[line]] });
  }
  const used = new Set();
  return raw.map((b) => normBlock(b, used)).filter(Boolean);
}

/** A lightweight Markdown reader, used when notes/core/markdown.js isn't loaded. */
export function markdownLite(text) {
  const src = String(text || '').slice(0, MAX_PASTE).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const raw = [];
  let code = null;
  // Indent unit: the smallest indentation used by a list line (2–4 spaces or a tab), default 4.
  let unit = 4;
  for (const line of lines) {
    const m = /^( +|\t+)(?:[-*+]|\d{1,9}[.)])\s/.exec(line);
    if (m) unit = Math.min(unit, Math.max(2, m[1].replace(/\t/g, '    ').length));
  }
  for (const line of lines) {
    if (code) {
      if (/^```\s*$/.test(line)) {
        raw.push({ t: 'code', lang: code.lang, c: [[code.lines.join('\n')]] });
        code = null;
      } else code.lines.push(line);
      continue;
    }
    const fence = /^```([\w+-]{0,20})\s*$/.exec(line);
    if (fence) {
      code = { lang: fence[1] || undefined, lines: [] };
      continue;
    }
    const ind = /^(\s*)/.exec(line)[1].replace(/\t/g, '    ').length;
    const lvl = Math.min(6, Math.floor(ind / unit));
    const t = line.trimStart();
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) raw.push({ t: `h${Math.min(3, m[1].length)}`, c: inlineMd(m[2]) });
    else if ((m = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(t))) raw.push({ t: 'check', in: lvl, ck: m[1] !== ' ', c: inlineMd(m[2]) });
    else if ((m = /^\*\s+(.*)$/.exec(t)) || (m = /^\+\s+(.*)$/.exec(t))) raw.push({ t: 'bullet', in: lvl, c: inlineMd(m[1]) });
    else if ((m = /^-\s+(.*)$/.exec(t))) raw.push({ t: 'dash', in: lvl, c: inlineMd(m[1]) });
    else if ((m = /^(\d{1,9})[.)]\s+(.*)$/.exec(t))) raw.push({ t: 'num', in: lvl, start: +m[1], c: inlineMd(m[2]) });
    else if ((m = /^>\s?(.*)$/.exec(t))) raw.push({ t: 'quote', c: inlineMd(m[1]) });
    else if (/^(?:---|\*\*\*|___)\s*$/.test(t)) raw.push({ t: 'hr' });
    else raw.push({ t: 'p', c: inlineMd(line) });
  }
  if (code) raw.push({ t: 'code', lang: code.lang, c: [[code.lines.join('\n')]] });
  // Numbered runs keep only the first start.
  for (let i = 1; i < raw.length; i++) if (raw[i].t === 'num' && raw[i - 1].t === 'num') delete raw[i].start;
  const used = new Set();
  return raw.map((b) => normBlock(b, used)).filter(Boolean);
}

/** Inline Markdown: **b**, *i* / _i_, ~~s~~, `c`, ==h==, <u>u</u>, [t](url), backslash escapes. HTML is text. */
export function inlineMd(s) {
  const out = [];
  const re = /\\([\\`*_{}[\]()#+\-.!~=<>|])|\*\*([^*\n]+?)\*\*|~~([^~\n]+?)~~|==([^=\n]+?)==|`([^`\n]+?)`|<u>([^<\n]+?)<\/u>|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*([^*\n]+?)\*(?!\w)|(?<![\w_])_([^_\n]+?)_(?!\w)/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push([s.slice(last, m.index)]);
    if (m[1]) out.push([m[1]]);
    else if (m[2]) out.push(...inlineMd(m[2]).map((r) => mkRun(r[0], (r[1] || '') + 'b', r[2])));
    else if (m[3]) out.push(...inlineMd(m[3]).map((r) => mkRun(r[0], (r[1] || '') + 's', r[2])));
    else if (m[4]) out.push(...inlineMd(m[4]).map((r) => mkRun(r[0], r[1], { ...(r[2] || {}), hl: 'purple' })));
    else if (m[5]) out.push([m[5], 'c']);
    else if (m[6]) out.push([m[6], 'u']);
    else if (m[7]) {
      const href = safeHref(m[8]);
      out.push(...inlineMd(m[7]).map((r) => (href ? mkRun(r[0], r[1], { ...(r[2] || {}), href }) : r)));
    } else if (m[9]) out.push(...inlineMd(m[9]).map((r) => mkRun(r[0], (r[1] || '') + 'i', r[2])));
    else if (m[10]) out.push(...inlineMd(m[10]).map((r) => mkRun(r[0], (r[1] || '') + 'i', r[2])));
    last = re.lastIndex;
  }
  if (last < s.length) out.push([s.slice(last)]);
  return normRuns(out);
}

// ------------------------------------------------------------------ blocks → HTML / Markdown / text

const H = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function runsHtml(runs) {
  let s = '';
  for (const r of runs) {
    const a = rAttrs(r);
    if (isAtom(r)) {
      s += `<span data-ref="${H(a.ref)}" data-atom="1"${a.hl ? ` data-hl="${H(a.hl)}"` : ''}>${H(r[0])}</span>`;
      continue;
    }
    let t = H(r[0]).replace(/\n/g, '<br>');
    const m = rMarks(r);
    if (m.includes('c')) t = `<code>${t}</code>`;
    if (m.includes('s')) t = `<s>${t}</s>`;
    if (m.includes('u')) t = `<u>${t}</u>`;
    if (m.includes('i')) t = `<em>${t}</em>`;
    if (m.includes('b')) t = `<strong>${t}</strong>`;
    if (a?.hl) t = `<mark data-hl="${H(a.hl)}">${t}</mark>`;
    if (a?.href) t = `<a href="${H(a.href)}">${t}</a>`;
    else if (a?.ref) t = `<a data-ref="${H(a.ref)}">${t}</a>`;
    s += t;
  }
  return s;
}

/** Blocks → clipboard HTML (lists properly nested; data-* attributes make in-app paste lossless). */
export function blocksToHtml(blocks) {
  let s = '';
  const stack = []; // open lists: {tag, level}
  const closeTo = (level) => {
    while (stack.length && stack[stack.length - 1].level >= level) s += `</li></${stack.pop().tag}>`;
  };
  for (let i = 0; i < blocks.length; i++) {
    // Every interpolated field is checked here too, whoever calls this.
    const raw = blocks[i] || {};
    const t = OUR_TYPES.has(raw.t) ? raw.t : 'p';
    const b = { t, in: Number.isInteger(raw.in) ? Math.min(6, Math.max(0, raw.in)) : 0, ck: raw.ck === true, start: Number.isInteger(raw.start) ? raw.start : undefined, lang: typeof raw.lang === 'string' ? raw.lang : '', c: Array.isArray(raw.c) ? raw.c : [] };
    if (LIST.has(b.t)) {
      const L = b.in;
      const tag = b.t === 'num' ? 'ol' : 'ul';
      while (stack.length && stack[stack.length - 1].level > L) s += `</li></${stack.pop().tag}>`;
      const top = stack[stack.length - 1];
      if (top && top.level === L && top.tag !== tag) {
        s += `</li></${stack.pop().tag}>`;
      }
      const cur = stack[stack.length - 1];
      if (cur && cur.level === L) s += '</li>';
      else {
        while (stack.length < L) {
          s += `<ul><li style="list-style:none">`;
          stack.push({ tag: 'ul', level: stack.length });
        }
        const start = b.t === 'num' && Number.isInteger(b.start) && b.start !== 1 ? ` start="${b.start}"` : '';
        s += `<${tag}${start}${b.t === 'check' ? ' class="contains-task-list"' : ''}>`;
        stack.push({ tag, level: L });
      }
      const attrs = ` data-type="${b.t}" data-in="${L}"${b.t === 'check' ? ` data-checked="${b.ck ? 'true' : 'false'}" class="task-list-item"` : ''}`;
      s += `<li${attrs}>${runsHtml(b.c)}`;
      continue;
    }
    closeTo(0);
    if (b.t === 'hr') s += '<hr>';
    else if (b.t === 'code') s += `<pre data-type="code"${b.lang ? ` data-lang="${H(b.lang)}"` : ''}><code>${H(blockText(b))}</code></pre>`;
    else if (b.t === 'quote') s += `<blockquote data-type="quote"><p>${runsHtml(b.c) || '<br>'}</p></blockquote>`;
    else {
      const tag = b.t === 'p' ? 'p' : b.t;
      s += `<${tag}${b.t === 'p' ? '' : ` data-type="${b.t}"`}>${runsHtml(b.c) || '<br>'}</${tag}>`;
    }
  }
  closeTo(0);
  return s;
}

/** Inline Markdown for runs (fallback serializer). */
function runsMd(runs) {
  let s = '';
  for (const r of runs) {
    const a = rAttrs(r);
    if (isAtom(r)) {
      s += a.ref.startsWith('note:') ? `[[${r[0]}]]` : a.ref.startsWith('day:') ? `[[${a.ref.slice(4)}]]` : `[${escMd(r[0])}](ecosys://${a.ref.replace(':', '/')})`;
      continue;
    }
    const m = rMarks(r);
    let t = m.includes('c') ? `\`${r[0]}\`` : escMd(r[0]).replace(/\n/g, '\\\n');
    if (m.includes('u')) t = `<u>${t}</u>`;
    if (m.includes('s')) t = `~~${t}~~`;
    if (m.includes('i')) t = `*${t}*`;
    if (m.includes('b')) t = `**${t}**`;
    if (a?.hl) t = `==${t}==`;
    if (a?.href) t = `[${t}](${a.href})`;
    else if (a?.ref) t = `[${t}](ecosys://${a.ref.replace(':', '/')})`;
    s += t;
  }
  return s;
}
const escMd = (s) => s.replace(/([\\*_~`[\]<#])/g, '\\$1');

/** Blocks → Markdown (fallback when notes/core/markdown.js isn't available). */
export function markdownLiteOut(blocks) {
  const lines = [];
  let num = new Map();
  blocks.forEach((b, i) => {
    const pad = '    '.repeat(b.in || 0);
    if (b.t !== 'num') num = b.t === 'bullet' || b.t === 'dash' || b.t === 'check' ? num : new Map();
    if (b.t === 'h1' || b.t === 'h2' || b.t === 'h3') lines.push(`${'#'.repeat(+b.t[1])} ${runsMd(b.c)}`);
    else if (b.t === 'bullet') lines.push(`${pad}* ${runsMd(b.c)}`);
    else if (b.t === 'dash') lines.push(`${pad}- ${runsMd(b.c)}`);
    else if (b.t === 'check') lines.push(`${pad}- [${b.ck ? 'x' : ' '}] ${runsMd(b.c)}`);
    else if (b.t === 'num') {
      const L = b.in || 0;
      const n = num.has(L) ? num.get(L) + 1 : Number.isInteger(b.start) ? b.start : 1;
      num.set(L, n);
      lines.push(`${pad}${n}. ${runsMd(b.c)}`);
    } else if (b.t === 'quote') lines.push(`> ${runsMd(b.c)}`);
    else if (b.t === 'hr') lines.push('---');
    else if (b.t === 'code') lines.push('```' + (b.lang || ''), blockText(b), '```');
    else lines.push(runsMd(b.c).replace(/^(\d+)\./, '$1\\.'));
    if (i < blocks.length - 1 && (b.t === 'p' || b.t.startsWith('h') || b.t === 'code' || b.t === 'quote' || b.t === 'hr')) {
      const n = blocks[i + 1];
      if (n.t === 'p' || n.t.startsWith('h')) lines.push('');
    }
  });
  return lines.join('\n');
}

/** Plain text of blocks (one line per block; list markers kept as text). */
export function blocksToText(blocks) {
  return blocks.map((b) => (b.t === 'hr' ? '---' : blockText(b))).join('\n');
}
