// QA regressions for the shell's glyphs, logos and mini calendar (shared/icons.js, shared/icons/, shared/minical.js),
// no browser needed:
//   - icon() draws with an optical size, as the notes editor does: 2.2 at 14px and below, 2 at 15-16px, 1.8 above,
//     and an explicit stroke still wins (keycaps)
//   - the old names of the redrawn glyphs draw the new art until every call site has moved
//   - the date picker's month button keeps its visible word "Today" but is named "Go to today": the quick-date
//     row above it is also "Today", and picks today and closes
//   - every app has a 180px apple-touch icon (iOS ignores SVG icons): an opaque, full-bleed PNG of its maskable logo
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { icon, hasIcon } from '../shared/icons.js';
import { miniCalendar } from '../shared/minical.js';

const ROOT = new URL('../', import.meta.url);
const strokeOf = (svg) => +/stroke-width="([\d.]+)"/.exec(svg)[1];

test('icon(): the line has an optical size, and an explicit stroke wins', () => {
  for (const [size, w] of [[12, 2.2], [13, 2.2], [14, 2.2], [15, 2], [16, 2], [17, 1.8], [18, 1.8], [20, 1.8], [24, 1.8], [26, 1.8]]) {
    assert.equal(strokeOf(icon('check', { size })), w, `${size}px: ${w}`);
  }
  assert.equal(strokeOf(icon('check')), 1.8, 'the default 20px');
  assert.equal(strokeOf(icon('key-command', { size: 12, stroke: 2.2 })), 2.2, 'keycaps keep theirs');
  assert.equal(strokeOf(icon('check', { size: 12, stroke: 3 })), 3, 'a checkbox tick keeps its 3');
  assert.equal(strokeOf(icon('check', { size: 16, stroke: '1.5' })), 1.5, 'a stroke given as text');
  assert.match(icon('check', { size: 16 }), /width="16" height="16"/);
});

test('icon(): an unknown name draws the circle, and markup stays decorative', () => {
  assert.equal(icon('no-such-glyph', { size: 18 }), icon('circle', { size: 18 }));
  assert.match(icon('today'), /aria-hidden="true" focusable="false"/);
  assert.equal(icon('x', { cls: 'a"><script>' }).includes('<script>'), false, 'class text is cleaned');
});

test('the renamed glyphs: old names draw the new art (call sites move over in their own time)', () => {
  const renamed = { sparkle: 'ai', sun: 'tomorrow', target: 'deadline', hourglass: 'duration', 'circle-slash': 'no-date', bolt: 'quick-note' };
  for (const [old, now] of Object.entries(renamed)) {
    assert.ok(hasIcon(old) && hasIcon(now), `${old} and ${now}`);
    assert.equal(icon(old, { size: 18 }), icon(now, { size: 18 }), `${old} draws ${now}`);
  }
  assert.match(icon('today'), /<circle cx="12" cy="15\.4" r="2\.2" fill="currentColor" stroke="none"\/>/, 'Today has the now-dot');
});

test('shell.js uses the new glyph names itself', () => {
  const shell = readFileSync(new URL('shared/shell.js', ROOT), 'utf8');
  for (const old of ['sparkle', 'sun', 'target', 'hourglass', 'circle-slash', 'bolt']) {
    assert.doesNotMatch(shell, new RegExp(`(icon\\(|icon: )'${old}'`), `no ${old}`);
  }
});

test('the date picker’s month button says "Today" and is named "Go to today", apart from the quick "Today" row', () => {
  const html = miniCalendar({ month: new Date(2026, 8, 1) });
  const m = /<button\b[^>]*data-mc="today"[^>]*>([\s\S]*?)<\/button>/.exec(html);
  assert.ok(m, 'a Today button');
  assert.equal(m[1].trim(), 'Today', 'the visible word');
  assert.match(m[0], /aria-label="Go to today"/, 'its name keeps the visible word (WCAG 2.5.3) and says what it does');
  assert.doesNotMatch(m[1], /<svg/);
  const compact = /<button\b[^>]*data-mc="today"[^>]*>/.exec(miniCalendar({ month: new Date(2026, 8, 1), compact: true }))[0];
  assert.match(compact, /aria-label="Go to today"/, 'the compact one is named the same');
});

/** Decode an 8-bit RGB or RGBA PNG (no interlace): { width, height, px(x, y) → [r, g, b, a] }. */
function decodePng(buf) {
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString();
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  assert.equal(ihdr.depth, 8);
  assert.equal(ihdr.interlace, 0);
  const bpp = ihdr.color === 6 ? 4 : ihdr.color === 2 ? 3 : 0;
  assert.ok(bpp, `RGB or RGBA (color type ${ihdr.color})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * bpp;
  const out = Buffer.alloc(stride * ihdr.height);
  for (let y = 0; y < ihdr.height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[y * stride + x] = (line[x] + [0, a, b, (a + b) >> 1, pr][f]) & 255;
    }
  }
  return { ...ihdr, px: (x, y) => [...out.subarray(y * stride + x * bpp, y * stride + x * bpp + bpp), ...(bpp === 3 ? [255] : [])] };
}

test('apple-touch icons: a 180px opaque PNG of each maskable logo, full bleed in the tile’s own colours', () => {
  // The deep stop of each tile (shell.js appIcon): the bottom-right corner, where no sheen or mark falls.
  const deep = { ecosys: '#1d2036', tasks: '#1660c2', schedule: '#5534e0', notes: '#e0560a' };
  for (const [app, hex] of Object.entries(deep)) {
    const file = new URL(`shared/icons/${app}-180.png`, ROOT);
    assert.ok(existsSync(file), `shared/icons/${app}-180.png`);
    const png = decodePng(readFileSync(file));
    assert.deepEqual([png.width, png.height], [180, 180], app);
    const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [r, g, b, a] = png.px(179, 179);
    assert.equal(a, 255, `${app}: opaque`);
    for (const [i, v] of [r, g, b].entries()) assert.ok(Math.abs(v - want[i]) <= 8, `${app}: bottom-right corner is the tile (${[r, g, b]} vs ${want})`);
    // Every corner is tile, not a transparent or white edge (iOS rounds the square itself).
    for (const [x, y] of [[0, 0], [179, 0], [0, 179]]) {
      const p = png.px(x, y);
      assert.equal(p[3], 255);
      assert.ok(!(p[0] > 245 && p[1] > 245 && p[2] > 245) && !(p[0] < 10 && p[1] < 10 && p[2] < 10), `${app} corner ${x},${y}: ${p}`);
    }
    // The mark is in the middle: some white there.
    let white = 0;
    for (let y = 40; y < 140; y += 4) for (let x = 40; x < 140; x += 4) if (png.px(x, y).slice(0, 3).every((v) => v > 240)) white++;
    assert.ok(white > 20, `${app}: the white mark is drawn (${white} samples)`);
  }
});
