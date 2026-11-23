// QA regressions for the shell's pickers on a phone (390x844, touch): the date and time pickers open as
// bottom sheets over a scrim (class .as-sheet, which ui.css lays out), and a tap on the scrim closes
// just the picker, not the details sheet under it, and nothing under the tap is pressed (also when it closes
// a sheet opened from another). A sheet closed any other way (Escape, a day picked) takes its scrim along at
// once, so the next tap reaches the page. The repeat picker opens without raising the keyboard.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A touch tap, without waiting afterwards. */
async function tapNow(page, x, y) {
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function tap(page, sel) {
  const p = await page.evaluate((sel) => {
    const e = [...document.querySelectorAll(sel)].find((x) => x.offsetParent);
    if (!e) return null;
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);
  assert.ok(p, `${sel} is on screen`);
  await tapAt(page, p.x, p.y);
}
async function tapAt(page, x, y) {
  await tapNow(page, x, y);
  await sleep(350);
}

describe('qa shell (phone): pickers are bottom sheets', () => {
  const ctx = useE2E({ width: 390, height: 844, mobile: true, scheme: 'light' });

  test('the date and time pickers open as sheets over a scrim; a scrim tap closes only the picker', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-phone-sheets', async () => {
      await openApp(page, server.url('tasks/#/today'));
      await tap(page, '.task-title');
      await page.waitFor('[data-dp="date"]', { timeout: 5000, message: 'the task details' });
      await settle(page, 300);
      await tap(page, '[data-dp="date"]');
      await page.waitFor('.dp-pop', 3000);
      const s = await page.evaluate(() => {
        const pop = document.querySelector('.dp-pop');
        const scrim = document.querySelector('.pop-scrim');
        return { sheet: pop.classList.contains('as-sheet'), scrim: !!scrim, z: scrim && +getComputedStyle(scrim).zIndex, popZ: +getComputedStyle(pop).zIndex };
      });
      assert.ok(s.sheet, 'the date picker is a sheet');
      assert.ok(s.scrim, 'over a scrim');
      assert.ok(s.z > 61 && s.z < s.popZ, `the scrim (${s.z}) sits over sheets and modals (61) and under the picker (${s.popZ})`);
      // A tap on the scrim right over the details' close button: it closes the picker only. The button
      // under it is not pressed (the scrim stays, clear, for the rest of that tap).
      const x = await page.evaluate(() => {
        const b = [...document.querySelectorAll('[data-dp="close"], [aria-label="Close"]')].find((n) => n.offsetParent && !n.closest('.menu'));
        const r = b?.getBoundingClientRect();
        return r && r.bottom < document.querySelector('.dp-pop').getBoundingClientRect().top ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : { x: 200, y: 40 };
      });
      await tapAt(page, x.x, x.y);
      await page.waitFor(() => !document.querySelector('.dp-pop'), { timeout: 3000, message: 'the picker to close' });
      await page.waitFor(() => !document.querySelector('.pop-scrim'), { timeout: 3000, message: 'the scrim to go' });
      await sleep(200);
      assert.ok(await page.evaluate(() => !!document.querySelector('[data-dp="date"]')?.offsetParent), 'the details are still open');

      await tap(page, '[data-time-field]');
      await page.waitFor('.tp-pop', 3000);
      assert.ok(await page.evaluate(() => document.querySelector('.tp-pop').classList.contains('as-sheet') && !!document.querySelector('.pop-scrim')), 'the time list is a sheet too');
      await tapAt(page, 200, 40);
      await page.waitFor(() => !document.querySelector('.tp-pop, .pop-scrim'), 3000);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('a sheet closed by Escape or by a day picked in it lets the very next tap through', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-phone-next-tap', async () => {
      // A fresh load (the query forces one): the details sheet the first test leaves open would cover the list.
      await openApp(page, server.url(`tasks/?fresh=${Date.now()}#/today`));
      const p = await page.evaluate(() => {
        const r = document.querySelector('.task .task-title').getBoundingClientRect();
        return { x: r.x + 24, y: r.y + r.height / 2 };
      });
      const hit = () => page.evaluate((x, y) => (document.elementFromPoint(x, y)?.closest('.task-title') ? 'name' : String(document.elementFromPoint(x, y)?.className || '')), p.x, p.y);
      const openPicker = async () => {
        await page.evaluate(async () => {
          const s = await import('/shared/shell.js');
          s.openDatePicker(document.querySelector('.task .task-title'), { value: null, onPick: () => (window.__qaPicked = (window.__qaPicked || 0) + 1) });
        });
        await page.waitFor(() => document.querySelector('.dp-pop.as-sheet') && document.querySelector('.pop-scrim'), { timeout: 3000, message: 'the date sheet over its scrim' });
        await settle(page, 250);
      };
      const opensDetails = async (message) => {
        await page.waitFor(() => !!document.querySelector('#inspector [data-dp="date"]')?.offsetParent, { timeout: 4000, message });
        await page.press('Escape');
        await page.waitFor(() => document.querySelector('#inspector')?.hidden === true, { timeout: 3000, message: 'Escape to close the details' });
        await settle(page, 300);
      };

      await openPicker();
      await page.press('Escape');
      assert.equal(await hit(), 'name', 'right after Escape a tap finds the row, not a lingering scrim');
      await sleep(50);
      await tapNow(page, p.x, p.y);
      await opensDetails('a tap 50 ms after Escape to open the task');

      await openPicker();
      const day = await page.evaluate(() => {
        const r = document.querySelector('.dp-pop .mc-day:not(.out)').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await tapNow(page, day.x, day.y);
      await page.waitFor(() => !document.querySelector('.dp-pop'), { timeout: 3000, message: 'a tapped day to close the sheet' });
      assert.equal(await page.evaluate(() => window.__qaPicked), 1, 'the day was picked');
      assert.equal(await hit(), 'name', 'right after the pick a tap finds the row');
      await sleep(50);
      await tapNow(page, p.x, p.y);
      await opensDetails('a tap 50 ms after the pick to open the task');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('a scrim tap that closes a sheet and the sheet opened from it presses nothing under it', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-phone-nested-scrim', async () => {
      await openApp(page, server.url(`tasks/?fresh=${Date.now()}#/today`));
      // A control along the top (under the scrims) that counts its clicks, and a date picker with a Time row
      // opened from a button at the bottom, so neither picker covers that control.
      await page.evaluate(async () => {
        const s = await import('/shared/shell.js');
        const top = document.createElement('button');
        top.id = 'qa-under';
        top.textContent = 'under';
        top.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:56px;z-index:50';
        window.__qaUnder = 0;
        top.addEventListener('click', () => window.__qaUnder++);
        const a = document.createElement('button');
        a.id = 'qa-dp-anchor';
        a.textContent = 'date';
        a.style.cssText = 'position:fixed;left:20px;bottom:24px;z-index:50';
        document.body.append(top, a);
        s.openDatePicker(a, { value: null, withTime: true, time: null, onPick: () => {} });
      });
      await page.waitFor('.dp-pop [data-dp="time"]', 3000);
      await settle(page, 250);
      await tap(page, '.dp-pop [data-dp="time"]');
      await page.waitFor(() => document.querySelectorAll('.pop-scrim').length === 2 && !!document.querySelector('.tp-pop'), { timeout: 3000, message: 'the time sheet over the date sheet, each with its scrim' });
      await settle(page, 250);
      assert.ok(await page.evaluate(() => document.elementFromPoint(195, 28)?.classList.contains('pop-scrim')), 'a scrim covers the control');
      await tapNow(page, 195, 28);
      await page.waitFor(() => !document.querySelector('.dp-pop, .tp-pop'), { timeout: 3000, message: 'one tap on the scrim to close both pickers' });
      await sleep(600);
      assert.equal(await page.evaluate(() => window.__qaUnder), 0, 'the tap that closed them pressed nothing under the scrim');
      await page.waitFor(() => !document.querySelector('.pop-scrim'), { timeout: 3000, message: 'the scrims to go' });
      await tapAt(page, 195, 28);
      assert.equal(await page.evaluate(() => window.__qaUnder), 1, 'the next tap reaches the page');
      await page.evaluate(() => ['qa-under', 'qa-dp-anchor'].forEach((id) => document.getElementById(id)?.remove()));
    });
  });

  test('the repeat picker opens as a sheet without raising the keyboard', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('tasks/#/today'));
    const r = await page.evaluate(async () => {
      const s = await import('/shared/shell.js');
      const b = document.createElement('button');
      b.textContent = 'repeat';
      b.style.cssText = 'position:fixed;left:20px;top:200px';
      document.body.append(b);
      b.focus();
      const h = s.openRepeatPicker(b, { value: null, date: '2026-11-26' });
      await new Promise((res) => setTimeout(res, 150));
      const out = { sheet: h.el.classList.contains('as-sheet'), focusInField: document.activeElement?.matches('input, textarea') ?? false };
      h.close();
      b.remove();
      return out;
    });
    assert.deepEqual(r, { sheet: true, focusInField: false });
  });

  test(
    'the date, time and repeat pickers are laid out as bottom sheets, the width of the screen',
    { todo: 'needs the .as-sheet rules in shared/ui.css (the shell-js cross-request to design-system)' },
    async () => {
      const { page, server } = ctx;
      await openApp(page, server.url('tasks/#/today'));
      for (const open of ['openDatePicker', 'openTimePicker', 'openRepeatPicker']) {
        const r = await page.evaluate(async (open) => {
          const s = await import('/shared/shell.js');
          const b = document.createElement('button');
          b.textContent = 'anchor';
          b.style.cssText = 'position:fixed;left:20px;top:120px';
          document.body.append(b);
          const h = s[open](b, { value: open === 'openTimePicker' ? '09:00' : null });
          await new Promise((res) => setTimeout(res, 400)); // past the sheet's slide-up
          const box = h.el.getBoundingClientRect();
          const out = { left: Math.round(box.left), bottom: Math.round(box.bottom), width: Math.round(box.width), vw: innerWidth, vh: innerHeight };
          h.close();
          b.remove();
          return out;
        }, open);
        await page.waitFor(() => !document.querySelector('.pop-scrim'), 3000);
        assert.deepEqual({ left: r.left, bottom: r.bottom, width: r.width }, { left: 0, bottom: r.vh, width: r.vw }, `${open}: a sheet along the bottom edge (${JSON.stringify(r)})`);
      }
    },
  );

  test('menus stay popovers on a phone, and pickers are popovers on a wide screen', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('tasks/#/today'));
    await page.waitFor(() => !document.querySelector('.pop-scrim'), { timeout: 3000, message: 'no picker scrim left from before' });
    const r = await page.evaluate(async () => {
      const s = await import('/shared/shell.js');
      const b = document.createElement('button');
      b.textContent = 'x';
      b.style.cssText = 'position:fixed;left:20px;top:200px';
      document.body.append(b);
      const m = s.openMenu(b, [{ label: 'One' }, { label: 'Two' }]);
      const menu = { sheet: m.el.classList.contains('as-sheet'), scrim: !!document.querySelector('.pop-scrim') };
      m.close();
      b.remove();
      return menu;
    });
    assert.deepEqual(r, { sheet: false, scrim: false });
    await page.setViewport(1024, 800, false);
    await openApp(page, server.url('tasks/#/today'));
    const wide = await page.evaluate(async () => {
      const s = await import('/shared/shell.js');
      const b = document.createElement('button');
      b.textContent = 'x';
      b.style.cssText = 'position:fixed;left:200px;top:100px';
      document.body.append(b);
      const h = s.openDatePicker(b, {});
      const out = { sheet: h.el.classList.contains('as-sheet'), scrim: !!document.querySelector('.pop-scrim') };
      h.close();
      b.remove();
      return out;
    });
    assert.deepEqual(wide, { sheet: false, scrim: false });
    await page.setViewport(390, 844, true);
  });
});
