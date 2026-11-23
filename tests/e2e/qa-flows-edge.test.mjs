// QA flows at the edges: natural-language quick add (the README's examples, then tricky phrases),
// undo after other edits, and a repeating event across a daylight-saving change. The tests after the
// first were written for wave-1 findings (each named above its test). One still pins a known gap and is
// marked todo until it is closed (see its todo text and the note above it).
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, browserToday, waitForSyncIdle, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const dayOfWeek = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getDay();
};
/** The next `MM-DD` on or after `today` ('YYYY-MM-DD'). */
const nextDate = (today, mmdd) => (`${today.slice(0, 4)}-${mmdd}` >= today ? `${today.slice(0, 4)}-${mmdd}` : `${+today.slice(0, 4) + 1}-${mmdd}`);

async function shortcut(page, key) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.press(key);
}

/** Tasks: type into the composer of the current view and press Enter. */
async function addTask(page, text) {
  if (!(await page.exists('textbox', 'Task name'))) await page.clickText('button', /^add task$/i);
  await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', 3000);
  await page.type(text);
  await page.press('Enter');
  await page.press('Escape');
}

/** Schedule: create with the Create card. */
async function addEvent(page, text) {
  await shortcut(page, 'c');
  await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Title', 4000);
  await page.type(text);
  await page.clickText('button', /^Save$/);
}

/** Tasks: open a task row's menu (right click) and pick an item. */
async function rowMenu(page, id, item) {
  await page.click((id) => document.querySelector(`.task[data-id="${id}"] .task-title`), { args: [id], button: 'right' });
  await page.clickText('menuitem', item);
}

/** Tasks: rename a task in its detail pane. */
async function rename(page, id, title) {
  await page.evaluate((id) => (location.hash = `#/task/${id}`), id);
  await page.waitFor('#inspector [aria-label="Task name"]', 5000);
  await page.click('#inspector [aria-label="Task name"]');
  await page.press('Control+a');
  await page.type(title);
  await page.press('Tab');
}

async function mouseDrag(page, from, to, { steps = 12 } = {}) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(120);
  for (let i = 1; i <= steps; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await sleep(60);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
}

