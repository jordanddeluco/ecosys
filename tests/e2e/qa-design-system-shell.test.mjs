// QA regression (design system, shared/ui.css): phone toasts use the screen's width and clear the floating +,
// a confirm over a sheet dims that sheet, the palette marks one row and opens at the top on phones (with a
// Cancel button and no Keyboard shortcuts there), keyboard focus in menus and the app switcher is a ring rather
// than a grey tint, mini-month dots sit under the day circles and the week band on them, task circles stay
// visible, Windows Contrast themes keep switches, swatches and states visible, and a tooltip never takes the
// pointer, so a click or wheel turn over it reaches the control it covers, while a pointer-opened one stays up
// as long as the pointer is on it or its trigger (shared/shell.js, geometric hovering: WCAG 1.4.13).
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run code with the shell module (the same instance the app uses). */
const shell = (page, code) => page.evaluate(`(async () => { const s = await import('/shared/shell.js'); ${code} })()`);

async function setLook(page, theme, accent = 'iris') {
  await page.evaluate(
    async (theme, accent) => {
      const { settings } = await import('/shared/store.js');
      settings.set({ theme, accent });
    },
    theme,
    accent,
  );
  await page.waitFor((theme, accent) => document.documentElement.dataset.theme === theme && document.documentElement.dataset.accent === accent, { args: [theme, accent], timeout: 5000 });
  await settle(page, 150);
}

async function closeLayers(page) {
  for (let i = 0; i < 4 && (await page.evaluate(() => !!document.querySelector('.modal, .menu'))); i++) {
    await page.press('Escape');
    await sleep(120);
  }
}

const mouseTo = (page, x, y) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
/** A real press and release at a point (the click lands wherever hit-testing puts it, as for a person). */
async function clickAt(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
const wheelAt = (page, x, y, deltaY) => page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
/** Move the pointer from a to b in steps, as a hand would. */
async function glide(page, a, b, steps = 8) {
  for (let i = 1; i <= steps; i++) await mouseTo(page, a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
}
const covers = (box, p) => box.left <= p.x && p.x <= box.right && box.top <= p.y && p.y <= box.bottom;
const tipShown = (page) => page.evaluate(() => !!document.querySelector('.tooltip.on'));

/**
 * Tasks › Today with an overdue task: the first overdue row's star, whose "Important" tooltip opens above it,
 * over the Overdue section's Reschedule button.
 */
async function starOverReschedule(page, server) {
  await page.setViewport(1440, 520, false);
  await openApp(page, server.url('tasks/#/today'));
  await setLook(page, 'light');
  await page.evaluate(async () => {
    const { createTask } = await import('/shared/model.js');
    const { todayYmd, addDaysYmd } = await import('/shared/dates.js');
    createTask({ title: 'Renew the parking permit', date: addDaysYmd(todayYmd(), -1) });
  });
  await page.waitFor('section[aria-label="Overdue"] .task', 8000); // (its star shows only while the row is hovered)
  await settle(page, 150);
  return page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const star = document.querySelector('section[aria-label="Overdue"] .task [data-star]');
    // The list's scroller (marked for the wheel check): the nearest ancestor that scrolls.
    for (let e = star.parentElement; e; e = e.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(e).overflowY)) {
        e.dataset.qaScroller = '';
        break;
      }
    }
    return { star: box(star), res: box(document.querySelector('[data-reschedule]')) };
  });
}
/** Rest the pointer on the star until its tooltip shows; the tooltip's box. */
async function hoverStar(page, g) {
  await mouseTo(page, 700, 500);
  await sleep(350); // past the warm-up window, so the next tooltip takes its normal delay
  await mouseTo(page, g.star.x - 300, g.star.y);
  await sleep(100);
  await mouseTo(page, g.star.x, g.star.y);
  await page.waitFor('.tooltip.on', 3000);
  await sleep(150);
  return page.evaluate(() => {
    const r = document.querySelector('.tooltip.on').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

/** WCAG contrast of two computed CSS colours ('rgb(…)', 'rgba(…)', 'color(srgb …)'), the first laid over the second. */
function contrast(fg, bg) {
  const parse = (s) => {
    let m = /rgba?\(([^)]+)\)/.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    }
    m = /color\(srgb ([^)]+)\)/.exec(s);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
    }
    throw new Error(`cannot read colour ${s}`);
  };
  const b = parse(bg);
  const f0 = parse(fg);
  const f = [0, 1, 2].map((i) => f0[i] * f0[3] + b[i] * (1 - f0[3]));
  const L = (c) => {
    const g = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * g(c[0]) + 0.7152 * g(c[1]) + 0.0722 * g(c[2]);
  };
  const [x, y] = [L(f), L(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** The colour at the start of a computed box-shadow, e.g. 'rgb(77, 76, 212) 0px 0px 0px 2px inset'. */
const shadowColor = (shadow) => /^(rgba?\([^)]*\)|color\([^)]*\))/.exec(shadow)?.[1] || null;

