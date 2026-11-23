// QA regression (design system, shared/ui.css), the components other apps asked for. On a phone the date, time
// and repeat pickers are bottom sheets the width of the screen, with touch-size rows, days and fields (shell.js
// adds .as-sheet; ui.css lays it out), and a small circle (a step) takes a tap that just misses it. On a desktop
// the pickers stay popovers and small circles keep their drawn size, a punctuation shortcut keeps its keycap in
// a menu hint, Tasks, Schedule and Notes share one primary sidebar pill in every theme, and empty-state text
// is balanced (no one-word last line).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setLook(page, theme, accent = 'iris') {
  await page.evaluate(async (theme, accent) => (await import('/shared/store.js')).settings.set({ theme, accent }), theme, accent);
  await page.waitFor((theme, accent) => document.documentElement.dataset.theme === theme && document.documentElement.dataset.accent === accent, { args: [theme, accent], timeout: 5000 });
  await settle(page, 150);
}

/** A touch tap at a point (the tap lands wherever hit-testing puts it, as for a finger). */
async function tapAt(page, x, y) {
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** A task due today with two steps, opened in its details (a sheet on a phone, the side pane on a desktop). */
async function openTaskWithSteps(page, server) {
  await openApp(page, server.url(`tasks/?fresh=${Date.now()}#/today`));
  const id = await page.evaluate(async () => {
    const { createTask } = await import('/shared/model.js');
    const { todayYmd } = await import('/shared/dates.js');
    return createTask({ title: 'Pack for the trip', date: todayYmd(), checklist: [{ id: 'qa-s1', title: 'Passport', done: false }, { id: 'qa-s2', title: 'Charger', done: false }] }).id;
  });
  await page.evaluate((id) => (location.hash = `#/task/${id}`), id);
  await page.waitFor(() => !!document.querySelector('[data-step-check]')?.offsetParent, { timeout: 5000, message: "the task's steps in its details" });
  await settle(page, 400);
  return id;
}

describe('qa design system: shared components', () => {
  const ctx = useE2E({ width: 390, height: 844, mobile: true, scheme: 'light' });

  test('on a phone the date, time and repeat pickers are bottom sheets the width of the screen, sized for touch', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-phone-sheets', async () => {
      await openApp(page, server.url('tasks/#/today'));
      for (const open of ['openDatePicker', 'openTimePicker', 'openRepeatPicker']) {
        const r = await page.evaluate(async (open) => {
          const s = await import('/shared/shell.js');
          const b = document.createElement('button');
          b.textContent = 'anchor';
          b.style.cssText = 'position:fixed;left:20px;top:120px';
          document.body.append(b);
          const opts = open === 'openTimePicker' ? { value: '09:00' } : open === 'openRepeatPicker' ? { value: { freq: 'week', interval: 2, days: [1, 4] }, date: '2026-11-26' } : { value: null };
          const h = s[open](b, opts);
          await Promise.all(h.el.getAnimations().map((a) => a.finished.catch(() => {}))); // past the slide-up
          const box = h.el.getBoundingClientRect();
          const size = (sel) => [...h.el.querySelectorAll(sel)].filter((n) => n.getClientRects().length).map((n) => n.getBoundingClientRect());
          const font = (sel) => {
            const n = h.el.querySelector(sel);
            return n ? parseFloat(getComputedStyle(n).fontSize) : null;
          };
          const out = {
            sheet: h.el.classList.contains('as-sheet'),
            scrim: !!document.querySelector('.pop-scrim'),
            left: Math.round(box.left),
            bottom: Math.round(box.bottom),
            width: Math.round(box.width),
            vw: innerWidth,
            vh: innerHeight,
            rows: size('.menu-item').map((x) => Math.round(x.height)),
            days: size('.mc-day').map((x) => Math.round(x.height)),
            circles: size('.mc-day span').map((x) => Math.round(x.width)),
            fieldFont: font('.dp-type .input, .tp-type .input, input[name="interval"]'),
            fieldHeight: size('.dp-type .input, .tp-type .input, input[name="interval"]').map((x) => Math.round(x.height))[0] ?? null,
            list: size('.tp-list').map((x) => Math.round(x.height))[0] ?? null,
          };
          h.close();
          b.remove();
          return out;
        }, open);
        const what = `${open}: ${JSON.stringify(r)}`;
        assert.ok(r.sheet && r.scrim, `${open} opens as a sheet over a scrim on a phone (${what})`);
        assert.deepEqual({ left: r.left, bottom: r.bottom, width: r.width }, { left: 0, bottom: r.vh, width: r.vw }, `${open}: along the bottom edge, the width of the screen (${what})`);
        assert.ok(r.fieldFont >= 16, `${open}: its field's text is 16px or more, so iOS does not zoom in (${what})`);
        assert.ok(r.fieldHeight >= 40, `${open}: its field is 40px or taller (${what})`);
        if (open === 'openDatePicker') {
          assert.ok(r.rows.length && r.rows.every((h) => h >= 44), `quick dates are 44px rows (${what})`);
          assert.ok(r.days.length >= 28 && r.days.every((h) => h >= 40), `calendar days are 40px tall (${what})`);
          assert.ok(r.circles.every((w) => w >= 36), `with 36px circles (${what})`);
        }
        if (open === 'openTimePicker') {
          assert.ok(r.rows.length && r.rows.every((h) => h >= 44), `times are 44px rows (${what})`);
          assert.ok(r.list > 0 && r.list <= Math.ceil(r.vh * 0.52), `the time list scrolls within about half the screen (${what})`);
        }
        await page.waitFor(() => !document.querySelector('.pop-scrim'), { timeout: 3000, message: `the ${open} scrim to go` });
      }
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('on a touch screen a tap that just misses a step’s circle completes the step', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-phone-near-miss', async () => {
      const id = await openTaskWithSteps(page, server);
      const g = await page.evaluate(() => {
        const c = document.querySelector('[data-step-check]');
        c.scrollIntoView({ block: 'center' });
        const r = c.getBoundingClientRect();
        // 4px outside the circle on each side: the circle (not the step's name or the row) takes it.
        const near = [
          [r.left - 4, r.top + r.height / 2],
          [r.right + 4, r.top + r.height / 2],
          [r.left + r.width / 2, r.top - 4],
          [r.left + r.width / 2, r.bottom + 4],
        ].map(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-step-check]') === c);
        return { x: r.left - 4, y: r.top + r.height / 2, w: r.width, near, checked: c.getAttribute('aria-checked') };
      });
      assert.ok(g.w <= 18, `the step circle is small (${g.w}px), so it needs the larger hit area`);
      assert.deepEqual(g.near, [true, true, true, true], 'taps 4px outside the circle reach it');
      assert.equal(g.checked, 'false');
      await tapAt(page, g.x, g.y);
      await page.waitFor(() => document.querySelector('[data-step-check]')?.getAttribute('aria-checked') === 'true', { timeout: 3000, message: 'the near miss to complete the step' });
      const done = await page.evaluate(async (id) => (await import('/shared/store.js')).db.get('tasks', id).checklist.map((s) => s.done), id);
      assert.deepEqual(done, [true, false], 'the first step is done, and only that one');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('on a desktop: pickers stay popovers, small circles keep their size, a punctuation shortcut keeps its keycap', async () => {
    const { page, server } = ctx;
    await page.setViewport(1440, 900, false);
    await withScreenshot(page, 'qa-ds-desktop-components', async () => {
      await openTaskWithSteps(page, server);
      const fine = await page.evaluate(async () => {
        const c = document.querySelector('[data-step-check]');
        const s = await import('/shared/shell.js');
        const b = document.querySelector('#inspector [data-dp="date"]');
        const h = s.openDatePicker(b, { value: null });
        await Promise.all(h.el.getAnimations().map((a) => a.finished.catch(() => {})));
        const box = h.el.getBoundingClientRect();
        const out = { coarse: matchMedia('(pointer: coarse)').matches, before: getComputedStyle(c, '::before').content, sheet: h.el.classList.contains('as-sheet'), width: Math.round(box.width), day: Math.round(h.el.querySelector('.mc-day').getBoundingClientRect().height) };
        h.close();
        return out;
      });
      assert.equal(fine.coarse, false);
      assert.equal(fine.before, 'none', 'no enlarged hit area under a mouse');
      assert.deepEqual({ sheet: fine.sheet, width: fine.width, day: fine.day }, { sheet: false, width: 296, day: 32 }, 'the date picker is its usual popover');

      await page.press('Escape');
      await page.click('.brand-btn');
      await page.waitFor('.menu [role="menuitem"]', 3000);
      await settle(page, 200);
      const cap = await page.evaluate(() => {
        const k = [...document.querySelectorAll('.menu .menu-item')].find((i) => /settings/i.test(i.textContent))?.querySelector('.hint .kbd-punct');
        if (!k) return null;
        const r = k.getBoundingClientRect();
        const plain = document.querySelector('.menu .menu-item .hint .kbd:not(.kbd-punct)');
        return { text: k.textContent, w: r.width, h: r.height, bg: getComputedStyle(k).backgroundColor, plainBg: plain && getComputedStyle(plain).backgroundColor };
      });
      assert.ok(cap, "the app menu's Settings row shows its shortcut, a punctuation key");
      assert.equal(cap.text, ',');
      assert.ok(cap.w >= 18 && cap.h >= 18, `drawn as a keycap, not a speck (${JSON.stringify(cap)})`);
      assert.doesNotMatch(cap.bg, /rgba\(0, 0, 0, 0\)|transparent/, `with the keycap fill (${cap.bg})`);
      if (cap.plainBg) assert.match(cap.plainBg, /rgba\(0, 0, 0, 0\)|transparent/, 'while letter keys in hints stay plain text');
      await page.press('Escape');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('Tasks, Schedule and Notes share one primary sidebar pill in every theme, and empty states are balanced', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-desktop-pill', async () => {
      const pill = () =>
        page.evaluate(async () => {
          const b = document.querySelector('.sidebar .create-btn');
          if (!b) return null;
          // A theme switched live fades the pill's fill and shadow (transitions): read them once they have settled.
          await Promise.all(b.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
          const s = getComputedStyle(b);
          const r = b.getBoundingClientRect();
          const keys = ['height', 'borderRadius', 'backgroundColor', 'borderTopWidth', 'borderTopColor', 'boxShadow', 'fontSize', 'fontWeight', 'paddingLeft', 'paddingRight', 'color'];
          return { ...Object.fromEntries(keys.map((k) => [k, s[k]])), icon: getComputedStyle(b.querySelector('.i')).color, left: Math.round(r.left), top: Math.round(r.top) };
        });
      for (const theme of ['light', 'dim', 'dark']) {
        const look = {};
        for (const app of ['tasks', 'schedule', 'notes']) {
          await openApp(page, server.url(`${app}/?look=${theme}`));
          await setLook(page, theme);
          look[app] = await pill();
          assert.ok(look[app], `${app} has the sidebar pill (${theme})`);
        }
        assert.equal(look.tasks.height, '44px');
        assert.equal(look.tasks.borderRadius, '9999px');
        assert.deepEqual(look.schedule, look.tasks, `the same pill, in the same place, in Schedule as in Tasks (${theme})`);
        assert.deepEqual(look.notes, look.tasks, `and in Notes (${theme})`);
      }
      await openApp(page, server.url('notes/#/trash'));
      await page.waitFor('.empty p', { timeout: 5000, message: "Notes' empty Recently Deleted" });
      const wrap = await page.evaluate(() => getComputedStyle(document.querySelector('.empty p')).textWrapStyle);
      assert.equal(wrap, 'balance', 'empty-state text wraps balanced');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
