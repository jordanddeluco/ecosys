// QA regression (tasks): focus, the composer's Date menu and date ranges, at 1440x900 with real keys.
//   focus      a task picked while keyboard focus is on another row (from search, a #/task link, a
//              duplicate) takes the focus: focus, selection and the details pane are on the same task, so
//              Delete deletes the task a screen reader is on
//   time       a time picked in the composer's Date menu goes with its day: after the chip's x or "No date",
//              the next day picked doesn't bring it back
//   range      "dec 3-5" in quick add: planned Dec 3, deadline Dec 5
//   date menu  the date menus (a row's, the composer's) show all of themselves, "No date" included, with
//              no scroll of their own, at 1440x900 and 1280x800
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot, tag, browserToday } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const go = async (page, hash) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await settle(page, 350);
};
const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const make = (page, titles) =>
  page.evaluate(async (titles) => {
    const { createTask } = await import('/shared/model.js');
    const { todayYmd } = await import('/shared/dates.js');
    return titles.map((title) => createTask({ title, date: todayYmd() }).id);
  }, titles);
/** Keyboard focus (focus-visible) on a row's circle. */
const kbFocus = async (page, id) => {
  await page.evaluate((id) => document.querySelector(`.task[data-id="${id}"] [data-check]`).focus(), id);
  await page.press('Shift+Tab');
  await page.press('Tab');
  await sleep(100);
};
/** The task focus is on, the selected one and the one in the details pane. */
const where = (page) =>
  page.evaluate(() => ({
    focus: document.activeElement?.closest('.task[data-id]')?.dataset.id || null,
    sel: document.querySelector('.task.sel')?.dataset.id || null,
    pane: document.querySelector('#inspector').hidden ? null : document.querySelector('#inspector [data-f="title"]')?.value || null,
  }));
const chipLabel = (page) => page.evaluate(() => document.querySelector('[data-cc="date"]')?.getAttribute('aria-label'));
const openComposer = async (page) => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.press('q');
  await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', { timeout: 3000, message: 'the composer to open' });
};
const findTask = (page, title) => page.waitFor(async (title) => (await import('/shared/store.js')).db.all('tasks').find((x) => x.title === title) || null, { timeout: 4000, args: [title], message: `the task "${title}"` });

