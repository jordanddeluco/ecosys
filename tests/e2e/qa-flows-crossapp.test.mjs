// QA flows across the apps, in two tabs of one profile (Tasks, Schedule) against an isolated server, with
// real mouse and keyboard input (Home is an app launcher with no data of its own: qa-home-launcher.test.mjs):
//   live        a task added, completed, undone, rescheduled and deleted in Tasks updates Schedule at once
//               (no reload), and the reverse: a task made and completed in Schedule
//   time block  a task dragged from Schedule's Tasks panel onto the grid (HTML5 drag and drop through
//               the DevTools drag interception), then resized by its edge and moved to another day
//   repeats     a weekday series: edit "This event", "This and following", "All events", delete one
//   search      Ctrl+K in Schedule finds a task (opened in Tasks) and runs a view command; in Tasks,
//               Enter on a command or an event runs it rather than starting a new task ("Add task" is last)
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, waitForSyncIdle, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 'YYYY-MM-DD' plus n days (local noon, so a DST change never moves the date). */
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const dayOfWeek = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getDay();
};

/** Real mouse drag: press, move in steps, release (pointer events, like a person). */
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

/** HTML5 drag and drop: start a real drag on `from`, intercept its data, drop it at `to` (same page). */
async function html5Drag(page, from, to) {
  await page.send('Input.setInterceptDrags', { enabled: true });
  try {
    const intercepted = page.waitForEvent('Input.dragIntercepted', { timeout: 5000 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 5; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 4, y: from.y + i * 4, button: 'left', buttons: 1 });
    const { data } = await intercepted;
    await page.send('Input.dispatchDragEvent', { type: 'dragEnter', x: to.x, y: to.y, data });
    for (let i = 0; i < 3; i++) {
      await page.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data });
      await sleep(50);
    }
    await page.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  } finally {
    await page.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
  }
}

/** Centre of the first element matching `selector` (scrolled into view), or null. */
const centre = (page, selector, { dy = null } = {}) =>
  page.evaluate(
    (s, dy) => {
      const el = document.querySelector(s);
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: dy === null ? r.top + r.height / 2 : r.top + dy, top: r.top, h: r.height };
    },
    selector,
    dy,
  );

/** Centre of the first element matching `selector` where it is now (no scrolling), or null. */
const rectOf = (page, selector, { dy = null } = {}) =>
  page.evaluate(
    (s, dy) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: dy === null ? r.top + r.height / 2 : r.top + dy, top: r.top, h: r.height };
    },
    selector,
    dy,
  );

/**
 * A point in Schedule's time grid: column `date`, at `hours` (e.g. 10.5 = 10:30). With `scroll` (the
 * default) the grid is first scrolled so that this time sits near the top; read other points with
 * `scroll: false` afterwards, so they all share one scroll position.
 */
const gridPoint = (page, date, hours, { scroll = true } = {}) =>
  page.evaluate(
    (date, hours, scroll) => {
      const body = document.querySelector('.grid-body');
      const col = body?.querySelector(`.col[data-date="${date}"]`);
      if (!col) return null;
      const hour = parseFloat(getComputedStyle(body).getPropertyValue('--hour')) || 48;
      const sc = document.querySelector('.grid-scroll');
      if (sc && scroll) sc.scrollTop = Math.max(0, hour * (hours - 3));
      const c = col.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      return { x: c.left + c.width / 2, y: b.top + hour * hours, hour };
    },
    date,
    hours,
    scroll,
  );

/** Press a single-key shortcut with nothing focused. */
async function shortcut(page, key) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.press(key);
}

/** Tasks: add one task through the composer of the current view. */
async function addTask(page, text) {
  if (!(await page.exists('textbox', 'Task name'))) await page.clickText('button', /^add task$/i);
  await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', 3000);
  await page.type(text);
  await page.press('Enter');
  await page.press('Escape');
}

/** Tasks: open a task row's menu (right click) and pick an item. */
async function rowMenu(page, id, item) {
  await page.click((id) => document.querySelector(`.task[data-id="${id}"] .task-title`), { args: [id], button: 'right' });
  await page.clickText('menuitem', item);
}