describe('qa design system: shell components', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  // Each test starts on a desktop window without forced colours, whatever the one before it left behind.
  beforeEach(async () => {
    await ctx.page.setViewport(1440, 900, false);
    await ctx.page.emulateMedia({ 'forced-colors': '' });
  });

  test('phone toasts span the screen and sit above the floating +', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-toasts', async () => {
      await page.setViewport(390, 844, true);
      await openApp(page, server.url('tasks/#/today'));
      await setLook(page, 'light');
      await page.waitFor('.fab', 5000);
      await shell(page, `s.toast('1 task completed', { action: 'Undo', duration: 30000 }); s.toast('Deleted “Call the insurance company about the renewal letter and the new policy number”', { action: 'Undo', duration: 30000 });`);
      await sleep(450);
      const m = await page.evaluate(() => {
        const [short, long] = [...document.querySelectorAll('.toast')].map((t) => t.getBoundingClientRect());
        const msg = document.querySelector('.toast .toast-msg');
        return {
          vw: innerWidth,
          short: { w: short.width, h: short.height },
          long: { w: long.width, bottom: long.bottom },
          msgLines: (msg.offsetHeight - 8) / parseFloat(getComputedStyle(msg).lineHeight),
          fabTop: document.querySelector('.fab').getBoundingClientRect().top,
        };
      });
      assert.ok(m.msgLines < 1.5, `"1 task completed" fits on one line (it takes ${m.msgLines.toFixed(1)} lines in a ${m.short.w}px toast)`);
      assert.ok(m.long.w >= m.vw - 32 - 1, `a long toast uses the screen's width less 16px margins (${m.long.w}px of ${m.vw}px)`);
      assert.ok(m.long.bottom <= m.fabTop, `toasts clear the floating + (toast bottom ${m.long.bottom}, + top ${m.fabTop})`);
      await page.evaluate(() => document.querySelector('.toasts')?.replaceChildren());
    });
  });

  test('a confirm over Settings dims the sheet beneath it', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-stacked-modals', async () => {
      await openApp(page, server.url('tasks/'));
      await shell(page, `s.openSettings();`);
      await page.waitFor('.modal.settings', 5000);
      await shell(page, `s.confirmDialog({ title: 'Erase everything?', message: 'Every task is deleted.', confirm: 'Erase everything', danger: true });`);
      await page.waitFor('.modal.choice', 5000);
      await sleep(300);
      // Paint order, not hit-testing: the sheet beneath is inert, so elementFromPoint would skip it either way.
      const z = await page.evaluate(() => {
        const zi = (el) => Number(getComputedStyle(el).zIndex);
        const scrims = [...document.querySelectorAll('body > .scrim')];
        return { scrims: scrims.length, settings: zi(document.querySelector('.modal.settings')), scrim2: zi(scrims[1]), confirm: zi(document.querySelector('.modal.choice')), menu: 70 };
      });
      assert.equal(z.scrims, 2);
      assert.ok(z.scrim2 > z.settings, `the confirm's scrim covers Settings (z-index ${z.scrim2} over ${z.settings})`);
      assert.ok(z.confirm > z.scrim2 && z.confirm < z.menu, `the confirm sits on its scrim, under menus (z-index ${z.confirm})`);
      await closeLayers(page);
    });
  });

  test('the palette marks exactly one row, even when it opens under the pointer', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-palette-one-row', async () => {
      await openApp(page, server.url('tasks/'));
      await setLook(page, 'light');
      await shell(page, `s.openPalette();`);
      await page.waitFor('.palette-list .menu-item.hl', 5000);
      // Rest the pointer on the third row, then open the palette again under it (no pointer movement).
      const at = await page.evaluate(() => {
        const r = document.querySelectorAll('.palette-list .menu-item')[2].getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await closeLayers(page);
      await mouseTo(page, at.x, at.y);
      await shell(page, `s.openPalette();`);
      await page.waitFor('.palette-list .menu-item.hl', 5000);
      await sleep(250);
      const r = await page.evaluate(
        (x, y) => {
          const rows = [...document.querySelectorAll('.palette-list .menu-item')];
          const marked = rows.filter((b) => getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)' || getComputedStyle(b).boxShadow !== 'none');
          const under = document.elementFromPoint(x, y)?.closest('.menu-item');
          const hl = document.querySelector('.palette-list .menu-item.hl');
          return {
            marked: marked.map((b) => b.textContent.trim()),
            hl: hl.textContent.trim(),
            underIsOtherRow: !!under && under !== hl,
            ring: getComputedStyle(hl).boxShadow,
            palette: getComputedStyle(document.querySelector('.palette')).backgroundColor,
          };
        },
        at.x,
        at.y,
      );
      assert.ok(r.underIsOtherRow, 'the pointer rests on a row other than the highlighted one');
      assert.deepEqual(r.marked, [r.hl], 'only the highlighted row (the one Enter runs) looks marked');
      assert.match(r.ring, /inset/, 'the highlighted row wears an inset ring');
      const ratio = contrast(shadowColor(r.ring), r.palette);
      assert.ok(ratio >= 3, `the ring is 3:1 against the palette (${ratio.toFixed(2)}:1)`);
      await closeLayers(page);
    });
  });

  test('on phones the palette opens at the top, results under the field', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-palette-phone', async () => {
      await page.setViewport(390, 844, true);
      await openApp(page, server.url(''));
      await shell(page, `s.openPalette();`);
      await page.waitFor('.palette-list .menu-item', 5000);
      await sleep(400);
      const r = await page.evaluate(() => {
        const box = (s) => document.querySelector(s).getBoundingClientRect();
        const grab = document.querySelector('.palette .grabber');
        return { top: box('.palette').top, inputTop: box('.palette-input').top, listTop: box('.palette-list').top, grabber: grab ? getComputedStyle(grab).display : 'none' };
      });
      assert.ok(Math.abs(r.top) <= 1, `the palette hangs from the top edge (top ${r.top})`);
      assert.ok(r.listTop > r.inputTop, 'results come under the field');
      assert.equal(r.grabber, 'none', 'no bottom-sheet grabber on a sheet that drops from the top');
      await closeLayers(page);
    });
  });

  test('on phones the palette has a Cancel button and no Keyboard shortcuts', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-palette-cancel', async () => {
      await page.setViewport(390, 844, true);
      await openApp(page, server.url(''));
      await shell(page, `s.openPalette();`);
      await page.waitFor('.palette-list .menu-item', 5000);
      const r = await page.evaluate(() => {
        const cancel = document.querySelector('.palette-cancel');
        const box = cancel?.getBoundingClientRect();
        return { cancel: cancel ? cancel.textContent.trim() : null, visible: !!box && box.width > 0, rows: [...document.querySelectorAll('.palette-list .menu-item')].map((b) => b.textContent.trim()) };
      });
      assert.equal(r.cancel, 'Cancel');
      assert.ok(r.visible, 'Cancel shows on a phone');
      assert.ok(!r.rows.some((t) => /keyboard shortcuts/i.test(t)), `no Keyboard shortcuts on a touch screen (${r.rows.join(', ')})`);
      await page.clickText('button', 'Cancel');
      await page.waitFor(() => !document.querySelector('.palette'), { timeout: 3000, message: 'Cancel to close the palette' });
    });
  });

  test('keyboard focus in menus and the app switcher is a ring, not a grey tint', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-menu-focus', async () => {
      await openApp(page, server.url('tasks/'));
      for (const [theme, accent] of [['light', 'yellow'], ['dim', 'iris'], ['dark', 'blue']]) {
        await setLook(page, theme, accent);
        await page.evaluate(() => document.querySelector('[data-app-menu]').focus());
        await page.press('Enter');
        await page.waitFor('.menu .menu-item', 5000);
        await page.press('ArrowDown');
        await sleep(150);
        const r = await page.evaluate(() => {
          const a = document.activeElement;
          return { item: a.classList.contains('menu-item'), shadow: getComputedStyle(a).boxShadow, menu: getComputedStyle(a.closest('.menu')).backgroundColor };
        });
        assert.ok(r.item, 'focus is on a menu item');
        assert.match(r.shadow, /inset/, `${theme}/${accent}: the focused menu item wears a ring (box-shadow ${r.shadow})`);
        const ratio = contrast(shadowColor(r.shadow), r.menu);
        assert.ok(ratio >= 3, `${theme}/${accent}: the ring is 3:1 against the menu (${ratio.toFixed(2)}:1)`);
        await closeLayers(page);
      }
      await setLook(page, 'light');
      await page.evaluate(() => document.querySelector('[data-app-switcher]').focus());
      await page.press('Enter');
      await page.waitFor('.switcher-app', 5000);
      await page.press('ArrowRight');
      await sleep(150);
      const sw = await page.evaluate(() => {
        const a = document.activeElement;
        const cur = document.querySelector('.switcher-app[aria-current="page"]');
        return { onTile: a.classList.contains('switcher-app'), same: a === cur, outline: getComputedStyle(a).outlineStyle, width: parseFloat(getComputedStyle(a).outlineWidth), curOutline: getComputedStyle(cur).outlineStyle };
      });
      assert.ok(sw.onTile && !sw.same, 'focus moved to another app tile');
      assert.equal(sw.outline, 'solid', 'the focused tile has an outline ring');
      assert.ok(sw.width >= 2);
      assert.equal(sw.curOutline, 'none', 'the current app keeps its plain grey tile, so the two never look alike');
      await closeLayers(page);
    });
  });

  test('mini-month dots sit under the day circles and the week band stays behind them', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-minical', async () => {
      await openApp(page, server.url('schedule/'));
      await page.waitFor('#minical .mc-day.mark', 8000);
      const marked = await page.evaluate(() =>
        [...document.querySelectorAll('#minical .mc-day.mark')].map((d) => {
          const cell = d.getBoundingClientRect();
          const circle = d.querySelector('span').getBoundingClientRect();
          const dot = getComputedStyle(d, '::after');
          const dotTop = cell.bottom - parseFloat(dot.bottom) - parseFloat(dot.height);
          return { date: d.dataset.date, overlap: circle.bottom - dotTop };
        }),
      );
      assert.ok(marked.length > 0, "Schedule's mini month marks the days that have events");
      assert.deepEqual(marked.filter((d) => d.overlap > 0.5), [], 'no dot overlaps its day circle');

      await page.waitFor('#minical .mc-day.in-range', 8000);
      const band = await page.evaluate(() => {
        const d = document.querySelector('#minical .mc-day.in-range');
        const cell = d.getBoundingClientRect();
        const circle = d.querySelector('span').getBoundingClientRect();
        const b = getComputedStyle(d, '::before');
        return { cellBg: getComputedStyle(d).backgroundColor, bandTop: cell.top + parseFloat(b.top), bandBottom: cell.top + parseFloat(b.top) + parseFloat(b.height), circleTop: circle.top, circleBottom: circle.bottom };
      });
      assert.equal(band.cellBg, 'rgba(0, 0, 0, 0)', 'the cell itself is not tinted (that would cover the dot row)');
      assert.ok(Math.abs(band.bandTop - band.circleTop) <= 1 && Math.abs(band.bandBottom - band.circleBottom) <= 1, `the band hugs the circles' row (${JSON.stringify(band)})`);
    });
  });

  test('in every mini-month layout the week band hugs the day circles and dots stay clear of them', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('tasks/'));
    // Full size and compact, with and without busy-day dots, each with a selected week (as Schedule shows one).
    const r = await page.evaluate(async () => {
      const { miniCalendar } = await import('/shared/minical.js');
      const { ymd, addDaysYmd, startOfWeek } = await import('/shared/dates.js');
      const month = new Date(2026, 5, 1);
      const from = ymd(startOfWeek(new Date(2026, 5, 10), 0));
      const to = addDaysYmd(from, 6);
      const out = {};
      for (const compact of [false, true]) {
        for (const dots of [false, true]) {
          const box = document.createElement('div');
          box.style.cssText = 'position:fixed;left:0;top:0;width:280px;background:var(--bg);z-index:99';
          box.innerHTML = miniCalendar({ month, selected: addDaysYmd(from, 2), rangeFrom: from, rangeTo: to, marks: dots ? new Set(Array.from({ length: 7 }, (_, i) => addDaysYmd(from, i))) : undefined, compact });
          document.body.append(box);
          const days = [...box.querySelectorAll('.mc-day.in-range')].map((d) => {
            const cell = d.getBoundingClientRect();
            const circle = d.querySelector('span').getBoundingClientRect();
            const band = getComputedStyle(d, '::before');
            const dot = getComputedStyle(d, '::after');
            return {
              bandOff: Math.max(Math.abs(cell.top + parseFloat(band.top) - circle.top), Math.abs(cell.top + parseFloat(band.top) + parseFloat(band.height) - circle.bottom)),
              dotGap: dot.content === 'none' ? null : cell.bottom - parseFloat(dot.bottom) - parseFloat(dot.height) - circle.bottom,
            };
          });
          out[`${compact ? 'compact' : 'full size'}${dots ? ' with dots' : ''}`] = days;
          box.remove();
        }
      }
      return out;
    });
    for (const [layout, days] of Object.entries(r)) {
      assert.equal(days.length, 7, `${layout}: the selected week is marked`);
      const worstBand = Math.max(...days.map((d) => d.bandOff));
      assert.ok(worstBand <= 0.5, `${layout}: the week band hugs the circles (off by ${worstBand}px)`);
      if (layout.endsWith('with dots')) {
        const worstGap = Math.min(...days.map((d) => d.dotGap));
        assert.ok(worstGap >= 0, `${layout}: dots sit below the circles (gap ${worstGap}px)`);
      }
    }
  });

  test('task circles stay visible in every theme', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-rings', async () => {
      await openApp(page, server.url('tasks/#/today'));
      for (const theme of ['light', 'dim', 'dark']) {
        await setLook(page, theme);
        const r = await page.evaluate(() => {
          const ring = [...document.querySelectorAll('.check[aria-checked="false"]')].find((c) => !/\bp[123]\b/.test(c.className));
          if (!ring) return null;
          return { ring: getComputedStyle(ring).borderTopColor, bg: getComputedStyle(document.body).backgroundColor };
        });
        assert.ok(r, 'an open task without a priority shows its circle');
        const ratio = contrast(r.ring, r.bg);
        assert.ok(ratio >= 3, `${theme}: the task circle is 3:1 against the page (${ratio.toFixed(2)}:1)`);
      }
      await setLook(page, 'light');
    });
  });

  test('Windows Contrast themes keep switches, swatches and selected states visible', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-forced-colors', async () => {
      await page.emulateMedia({ 'forced-colors': 'active' });
      try {
        await openApp(page, server.url('tasks/'));
        await shell(page, `s.openSettings();`);
        await page.waitFor('.modal.settings .switch', 5000);
        const r = await page.evaluate(() => {
          const cs = (el, p) => getComputedStyle(el)[p];
          const sw = document.querySelector('.modal.settings .switch');
          const seg = document.querySelector('.modal.settings .segmented button[aria-pressed="true"]');
          const swatch = document.querySelector('.modal.settings .swatch-btn');
          return {
            knob: cs(sw.querySelector('span'), 'backgroundColor'),
            track: cs(sw, 'backgroundColor'),
            switchEdge: cs(sw, 'borderTopStyle'),
            segOutline: seg ? cs(seg, 'outlineStyle') : 'no segmented control',
            swatchAdjust: swatch ? cs(swatch, 'forcedColorAdjust') : 'no swatch',
            modalEdge: parseFloat(cs(document.querySelector('.modal.settings'), 'borderTopWidth')),
          };
        });
        assert.notEqual(r.knob, r.track, 'a switch knob differs from its track');
        assert.equal(r.switchEdge, 'solid', 'a switch has an edge');
        assert.equal(r.segOutline, 'solid', 'the selected segment is outlined');
        assert.equal(r.swatchAdjust, 'none', 'accent swatches keep their colours');
        assert.ok(r.modalEdge >= 1, 'the sheet has an edge');
        await closeLayers(page);
      } finally {
        await page.emulateMedia({ 'forced-colors': '' });
      }
    });
  });

  test('a tooltip never takes the pointer: a click over it reaches the control it covers', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-tooltip-click-through', async () => {
      const g = await starOverReschedule(page, server);
      const events = await page.evaluate(() =>
        ['tooltip', 'tooltip on', 'tooltip on hoverable'].map((cls) => {
          const t = document.createElement('div');
          t.className = cls;
          t.textContent = 'Tip';
          document.body.append(t);
          const out = getComputedStyle(t).pointerEvents;
          t.remove();
          return out;
        }),
      );
      assert.deepEqual(events, ['none', 'none', 'none'], 'no tooltip takes the pointer, shown or not, whatever opened it');
      const tip = await hoverStar(page, g);
      assert.ok(covers(tip, g.res), `the star's tooltip covers Reschedule (tooltip ${JSON.stringify(tip)}, Reschedule ${JSON.stringify(g.res)})`);
      const hit = await page.evaluate((x, y) => (document.elementFromPoint(x, y)?.closest('[data-reschedule]') ? 'Reschedule' : document.elementFromPoint(x, y)?.className), g.res.x, g.res.y);
      assert.equal(hit, 'Reschedule', 'under the shown tooltip, the pointer finds Reschedule');
      await glide(page, g.star, g.res);
      await sleep(100);
      await clickAt(page, g.res.x, g.res.y);
      await page.waitFor(() => !!document.querySelector('.menu'), { timeout: 3000, message: 'the Reschedule menu to open from a click over the tooltip' });
      await closeLayers(page);
      await mouseTo(page, 700, 500);
    });
  });

  test('a pointer-opened tooltip stays up while the pointer is on it, and lets a click or wheel turn through (WCAG 1.4.13)', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-tooltip-hover', async () => {
      const g = await starOverReschedule(page, server);
      const scroll = () => page.evaluate(() => document.querySelector('[data-qa-scroller]').scrollTop);
      assert.ok(await page.evaluate(() => { const s = document.querySelector('[data-qa-scroller]'); return !!s && s.scrollHeight > s.clientHeight + 100; }), 'the list scrolls at this height');
      // Onto the tooltip: it stays, and a wheel turn there scrolls the list beneath it.
      const tip = await hoverStar(page, g);
      await glide(page, g.star, tip, 6);
      await sleep(250);
      assert.ok(await tipShown(page), 'the tooltip is still up with the pointer on it');
      const before = await scroll();
      await wheelAt(page, tip.x, tip.y, 300);
      await page.waitFor((y) => document.querySelector('[data-qa-scroller]').scrollTop > y, { args: [before], timeout: 3000, message: 'a wheel turn over the tooltip to scroll the list' });
      await page.evaluate(() => document.querySelector('[data-qa-scroller]').scrollTo({ top: 0, behavior: 'instant' }));
      await sleep(200);
      // Onto the part of it over Reschedule: it stays, and a click there opens Reschedule's menu.
      await hoverStar(page, g);
      await glide(page, g.star, g.res);
      await sleep(250);
      assert.ok(await tipShown(page), 'the tooltip is still up with the pointer on the part over Reschedule');
      await clickAt(page, g.res.x, g.res.y);
      await page.waitFor(() => !!document.querySelector('.menu'), { timeout: 3000, message: 'the Reschedule menu to open' });
      await closeLayers(page);
      // Off both the star and its tooltip, the star's tooltip goes (another control there may show its own).
      const starTip = await hoverStar(page, g);
      await glide(page, g.star, { x: g.star.x - 320, y: g.star.y + 90 });
      await page.waitFor(
        (left, top) => {
          const t = document.querySelector('.tooltip.on');
          if (!t) return true;
          const r = t.getBoundingClientRect();
          return Math.abs(r.left - left) > 2 || Math.abs(r.top - top) > 2;
        },
        { args: [starTip.left, starTip.top], timeout: 2000, message: "the star's tooltip to go once the pointer is off it and its trigger" },
      );
      await mouseTo(page, 700, 500);
    });
  });
});