describe('qa tasks: focus, the Date menu and date ranges', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let page;
  let today;
  const k = tag();

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('tasks/'));
    today = await browserToday(page);
  });

  test('a task picked from search takes the focus; Delete deletes that one', async () => {
    await withScreenshot(page, 'qa-tasks-keys-search', async () => {
      const [a, b, c] = await make(page, [`Alpha ${k}`, `Bravo ${k}`, `Charlie ${k}`]);
      await go(page, '#/today');
      await kbFocus(page, a);
      await page.press('Control+k');
      await page.waitFor(() => document.activeElement?.matches('.palette input'), 3000);
      await page.type(`Bravo ${k}`);
      await sleep(300);
      await page.press('Enter');
      await page.waitFor((t) => document.querySelector('#inspector [data-f="title"]')?.value === t, { timeout: 4000, args: [`Bravo ${k}`] });
      await page.waitFor((b) => document.activeElement?.closest('.task[data-id]')?.dataset.id === b, { timeout: 3000, args: [b], message: 'focus on the picked task' });
      assert.deepEqual(await where(page), { focus: b, sel: b, pane: `Bravo ${k}` }, 'focus, selection and pane agree');
      await page.press('Delete');
      await page.waitFor((b) => !document.querySelector(`.task[data-id="${b}"]`), { timeout: 3000, args: [b] });
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.toast .toast-msg')].map((x) => x.innerText).at(-1)), `Deleted “Bravo ${k}”`);
      const after = await where(page);
      assert.equal(after.focus, after.sel, 'focus and selection move on together');
      assert.notEqual(after.focus, a, 'not back on the row that had focus before the search');
      assert.ok([c, a].includes(after.focus));
      await page.press('Escape');
    });
  });

  test('a task opened from a #/task link takes the focus', async () => {
    await withScreenshot(page, 'qa-tasks-keys-link', async () => {
      const [d, e] = await make(page, [`Delta ${k}`, `Echo ${k}`]);
      await go(page, '#/today');
      await kbFocus(page, d);
      await go(page, `#/task/${e}`);
      await page.waitFor((e) => document.activeElement?.closest('.task[data-id]')?.dataset.id === e, { timeout: 3000, args: [e], message: 'focus on the linked task' });
      assert.deepEqual(await where(page), { focus: e, sel: e, pane: `Echo ${k}` });
      await page.press('Escape');
      await page.waitFor(() => document.querySelector('#inspector').hidden, 3000);
    });
  });

  test('"d" duplicates the focused task and focus goes to the copy', async () => {
    await withScreenshot(page, 'qa-tasks-keys-duplicate', async () => {
      const [f] = await make(page, [`Foxtrot ${k}`]);
      await go(page, '#/today');
      await kbFocus(page, f);
      await page.press('d');
      const copy = await page.waitFor(
        async (title, f) => (await import('/shared/store.js')).db.all('tasks').find((t) => t.title === title && t.id !== f)?.id || null,
        { timeout: 3000, args: [`Foxtrot ${k}`, f], message: 'the copy' },
      );
      await page.waitFor((copy) => document.activeElement?.closest('.task[data-id]')?.dataset.id === copy, { timeout: 3000, args: [copy], message: 'focus on the copy' });
      const w = await where(page);
      assert.deepEqual([w.focus, w.sel], [copy, copy]);
    });
  });

  test("composer: a time picked in the Date menu goes with its day (the chip's x, No date)", async () => {
    await withScreenshot(page, 'qa-tasks-keys-time', async () => {
      await go(page, '#/inbox');
      await openComposer(page);
      await page.type(`Read a chapter ${k}`);
      const pickTime = async (hhmm) => {
        await page.click('[data-cc="date"]');
        await page.waitFor('.dp-pop [data-dp="time"]', 3000);
        await page.click('.dp-pop [data-dp="time"]');
        await page.waitFor('.tp-pop .tp-row', 3000);
        await page.evaluate((t) => [...document.querySelectorAll('.tp-pop .tp-row')].find((r) => r.dataset.t === t).click(), hhmm);
        await page.waitFor(() => !document.querySelector('.dp-pop, .tp-pop'), 3000);
      };
      const pickDay = async (dp) => {
        await page.click('[data-cc="date"]');
        await page.waitFor(`.dp-pop [data-dp="${dp}"]`, 3000);
        await page.click(`.dp-pop [data-dp="${dp}"]`);
        await page.waitFor(() => !document.querySelector('.dp-pop'), 3000);
      };
      await pickTime('15:00');
      assert.equal(await chipLabel(page), 'Date: Today 3pm');
      // The chip's x: the day goes, and its time with it.
      await page.click('[data-cc-clear="date"]');
      assert.equal(await chipLabel(page), 'Set date');
      await page.click('[data-cc="date"]');
      await page.waitFor('.dp-pop [data-dp="time"]', 3000);
      assert.equal(await page.evaluate(() => document.querySelector('.dp-pop [data-dp="time"]').innerText.trim()), 'Add time');
      await page.click('.dp-pop [data-dp="tomorrow"]');
      await page.waitFor(() => !document.querySelector('.dp-pop'), 3000);
      assert.equal(await chipLabel(page), 'Date: Tomorrow', 'the picked time did not come back');
      await page.press('Enter');
      const t = await findTask(page, `Read a chapter ${k}`);
      assert.deepEqual([t.date, t.time], [addDays(today, 1), null]);

      // "No date" in the menu does the same.
      await page.type(`Gym ${k}`);
      await pickTime('17:00');
      assert.equal(await chipLabel(page), 'Date: Today 5pm');
      await pickDay('clear');
      assert.equal(await chipLabel(page), 'Set date');
      await pickDay('tomorrow');
      assert.equal(await chipLabel(page), 'Date: Tomorrow');
      await page.press('Enter');
      const g = await findTask(page, `Gym ${k}`);
      assert.deepEqual([g.date, g.time], [addDays(today, 1), null]);
      await page.press('Escape');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('composer: "dec 3-5" plans Dec 3 with a deadline on Dec 5', async () => {
    await withScreenshot(page, 'qa-tasks-keys-range', async () => {
      await go(page, '#/inbox');
      await openComposer(page);
      await page.type(`Prep slides ${k} dec 3-5`);
      await page.waitFor(() => [...document.querySelectorAll('.cb-chips .is-parsed')].some((c) => /^Deadline /.test(c.innerText.trim())), { timeout: 3000, message: 'a Deadline chip' });
      assert.notEqual(await chipLabel(page), 'Set date', 'and a date');
      await page.press('Enter');
      const t = await findTask(page, `Prep slides ${k}`);
      const y = today.slice(5) > '12-03' ? +today.slice(0, 4) + 1 : +today.slice(0, 4);
      assert.deepEqual([t.date, t.deadline], [`${y}-12-03`, `${y}-12-05`]);
      await page.press('Escape');
    });
  });

  test('date menus show all of themselves, "No date" included', async () => {
    await withScreenshot(page, 'qa-tasks-keys-datemenu', async () => {
      const [id] = await make(page, [`Dated ${k}`]);
      for (const [w, h] of [
        [1440, 900],
        [1280, 800],
      ]) {
        await page.setViewport(w, h, false);
        await go(page, '#/today');
        // The row's date menu (its buttons show while it is hovered).
        const box = await page.evaluate((id) => {
          const el = document.querySelector(`.task[data-id="${id}"]`);
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, id);
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
        await sleep(200);
        await page.click(`.task[data-id="${id}"] [data-row-date]`);
        await page.waitFor('.dp-pop [data-dp="clear"]', 3000);
        await settle(page, 250);
        const m = await page.evaluate(() => {
          const pop = document.querySelector('.dp-pop');
          const none = pop.querySelector('[data-dp="clear"]').getBoundingClientRect();
          const r = pop.getBoundingClientRect();
          return { sh: pop.scrollHeight, ch: pop.clientHeight, noneInside: none.bottom <= r.bottom + 0.5 && none.top >= r.top };
        });
        assert.ok(m.sh <= m.ch + 1, `the row's date menu doesn't scroll (${m.sh} > ${m.ch}) at ${w}x${h}`);
        assert.ok(m.noneInside, `"No date" fully shown at ${w}x${h}`);
        await page.press('Escape');
        await page.waitFor(() => !document.querySelector('.dp-pop'), 3000);

        // The composer's Date chip.
        await openComposer(page);
        await page.click('[data-cc="date"]');
        await page.waitFor('.dp-pop [data-dp="clear"]', 3000);
        await settle(page, 250);
        const c = await page.evaluate(() => ({ sh: document.querySelector('.dp-pop').scrollHeight, ch: document.querySelector('.dp-pop').clientHeight }));
        assert.ok(c.sh <= c.ch + 1, `the composer's date menu doesn't scroll (${c.sh} > ${c.ch}) at ${w}x${h}`);
        await page.press('Escape');
        await page.press('Escape');
      }
      await page.setViewport(1440, 900, false);
    });
  });
});
