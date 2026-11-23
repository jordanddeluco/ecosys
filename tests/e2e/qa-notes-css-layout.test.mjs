// QA regression (notes/notes.css), measured in a real headless Chrome against an isolated server:
//   version history  changed blocks are tinted and an assistant's version wears the violet glyph
//                    (the dialog is appended to <body>, outside the Notes shell), in Light, Dim and Lights out
//   highlights       one fill per theme: the same inside the Notes shell and in layers on <body>
//   print            from Dim or Lights out, links, tags and highlights print in Light's colours
//   sticky headers   J/K never leaves the open row under the date-group header (list and gallery)
//   search chips     one row on the desktop, faded only on a side where chips are scrolled out of view;
//                    a click on a half-shown chip presses it without moving the row; Tab / Shift+Tab bring
//                    each chip fully in, its focus ring clear of the fade, a press keeps the row's place and
//                    a mouse wheel scrolls it (todo: the notes/app.js cross request of the second pass)
//   folder colours   all ten in one row in the dialog; small dialogs are full-width sheets on phones
//   forced colours   the open and focused rows, the chosen version, a pressed chip, the search field
//                    and highlighted words stay visible in Windows Contrast themes
//   contrast         the Today tile's weekday, and quiet text on an accent-tinted row (every accent)
//   targets          the folder disclosure is 24px wide (desktop) and 24 × 46 on phones
//   phone sheet      Quick Note's head: Open in Notes top left, Done top right, destination below; a
//                    grabber and a scrim on phones (a tap on it is Done), neither on a desk
// Static checks of the same rules: tests/qa-notes-css-static.test.js.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, waitForApp, settle, withScreenshot } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** In-page colour maths: parse (rgb / color(srgb)), composite, WCAG ratio, the opaque colour behind an element. */
const COLOR = `(() => {
  const parse = (s) => {
    let m = /rgba?\\(([^)]+)\\)/.exec(s);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /color\\(srgb ([^)]+)\\)/.exec(s);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    if (stack.length && stack[stack.length - 1].a >= 1) base = stack.pop();
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };
  const textRatio = (el) => ratio(over(parse(getComputedStyle(el).color), bgOf(el)), bgOf(el));
  return { parse, ratio, bgOf, textRatio };
})()`;

async function setLook(page, theme, accent = 'iris') {
  await page.evaluate(
    async (theme, accent) => {
      const { settings } = await import('/shared/store.js');
      settings.set({ theme, accent });
    },
    theme,
    accent,
  );
  await page.waitFor((t, a) => document.documentElement.dataset.theme === t && document.documentElement.dataset.accent === a, { args: [theme, accent], timeout: 5000 });
  await settle(page, 120);
}

async function closeLayers(page) {
  for (let i = 0; i < 4 && (await page.evaluate(() => !!document.querySelector('.modal, .menu'))); i++) {
    await page.press('Escape');
    await sleep(150);
  }
}

/** How many px of the open row (or card) sit under a stuck date-group header of the list. */
const hiddenUnderHeader = (page, sel) =>
  page.evaluate((sel) => {
    const list = document.querySelector('.n-list');
    const open = list.querySelector(sel);
    if (!open) return null;
    const lr = list.getBoundingClientRect();
    const r = open.getBoundingClientRect();
    const stuck = [...list.querySelectorAll('.ngroup')].map((h) => h.getBoundingClientRect()).filter((h) => h.top <= lr.top + 1 && h.bottom > lr.top);
    const bottom = stuck.length ? Math.max(...stuck.map((h) => h.bottom)) : lr.top;
    return Math.round(Math.max(0, bottom - r.top));
  }, sel);

/** The focused search chip against the unfaded part of its row: px of its focus ring past each faded edge (≤ 0: clear). */
const chipFocus = (page) =>
  page.evaluate(() => {
    const row = document.querySelector('.n-schips');
    const el = document.activeElement;
    if (!row || !el?.matches('.n-schip')) return { chip: null, index: -1, focus: el?.className || el?.tagName || null };
    const rr = row.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const rs = getComputedStyle(row);
    const es = getComputedStyle(el);
    const ring = es.outlineStyle === 'none' ? 0 : parseFloat(es.outlineWidth) + parseFloat(es.outlineOffset);
    const fadeS = parseFloat(rs.getPropertyValue('--n-fade-s')) || 0;
    const fadeE = parseFloat(rs.getPropertyValue('--n-fade-e')) || 0;
    const r1 = (v) => Math.round(v * 10) / 10;
    return { chip: el.textContent, index: [...row.children].indexOf(el), start: r1(rr.left + fadeS - (r.left - ring)), end: r1(r.right + ring - (rr.right - fadeE)) };
  });

