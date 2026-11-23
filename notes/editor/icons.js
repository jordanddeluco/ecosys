// notes editor: line icons built with createElementNS (the editor never parses HTML strings; svgMarkup only
// hands a shared menu one of these constant glyphs as markup). Same 24-grid, 1.8-stroke family as
// shared/icons.js; a few editor-only glyphs are added here.

const NS = 'http://www.w3.org/2000/svg';

const P = {
  bold: ['M7 4.5h6a3.75 3.75 0 0 1 0 7.5H7zM7 12h7a3.75 3.75 0 0 1 0 7.5H7z'],
  italic: ['M18.5 4.5h-8M13.5 19.5h-8M14.5 4.5l-5 15'],
  underline: ['M7 4v7a5 5 0 0 0 10 0V4M5 20.5h14'],
  strikethrough: ['M16.5 6.8A4.5 4.5 0 0 0 12.2 4.5c-2.6 0-4.3 1.5-4.3 3.4 0 1.4.8 2.4 2.4 3.1M4 12h16M7.6 16.6c.7 1.8 2.3 2.9 4.6 2.9 2.7 0 4.4-1.5 4.4-3.5a3 3 0 0 0-.7-2'],
  code: ['m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5'],
  link: ['M10 13.5a4 4 0 0 0 5.7.4l2.7-2.7a4 4 0 0 0-5.7-5.7l-1.5 1.5', 'M14 10.5a4 4 0 0 0-5.7-.4l-2.7 2.7a4 4 0 0 0 5.7 5.7l1.5-1.5'],
  unlink: ['M10 13.5a4 4 0 0 0 5.7.4l2.7-2.7a4 4 0 0 0-5.7-5.7l-1.5 1.5', 'M14 10.5a4 4 0 0 0-5.7-.4l-2.7 2.7a4 4 0 0 0 5.7 5.7l1.5-1.5', 'M4 4l16 16'],
  bullets: ['M9.5 6h11M9.5 12h11M9.5 18h11'], // + the solid dots in DOTTED
  dashes: ['M10.5 6h10M10.5 12h10M10.5 18h10M3 6h3.6M3 12h3.6M3 18h3.6'],
  numbers: ['M10.5 6h10M10.5 12h10M10.5 18h10M4 4.5h1.5V9M3.8 9h3.4M4 14.4a1.5 1.5 0 0 1 2.9.6c0 1.1-3 1.9-3 3.5h3.1'],
  checklist: ['m3.5 6.5 1.6 1.6 3.1-3.2M3.5 14l1.6 1.6 3.1-3.2M11.5 6.6h9M11.5 14.1h9M11.5 20h9'],
  quote: ['M20.5 6h-11M20.5 12h-11M20.5 18h-11M4 5.5v13'],
  heading: ['M6 4.5v15M18 4.5v15M6 12h12'],
  text: ['M5 6.5V5h14v1.5M12 5v14M9.5 19h5'],
  divider: ['M3.5 12h17', 'M7 7.5h10M7 16.5h10'],
  plus: ['M12 5v14M5 12h14'],
  undo: ['M9 14.5 4 9.5l5-5', 'M4 9.5h10.5a5.5 5.5 0 0 1 0 11H11'],
  redo: ['M15 14.5l5-5-5-5', 'M20 9.5H9.5a5.5 5.5 0 0 0 0 11H13'],
  indent: ['M10.5 6h10M10.5 12h10M10.5 18h10M3.5 8.5 7 12l-3.5 3.5'],
  outdent: ['M10.5 6h10M10.5 12h10M10.5 18h10M7 8.5 3.5 12 7 15.5'],
  highlighter: ['m14.5 4.5 5 5-8.6 8.6H6v-4.9z', 'M3.5 20.5h8'],
  'keyboard-hide': ['M5.2 3.5h13.6a2.2 2.2 0 0 1 2.2 2.2v7.6a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 13.3V5.7a2.2 2.2 0 0 1 2.2-2.2z', 'M6.6 7.5h.01M10.2 7.5h.01M13.8 7.5h.01M17.4 7.5h.01M8.5 11.5h7', 'm9 18.8 3 2.5 3-2.5'],
  // A drawn "Aa" (Text styles), so the keyboard bar's format button is a line glyph like its neighbours.
  'text-style': ['M3.4 19 8.6 5.4l5.2 13.6M5.4 14.2h6.4', 'M15.5 16.1a2.75 2.75 0 1 0 5.5 0a2.75 2.75 0 1 0-5.5 0', 'M21 13.35V19'],
  chevron: ['m6 9 6 6 6-6'],
  x: ['M18 6 6 18M6 6l12 12'],
  external: ['M14 3.5h6.5V10M20.5 3.5 11 13M18 14v4.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10'],
  edit: ['M12.5 20.5h8', 'M16.4 3.6a2.1 2.1 0 0 1 3 3L7.3 18.7l-4 1 1-4z'],
  calendar: ['M6.5 4.5h11A3.5 3.5 0 0 1 21 8v9.5a3.5 3.5 0 0 1-3.5 3.5h-11A3.5 3.5 0 0 1 3 17.5V8a3.5 3.5 0 0 1 3.5-3.5zM16 2.8v3.6M8 2.8v3.6M3 9.8h18'],
  // The Notes logo's sheet, fold, wave and caret dot (+ DOTTED.note), as in shared/icons.js.
  note: ['M14.5 2.8H7.1A2.6 2.6 0 0 0 4.5 5.4V18.6A2.6 2.6 0 0 0 7.1 21.2H16.9A2.6 2.6 0 0 0 19.5 18.6V7.8Z', 'M14.5 2.8V6.2A1.6 1.6 0 0 0 16.1 7.8H19.5', 'M7.4 15.2c.7-1.62 1.49-1.62 2.19 0s1.49 1.62 2.19 0'],
  'note-plus': ['M14.5 2.8H7.1A2.6 2.6 0 0 0 4.5 5.4V18.6A2.6 2.6 0 0 0 7.1 21.2H16.9A2.6 2.6 0 0 0 19.5 18.6V7.8Z', 'M14.5 2.8V6.2A1.6 1.6 0 0 0 16.1 7.8H19.5', 'M12 11.6v6M9 14.6h6'],
  repeat: ['m17 2.5 3.5 3.5L17 9.5', 'M3.5 11.5V10a4 4 0 0 1 4-4h13', 'm7 21.5-3.5-3.5L7 14.5', 'M20.5 12.5V14a4 4 0 0 1-4 4h-13'],
  // Send to Tasks: a check that goes on (an arrow), unlike share or upload.
  'send-task': ['M3.2 11.9 6.4 15.1 11.6 8.9', 'M14.4 11.9h6.4M17.8 8.9l3 3-3 3'],
  hash: ['M9.5 3.5 7.5 20.5M16.5 3.5l-2 17M4 8.5h17M3 15.5h17'],
};

