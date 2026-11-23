// QA (schedule, cross-area round) on a phone (390x844, mobile emulation with touch): the top bar's Main
// menu, Today, Previous and Next are 44px touch targets; the Tasks sheet is a modal dialog (the calendar,
// tab bar, + and drawer behind it are inert, it takes focus itself so no keyboard pops up, Tab stays in it,
// keys for the page behind wait, and Esc, i or the scrim close it, focus going back to the tab bar's Tasks);
// the drawer is a modal dialog too, and picking a day closes it with focus back on its button.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, browserToday, withScreenshot } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('qa schedule: cross-area fixes on a phone', () => {
  const ctx = useE2E({ width: 390, height: 844, mobile: true, scheme: 'light' });
  let page;
  let today;

  const go = async (hash) => {
    await page.evaluate((h) => (location.hash = h), hash);
    await settle(page, 400);
  };
  const touch = (type, x, y) => page.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const tap = async (x, y) => {
    await touch('touchStart', x, y);
    await sleep(50);
    await touch('touchEnd', x, y);
  };
  const tapOn = async (selector) => {
    const c = await page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector);
    await tap(c.x, c.y);
  };
  const focused = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return { body: true };
      return { id: a.id || null, tag: a.tagName.toLowerCase(), tab: a.dataset.tab ?? null, nav: a.matches('[data-nav-toggle]'), inPanel: !!a.closest('#panel'), inSidebar: !!a.closest('#sidebar') };
    });
  const sheet = () =>
    page.evaluate(() => {
      const p = document.querySelector('#panel');
      return {
        open: !p.hidden,
        role: p.getAttribute('role'),
        modal: p.getAttribute('aria-modal'),
        inert: ['#main', '#tabbar', '.fab', '#sidebar'].filter((s) => document.querySelector(s)?.inert),
      };
    });

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('schedule/'));
    today = await browserToday(page);
    await settle(page, 200);
  });

  test('the top bar’s Main menu, Today, Previous and Next are 44px touch targets', async () => {
    await go(`#/week/${today}`);
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll('#topbar button')]
        .filter((b) => b.getClientRects().length && !b.closest('.range-h'))
        .map((b) => [b.getAttribute('aria-label'), Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]),
    );
    assert.deepEqual(sizes.map(([n]) => n), ['Main menu', 'Today', 'Previous', 'Next']);
    for (const [name, w, h] of sizes) assert.ok(w >= 44 && h >= 44, `${name} is ${w}x${h}`);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#range-title').getBoundingClientRect().width > 80);
    assert.equal(fits, true, 'the bar still fits, with room for the month');
  });

  test('the Tasks sheet is a modal dialog: inert behind, focus in and kept, Esc / i / the scrim close it, focus back', async () => {
    await withScreenshot(page, 'qa-schedule-cross-sheet', async () => {
      await go(`#/week/${today}`);
      await tapOn('#tabbar [data-tab="tasks"]');
      await settle(page, 500);
      assert.deepEqual(await sheet(), { open: true, role: 'dialog', modal: 'true', inert: ['#main', '#tabbar', '.fab', '#sidebar'] });
      let f = await focused();
      assert.equal(f.id, 'panel', `the sheet takes focus itself, so no keyboard pops up: ${JSON.stringify(f)}`);
      for (let i = 0; i < 24; i++) {
        await page.press(i % 4 === 3 ? 'Shift+Tab' : 'Tab');
        f = await focused();
        assert.ok(f.inPanel, `Tab ${i + 1} stays in the sheet: ${JSON.stringify(f)}`);
      }
      // Keys for the calendar behind wait (j would step the range).
      const hash = await page.evaluate(() => location.hash);
      await page.evaluate(() => document.querySelector('#panel').focus());
      await page.press('j');
      await sleep(150);
      assert.equal(await page.evaluate(() => location.hash), hash, 'j did not move the calendar behind the sheet');
      // Esc from the text field closes it; focus goes back to the tab bar's Tasks.
      await page.evaluate(() => document.querySelector('[data-panel-add]').focus());
      await page.press('Escape');
      await settle(page, 400);
      assert.deepEqual(await sheet(), { open: false, role: null, modal: null, inert: [] });
      assert.equal((await focused()).tab, 'tasks', 'focus is back on Tasks in the tab bar');
      // Open with the keyboard, close with i.
      await page.press('Enter');
      await settle(page, 400);
      assert.equal((await sheet()).open, true);
      await page.press('i');
      await settle(page, 400);
      assert.equal((await sheet()).open, false);
      assert.equal((await focused()).tab, 'tasks');
      // Open, then a tap on the scrim above the sheet closes it; focus still goes back.
      await tapOn('#tabbar [data-tab="tasks"]');
      await settle(page, 500);
      assert.equal((await sheet()).open, true);
      await tap(195, 20);
      await settle(page, 400);
      assert.deepEqual(await sheet(), { open: false, role: null, modal: null, inert: [] });
      assert.equal((await focused()).tab, 'tasks', 'after the scrim too');
    });
  });

  test('the drawer is a modal dialog on a phone; picking a day closes it, focus back on its button', async () => {
    await withScreenshot(page, 'qa-schedule-cross-phone-drawer', async () => {
      await go(`#/week/${today}`);
      await tapOn('#topbar [data-nav-toggle]');
      await settle(page, 500);
      const st = await page.evaluate(() => ({
        role: document.querySelector('#sidebar').getAttribute('role'),
        modal: document.querySelector('#sidebar').getAttribute('aria-modal'),
        inert: ['#main', '#tabbar', '.fab'].filter((s) => document.querySelector(s)?.inert),
        expanded: document.querySelector('#topbar [data-nav-toggle]').getAttribute('aria-expanded'),
      }));
      assert.deepEqual(st, { role: 'dialog', modal: 'true', inert: ['#main', '#tabbar', '.fab'], expanded: 'true' });
      assert.equal((await focused()).inSidebar, true, 'focus moves into the drawer');
      const d = await page.evaluate((t) => [...document.querySelectorAll('#minical .mc-day:not(.out)')].map((b) => b.dataset.date).find((x) => x !== t), today);
      await tapOn(`#minical [data-date="${d}"]`);
      await settle(page, 500);
      assert.equal(await page.evaluate(() => document.querySelector('#shell').classList.contains('nav-open')), false);
      assert.equal(await page.evaluate(() => document.querySelector('#main').inert), false);
      assert.equal((await focused()).nav, true, 'focus is back on the menu button');
      assert.match(await page.evaluate(() => location.hash), new RegExp(d));
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