/** Real mouse events at (x, y): the press focuses a button (mousedown), the click comes on release. */
async function mouseClickAt(page, x, y, { between } = {}) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(50);
  const mid = between ? await between() : undefined;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  return mid;
}

/** Leave search: an empty query (which exits the search view), nothing focused. */
async function resetSearch(page) {
  await page.evaluate(() => {
    const q = document.querySelector('.n-q');
    if (q?.value) {
      q.value = '';
      q.dispatchEvent(new Event('input'));
    }
    document.activeElement?.blur();
  });
  await settle(page, 250);
}

describe('qa notes-css: notes.css in the browser', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let probe = null;
  let aiNote = null;

  /** Load Notes once: 30 older notes (so the list scrolls and groups by date), a probe note with
      highlights, a link and a tag whose history holds an assistant's earlier version, and a note an
      assistant edited last (its caption names the assistant; it is counted in Recent AI edits). */
  async function ready() {
    const { page, server } = ctx;
    if (probe) return probe;
    await openApp(page, server.url('notes/'));
    aiNote = await page.evaluate(async () => {
      const core = await import('/notes/core/notes.js');
      const n = core.createNote({ blocks: [{ t: 'h1', c: [['Assistant probe']] }, { t: 'p', c: [['Written by you.']] }] });
      core.saveBlocks(n.id, [...n.blocks, { t: 'p', c: [['Added by the assistant.']] }], { by: 'mcp:claude' });
      return n.id;
    });
    probe = await page.evaluate(async () => {
      const core = await import('/notes/core/notes.js');
      const hist = await import('/notes/history/revisions.js');
      const { db } = await import('/shared/store.js');
      for (let i = 1; i <= 30; i++) {
        const n = core.createNote({ blocks: [{ t: 'h1', c: [[`Older note ${i}`]] }, { t: 'p', c: [[`Preview text ${i}.`]] }] });
        const at = Date.now() - i * 26 * 3600 * 1000;
        db.put('notes', { ...db.get('notes', n.id), editedAt: at, createdAt: at });
      }
      const n = core.createNote({
        blocks: [
          { t: 'h1', c: [['Probe note']] },
          { t: 'p', c: [['Marks: '], ['purple', '', { hl: 'purple' }], [' '], ['mint', '', { hl: 'mint' }], [' '], ['blue', '', { hl: 'blue' }]] },
          { t: 'p', c: [['A '], ['web link', '', { href: 'https://example.com/' }], [' and a #work tag.']] },
        ],
      });
      await hist.snapshot(n, { by: 'mcp:claude', reason: 'qa', force: true });
      const blocks = structuredClone(n.blocks);
      blocks[0] = { ...blocks[0], c: [['Probe note (edited)']] };
      core.saveBlocks(n.id, blocks, { by: 'user' });
      return n.id;
    });
    return probe;
  }
  async function openProbe() {
    const { page } = ctx;
    const id = await ready();
    await page.evaluate((id) => (location.hash = `#/all/n/${id}`), id);
    await page.waitFor((id) => document.querySelector('.ne-doc') && document.querySelector(`#row-${CSS.escape(id)}.open, .nrow.open`), { args: [id], timeout: 8000, message: 'the probe note to open' });
    await settle(page, 250);
    return id;
  }
  async function openHistory() {
    const { page } = ctx;
    await page.click('[data-note-menu]');
    await page.clickText('menuitem', 'Version history', { exact: true });
    await page.waitFor('.n-histmodal .s-changed', 8000);
    await settle(page, 200);
  }

  test('version history tints changed blocks and marks an assistant version in violet, in every theme', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-notes-css-history', async () => {
      await openProbe();
      for (const theme of ['light', 'dim', 'dark']) {
        await setLook(page, theme);
        await openHistory();
        const r = await page.evaluate((C) => {
          const { parse } = eval(C);
          const ch = document.querySelector('.n-histmodal .s-changed');
          const glyph = document.querySelector('.n-histmodal .n-hrow .i');
          const purple = getComputedStyle(document.documentElement).getPropertyValue('--c-purple').trim();
          const probe = document.createElement('span');
          probe.style.color = purple;
          document.body.append(probe);
          const want = getComputedStyle(probe).color;
          probe.remove();
          return { tint: parse(getComputedStyle(ch).backgroundColor), glyph: getComputedStyle(glyph).color, want };
        }, COLOR);
        assert.ok(r.tint && r.tint.a > 0.05, `${theme}: a changed block is tinted (background ${JSON.stringify(r.tint)})`);
        assert.ok(r.tint.r > r.tint.g && r.tint.b > r.tint.g, `${theme}: the tint is the AI violet (${JSON.stringify(r.tint)})`);
        assert.equal(r.glyph, r.want, `${theme}: the assistant's version glyph is --c-purple`);
        await closeLayers(page);
      }
      await setLook(page, 'light');
    });
  });

  test('highlight fills are the same inside the Notes shell and on <body>, and differ by theme', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-notes-css-highlights', async () => {
      await openProbe();
      const fills = {};
      for (const theme of ['light', 'dark']) {
        await setLook(page, theme);
        fills[theme] = await page.evaluate(() =>
          ['purple', 'mint', 'blue'].map((h) => {
            const make = (host) => {
              const s = document.createElement('span');
              s.style.backgroundColor = `var(--hl-${h}-bg)`;
              host.append(s);
              const c = getComputedStyle(s).backgroundColor;
              s.remove();
              return c;
            };
            return { h, shell: make(document.querySelector('.n-page')), body: make(document.body) };
          }),
        );
        for (const f of fills[theme]) assert.equal(f.shell, f.body, `${theme}: --hl-${f.h}-bg is the same in the note and in Version history / Quick Note`);
      }
      for (let i = 0; i < 3; i++) assert.notEqual(fills.light[i].body, fills.dark[i].body, `--hl-${fills.light[i].h}-bg has its own Lights out fill (editor.css two-tones)`);
      await setLook(page, 'light');
    });
  });

  test('printing from Dim or Lights out prints links, tags and highlights in Light colours', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-notes-css-print', async () => {
      await openProbe();
      for (const theme of ['dim', 'dark']) {
        await setLook(page, theme, theme === 'dim' ? 'iris' : 'blue');
        await page.send('Emulation.setEmulatedMedia', { media: 'print', features: [] });
        await sleep(150);
        const r = await page.evaluate((C) => {
          const { parse, ratio } = eval(C);
          const white = { r: 255, g: 255, b: 255, a: 1 };
          const link = document.querySelector('.ne-doc a.ne-link');
          const tag = document.createElement('span');
          tag.style.color = 'var(--accent-text)';
          document.querySelector('.ne-doc').append(tag);
          // highlighted words against their own fill (a background image, so composited here) on paper
          const marks = [...document.querySelectorAll('.ne-doc mark.ne-hl')].map((m) => {
            const f = parse(getComputedStyle(m).getPropertyValue('--hlbg').trim());
            const bg = { r: f.r * f.a + 255 * (1 - f.a), g: f.g * f.a + 255 * (1 - f.a), b: f.b * f.a + 255 * (1 - f.a), a: 1 };
            return ratio(parse(getComputedStyle(m).color), bg);
          });
          const out = { link: ratio(parse(getComputedStyle(link).color), white), tag: ratio(parse(getComputedStyle(tag).color), white), marks, ai: ratio(parse(getComputedStyle(document.documentElement).getPropertyValue('--c-purple').trim().replace(/^#(..)(..)(..)$/, (_, a, b, c) => `rgb(${parseInt(a, 16)}, ${parseInt(b, 16)}, ${parseInt(c, 16)})`)), white) };
          tag.remove();
          return out;
        }, COLOR);
        await page.send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'light' }] });
        assert.ok(r.link >= 4.5, `${theme}: a printed link is ${r.link.toFixed(2)}:1 on paper`);
        assert.ok(r.tag >= 4.5, `${theme}: a printed tag / chip is ${r.tag.toFixed(2)}:1 on paper`);
        assert.equal(r.marks.length, 3);
        for (const m of r.marks) assert.ok(m >= 4.5, `${theme}: printed highlighted words are ${m.toFixed(2)}:1 on paper`);
        assert.ok(r.ai >= 4.4, `${theme}: the AI purple prints in Light's shade (${r.ai.toFixed(2)}:1)`);
      }
      await setLook(page, 'light', 'iris');
    });
  });

  test('J/K never leaves the open row under the sticky date header, in the list and the gallery', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-notes-css-sticky', async () => {
      await ready();
      for (const view of ['list', 'gallery']) {
        await page.evaluate(() => (location.hash = '#/all'));
        await sleep(300);
        const isGallery = await page.evaluate(() => document.querySelector('.n-list').classList.contains('is-gallery'));
        if ((view === 'gallery') !== isGallery) {
          await page.click('[data-toggle-view]');
          await page.waitFor((g) => document.querySelector('.n-list').classList.contains('is-gallery') === g, { args: [view === 'gallery'], timeout: 5000 });
        }
        const sel = view === 'gallery' ? '.ncard.open' : '.nrow.open';
        // open the oldest note, then walk up the list
        await page.evaluate((v) => {
          const items = [...document.querySelectorAll(v === 'gallery' ? '.ncard' : '.nrow')];
          items.at(-1).scrollIntoView({ block: 'end' });
          items.at(-1).click();
        }, view);
        await settle(page, 200);
        await page.evaluate(() => document.querySelector('.n-list').focus());
        const hidden = [];
        for (let i = 0; i < 16; i++) {
          await page.press('k');
          await sleep(90);
          hidden.push(await hiddenUnderHeader(page, sel));
        }
        assert.ok(hidden.some((h) => h !== null), `${view}: K moves an open ${view === 'gallery' ? 'card' : 'row'}`);
        assert.deepEqual(hidden.filter((h) => h > 0), [], `${view}: px of the open item under the sticky header after each K: ${hidden.join(', ')}`);
      }
      await page.click('[data-toggle-view]');
      await page.waitFor(() => !document.querySelector('.n-list').classList.contains('is-gallery'), 5000);
    });
  });

  test('search chips are one row on the desktop, faded only where chips are scrolled out of view', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-notes-css-chips', async () => {
      await openProbe();
      await page.click('.n-q');
      await page.waitFor('.n-schips .n-schip', 5000);
      await settle(page, 150);
      const at = (left) =>
        page.evaluate((left) => {
          const c = document.querySelector('.n-schips');
          if (left !== null) c.scrollLeft = left;
          return new Promise((r) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const cs = getComputedStyle(c);
                r({ rows: new Set([...c.children].filter((b) => !b.hidden).map((b) => Math.round(b.getBoundingClientRect().top))).size, height: c.getBoundingClientRect().height, over: c.scrollWidth > c.clientWidth, s: cs.getPropertyValue('--n-fade-s').trim(), e: cs.getPropertyValue('--n-fade-e').trim() });
              }),
            ),
          );
        }, left);
      const start = await at(0);
      assert.equal(start.rows, 1, 'every chip is on one line');
      assert.ok(start.height <= 40, `the chip row is one chip tall (${start.height}px), not four lines`);
      assert.ok(start.over, 'nine chips overflow the 320px column (the case this checks)');
      assert.deepEqual([start.s, start.e], ['0px', '28px'], 'at the start only the end fades');
      const mid = await at(150);
      assert.deepEqual([mid.s, mid.e], ['28px', '28px'], 'scrolled part-way: both edges fade');
      const end = await at(99999);
      assert.deepEqual([end.s, end.e], ['28px', '0px'], 'at the end only the start fades');
      // Reduce motion (1ms animations) keeps the scroll-driven fade.
      await page.evaluate(() => (document.documentElement.dataset.reduceMotion = 'true'));
      const reduced = await at(0);
      await page.evaluate(() => (document.documentElement.dataset.reduceMotion = 'false'));
      assert.deepEqual([reduced.s, reduced.e], ['0px', '28px'], 'Reduce motion keeps the edge fade');
      // all chips fit: no fade at all
      await page.evaluate(() => [...document.querySelectorAll('.n-schip')].slice(2).forEach((b) => (b.hidden = true)));
      const fit = await at(null);
      assert.equal(fit.over, false);
      assert.deepEqual([fit.s, fit.e], ['0px', '0px'], 'nothing scrolled out of view: no fade');
      await page.evaluate(() => [...document.querySelectorAll('.n-schip')].forEach((b) => (b.hidden = false)));
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Escape');
    });
  });

  /** Focus the search field over the open probe note: the chips show, scrolled to their start. Returns their number. */
  async function openChips() {
    const { page } = ctx;
    await openProbe();
    await page.click('.n-q');
    await page.waitFor('.n-schips .n-schip', 5000);
    await page.evaluate(() => (document.querySelector('.n-schips').scrollLeft = 0));
    await settle(page, 150);
    const r = await page.evaluate(() => {
      const c = document.querySelector('.n-schips');
      return { n: c.querySelectorAll('.n-schip').length, over: c.scrollWidth > c.clientWidth };
    });
    assert.ok(r.n >= 7 && r.over, `the chips (${r.n}) overflow their row (the case these checks are about)`);
    return r.n;
  }

  // Keyboard focus, a press and the wheel on the one-row chips. Three of these tests are todos until
  // notes/app.js lands the cross request of the notes-css second pass (a keyboard-only focusin scroll,
  // keeping the row's place across a re-render, the wheel); they pass with that code. The click test
  // guards its keyboard-only part: the row must not move under the pointer.
  test(
    'Tab and Shift+Tab bring each search chip fully into view, its focus ring clear of the faded edges',
    { todo: 'A chip the keyboard reaches half-shown stays cut off at the faded edge (Chrome moves a focused element sideways only when it is wholly out of view): waiting on the notes/app.js focusin cross request (notes-css)' },
    async () => {
      const { page } = ctx;
      await withScreenshot(page, 'qa-notes-css-chips-keyboard', async () => {
        try {
          const n = await openChips();
          const seen = [];
          for (let i = 0; i < n; i++) {
            await page.press('Tab');
            await settle(page, 80);
            seen.push(await chipFocus(page));
          }
          for (let i = 0; i < n - 1; i++) {
            await page.press('Shift+Tab');
            await settle(page, 80);
            seen.push(await chipFocus(page));
          }
          const order = [...Array(n).keys()];
          assert.deepEqual(seen.map((s) => s.index), [...order, ...order.slice(0, -1).reverse()], 'Tab and Shift+Tab walk the chips in order');
          const cut = seen.filter((s) => s.start > 1 || s.end > 1).map((s) => `${s.chip} (${Math.max(s.start, s.end)}px)`);
          assert.deepEqual(cut, [], 'focused chips whose focus ring runs into a faded edge (or past the row)');
        } finally {
          await resetSearch(page);
        }
      });
    },
  );

  test('a click on a half-shown search chip presses it and leaves the row where it is', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-notes-css-chips-click', async () => {
      try {
        await openChips();
        // The first chip cut off by the end of the row, clicked 10px from that end (inside the fade).
        const pt = await page.evaluate(() => {
          const row = document.querySelector('.n-schips');
          const rr = row.getBoundingClientRect();
          const chip = [...row.querySelectorAll('.n-schip')].find((b) => {
            const r = b.getBoundingClientRect();
            return r.left < rr.right - 24 && r.right > rr.right;
          });
          if (!chip) return null;
          const r = chip.getBoundingClientRect();
          return { x: Math.round(rr.right - 10), y: Math.round(r.top + r.height / 2), op: chip.dataset.searchOp, label: chip.textContent, at: row.scrollLeft };
        });
        assert.ok(pt, 'a chip is cut off by the end of the row');
        // A row that moved on mousedown (focus) would put the release, and so the click, on the next chip.
        const during = await mouseClickAt(page, pt.x, pt.y, { between: () => page.evaluate(() => document.querySelector('.n-schips').scrollLeft) });
        assert.equal(during, pt.at, 'pressing the mouse on the chip does not scroll the row under the pointer');
        await page.waitFor((op) => document.querySelector('.n-q').value.split(/\s+/).includes(op), { args: [pt.op], timeout: 5000, message: `the "${pt.label}" filter in the search field` });
      } finally {
        await resetSearch(page);
      }
    });
  });

  test(
    'pressing a search chip keeps the chip row where it was',
    { todo: 'A press re-renders the chips and the row jumps back to its start, hiding the chip just pressed: waiting on the notes/app.js renderSearchOpts cross request (notes-css)' },
    async () => {
      const { page } = ctx;
      await withScreenshot(page, 'qa-notes-css-chips-press', async () => {
        try {
          await openChips();
          const pt = await page.evaluate(() => {
            const row = document.querySelector('.n-schips');
            row.scrollLeft = row.scrollWidth;
            const chip = [...row.querySelectorAll('.n-schip')].at(-1);
            const r = chip.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), op: chip.dataset.searchOp, label: chip.textContent, at: row.scrollLeft };
          });
          await settle(page, 100);
          await mouseClickAt(page, pt.x, pt.y);
          await page.waitFor((op) => document.querySelector('.n-q').value.split(/\s+/).includes(op), { args: [pt.op], timeout: 5000, message: `the "${pt.label}" filter in the search field` });
          await settle(page, 250);
          const after = await page.evaluate((label) => {
            const row = document.querySelector('.n-schips');
            const rr = row.getBoundingClientRect();
            const chip = [...row.querySelectorAll('.n-schip')].find((b) => b.textContent === label);
            const r = chip.getBoundingClientRect();
            return { at: row.scrollLeft, pressed: chip.getAttribute('aria-pressed'), inView: r.left >= rr.left && r.right <= rr.right };
          }, pt.label);
          assert.equal(after.pressed, 'true');
          assert.equal(after.at, pt.at, 'the row stays scrolled where it was');
          assert.ok(after.inView, `the chip just pressed (${pt.label}) stays in view`);
        } finally {
          await resetSearch(page);
        }
      });
    },
  );

  test(
    'a mouse wheel over the search chips scrolls them sideways',
    { todo: 'A plain mouse wheel leaves the one-row chips where they are (only Shift+wheel, a trackpad or the keyboard reach the ones past the edge): waiting on the notes/app.js wheel cross request (notes-css)' },
    async () => {
      const { page } = ctx;
      await withScreenshot(page, 'qa-notes-css-chips-wheel', async () => {
        try {
          await openChips();
          const pt = await page.evaluate(() => {
            const r = document.querySelector('.n-schips').getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          });
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
          await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: 120 });
          await settle(page, 250);
          const at = await page.evaluate(() => document.querySelector('.n-schips').scrollLeft);
          assert.ok(at >= 60, `one notch of the wheel scrolls the chips sideways (scrollLeft ${at})`);
        } finally {
          await resetSearch(page);
        }
      });
    },
  );

  test('the ten folder colours sit in one row in the New folder dialog', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-notes-css-swatches', async () => {
      await ready();
      await page.click('.n-folders .side-label [data-new-folder]');
      await page.waitFor('.modal .n-colors', 5000);
      const r = await page.evaluate(() => {
        const tops = [...document.querySelectorAll('.n-colors .swatch-btn')].map((b) => Math.round(b.getBoundingClientRect().top));
        return { n: tops.length, rows: new Set(tops).size };
      });
      assert.equal(r.n, 10);
      assert.equal(r.rows, 1, 'no colour wraps onto a row of its own');
      await closeLayers(page);
    });
  });

  test('Windows Contrast themes: open and focused rows, the chosen version, a pressed chip and marks stay visible', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-notes-css-forced-colors', async () => {
      await openProbe();
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ 'forced-colors': 'active', 'prefers-color-scheme': scheme });
        try {
          await sleep(150);
          // the open row, unfocused and then focused from the keyboard
          await page.evaluate(() => document.activeElement?.blur());
          const open = await page.evaluate(() => getComputedStyle(document.querySelector('.nrow.open')).outlineStyle);
          assert.equal(open, 'solid', `${scheme}: the open note's row is outlined`);
          await page.evaluate(() => document.querySelector('.nrow.open').focus());
          await page.press('ArrowDown');
          await page.press('ArrowUp');
          await sleep(150);
          const focus = await page.evaluate(() => {
            const a = document.activeElement;
            const cs = getComputedStyle(a);
            return { row: a.classList.contains('nrow'), fv: a.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
          });
          assert.ok(focus.row && focus.fv, `${scheme}: keyboard focus is on a row (${JSON.stringify(focus)})`);
          assert.equal(focus.style, 'solid', `${scheme}: the focused row has an outline (box-shadow rings are dropped)`);
          assert.ok(focus.width >= 2, `${scheme}: the focus outline is 2px`);
          // search field and a pressed chip
          await page.click('.n-q');
          await page.waitFor('.n-schip', 5000);
          await page.evaluate(() => document.querySelector('.n-schip[data-search-op="is:pinned"]')?.click());
          await page.waitFor(() => document.querySelector('.n-schip[aria-pressed="true"]'), { timeout: 5000, message: 'a pressed chip' });
          await page.click('.n-q');
          const search = await page.evaluate(() => ({ field: getComputedStyle(document.querySelector('.n-search')).outlineStyle, chip: getComputedStyle(document.querySelector('.n-schip[aria-pressed="true"]')).outlineStyle }));
          assert.deepEqual(search, { field: 'solid', chip: 'solid' }, `${scheme}: the search field and the pressed chip are outlined`);
          await page.evaluate(() => (document.querySelector('.n-q').value = ''));
          await page.press('Escape');
          await openProbe();
          // version history: the chosen version, the changed blocks and highlighted words
          await openHistory();
          const h = await page.evaluate((C) => {
            const { textRatio } = eval(C);
            const row = document.querySelector('.n-hrow[aria-selected="true"]');
            const marks = [...document.querySelectorAll('.n-histmodal .s-hl')];
            return { row: getComputedStyle(row).outlineStyle, changed: getComputedStyle(document.querySelector('.n-histmodal .s-changed')).outlineStyle, marks: marks.map((m) => ({ adjust: getComputedStyle(m).forcedColorAdjust, ratio: textRatio(m) })) };
          }, COLOR);
          assert.equal(h.row, 'solid', `${scheme}: the chosen version is outlined`);
          assert.notEqual(h.changed, 'none', `${scheme}: a changed block is outlined (its tint is dropped)`);
          assert.ok(h.marks.length >= 3, 'the version shows its highlighted words');
          for (const m of h.marks) {
            assert.equal(m.adjust, 'none', `${scheme}: highlighted words keep the system mark colours`);
            assert.ok(m.ratio >= 4.5, `${scheme}: highlighted words read ${m.ratio.toFixed(2)}:1`);
          }
          await closeLayers(page);
        } finally {
          await page.emulateMedia({ 'forced-colors': '', 'prefers-color-scheme': 'light' });
        }
      }
    });
  });

  test('contrast: the Today tile weekday, AI-coloured text, and quiet text on an accent-tinted row, every theme and accent', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-notes-css-contrast', async () => {
      await ready();
      await page.evaluate(() => (location.hash = '#/day'));
      await page.waitFor('.dh-wd', 8000);
      for (const theme of ['light', 'dim', 'dark']) {
        await setLook(page, theme);
        const r = await page.evaluate((C) => eval(C).textRatio(document.querySelector('.dh-wd')), COLOR);
        assert.ok(r >= 4.5, `${theme}: the Today tile's weekday is ${r.toFixed(2)}:1`);
      }
      await page.evaluate((id) => (location.hash = `#/all/n/${id}`), aiNote);
      await page.waitFor('.n-cap-ai', { timeout: 8000, message: "the caption naming the note's assistant" });
      for (const theme of ['light', 'dim', 'dark']) {
        await setLook(page, theme);
        const r = await page.evaluate((C) => {
          const { textRatio } = eval(C);
          return { caption: textRatio(document.querySelector('.n-cap-ai')), count: textRatio(document.querySelector('.n-ai-item .badge')) };
        }, COLOR);
        assert.ok(r.caption >= 4.5, `${theme}: the assistant's name in the caption is ${r.caption.toFixed(2)}:1`);
        assert.ok(r.count >= 4.5, `${theme}: the Recent AI edits count is ${r.count.toFixed(2)}:1`);
      }
      await openProbe();
      const fails = [];
      for (const theme of ['light', 'dim', 'dark']) {
        for (const accent of ['iris', 'blue', 'violet', 'pink', 'orange', 'green', 'yellow']) {
          await setLook(page, theme, accent);
          await page.evaluate(() => document.querySelector('.nrow.open').focus());
          const rs = await page.evaluate((C) => {
            const { textRatio } = eval(C);
            const row = document.querySelector('.nrow.open');
            return [...row.querySelectorAll('.nrow-folder, .nrow-prev, .nrow-date, .n-ring')].map((el) => [el.className, textRatio(el)]);
          }, COLOR);
          for (const [cls, r] of rs) if (r < 4.5) fails.push(`${theme}/${accent} ${cls} ${r.toFixed(2)}:1`);
        }
      }
      await setLook(page, 'light', 'iris');
      assert.deepEqual(fails, [], 'text on the open row while the list has focus is 4.5:1+');
    });
  });

  test('the folder disclosure takes clicks 24px wide without covering the folder link', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-notes-css-disclosure', async () => {
      await ready();
      const r = await page.evaluate(() => {
        const d = document.querySelector('.n-disclose');
        const b = d.getBoundingClientRect();
        const y = b.top + b.height / 2;
        const at = (x) => (document.elementFromPoint(x, y)?.closest('.n-disclose') ? 'disclose' : document.elementFromPoint(x, y)?.closest('.nav-item') ? 'link' : 'other');
        let w = 0;
        for (let x = Math.floor(b.left) - 12; x <= b.right + 12; x++) if (at(x + 0.5) === 'disclose') w++;
        return { w, after: at(b.right + 1) };
      });
      assert.ok(r.w >= 24, `the disclosure takes clicks over ${r.w}px (WCAG 2.5.8: 24)`);
      assert.equal(r.after, 'link', 'right after it, a click opens the folder');
    });
  });

  describe('phone (390 × 844, touch)', () => {
    async function phone() {
      const { page, server } = ctx;
      await page.setViewport(390, 844, true);
      await openApp(page, server.url('notes/#/all'));
      await waitForApp(page);
    }

    test('folder rows: a 24 × 46 disclosure, and the Notes folder lines up with the user folders', async () => {
      const { page } = ctx;
      await withScreenshot(page, 'qa-notes-css-phone-folders', async () => {
        await ready();
        await phone();
        await page.evaluate(() => (location.hash = '#/folders'));
        await page.waitFor(() => document.querySelector('.nshell')?.dataset.screen === 'folders', { timeout: 5000 });
        await settle(page, 450);
        const r = await page.evaluate(() => {
          const d = document.querySelector('.n-disclose').getBoundingClientRect();
          const icons = [...document.querySelectorAll('.n-folders .nav-item')].filter((a) => !a.closest('.n-frow') || getComputedStyle(a.closest('.n-frow')).paddingLeft === '0px').map((a) => Math.round(a.querySelector('.n-fdot, .i').getBoundingClientRect().left));
          return { w: Math.round(d.width), h: Math.round(d.height), icons };
        });
        assert.ok(r.w >= 24 && r.h >= 44, `the disclosure is ${r.w} × ${r.h}`);
        assert.equal(new Set(r.icons).size, 1, `top-level folder icons line up (${r.icons.join(', ')})`);
      });
    });

    test('New folder: a full-width sheet with the ten colours in one row', async () => {
      const { page } = ctx;
      await withScreenshot(page, 'qa-notes-css-phone-newfolder', async () => {
        await ready();
        await phone();
        await page.evaluate(() => (location.hash = '#/folders'));
        await settle(page, 450);
        await page.evaluate(() => document.querySelector('[data-new-folder]').click());
        await page.waitFor('.modal .n-colors', 5000);
        await settle(page, 300);
        const r = await page.evaluate(() => {
          const m = document.querySelector('.modal').getBoundingClientRect();
          const tops = [...document.querySelectorAll('.n-colors .swatch-btn')].map((b) => Math.round(b.getBoundingClientRect().top));
          return { left: Math.round(m.left), right: Math.round(innerWidth - m.right), rows: new Set(tops).size };
        });
        assert.deepEqual([r.left, r.right], [0, 0], 'the sheet runs edge to edge');
        assert.equal(r.rows, 1, 'all ten colours in one row at 390px');
        await closeLayers(page);
      });
    });

    test('Quick Note: Open in Notes top left, Done top right, the destination below at full width', async () => {
      const { page } = ctx;
      await withScreenshot(page, 'qa-notes-css-phone-quick', async () => {
        await ready();
        await phone();
        await page.evaluate(() => (location.hash = '#/quick'));
        await page.waitFor('.n-quick [data-quick=done]', 5000);
        await settle(page, 450);
        const r = await page.evaluate(() => {
          const q = document.querySelector('.n-quick').getBoundingClientRect();
          const box = (s) => document.querySelector(`.n-quick ${s}`).getBoundingClientRect();
          const open = box('[data-quick=open]');
          const done = box('[data-quick=done]');
          const seg = box('.segmented');
          return { sameRow: Math.abs(open.top - done.top) < 2, openLeft: open.left - q.left, doneRight: q.right - done.right, segBelow: seg.top >= done.bottom, segWidth: seg.width / q.width };
        });
        assert.ok(r.sameRow, 'Open in Notes and Done share the top row');
        assert.ok(r.openLeft < 24 && r.doneRight < 24, `Open in Notes hugs the left and Done the right (${r.openLeft}px, ${r.doneRight}px)`);
        assert.ok(r.segBelow && r.segWidth > 0.9, 'the New note / Add to Today control is the full-width second row');
        await page.click('.n-quick [data-quick=done]');
        await page.waitFor('.n-quick', { state: 'hidden', timeout: 5000 });
      });
    });

    test('Quick Note is a sheet over a scrim (a tap on it is Done) with a grabber; on a desk it dims nothing', async () => {
      const { page } = ctx;
      await withScreenshot(page, 'qa-notes-css-phone-quick-scrim', async () => {
        await ready();
        await phone();
        await page.evaluate(() => (location.hash = '#/quick'));
        await page.waitFor('.n-quick', 5000);
        await settle(page, 450);
        const r = await page.evaluate(() => {
          const s = document.querySelector('.n-quick-scrim');
          const g = document.querySelector('.n-quick > .grabber');
          return { scrim: !!s && getComputedStyle(s).display !== 'none', grabber: !!g && getComputedStyle(g).display !== 'none', under: s ? Number(getComputedStyle(s).zIndex) < Number(getComputedStyle(document.querySelector('.n-quick')).zIndex) : false, hit: !!document.elementFromPoint(195, 60)?.classList.contains('n-quick-scrim') };
        });
        assert.deepEqual(r, { scrim: true, grabber: true, under: true, hit: true }, 'phone: a visible scrim under the sheet takes taps above it, and the sheet shows a grabber');
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 195, y: 60, button: 'left', buttons: 1, clickCount: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 195, y: 60, button: 'left', buttons: 0, clickCount: 1 });
        await page.waitFor('.n-quick', { state: 'hidden', timeout: 5000 });
        // a desk: Quick Note floats beside the notes; the list behind stays bright and usable
        await page.setViewport(1440, 900, false);
        await openApp(page, ctx.server.url('notes/#/all'));
        await page.evaluate(() => (location.hash = '#/quick'));
        await page.waitFor('.n-quick', 5000);
        await settle(page, 400);
        const d = await page.evaluate(() => {
          const s = document.querySelector('.n-quick-scrim');
          const g = document.querySelector('.n-quick > .grabber');
          const row = document.querySelector('.nrow').getBoundingClientRect();
          return { scrim: s ? getComputedStyle(s).display : 'none', grabber: g ? getComputedStyle(g).display : 'none', hit: !!document.elementFromPoint(row.left + 40, row.top + 20)?.closest('.nrow') };
        });
        assert.deepEqual(d, { scrim: 'none', grabber: 'none', hit: true }, 'desk: no scrim, no grabber, the list still takes clicks');
        await page.click('.n-quick [data-quick=done]');
        await page.waitFor('.n-quick', { state: 'hidden', timeout: 5000 });
      });
    });
  });
});