/** Schedule: wait for the recurring-event scope dialog and pick a scope. */
async function pickScope(page, label) {
  await page.waitFor(() => [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].some((d) => /recurring event/i.test(d.innerText)), { timeout: 5000, message: 'the recurring-event scope dialog' });
  await page.clickText('button', new RegExp(`^${label}$`));
}

describe('qa flows: tasks and schedule stay in step', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let tasks; // the Tasks tab (ctx.page)
  let sched; // a Schedule tab, same profile
  let today;
  let tomorrow;

  before(async () => {
    tasks = ctx.page;
    sched = await ctx.browser.newPage();
    for (const p of [sched]) {
      await p.setViewport(1440, 900, false);
      await p.emulateColorScheme('light');
    }
    await openApp(tasks, ctx.server.url('tasks/#/inbox'));
    await openApp(sched, ctx.server.url('schedule/'));
    today = await browserToday(tasks);
    tomorrow = addDaysYmd(today, 1);
  });

  test('a task added in Tasks updates Schedule and Home live: complete, undo, reschedule, delete', async () => {
    const { server } = ctx;
    await withScreenshot(tasks, 'qa-flows-live-tasks', async () => {
      await sched.evaluate((d) => (location.hash = `#/day/${d}`), tomorrow);
      const title = `QA live ${tag()}`;
      await tasks.bringToFront();
      await tasks.evaluate(() => (location.hash = '#/inbox'));
      await addTask(tasks, `${title} tomorrow 2pm for 45m p2`);
      const t = await server.waitForState((s) => s.data.tasks.find((x) => x.title === title), 10000, `"${title}" on the server`);
      assert.deepEqual([t.date, t.time, t.duration, t.priority], [tomorrow, '14:00', 45, 2], 'date, time, length and priority come from the typed words');

      const block = `.ev[data-task="${t.id}"]`;
      await sched.waitFor(block, { timeout: 8000, message: 'the time block to appear in Schedule without a reload' });
      assert.equal(await sched.evaluate((s) => document.querySelector(s).closest('[data-date]')?.dataset.date, block), tomorrow);

      // Complete in Tasks: the block in Schedule is checked off at once.
      await tasks.clickText('checkbox', `Complete: ${title}`);
      await server.waitForState((s) => s.data.tasks.find((x) => x.id === t.id && x.done), 8000, 'the task to be done on the server');
      await sched.waitFor((s) => document.querySelector(`${s} [role=checkbox]`)?.getAttribute('aria-checked') === 'true', { timeout: 8000, args: [block], message: 'the block to show as done' });

      // Ctrl+Z in Tasks reopens it, everywhere.
      await shortcut(tasks, 'Control+z');
      await server.waitForState((s) => s.data.tasks.find((x) => x.id === t.id && !x.done), 8000, 'Undo to reopen the task');
      await sched.waitFor((s) => document.querySelector(`${s} [role=checkbox]`)?.getAttribute('aria-checked') === 'false', { timeout: 8000, args: [block], message: 'the block to show as open again' });

      // Reschedule to today from the row menu: Schedule moves it.
      await sched.evaluate((d) => (location.hash = `#/day/${d}`), today);
      await rowMenu(tasks, t.id, /Add to Today/);
      await server.waitForState((s) => s.data.tasks.find((x) => x.id === t.id && x.date === today), 8000, 'the task to move to today');
      await sched.waitFor(block, { timeout: 8000, message: "the block to move to today's column" });

      // Delete it: gone from Schedule; the toast's Undo brings it back.
      await rowMenu(tasks, t.id, /^Delete/);
      await server.waitForState((s) => !s.data.tasks.some((x) => x.id === t.id), 8000, 'the task to be deleted');
      await sched.waitFor((s) => !document.querySelector(s), { timeout: 8000, args: [block], message: 'Schedule to drop the deleted block' });
      // The Undo of the "Deleted" toast (the "Scheduled for today" toast may still be up beside it).
      await tasks.click(() => [...document.querySelectorAll('.toast')].find((x) => /^Deleted/.test(x.innerText))?.querySelector('button'));
      await server.waitForState((s) => s.data.tasks.some((x) => x.id === t.id && x.date === today), 8000, 'Undo to restore the task, still planned for today');
    });
  });

  test('a task made in Schedule shows in Tasks; checking its block completes it in Tasks', async () => {
    const { server } = ctx;
    await withScreenshot(sched, 'qa-flows-live-schedule', async () => {
      const title = `QA made in schedule ${tag()}`;
      await sched.bringToFront();
      await sched.evaluate((d) => (location.hash = `#/day/${d}`), tomorrow);
      await settle(sched, 200);
      await shortcut(sched, 'c');
      await sched.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Title', 4000);
      await sched.clickText('button', /^Task$/);
      await sched.type(`${title} tomorrow 3pm p1`);
      await sched.clickText('button', /^Save$/);
      const t = await server.waitForState((s) => s.data.tasks.find((x) => x.title === title), 10000, `"${title}" on the server`);
      assert.deepEqual([t.date, t.time, t.priority, t.done], [tomorrow, '15:00', 3, false]);

      await tasks.evaluate(() => (location.hash = '#/upcoming'));
      await tasks.waitFor((id) => !!document.querySelector(`.task[data-id="${id}"]:not(.is-done)`), { timeout: 8000, args: [t.id], message: 'the task to appear in Tasks › Upcoming' });

      await sched.click((id) => document.querySelector(`.ev[data-task="${id}"] [role=checkbox]`), { args: [t.id] });
      await server.waitForState((s) => s.data.tasks.find((x) => x.id === t.id && x.done), 8000, 'the task to be done on the server');
      await tasks.waitFor((id) => !document.querySelector(`.task[data-id="${id}"]:not(.is-done)`), { timeout: 8000, args: [t.id], message: 'Tasks to show it done (moved out of the open list)' });
    });
  });

  test('drag a task from the Tasks panel onto the grid, resize the block, move it to another day', async () => {
    const { server } = ctx;
    await withScreenshot(sched, 'qa-flows-time-block', async () => {
      const t0 = (await server.state()).data.tasks.find((x) => !x.done && !x.date && /drag me onto the calendar/i.test(x.title));
      assert.ok(t0, 'the sample task "Drag me onto the calendar in schedule" (no date) exists');
      const len = t0.duration || 30;
      await sched.bringToFront();
      // Four days from tomorrow: the block can move to the next day on screen.
      await sched.evaluate((d) => (location.hash = `#/days/${d}`), tomorrow);
      await settle(sched, 300);
      if (!(await sched.evaluate((id) => !!document.querySelector(`[data-ptask="${id}"]`)?.checkVisibility(), t0.id))) await shortcut(sched, 'i');
      await sched.waitFor((id) => document.querySelector(`[data-ptask="${id}"]`)?.checkVisibility(), { timeout: 5000, args: [t0.id], message: 'the task in the Tasks panel' });

      // Drop it on tomorrow at 10:00 (the drop ghost sits 10 minutes above the pointer).
      const from = await centre(sched, `[data-ptask="${t0.id}"]`);
      const target = await gridPoint(sched, tomorrow, 10 + 10 / 60);
      await html5Drag(sched, from, target);
      let t = await server.waitForState((s) => s.data.tasks.find((x) => x.id === t0.id && x.time), 8000, 'the dropped task to get a date and time');
      assert.deepEqual([t.date, t.time, t.duration], [tomorrow, '10:00', len], 'dropped at 10:00 tomorrow, keeping its length');

      // Resize: drag the bottom edge down to 11:30.
      const block = `.ev[data-task="${t0.id}"]`;
      await sched.waitFor(`${block} [data-resize]`, { state: 'attached', timeout: 5000 });
      const to = await gridPoint(sched, tomorrow, 11.5);
      const handle = await rectOf(sched, `${block} [data-resize]`);
      assert.ok(handle, 'the block has a resize edge');
      await mouseDrag(sched, handle, { x: handle.x, y: to.y });
      t = await server.waitForState((s) => s.data.tasks.find((x) => x.id === t0.id && x.duration === 90), 8000, 'the block to be 90 minutes long after resizing');
      assert.equal(t.time, '10:00', 'resizing keeps the start');

      // Move: grab the block and drop it two hours later on the next day.
      const next = addDaysYmd(tomorrow, 1);
      await sched.waitFor((s) => document.querySelector(s)?.dataset.bottom === '690', { timeout: 5000, args: [block] });
      const nextCol = await gridPoint(sched, next, 10);
      const grip = await rectOf(sched, block, { dy: 12 });
      await mouseDrag(sched, grip, { x: nextCol.x, y: grip.y + nextCol.hour * 2 });
      t = await server.waitForState((s) => s.data.tasks.find((x) => x.id === t0.id && x.date === next), 8000, 'the block to move to the next day');
      assert.deepEqual([t.time, t.duration], ['12:00', 90], 'moved two hours later, same length');

      // Tasks shows the new day and time.
      await tasks.evaluate(() => (location.hash = '#/upcoming'));
      await tasks.waitFor((d, id) => !!document.querySelector(`.section[data-date="${d}"] .task[data-id="${id}"]`), { timeout: 8000, args: [next, t0.id], message: "the task under its new day in Tasks' Upcoming" });
    });
  });

  test('a repeating event: this event, this and following, delete one, all events', async () => {
    const { server } = ctx;
    await withScreenshot(sched, 'qa-flows-repeats', async () => {
      // The Monday of a week at least a week ahead, so the seed's events and today's time don't matter.
      let mon = addDaysYmd(today, 7);
      while (dayOfWeek(mon) !== 1) mon = addDaysYmd(mon, 1);
      const [tue, wed, thu, fri] = [1, 2, 3, 4].map((n) => addDaysYmd(mon, n));
      const title = `QA series ${tag()}`;
      await sched.bringToFront();
      await sched.evaluate((d) => (location.hash = `#/day/${d}`), mon);
      await settle(sched, 300);
      await shortcut(sched, 'c');
      await sched.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Title', 4000);
      await sched.type(`${title} 9:30-9:45 every weekday`);
      await sched.clickText('button', /^Save$/);
      const e = await server.waitForState((s) => s.data.events.find((x) => x.title === title), 10000, 'the series on the server');
      assert.equal(e.start, `${mon}T09:30`);
      assert.deepEqual(e.repeat?.days, [1, 2, 3, 4, 5]);

      await sched.evaluate((d) => (location.hash = `#/week/${d}`), mon);
      await settle(sched, 400);
      const key = (d) => `.ev[data-ev="${e.id}@${d}"]`;
      await sched.waitFor(key(fri), 5000);
      const moveBy = async (d, hours) => {
        const g = await gridPoint(sched, d, 10); // scrolls 7:00 to the top: 9:00 to 12:00 are on screen
        const at = await rectOf(sched, key(d), { dy: 3 });
        await mouseDrag(sched, at, { x: at.x, y: at.y + hours * g.hour });
      };

      // Wednesday, one hour later, this event only.
      await moveBy(wed, 1);
      await pickScope(sched, 'This event');
      let s = await server.waitForState((st) => (st.data.events.some((x) => x.seriesId === e.id) ? st : null), 8000, 'a detached copy for Wednesday');
      const copy = s.data.events.find((x) => x.seriesId === e.id);
      assert.deepEqual([copy.start, copy.end, copy.occurrence, copy.repeat], [`${wed}T10:30`, `${wed}T10:45`, wed, null]);
      assert.ok(s.data.events.find((x) => x.id === e.id).exdates.includes(wed), 'the series skips Wednesday');

      // Friday, 90 minutes later, this and following.
      await moveBy(fri, 1.5);
      await pickScope(sched, 'This and following events');
      s = await server.waitForState((st) => (st.data.events.find((x) => x.id === e.id)?.until ? st : null), 8000, 'the series to end before Friday');
      assert.equal(s.data.events.find((x) => x.id === e.id).until, thu);
      const tail = s.data.events.find((x) => x.title === title && x.id !== e.id && x.repeat);
      assert.ok(tail, 'a new series starts on Friday');
      assert.equal(tail.start, `${fri}T11:00`);

      // Thursday: delete this occurrence only.
      await sched.click((k) => document.querySelector(k), { args: [key(thu)] });
      await sched.clickText('button', 'Delete event');
      await pickScope(sched, 'This event');
      await server.waitForState((st) => st.data.events.find((x) => x.id === e.id)?.exdates.includes(thu), 8000, 'Thursday to be skipped');

      // Tuesday, 30 minutes earlier, all events (of the first part of the series).
      await moveBy(tue, -0.5);
      await pickScope(sched, 'All events');
      s = await server.waitForState((st) => (st.data.events.find((x) => x.id === e.id)?.start === `${mon}T09:00` ? st : null), 8000, 'the series to start at 9:00');

      // On screen: Mon 9:00, Tue 9:00, Wed 10:30 (its own copy), no Thursday, Fri 11:00 (the new series).
      await sched.waitFor((ids) => document.querySelectorAll(ids.map((i) => `.ev[data-ev^="${i}@"]`).join(',')).length === 4, { timeout: 8000, args: [[e.id, copy.id, tail.id]], message: 'four occurrences on screen' });
      const shown = await sched.evaluate(
        (ids) =>
          [...document.querySelectorAll(ids.map((i) => `.ev[data-ev^="${i}@"]`).join(','))]
            .map((el) => `${el.closest('[data-date]').dataset.date} ${el.dataset.top}`)
            .sort(),
        [e.id, copy.id, tail.id],
      );
      assert.deepEqual(shown, [`${mon} 540`, `${tue} 540`, `${wed} 630`, `${fri} 660`]);
    });
  });

  test('Ctrl+K in Schedule finds a task and opens it in Tasks, and runs a view command', async () => {
    const { server } = ctx;
    await withScreenshot(sched, 'qa-flows-search-schedule', async () => {
      const title = `QA findable ${tag()}`;
      await tasks.bringToFront();
      await tasks.evaluate(() => (location.hash = '#/inbox'));
      await settle(tasks, 200);
      await addTask(tasks, title);
      const t = await server.waitForState((s) => s.data.tasks.find((x) => x.title === title), 10000, 'the task on the server');
      await waitForSyncIdle(tasks);

      await sched.bringToFront();
      await openApp(sched, server.url(`schedule/#/day/${today}`));
      await sched.press('Control+k');
      await sched.waitFor(() => document.activeElement?.matches('.palette input'), 4000);
      await sched.type('month view');
      await settle(sched, 200);
      await sched.press('Enter');
      await sched.waitFor(() => location.hash.startsWith('#/month/'), { timeout: 5000, message: 'Enter on "month view" to switch to the month' });

      await sched.press('Control+k');
      await sched.waitFor(() => document.activeElement?.matches('.palette input'), 4000);
      await sched.type(title);
      await settle(sched, 200);
      const first = await sched.evaluate(() => document.querySelector('.palette-list [data-r].hl')?.innerText || '');
      assert.ok(first.startsWith(title), `the task is the first result (got ${JSON.stringify(first)})`);
      await sched.press('Enter');
      await sched.waitFor(() => location.pathname.endsWith('/tasks/') && !!window.ecosysSync, { timeout: 10000, message: 'Tasks to open' });
      await sched.waitFor((title) => document.querySelector('#inspector [aria-label="Task name"]')?.value === title, { timeout: 8000, args: [title], message: "the task's details to open" });
      assert.ok(t.id);
      await openApp(sched, server.url('schedule/'));
    });
  });

  // Regression test for the wave-1 finding 'Tasks palette ranks "Add task “…”" above matching events and commands'.
  test('Ctrl+K in Tasks: Enter on "settings" opens Settings and an event is found before "Add task"', async () => {
    await withScreenshot(tasks, 'qa-flows-search-tasks', async () => {
      await tasks.bringToFront();
      await tasks.evaluate(() => (location.hash = '#/today'));
      await settle(tasks, 200);
      await tasks.press('Control+k');
      await tasks.waitFor(() => document.activeElement?.matches('.palette input'), 4000);
      await tasks.type('Team standup');
      await settle(tasks, 200);
      const first = await tasks.evaluate(() => document.querySelector('.palette-list [data-r].hl')?.innerText || '');
      await tasks.press('Escape');
      await tasks.waitFor(() => !document.querySelector('.palette'), 3000);
      assert.ok(first.startsWith('Team standup'), `the event is the first result, not "Add task" (got ${JSON.stringify(first)})`);

      await tasks.press('Control+k');
      await tasks.waitFor(() => document.activeElement?.matches('.palette input'), 4000);
      await tasks.type('settings');
      await settle(tasks, 200);
      await tasks.press('Enter');
      await settle(tasks, 400);
      const opened = await tasks.evaluate(() => !!document.querySelector('.modal.settings'));
      await tasks.press('Escape');
      await tasks.press('Escape');
      assert.ok(opened, 'Enter on "settings" opens Settings (not the task composer)');
    });
  });
});