// Solid dots (fill) for the grip.
const DOTS = { grip: [[9, 6], [15, 6], [9, 12], [15, 12], [9, 18], [15, 18]] };
// Solid dots drawn with a line icon's strokes ([cx, cy, r]): list bullets read as bullets, not lines.
const DOTTED = { bullets: [[4.7, 6, 1.9], [4.7, 12, 1.9], [4.7, 18, 1.9]], note: [[15.6, 15.2, 1.7]] };

// Without a stroke, small glyphs draw heavier lines (2.2 up to 14px, 2 up to 16px, else 1.8), so a 12–14px glyph
// next to 12px text doesn't look washed out (the same rule as shared/icons.js).
const strokeFor = (s, stroke) => Number(stroke) || (s <= 14 ? 2.2 : s <= 16 ? 2 : 1.8);

/** An SVG icon element (see strokeFor for the default stroke). */
export function svgIcon(name, { size = 18, stroke, cls = '' } = {}) {
  const s = Number(size) || 18;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(s));
  svg.setAttribute('height', String(s));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `i ne-i${cls ? ` ${cls}` : ''}`);
  if (DOTS[name]) {
    for (const [cx, cy] of DOTS[name]) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', String(cy));
      c.setAttribute('r', '1.5');
      c.setAttribute('fill', 'currentColor');
      svg.append(c);
    }
    return svg;
  }
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeFor(s, stroke)));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of P[name] || []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  for (const [cx, cy, r] of DOTTED[name] || []) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', String(r));
    c.setAttribute('fill', 'currentColor');
    c.setAttribute('stroke', 'none');
    svg.append(c);
  }
  return svg;
}

/**
 * The same line icon as markup, for a shared component that takes trusted icon markup (shell.js openMenu's
 * iconHtml) and has no glyph of its own for it yet. Built only from this file's constant path data (each
 * value kept to path and number characters), never from anything a user typed.
 */
export function svgMarkup(name, { size = 18, stroke } = {}) {
  const s = Number(size) || 18;
  const num = (v) => String(Number(v) || 0);
  const d = (v) => String(v).replace(/[^\w .,-]/g, '');
  const paths = (P[name] || []).map((p) => `<path d="${d(p)}"/>`).join('');
  const dots = (DOTTED[name] || []).map(([cx, cy, r]) => `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="currentColor" stroke="none"/>`).join('');
  return `<svg class="i ne-i" width="${num(s)}" height="${num(s)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${num(strokeFor(s, stroke))}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}${dots}</svg>`;
}

/** The checklist circle with its tick (the tick draws in with stroke-dashoffset). */
export function checkCircle() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'ne-ck-svg');
  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('cx', '12');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '10.25');
  ring.setAttribute('class', 'ne-ck-ring');
  const tick = document.createElementNS(NS, 'path');
  tick.setAttribute('d', 'M7.4 12.4l3.1 3.1 6.2-6.6');
  tick.setAttribute('class', 'ne-ck-tick');
  tick.setAttribute('pathLength', '1');
  svg.append(ring, tick);
  return svg;
}

/** A small circle for a task chip (checkable in place). */
export function taskCircle(done) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `ne-tc-svg${done ? ' done' : ''}`);
  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('cx', '12');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '9.5');
  svg.append(ring);
  if (done) {
    const tick = document.createElementNS(NS, 'path');
    tick.setAttribute('d', 'M7.6 12.3l3 3 5.8-6.2');
    svg.append(tick);
  }
  return svg;
}

/** Build an element: el('div', {class:'x', 'aria-label':'y'}, child…). Text children become text nodes. */
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}
