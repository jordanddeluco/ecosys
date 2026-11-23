// QA regression (tasks): dates, times and repeats set from the app's pickers, at 1440x900 with real keys.
//   composer  a bare time ("Lunch at 9pm") shows on the Date chip the day it will be saved for (today while the
//             time is still ahead, else tomorrow), and that day is saved; the Date menu has a Time row, and a
//             time picked there is saved with the day; a day picked keeps a typed time live ("6pm" edited to
//             "7pm" after picking Tomorrow is saved as 7pm)
//   rows      the row's date menu sets a time with the day ("Scheduled for today, 9:30am"); a day picked from
//             it keeps the time; "No time" takes off only the time, and Ctrl+Z puts back only that
//   repeat    the details pane's Repeat lists "Custom…", which opens the repeat builder on the field; the field
//             keeps showing the current repeat meanwhile; Cancel changes nothing; Done saves the rule, keeping
//             "After done", and the field then reads it
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot, tag, browserToday } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const go = async (page, hash) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await settle(page, 300);
};
const getTask = (page, id) => page.evaluate(async (id) => (await import('/shared/store.js')).db.get('tasks', id), id);
const findTask = (page, title) => page.evaluate(async (title) => (await import('/shared/store.js')).db.all('tasks').find((t) => t.title === title) || null, title);
const addTask = (page, fields) =>
  page.evaluate(async (f) => {
    const { createTask } = await import('/shared/model.js');
    const { todayYmd } = await import('/shared/dates.js');
    return createTask({ ...f, date: f.today ? todayYmd() : f.date ?? null }).id;
  }, fields);
const lastToast = (page) => page.evaluate(() => [...document.querySelectorAll('.toast .toast-msg')].map((x) => x.innerText).at(-1));
const chipLabel = (page) => page.evaluate(() => document.querySelector('[data-cc="date"]')?.getAttribute('aria-label'));
const openComposer = async (page) => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.press('q');
  await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', { timeout: 3000, message: 'the composer to open' });
};
/** Open the Date menu's Time row and pick a time ('' picks "No time"). */
const pickTimeInMenu = async (page, hhmm) => {
  await page.waitFor('.dp-pop [data-dp="time"]', { timeout: 3000, message: "the date menu's Time row" });
  await page.click('.dp-pop [data-dp="time"]');
  await page.waitFor('.tp-pop .tp-row', { timeout: 3000, message: 'the time list' });
  await page.evaluate((t) => [...document.querySelectorAll('.tp-pop .tp-row')].find((r) => r.dataset.t === t).click(), hhmm);
  await page.waitFor(() => !document.querySelector('.dp-pop, .tp-pop'), { timeout: 3000, message: 'the date menu to close' });
};
const ymdPlus = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

