// QA regression (tasks): Upcoming's week strip follows the list, at 1440x900.
//   jump     a day picked in the strip is marked at once (and stays marked once the list has scrolled there)
//   scroll   scrolling into the second week turns the strip to that week, marks the day under it and names
//            its month; the arrows then step on from the week shown
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (page) =>
  page.evaluate(() => ({
    week: document.querySelector('.up-days')?.dataset.week,
    days: [...document.querySelectorAll('[data-up-jump]')].map((b) => b.dataset.upJump),
    active: [...document.querySelectorAll('.up-day.active')].map((b) => b.dataset.upJump),
    month: document.querySelector('.up-month')?.textContent.trim(),
  }));
/** 'YYYY-MM-DD' + n days (local noon, so a DST change never moves the date). */
const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const monthName = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};

describe('qa tasks: Upcoming week strip', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let page;

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('tasks/'));
    await page.evaluate(() => (location.hash = '#/upcoming'));
    await page.waitFor('.up-days', 5000);
    await settle(page, 300);
  });

  test('a day picked in the strip is marked at once and stays marked', async () => {
    await withScreenshot(page, 'qa-tasks-upcoming-jump', async () => {
      const s0 = await strip(page);
      assert.deepEqual(s0.active, [s0.days[0]], 'the first day is marked to start with');
      const thu = s0.days[4];
      await page.click((d) => document.querySelector(`[data-up-jump="${d}"]`), { args: [thu] });
      assert.deepEqual((await strip(page)).active, [thu], 'marked at once');
      await sleep(1300); // the list scrolls there
      assert.deepEqual((await strip(page)).active, [thu], 'still marked once the list has landed');
      assert.ok((await page.evaluate(() => document.querySelector('#main').scrollTop)) > 0, 'the list scrolled');
    });
  });

  test('scrolling into the next week turns the strip to it; the arrows step on from there', async () => {
    await withScreenshot(page, 'qa-tasks-upcoming-scroll', async () => {
      const first = (await strip(page)).days[0];
      const target = addDays(first, 8); // the second day of the list's second week
      await page.evaluate((d) => {
        const head = document.getElementById(`day-${d}`);
        const main = document.querySelector('#main');
        const bar = document.querySelector('.up-bar').getBoundingClientRect().bottom;
        main.scrollTop += head.getBoundingClientRect().top - bar - 4;
      }, target);
      await page.waitFor((w) => document.querySelector('.up-days')?.dataset.week === w, { timeout: 3000, args: [addDays(first, 7)], message: 'the strip to turn to the second week' });
      const s = await strip(page);
      assert.deepEqual(s.active, [target], `the day under the strip is marked (${s.active})`);
      assert.equal(s.month, monthName(target), "the strip names that day's month");
      await page.click('[data-up-step="7"]');
      await page.waitFor((w) => document.querySelector('.up-days')?.dataset.week === w, { timeout: 3000, args: [addDays(first, 14)], message: 'the week after the one shown' });
      assert.equal(await page.evaluate(() => document.querySelector('#main').scrollTop), 0, 'a new week opens at its top');
      await page.click('[data-up-today]');
      await page.waitFor((w) => document.querySelector('.up-days')?.dataset.week === w, { timeout: 3000, args: [first], message: 'back to this week' });
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