describe('qa flows: quick add, undo, daylight saving', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let tasks;
  let sched;
  let today;
  let tomorrow;

  before(async () => {
    tasks = ctx.page;
    sched = await ctx.browser.newPage();
    await sched.setViewport(1440, 900, false);
    await sched.emulateColorScheme('light');
    await openApp(tasks, ctx.server.url('tasks/#/inbox'));
    await openApp(sched, ctx.server.url('schedule/'));
    today = await browserToday(tasks);
    tomorrow = addDaysYmd(today, 1);
  });

  const lists = async () => new Map((await ctx.server.state()).data.lists.map((l) => [l.id, l.name]));
  const calendars = async () => new Map((await ctx.server.state()).data.calendars.map((c) => [c.id, c.name]));
  const findTask = (title, what = `"${title}" on the server`) => ctx.server.waitForState((s) => s.data.tasks.find((x) => x.title === title), 10000, what);
  const findEvent = (title, what = `"${title}" on the server`) => ctx.server.waitForState((s) => s.data.events.find((x) => x.title === title), 10000, what);

  test("quick add: the README's examples, in Tasks and in Schedule", async () => {
    await withScreenshot(tasks, 'qa-edge-quick-add', async () => {
      await tasks.bringToFront();
      await tasks.evaluate(() => (location.hash = '#/inbox'));
      await settle(tasks, 200);
      const k = tag(4);
      await addTask(tasks, `Call mom ${k} tomorrow 6pm for 20m #Personal p1 @phone`);
      const call = await findTask(`Call mom ${k}`);
      assert.deepEqual(
        { date: call.date, time: call.time, duration: call.duration, priority: call.priority, list: (await lists()).get(call.listId), tags: call.tags },
        { date: tomorrow, time: '18:00', duration: 20, priority: 3, list: 'Personal', tags: ['phone'] },
      );
      await addTask(tasks, `Pay rent ${k} every 1st`);
      const rent = await findTask(`Pay rent ${k}`);
      assert.equal(rent.repeat?.freq, 'month');
      assert.equal(rent.repeat?.monthDay, 1);
      assert.equal(rent.date, today.endsWith('-01') ? today : `${addDaysYmd(today.slice(0, 8) + '28', 4).slice(0, 8)}01`, 'the first 1st from today');
      await addTask(tasks, `Renew passport ${k} by dec 15`);
      const passport = await findTask(`Renew passport ${k}`);
      assert.equal(passport.deadline, nextDate(today, '12-15'));
      assert.equal(passport.date, null, '"by" sets a deadline, not a plan date');

      await sched.bringToFront();
      await sched.evaluate((d) => (location.hash = `#/day/${d}`), today);
      await settle(sched, 200);
      await addEvent(sched, `Lunch with Sam ${k} fri 1pm at Cafe Luna #Work`);
      const lunch = await findEvent(`Lunch with Sam ${k}`);
      const day = lunch.start.slice(0, 10);
      assert.equal(dayOfWeek(day), 5, `on a Friday (${day})`);
      assert.ok(day >= today && day <= addDaysYmd(today, 7), `the coming Friday (${day})`);
      assert.deepEqual([lunch.start.slice(11), lunch.end, lunch.location, (await calendars()).get(lunch.calendarId)], ['13:00', `${day}T14:00`, 'Cafe Luna', 'Work']);
      await addEvent(sched, `Standup ${k} 9:30-9:45 every weekday`);
      const standup = await findEvent(`Standup ${k}`);
      assert.deepEqual([standup.start.slice(11), standup.end.slice(11), standup.repeat?.days], ['09:30', '09:45', [1, 2, 3, 4, 5]]);
    });
  });

  // Finding: 'Weekday lists without commas ("every mon wed fri") repeat on Monday only and leave words in the title'.
  test('quick add: "every mon wed fri" repeats on all three days', async () => {
    await withScreenshot(tasks, 'qa-edge-weekday-list', async () => {
      await tasks.bringToFront();
      await tasks.evaluate(() => (location.hash = '#/inbox'));
      await settle(tasks, 200);
      const title = `Gym ${tag()}`;
      await addTask(tasks, `${title} every mon wed fri 7am`);
      // Found by the start of its name, so a weekday left in the title fails the check below, not this wait.
      const t = await ctx.server.waitForState((s) => s.data.tasks.find((x) => x.title.startsWith(title)), 10000, 'the task on the server');
      assert.equal(t.title, title, 'no weekday is left in the title');
      assert.deepEqual(t.repeat?.days, [1, 3, 5]);
      assert.equal(t.time, '07:00');
    });
  });

  // Still todo: shared/nlp.js reads a range when asked (parse(text, { ranges: true }) returns endDate), but
  // Schedule's Create card doesn't ask yet. In schedule/app.js openCreate, parseOpts must pass ranges: true,
  // update() must make a typed range all day (c.allDay = true; c.endDate = r.endDate), and Save must pass
  // endDate: cur.endDate to createEvent. With that change (the data layer's cross request for
  // schedule/app.js) this test passes; then remove the todo.
  test('quick add: "dec 20-28" makes one all-day event over those days', { todo: 'Date ranges ("Vacation dec 20-28", "dec 3 to dec 5") make a one-day event and leave "-28" in the title' }, async () => {
    await withScreenshot(sched, 'qa-edge-date-range', async () => {
      await sched.bringToFront();
      const title = `Vacation ${tag()}`;
      await addEvent(sched, `${title} dec 20-28`);
      const e = await ctx.server.waitForState((s) => s.data.events.find((x) => x.title.startsWith(title)), 10000, 'the event on the server');
      // From Dec 21 to 28 the parser takes the range under way, this year's; after Dec 28, next year's.
      const y = nextDate(today, '12-28').slice(0, 4);
      assert.deepEqual({ title: e.title, allDay: e.allDay, start: e.start, end: e.end }, { title, allDay: true, start: `${y}-12-20`, end: `${y}-12-28` });
    });
  });

  // Finding: 'A typed time without a date ("Lunch at noon") is saved with no date, so it never reaches Today or the calendar'.
  test('quick add: a time typed without a day gets a day', async () => {
    await withScreenshot(tasks, 'qa-edge-time-no-date', async () => {
      await tasks.bringToFront();
      await tasks.evaluate(() => (location.hash = '#/inbox'));
      await settle(tasks, 200);
      const title = `Lunch ${tag()}`;
      await addTask(tasks, `${title} at noon`);
      const t = await findTask(title);
      assert.equal(t.time, '12:00');
      assert.ok(t.date === today || t.date === tomorrow, `the time comes with a day (today, or tomorrow once noon has passed); got date ${t.date}`);
    });
  });

  // Finding: 'Undo restores the whole record: it reverts later edits (from any tab) and can bring back deleted tasks'.
  test('undo takes back only its own change, not edits made since', async () => {
    await withScreenshot(tasks, 'qa-edge-undo', async () => {
      const { server } = ctx;
      await tasks.bringToFront();
      await tasks.evaluate(() => (location.hash = '#/inbox'));
      await settle(tasks, 200);
      const title = `QA undo ${tag()}`;
      await addTask(tasks, `${title} tomorrow`);
      const t = await findTask(title);

      // 1. Move it to today (undoable), rename it, then undo: the date goes back, the new name stays.
      await rowMenu(tasks, t.id, /Add to Today/);
      await server.waitForState((s) => s.data.tasks.find((x) => x.id === t.id)?.date === today, 8000, 'the task on today');
      await rename(tasks, t.id, `${title} renamed`);
      await server.waitForState((s) => s.data.tasks.find((x) => x.id === t.id)?.title === `${title} renamed`, 8000, 'the rename');
      await tasks.press('Escape');
      await shortcut(tasks, 'Control+z');
      const back = await server.waitForState((s) => {
        const x = s.data.tasks.find((y) => y.id === t.id);
        return x?.date === tomorrow ? x : null;
      }, 8000, 'Ctrl+Z to move it back to tomorrow');
      assert.equal(back.title, `${title} renamed`, 'the rename made after the move survives its undo');

      // 2. Move a time block in Schedule, rename the task in Tasks, Ctrl+Z in Schedule: the rename stays.
      await tasks.evaluate(() => (location.hash = '#/inbox'));
      const blockTitle = `QA block ${tag()}`;
      await settle(tasks, 200);
      await addTask(tasks, `${blockTitle} tomorrow 10am`);
      const b = await findTask(blockTitle);
      await sched.bringToFront();
      await sched.evaluate((d) => (location.hash = `#/day/${d}`), tomorrow);
      await sched.waitFor(`.ev[data-task="${b.id}"]`, 8000);
      const at = await sched.evaluate((id) => {
        const sc = document.querySelector('.grid-scroll');
        const hour = parseFloat(getComputedStyle(document.querySelector('.grid-body')).getPropertyValue('--hour')) || 48;
        sc.scrollTop = hour * 7;
        const r = document.querySelector(`.ev[data-task="${id}"]`).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + 8, hour };
      }, b.id);
      await mouseDrag(sched, at, { x: at.x, y: at.y + at.hour * 2 });
      await server.waitForState((s) => s.data.tasks.find((x) => x.id === b.id)?.time === '12:00', 8000, 'the block moved to 12:00');
      await tasks.bringToFront();
      await rename(tasks, b.id, `${blockTitle} renamed`);
      await server.waitForState((s) => s.data.tasks.find((x) => x.id === b.id)?.title === `${blockTitle} renamed`, 8000, 'the rename');
      await tasks.press('Escape');
      await sched.bringToFront();
      await shortcut(sched, 'Control+z');
      const blockBack = await server.waitForState((s) => {
        const x = s.data.tasks.find((y) => y.id === b.id);
        return x?.time === '10:00' ? x : null;
      }, 8000, 'Ctrl+Z in Schedule to move the block back');
      assert.equal(blockBack.title, `${blockTitle} renamed`, 'the rename made in Tasks survives an undo in Schedule');

      // 3. An older toast's Undo must not bring back a task deleted since.
      await tasks.bringToFront();
      await tasks.evaluate(() => (location.hash = '#/inbox'));
      await settle(tasks, 200);
      const goneTitle = `QA gone ${tag()}`;
      await addTask(tasks, `${goneTitle} tomorrow`);
      const g = await findTask(goneTitle);
      await rowMenu(tasks, g.id, /Add to Today/);
      await server.waitForState((s) => s.data.tasks.find((x) => x.id === g.id)?.date === today, 8000, 'the task on today');
      await rowMenu(tasks, g.id, /^Delete/);
      await server.waitForState((s) => !s.data.tasks.some((x) => x.id === g.id), 8000, 'the task deleted');
      await tasks.click(() => [...document.querySelectorAll('.toast')].find((x) => /^Scheduled for today/.test(x.innerText))?.querySelector('button'));
      await sleep(1000);
      await waitForSyncIdle(tasks); // a task the Undo brought back would be on the server by now
      assert.ok(!(await server.state()).data.tasks.some((x) => x.id === g.id), 'undoing "Scheduled for today" does not bring back the deleted task');
    });
  });

  // Finding: 'An event in the hour skipped by a DST change shrinks to zero length on that day (3:30am – 3:30am)'.
  test('a repeating event keeps its length on the day the clocks go forward', async () => {
    const page = await ctx.browser.newPage();
    try {
      await page.setViewport(1440, 900, false);
      await page.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Denver' }); // DST starts 2027-03-14 at 2:00
      await withScreenshot(page, 'qa-edge-dst', async () => {
        await openApp(page, ctx.server.url('schedule/#/day/2027-03-12'));
        const title = `QA night shift ${tag()}`;
        await addEvent(page, `${title} 2:30am every day`);
        const e = await findEvent(title);
        assert.equal(e.start, '2027-03-12T02:30');
        assert.equal(e.end, '2027-03-12T03:30');
        const len = async (d) => {
          await page.evaluate((d) => (location.hash = `#/day/${d}`), d);
          const el = await page.waitFor((k) => {
            const b = document.querySelector(`.ev[data-ev="${k}"]`);
            return b ? { top: +b.dataset.top, bottom: +b.dataset.bottom } : null;
          }, { timeout: 5000, args: [`${e.id}@${d}`] });
          return el.bottom - el.top;
        };
        assert.equal(await len('2027-03-13'), 60, 'an hour long the day before');
        assert.equal(await len('2027-03-15'), 60, 'an hour long the day after');
        assert.equal(await len('2027-03-14'), 60, 'still an hour long on the day 2:30am does not exist (3:30 to 4:30, as Apple and Google show it)');
      });
    } finally {
      await page.close();
    }
  });
});