describe('qa tasks: date, time and repeat pickers', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let page;
  let today;
  const k = tag();

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('tasks/'));
    today = await browserToday(page);
  });

  test("composer: a bare time's Date chip shows the day it is saved for", async () => {
    await withScreenshot(page, 'qa-tasks-pickers-bare-time', async () => {
      await go(page, '#/inbox'); // no day of its own: the time decides it
      // Twelve hours from now: never within a minute of the clock, so "still ahead" can't change mid-test.
      const now = await page.evaluate(() => ({ h: new Date().getHours(), m: new Date().getMinutes() }));
      const h = (now.h + 12) % 24;
      const spoken = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;
      const ahead = h * 60 >= now.h * 60 + now.m;
      await openComposer(page);
      await page.type(`Lunch ${k} at ${spoken}`);
      await page.waitFor((label) => document.querySelector('[data-cc="date"]')?.getAttribute('aria-label') === label, {
        timeout: 3000,
        args: [`Date: ${ahead ? 'Today' : 'Tomorrow'} ${spoken}`],
        message: 'the Date chip to show the day the time is on',
      });
      await page.press('Enter');
      const t = await page.waitFor((title) => import('/shared/store.js').then((m) => m.db.all('tasks').find((x) => x.title === title) || null), { timeout: 3000, args: [`Lunch ${k}`] });
      assert.equal(t.date, ahead ? today : ymdPlus(today, 1), 'saved for the day the chip showed');
      assert.equal(t.time, `${String(h).padStart(2, '0')}:00`);
      await page.press('Escape');
    });
  });

  test("composer: the Date menu's Time row sets a time; a day picked keeps a typed time live", async () => {
    await withScreenshot(page, 'qa-tasks-pickers-composer-time', async () => {
      await go(page, '#/inbox');
      await openComposer(page);
      await page.type(`Dentist ${k}`);
      await page.click('[data-cc="date"]');
      await page.waitFor('.dp-pop [data-dp="time"]', 3000);
      assert.equal(await page.evaluate(() => document.querySelector('.dp-pop [data-dp="time"]').innerText.trim()), 'Add time');
      await pickTimeInMenu(page, '15:00');
      assert.equal(await chipLabel(page), 'Date: Today 3pm', 'a time with no day is today');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Task name', 'focus back in the name');
      await page.press('Enter');
      const a = await page.waitFor((title) => import('/shared/store.js').then((m) => m.db.all('tasks').find((x) => x.title === title) || null), { timeout: 3000, args: [`Dentist ${k}`] });
      assert.deepEqual([a.date, a.time], [today, '15:00']);

      // A day picked from the menu leaves the typed time live: editing it afterwards still counts.
      await page.type(`Gym ${k} at 6pm`);
      await page.click('[data-cc="date"]');
      await page.waitFor('.dp-pop [data-dp="tomorrow"]', 3000);
      assert.match(await page.evaluate(() => document.querySelector('.dp-pop [data-dp="time"]').innerText), /Time\s+6pm/, 'the Time row shows the typed time');
      await page.click('.dp-pop [data-dp="tomorrow"]');
      await page.waitFor(() => !document.querySelector('.dp-pop'), 3000);
      assert.equal(await chipLabel(page), 'Date: Tomorrow 6pm');
      await page.press('Backspace', { repeat: 3 });
      await page.type('7pm');
      await page.waitFor(() => document.querySelector('[data-cc="date"]')?.getAttribute('aria-label') === 'Date: Tomorrow 7pm', { timeout: 3000, message: 'the edited time on the chip' });
      await page.press('Enter');
      const g = await page.waitFor((title) => import('/shared/store.js').then((m) => m.db.all('tasks').find((x) => x.title === title) || null), { timeout: 3000, args: [`Gym ${k}`] });
      assert.deepEqual([g.date, g.time], [ymdPlus(today, 1), '19:00']);
      await page.press('Escape');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test("rows: the date menu sets a time with the day, keeps it with a new day, and takes off only the time", async () => {
    await withScreenshot(page, 'qa-tasks-pickers-row-time', async () => {
      const id = await addTask(page, { title: `Row time ${k}`, today: true });
      await go(page, '#/today');
      // The row's buttons show while it is hovered.
      const row = await page.evaluate((id) => {
        const el = document.querySelector(`.task[data-id="${id}"]`);
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, id);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
      await sleep(200);
      await page.click(`.task[data-id="${id}"] [data-row-date]`);
      await pickTimeInMenu(page, '09:30');
      let t = await getTask(page, id);
      assert.deepEqual([t.date, t.time], [today, '09:30']);
      assert.equal(await lastToast(page), 'Scheduled for today, 9:30am');

      // The same menu from the details pane: a day picked keeps the time.
      await go(page, `#/task/${id}`);
      await page.click('#inspector [data-dp="date"]');
      await page.waitFor('.dp-pop [data-dp="tomorrow"]', 3000);
      assert.match(await page.evaluate(() => document.querySelector('.dp-pop [data-dp="time"]').innerText), /Time\s+9:30am/);
      await page.click('.dp-pop [data-dp="tomorrow"]');
      await page.waitFor(() => !document.querySelector('.dp-pop'), 3000);
      t = await getTask(page, id);
      assert.deepEqual([t.date, t.time], [ymdPlus(today, 1), '09:30'], 'the time stays with the new day');

      // "No time" takes off the time alone; undo puts back just that.
      await page.click('#inspector [data-dp="date"]');
      await pickTimeInMenu(page, '');
      t = await getTask(page, id);
      assert.deepEqual([t.date, t.time], [ymdPlus(today, 1), null]);
      assert.equal(await lastToast(page), 'Time removed');
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+z');
      await page.waitFor(async (id) => (await import('/shared/store.js')).db.get('tasks', id).time === '09:30', { timeout: 3000, args: [id], message: 'undo to put the time back' });
      t = await getTask(page, id);
      assert.equal(t.date, ymdPlus(today, 1), 'the day is left as it was');
      await page.press('Escape');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('repeat: "Custom…" opens the builder on the field; Cancel keeps the repeat, Done saves the rule', async () => {
    await withScreenshot(page, 'qa-tasks-pickers-custom-repeat', async () => {
      const id = await addTask(page, { title: `Custom repeat ${k}`, today: true, repeat: { freq: 'day', interval: 2, from: 'done' } });
      await go(page, `#/task/${id}`);
      const field = '#inspector [data-select][name="repeat"]';
      const fieldText = () => page.evaluate((s) => document.querySelector(s).innerText.trim(), field);
      assert.equal(await fieldText(), 'Every 2 days');
      const openCustom = async () => {
        await page.click(field);
        await page.waitFor('.select-pop .menu-item', 3000);
        const items = await page.evaluate(() => [...document.querySelectorAll('.select-pop .menu-item')].map((b) => b.innerText.trim()));
        assert.equal(items.at(-1), 'Custom…', 'the list ends in Custom…');
        assert.ok(items.includes('Every 2 days'), `the current repeat is listed (${items.join(', ')})`);
        await page.clickText('menuitemradio', 'Custom…');
        await page.waitFor('.rp-pop input', { timeout: 3000, message: 'the repeat builder' });
      };
      await openCustom();
      assert.equal(await fieldText(), 'Every 2 days', 'the field keeps showing the current repeat');
      const near = await page.evaluate((s) => {
        const f = document.querySelector(s).getBoundingClientRect();
        const p = document.querySelector('.rp-pop').getBoundingClientRect();
        return Math.abs(p.top - f.bottom) < 24 || Math.abs(f.top - p.bottom) < 24;
      }, field);
      assert.ok(near, 'the builder opens on the field');
      assert.equal(await page.evaluate(() => document.querySelector('.rp-pop input').value), '2', 'it starts from the current rule');
      await page.clickText('button', 'Cancel');
      await page.waitFor(() => !document.querySelector('.rp-pop'), 3000);
      assert.deepEqual((await getTask(page, id)).repeat, { freq: 'day', interval: 2, from: 'done' }, 'Cancel changes nothing');

      await openCustom();
      await page.press('Control+a');
      await page.type('3');
      await page.waitFor(() => document.querySelector('.rp-pop [data-rp-sum]')?.textContent === 'Every 3 days', 3000);
      await page.clickText('button', 'Done');
      await page.waitFor(async (id) => (await import('/shared/store.js')).db.get('tasks', id).repeat?.interval === 3, { timeout: 3000, args: [id], message: 'the new rule to be saved' });
      const t = await getTask(page, id);
      assert.deepEqual(t.repeat, { freq: 'day', interval: 3, from: 'done' }, '"After done" is kept');
      assert.equal(t.date, today);
      await page.waitFor((s) => document.querySelector(s)?.innerText.trim() === 'Every 3 days', { timeout: 3000, args: [field], message: 'the field to read the new rule' });
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'repeat', 'focus is back on the field');
      await page.press('Escape');
      await sleep(100);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
