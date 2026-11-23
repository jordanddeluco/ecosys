// QA wave 1, schedule fixes on a phone (390x844, mobile emulation with touch): every view reachable from
// the drawer and the Month tab, one create sheet (the floating + and a tapped slot), the day's "more" list,
// moving an event with a long press, the editor's Starts / Ends rows (in focus order too, and after the
// phone turns), the create preview, and narrow day columns (no time cut off, a time that fits shows).
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

describe('qa schedule: phone fixes', () => {
  const ctx = useE2E({ width: 390, height: 844, mobile: true, scheme: 'light' });
  let page;
  let today;
  let D;

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
  const insert = (collection, records) =>
    page.evaluate(
      async (c, recs) => {
        const { db } = await import('/shared/store.js');
        return recs.map((r) => db.insert(c, r).id);
      },
      collection,
      records,
    );
  const event = (title, date, start, end) => ({ title, calendarId: null, start: `${date}T${start}`, end: `${date}T${end}`, allDay: false, location: '', notes: '', repeat: null, exdates: [], until: null });
  const task = (title, date, time, duration) => ({ title, date, time, duration, deadline: null, done: false, tags: [], checklist: [], listId: null, priority: 0, notes: '', repeat: null, order: 1 });
  const visible = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'), sel);
  /**
   * Every block time on the grid (ghosts included) that shows cut off: its visible text wider than its box, in
   * fractions of a pixel, or its line ending less than 1px above the block's bottom (a short block's one-line
   * time wraps out of sight unless it fits, so only its width counts).
   */
  const cutTimes = () =>
    page.evaluate(() => {
      const out = [];
      for (const ev of document.querySelectorAll('#view .ev')) {
        const t = ev.querySelector('.ev-time');
        if (!t || getComputedStyle(t).display === 'none' || !t.getClientRects().length) continue;
        const shown = [...t.children].find((c) => getComputedStyle(c).display !== 'none') || t;
        const text = document.createRange();
        text.selectNodeContents(shown);
        const w = text.getBoundingClientRect().width;
        const box = t.getBoundingClientRect();
        const name = ev.querySelector('.ev-title')?.textContent;
        if (w > box.width + 0.01) out.push(`${name}: "${shown.textContent}" is ${w.toFixed(2)}px wide in ${box.width.toFixed(2)}px`);
        const bottom = ev.getBoundingClientRect().bottom;
        if (!ev.classList.contains('short') && box.bottom > bottom - 1) out.push(`${name}: "${shown.textContent}" ends at ${box.bottom.toFixed(1)}, its block at ${bottom.toFixed(1)}`);
      }
      return out;
    });

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('schedule/'));
    today = await browserToday(page);
    D = addDaysYmd(today, 14);
    await page.evaluate(async () => (await import('/shared/store.js')).settings.set({ timeFormat: '12h' }));
    await settle(page, 200);
  });

  test('every view is reachable: the drawer lists them (Year included) and the Month tab zooms out to Year', async () => {
    await withScreenshot(page, 'qa-schedule-phone-views', async () => {
      await go(`#/week/${D}`);
      await page.click('#topbar [data-nav-toggle]');
      await page.waitFor('#side-views:not([hidden]) [data-view="year"]', 3000);
      const items = await page.evaluate(() => [...document.querySelectorAll('#side-views [data-view]')].map((b) => [b.dataset.view, b.getAttribute('aria-current')]));
      assert.deepEqual(items.map(([v]) => v), ['day', 'days', 'month', 'year', 'agenda'], 'Week is a few days on a phone, so it is not listed twice');
      assert.deepEqual(items.find(([v]) => v === 'days'), ['days', 'true']);
      await page.click('#side-views [data-view="year"]');
      await settle(page, 400);
      assert.deepEqual(await page.evaluate(() => ({ hash: location.hash.split('/')[1], open: document.querySelector('#shell').classList.contains('nav-open') })), { hash: 'year', open: false });
      await go(`#/month/${D}`);
      await page.click('#tabbar [data-tab="month"]');
      await settle(page, 300);
      assert.equal(await page.evaluate(() => location.hash.split('/')[1]), 'year', 'Month again goes to the year (Apple)');
      await page.click('#tabbar [data-tab="month"]');
      await settle(page, 300);
      assert.equal(await page.evaluate(() => location.hash.split('/')[1]), 'month', 'and back');
    });
  });

  test('one create sheet: the floating + (no header +) and a tapped empty slot open the same sheet', async () => {
    await withScreenshot(page, 'qa-schedule-phone-create', async () => {
      await go(`#/week/${D}`);
      assert.equal(await visible('#topbar .top-create'), false, 'no + in the header');
      const fab = await page.evaluate(() => {
        const f = document.querySelector('.fab').getBoundingClientRect();
        const t = document.querySelector('#tabbar').getBoundingClientRect();
        return { shown: f.width > 0, above: f.bottom <= t.top };
      });
      assert.deepEqual(fab, { shown: true, above: true }, 'the + floats above the tab bar, as in Tasks');
      await page.click('.fab');
      await page.waitFor('.modal.qc-modal', 3000);
      await page.press('Escape');
      await settle(page, 300);
      const p = await page.evaluate((d) => {
        const body = document.querySelector('.grid-body');
        const hour = parseFloat(getComputedStyle(body).getPropertyValue('--hour'));
        document.querySelector('.grid-scroll').scrollTop = hour * 9;
        const col = document.querySelector(`.col[data-date="${d}"]`).getBoundingClientRect();
        return { x: col.left + col.width / 2, y: body.getBoundingClientRect().top + hour * 10 + 8 };
      }, D);
      await tap(p.x, p.y);
      await page.waitFor('.modal.qc-modal', 3000);
      assert.equal(await page.evaluate(() => !!document.querySelector('.menu.qc-pop')), false, 'not a floating card');
      assert.equal(await page.evaluate((d) => !!document.querySelector(`.col[data-date="${d}"] .ev.ghost`), D), true, 'the tapped slot keeps its ghost on the grid');
      await page.press('Escape');
      await settle(page, 300);
      assert.equal(await page.evaluate(() => !!document.querySelector('.ev.ghost')), false);
    });
  });

  test('a day’s "more" list keeps times, calendar dots and checkboxes in touch-size rows', async () => {
    await withScreenshot(page, 'qa-schedule-phone-more', async () => {
      const d = addDaysYmd(D, 1);
      await insert('events', [1, 2, 3, 4, 5].map((i) => event(`QA more ${i} ${tag(3)}`, d, `${String(8 + i).padStart(2, '0')}:00`, `${String(8 + i).padStart(2, '0')}:30`)));
      await insert('tasks', [{ title: `QA more task ${tag(3)}`, date: d, time: '16:00', duration: 30, deadline: null, done: false, tags: [], checklist: [], listId: null, priority: 0, notes: '', repeat: null, order: 1 }]);
      await go(`#/month/${d}`);
      await page.click(`[data-day-more="${d}"]`);
      await page.waitFor('.day-pop', 3000);
      const r = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.day-pop .mitem')].filter((i) => i.querySelector('.n')?.textContent.startsWith('QA more'));
        const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
        return {
          n: items.length,
          times: items.filter((i) => shown(i.querySelector('.t'))).length,
          dots: items.filter((i) => shown(i.querySelector('.dot'))).length,
          checks: items.filter((i) => shown(i.querySelector('.check'))).length,
          minH: Math.min(...items.map((i) => i.getBoundingClientRect().height)),
        };
      });
      assert.equal(r.n, 6);
      assert.equal(r.times, 6, 'every item shows its time');
      assert.equal(r.dots, 5, 'events show their calendar dot');
      assert.equal(r.checks, 1, 'the task can be completed from the list');
      assert.ok(r.minH >= 32, `rows are touch-size: ${r.minH}px`);
      await page.press('Escape');
      await settle(page, 200);
    });
  });

  test('touch: holding an event lifts it, and dragging moves it (Apple, Google)', async () => {
    await withScreenshot(page, 'qa-schedule-phone-drag', async () => {
      const d = addDaysYmd(D, 2);
      const [id] = await insert('events', [event(`QA touch ${tag(4)}`, d, '10:00', '11:00')]);
      await go(`#/week/${d}`);
      const sel = `.ev[data-ev="${id}@${d}"]`;
      await page.waitFor(sel, 4000);
      const b = await page.evaluate((s) => {
        const el = document.querySelector(s);
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + 14, hour: parseFloat(getComputedStyle(document.querySelector('.grid-body')).getPropertyValue('--hour')) };
      }, sel);
      await sleep(200);
      const hash = await page.evaluate(() => location.hash);
      await touch('touchStart', b.x, b.y);
      await sleep(650); // past the hold
      assert.equal(await page.evaluate((s) => document.querySelector(s)?.classList.contains('dragging'), sel), true, 'the held block is lifted');
      for (let i = 1; i <= 10; i++) {
        await touch('touchMove', b.x, b.y + (b.hour * i) / 10);
        await sleep(30);
      }
      await touch('touchEnd', b.x, b.y + b.hour);
      await page.waitFor(async (i) => (await import('/shared/store.js')).db.get('events', i)?.start !== undefined, { args: [id] });
      await settle(page, 300);
      const ev = await page.evaluate(async (i) => (await import('/shared/store.js')).db.get('events', i), id);
      assert.deepEqual([ev.start, ev.end], [`${d}T11:00`, `${d}T12:00`], 'moved one hour later');
      assert.equal(await page.evaluate(() => location.hash), hash, 'the drag is not taken as a swipe to another range');
      // A quick swipe-free scroll still scrolls: a finger that moves at once lifts nothing.
      await go(`#/week/${d}`);
      await page.waitFor(sel, 4000);
      const c = await page.evaluate((s) => {
        const el = document.querySelector(s);
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + 14 };
      }, sel);
      await touch('touchStart', c.x, c.y);
      for (let i = 1; i <= 6; i++) {
        await touch('touchMove', c.x, c.y - i * 12);
        await sleep(16);
      }
      await touch('touchEnd', c.x, c.y - 72);
      await settle(page, 400);
      const ev2 = await page.evaluate(async (i) => (await import('/shared/store.js')).db.get('events', i), id);
      assert.equal(ev2.start, `${d}T11:00`, 'moving without holding first does not move the event');
    });
  });

  test('the editor shows Starts and Ends rows, and the repeat icon fronts Repeat', async () => {
    await withScreenshot(page, 'qa-schedule-phone-editor', async () => {
      await go(`#/week/${D}`);
      await page.click('.fab');
      await page.waitFor('.modal.qc-modal .qc-title', 3000);
      await page.type(`QA editor ${tag(4)} 1pm`);
      await page.clickText('button', 'More options');
      await page.waitFor('.modal.editor [name="endDate"]', 3000);
      const r = await page.evaluate(() => {
        const y = (s) => Math.round(document.querySelector(`.editor ${s}`).getBoundingClientRect().top);
        const labels = [...document.querySelectorAll('.editor .ed-ph')].filter((el) => el.getClientRects().length).map((el) => el.textContent);
        const repeatRow = document.querySelector('.editor [name="repeat"]').closest('.ed-row');
        const allDayRow = document.querySelector('.editor [name="allDay"]').closest('.ed-row');
        return { startDate: y('[name="startDate"]'), startTime: y('[name="startTime"]'), endDate: y('[name="endDate"]'), endTime: y('[name="endTime"]'), labels, repeatIcon: !!repeatRow.querySelector(':scope > svg'), allDayIcon: !!allDayRow.querySelector(':scope > svg') };
      });
      assert.deepEqual(r.labels, ['Starts', 'Ends']);
      assert.equal(r.startDate, r.startTime, 'start date and time share a row');
      assert.equal(r.endDate, r.endTime, 'end date and time share the next row (the end date never sits alone)');
      assert.ok(r.endDate > r.startDate);
      assert.deepEqual([r.repeatIcon, r.allDayIcon], [true, false]);
      // Focus order is the order shown (WCAG 1.3.2, 2.4.3): Starts date, time, then Ends date, time.
      const shownFields = () => page.evaluate(() => [...document.querySelectorAll('.editor .ed-when [name]')].filter((b) => b.getClientRects().length).map((b) => b.getAttribute('name')));
      assert.deepEqual(await shownFields(), ['startDate', 'startTime', 'endDate', 'endTime'], 'the fields are in the order shown in the DOM, not moved with CSS order');
      const tabFrom = async (name, n) => {
        await page.evaluate((x) => document.querySelector(`.editor [name="${x}"]`).focus(), name);
        const seq = [];
        for (let i = 0; i < n; i++) {
          await page.press('Tab');
          seq.push(await page.evaluate(() => document.activeElement?.getAttribute('name')));
        }
        return seq;
      };
      assert.deepEqual(await tabFrom('startTime', 2), ['endDate', 'endTime'], 'Tab from Start time lands on End date, then End time');
      await page.click('.editor [name="allDay"]');
      await settle(page, 150);
      assert.deepEqual(await shownFields(), ['startDate', 'endDate'], 'All day hides both times (the end time sits outside the start time’s group here)');
      await page.click('.editor [name="allDay"]');
      await settle(page, 150);
      assert.deepEqual(await shownFields(), ['startDate', 'startTime', 'endDate', 'endTime']);
      // Turned to landscape (wider than 640px), Google's one row: the end time goes back beside the start time.
      await page.setViewport(844, 390, true);
      try {
        await settle(page, 300);
        assert.deepEqual(await shownFields(), ['startDate', 'startTime', 'endTime', 'endDate']);
        assert.deepEqual(await tabFrom('startTime', 2), ['endTime', 'endDate']);
      } finally {
        await page.setViewport(390, 844, true);
        await settle(page, 300);
      }
      assert.deepEqual(await shownFields(), ['startDate', 'startTime', 'endDate', 'endTime']);
      await page.press('Escape');
      await settle(page, 300);
    });
  });

  test('the create preview never shows its time half below it', async () => {
    await withScreenshot(page, 'qa-schedule-phone-preview', async () => {
      const d = addDaysYmd(D, 5);
      await go(`#/week/${d}`);
      const p = await page.evaluate((x) => {
        const body = document.querySelector('.grid-body');
        const hour = parseFloat(getComputedStyle(body).getPropertyValue('--hour'));
        document.querySelector('.grid-scroll').scrollTop = hour * 8;
        const col = document.querySelector(`.col[data-date="${x}"]`).getBoundingClientRect();
        return { x: col.left + col.width / 2, y: body.getBoundingClientRect().top + hour * 10 + 8 };
      }, addDaysYmd(d, 1));
      await tap(p.x, p.y);
      await page.waitFor('.modal.qc-modal .qc-title', 3000);
      await settle(page, 200);
      await page.type('Budget review 1pm');
      await settle(page, 300);
      const g = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.ev.ghost')].find((x) => x.style.visibility !== 'hidden');
        return el && { title: el.querySelector('.ev-title').textContent, time: getComputedStyle(el.querySelector('.ev-time')).display };
      });
      assert.equal(g?.title, 'Budget review', 'the preview shows at 1pm');
      // 'Budget / review' takes two lines in a phone's day column: its time ('1 – 2pm') was cut at the bottom.
      assert.equal(g.time, 'none');
      assert.deepEqual(await cutTimes(), []);
      await page.press('Escape');
      await settle(page, 300);
      assert.equal(await page.evaluate(() => !!document.querySelector('.ev.ghost')), false);
    });
  });

  test('narrow day columns: a title that does not fit on one line takes two and no time; a time that fits shows; none is cut', async () => {
    const d = addDaysYmd(D, 3);
    // 'Swim' at 8pm: the sample data's Gym repeats at 6pm on some weekdays (two side by side are narrower).
    const [id, swim] = await insert('events', [event(`Lunch with Sam ${tag(4)}`, d, '12:30', '13:30'), event('Swim', d, '20:00', '21:15')]);
    const [draft, long] = await insert('tasks', [task('Draft report', addDaysYmd(d, 1), '15:00', 60), task('Write the long quarterly summary', addDaysYmd(d, 2), '15:00', 60)]);
    await go(`#/week/${d}`);
    await page.waitFor(`.ev[data-ev="${id}@${d}"]`, 4000);
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      const time = el.querySelector('.ev-time');
      return { narrow: document.querySelector('#view').classList.contains('narrow-cols'), time: getComputedStyle(time).display, clamp: getComputedStyle(el.querySelector('.ev-title')).webkitLineClamp };
    }, `.ev[data-ev="${id}@${d}"]`);
    assert.deepEqual(r, { narrow: true, time: 'none', clamp: '2' });
    // 'Swim 8 – 9:15pm' fits on its lines: its time shows (it was hidden for every mid-length event here).
    assert.notEqual(await page.evaluate((s) => getComputedStyle(document.querySelector(s)).display, `.ev[data-ev="${swim}@${d}"] .ev-time`), 'none');
    // A 60-minute task whose title wraps: its time goes rather than show half below the block ('Draft / report / 3pm').
    for (const tid of [draft, long]) {
      const t = await page.evaluate((s) => {
        const el = document.querySelector(s);
        const time = el.querySelector('.ev-time');
        return { time: getComputedStyle(time).display, below: time.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom };
      }, `.ev[data-task="${tid}"]`);
      assert.ok(t.time === 'none' || t.below <= -1, `a task's time is hidden or whole: ${JSON.stringify(t)}`);
    }
    assert.deepEqual(await cutTimes(), []);
    const errors = page.consoleErrors();
    assert.deepEqual(errors, [], 'no console errors');
  });
});
