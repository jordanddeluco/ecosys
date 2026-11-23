// QA (model, cross-area) in the real apps. Tasks' Sort menu and its "Sorted by" chip call the sort by
// the planned day "Date", the word Tasks uses for it everywhere, never "Due date" (shared/model.js
// SORTS). And busyDays, the one rule for a mini month's grey dots, reads the app's live, synced data the
// way Schedule's sidebar shows it: hiding a calendar, or the tasks, there takes their days out, showing
// them again puts the days back, and Schedule's mini month draws exactly those days.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const now = () => Date.now();
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

describe('qa model: one name for the date, and the busy days of the mini month', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });

  async function ops(list) {
    const r = await ctx.server.api('api/ops', { method: 'POST', body: { client: 'qamodelcross0001', ops: list } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.applied, list.length, `the server took every op: ${r.text}`);
    return r.json.rev;
  }

  test('Tasks: the Sort menu and the Sorted-by chip say "Date"', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-model-cross-sort', async () => {
      await openApp(page, server.url('tasks/#/inbox'));
      const menu = '[role="menu"][aria-label="Sort by"]';
      const items = () =>
        page.evaluate((m) => [...document.querySelectorAll(`${m} .menu-item`)].map((b) => ({ label: b.querySelector('.grow')?.textContent.trim(), checked: b.getAttribute('aria-checked') })), menu);

      await page.click('[data-view-menu]');
      await page.clickText('menuitem', /^Sort by/);
      await page.waitFor(menu, 5000);
      assert.deepEqual((await items()).map((x) => x.label), ['My order', 'Date', 'Priority', 'Alphabetically', 'Creation date']);

      await page.clickText('menuitem', 'Date', { exact: true });
      const chip = await page.waitFor(() => {
        const b = document.querySelector('.sort-chip-btn');
        return b && { text: b.textContent.trim(), label: b.getAttribute('aria-label') };
      }, { timeout: 5000, message: 'the Sorted-by chip' });
      assert.deepEqual(chip, { text: 'Date', label: 'Sorted by Date. Change sort' });

      await page.click('.sort-chip-btn');
      await page.waitFor(menu, 5000);
      assert.deepEqual((await items()).filter((x) => x.checked === 'true').map((x) => x.label), ['Date'], 'the chip opens the same menu, with Date checked');
      await page.press('Escape');
      await page.waitFor(menu, { timeout: 5000, state: 'hidden' });

      await page.click('[data-sort-reset]');
      await page.waitFor(() => !document.querySelector('.sort-chip'), { timeout: 5000, message: 'back to my order' });
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('Schedule: busyDays follows the sidebar, hiding a calendar or the tasks takes their days out', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-model-cross-busydays', async () => {
      await openApp(page, server.url('schedule/'));
      // Start from an empty calendar: the sample events and tasks go.
      const st = await server.state();
      await ops([...st.data.events.map((e) => ({ op: 'del', c: 'events', id: e.id })), ...st.data.tasks.map((t) => ({ op: 'del', c: 'tasks', id: t.id }))]);
      await page.waitFor(
        async () => {
          const { db } = await import('/shared/store.js');
          return !db.all('events').length && !db.all('tasks').length;
        },
        { timeout: 8000, message: 'the sample events and tasks to leave the page' },
      );

      // This month's grid, as the mini month draws it (six weeks from the week the 1st is in).
      const grid = await page.evaluate(async () => {
        const { settings } = await import('/shared/store.js');
        const D = await import('/shared/dates.js');
        const from = D.ymd(D.startOfWeek(D.startOfMonth(new Date()), settings.get().weekStart || 0));
        return { from, to: D.addDaysYmd(from, 41) };
      });
      const day = (n) => addDaysYmd(grid.from, n);
      const main = st.data.calendars.find((c) => c.visible !== false) || st.data.calendars[0];
      const side = { id: uid(), name: `QA side ${tag()}`, color: 'teal', visible: true, order: 99, createdAt: now(), updatedAt: now() };
      const ev = (f) => ({ id: uid(), title: `QA ${tag()}`, calendarId: main?.id ?? null, allDay: false, location: '', notes: '', repeat: null, exdates: [], until: null, createdAt: now(), updatedAt: now(), ...f });
      const task = (f) => ({ id: uid(), title: `QA ${tag()}`, notes: '', listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null, checklist: [], done: false, completedAt: null, order: 9999, createdAt: now(), updatedAt: now(), ...f });
      await ops([
        { op: 'put', c: 'calendars', item: side },
        { op: 'put', c: 'events', item: ev({ start: `${day(9)}T10:00`, end: `${day(9)}T11:00` }) },
        { op: 'put', c: 'events', item: ev({ allDay: true, start: day(15), end: day(17) }) },
        { op: 'put', c: 'events', item: ev({ calendarId: side.id, start: `${day(20)}T23:00`, end: `${day(21)}T01:00` }) },
        { op: 'put', c: 'tasks', item: task({ date: day(25), time: '09:00', duration: 30 }) },
        { op: 'put', c: 'tasks', item: task({ date: day(26), time: '09:00', done: true, completedAt: now() }) },
        { op: 'put', c: 'tasks', item: task({ date: day(27) }) },
      ]);

      const busy = () =>
        page.evaluate(async (g) => {
          const { busyDays } = await import('/shared/model.js');
          const { settings } = await import('/shared/store.js');
          return [...busyDays(g.from, g.to, settings.get())].sort();
        }, grid);
      async function expectBusy(want, what) {
        let got = [];
        for (const until = Date.now() + 8000; Date.now() < until; await sleep(100)) {
          got = await busy();
          if (JSON.stringify(got) === JSON.stringify(want)) return;
        }
        assert.deepEqual(got, want, what);
      }

      const events = [day(9), day(15), day(16), day(17)];
      const all = [...events, day(20), day(21), day(25)];
      await expectBusy(all, 'each day of each event, and the open task with a time (not the done one, not the one without a time)');

      await page.clickText('checkbox', side.name, { exact: true });
      await server.waitForState((s) => s.data.calendars.find((c) => c.id === side.id)?.visible === false, 8000);
      await expectBusy([...events, day(25)], "the hidden calendar's event leaves its two days");

      await page.clickText('checkbox', 'Tasks', { exact: true });
      await server.waitForState((s) => s.settings.showTasksInSchedule === false, 8000);
      await expectBusy(events, 'tasks hidden on the calendar leave their day');

      await page.clickText('checkbox', 'Tasks', { exact: true });
      await page.clickText('checkbox', side.name, { exact: true });
      await expectBusy(all, 'shown again, the days come back');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  // One rule for every mini month: the dots Schedule draws are exactly busyDays' days, before and after
  // the sidebar changes what is shown.
  test("Schedule: the mini month's dots are the days busyDays finds, and follow the sidebar", async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-model-cross-minical', async () => {
      await openApp(page, server.url('schedule/'));
      const check = async (what) => {
        const r = await page.evaluate(async () => {
          const { busyDays } = await import('/shared/model.js');
          const { settings } = await import('/shared/store.js');
          const cells = [...document.querySelectorAll('#minical .mc-day')];
          const days = cells.map((c) => c.dataset.date);
          const busy = busyDays(days[0], days.at(-1), settings.get());
          const marked = cells.filter((c) => c.classList.contains('mark'));
          return {
            dots: marked.map((c) => c.dataset.date),
            want: days.filter((d) => busy.has(d)),
            said: marked.every((c) => (c.getAttribute('aria-label') || '').endsWith(', has plans')),
          };
        });
        assert.ok(r.want.length > 0, `${what}: this month has busy days`);
        assert.deepEqual(r.dots, r.want, what);
        assert.ok(r.said, `${what}: each marked day says it has plans`);
      };
      await check('on load');
      await page.clickText('checkbox', 'Tasks', { exact: true });
      await server.waitForState((s) => s.settings.showTasksInSchedule === false, 8000);
      await sleep(300);
      await check('tasks hidden on the calendar');
      await page.clickText('checkbox', 'Tasks', { exact: true });
      await server.waitForState((s) => s.settings.showTasksInSchedule === true, 8000);
      await sleep(300);
      await check('tasks shown again');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
