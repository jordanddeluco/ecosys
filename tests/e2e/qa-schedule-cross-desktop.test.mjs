// QA (schedule, cross-area round) on a desktop: the sidebar's mini month marks the days that have plans and
// says so, announces the month it pages to and keeps focus on the arrow pressed, and moves by week and month
// with Home / End / Page Up / Page Down; Esc on a focused event keeps focus there; the Tasks panel's quick
// add says which day a task went to when it isn't the panel's day; up to 1280px the open panel covers no
// day (the calendar moves over for it, tasks still drag onto the last day) and takes focus, giving it back
// when closed; up to 900px the drawer is a modal dialog, and wider the menu button says what it does.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const ymdOf = (t) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
/** The same day `n` months on, or that month's last day (Page Up / Page Down). */
const addMonths = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(y, m - 1 + n + 1, 0).getDate();
  return ymdOf(new Date(y, m - 1 + n, Math.min(d, last), 12));
};

describe('qa schedule: cross-area fixes on a desktop', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let page;
  let today;

  const go = async (hash) => {
    await page.evaluate((h) => (location.hash = h), hash);
    await settle(page, 400);
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
  const task = (title, extra = {}) => ({ title, date: null, time: null, duration: null, deadline: null, done: false, tags: [], checklist: [], listId: null, priority: 0, notes: '', repeat: null, order: -1, ...extra });
  /** What has focus: its id, the data-* that names it and its accessible name. */
  const focused = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return { body: true };
      return { id: a.id || null, mc: a.dataset.mc ?? null, date: a.dataset.date ?? null, ev: a.dataset.ev ?? null, label: a.getAttribute('aria-label'), inMinical: !!a.closest('#minical'), inPanel: !!a.closest('#panel'), inSidebar: !!a.closest('#sidebar'), toggle: a.matches('[data-nav-toggle]') ? 'nav' : a.matches('#topbar [data-toggle-panel]') ? 'panel' : null };
    });
  // A native drag from the Tasks panel (dragstart / dragover / drop), as Chrome sends it for a real mouse.
  async function html5Drag(from, to) {
    await page.send('Input.setInterceptDrags', { enabled: true });
    try {
      const intercepted = page.waitForEvent('Input.dragIntercepted', { timeout: 5000 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 5; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x - i * 4, y: from.y + i * 4, button: 'left', buttons: 1 });
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

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('schedule/'));
    today = await browserToday(page);
    await page.evaluate(async () => (await import('/shared/store.js')).settings.set({ timeFormat: '12h' }));
    await settle(page, 200);
  });

  test('the mini month: dots on the days with plans, paging is announced and keeps focus, Home / End / Page Up / Page Down', async () => {
    await withScreenshot(page, 'qa-schedule-cross-minical', async () => {
      await go(`#/week/${today}`);
      // A month four ahead, emptied of the sample's repeating events so only this test's plans show there.
      const [y, m] = today.split('-').map(Number);
      const month = ymdOf(new Date(y, m - 1 + 4, 1, 12)).slice(0, 7);
      const day = (n) => `${month}-${String(n).padStart(2, '0')}`;
      await page.evaluate(async () => {
        const { db } = await import('/shared/store.js');
        db.batch(() => db.all('events').forEach((e) => e.repeat && db.remove('events', e.id)));
      });
      await insert('events', [event(`QA plan ${tag(4)}`, day(10), '10:00', '11:00')]);
      await insert('tasks', [task(`QA open ${tag(4)}`, { date: day(12), time: '09:00', duration: 30 }), task(`QA done ${tag(4)}`, { date: day(14), time: '09:00', done: true }), task(`QA any time ${tag(4)}`, { date: day(16) })]);
      await settle(page, 300);
      // Page with the keyboard: Enter on "Next month", four times.
      await page.evaluate(() => document.querySelector('#minical [data-mc="next"]').focus());
      for (let i = 0; i < 4; i++) {
        await page.press('Enter');
        await sleep(60);
      }
      await sleep(250); // the announcement is set just after the redraw
      const st = await page.evaluate(() => ({ heading: document.querySelector('#minical .mc-head strong').textContent, said: document.querySelector('[data-announcer]')?.textContent || '' }));
      assert.equal(st.said, st.heading, 'the month paged to is announced (the heading is redrawn, so it is not read)');
      assert.match(st.heading, new RegExp(String(new Date(`${month}-01T12:00`).getFullYear())));
      const f = await focused();
      assert.equal(f.mc, 'next', `focus stays on the arrow pressed, redrawn with the month (${JSON.stringify(f)})`);
      const marks = await page.evaluate((m) => [...document.querySelectorAll('#minical .mc-day.mark')].filter((d) => d.dataset.date.startsWith(m)).map((d) => [d.dataset.date, d.getAttribute('aria-label')]), month);
      assert.deepEqual(marks.map(([d]) => d), [day(10), day(12)], 'the event and the open time-blocked task mark their days; a done task and one with no time do not');
      for (const [, label] of marks) assert.match(label, /, has plans$/, 'a dotted day says what the dot means');

      // The roving day: the 1st of the month shown. Page Down, End, Home, Page Up, then an arrow.
      await page.evaluate(() => document.querySelector('#minical .mc-day[tabindex="0"]').focus());
      const weekStart = await page.evaluate(async () => (await import('/shared/store.js')).settings.get().weekStart || 0);
      let cur = (await focused()).date;
      assert.equal(cur, day(1));
      const col = (s) => (new Date(`${s}T12:00`).getDay() - weekStart + 7) % 7;
      const expect = { PageDown: (s) => addMonths(s, 1), End: (s) => addDaysYmd(s, 6 - col(s)), Home: (s) => addDaysYmd(s, -col(s)), PageUp: (s) => addMonths(s, -1), ArrowRight: (s) => addDaysYmd(s, 1) };
      const hash = await page.evaluate(() => location.hash);
      for (const key of Object.keys(expect)) {
        await page.press(key);
        await sleep(60);
        const next = expect[key](cur);
        const now = await focused();
        assert.deepEqual([now.inMinical, now.date], [true, next], `${key} from ${cur}`);
        cur = next;
      }
      assert.equal(await page.evaluate(() => location.hash), hash, 'the keys move in the mini month only (Enter picks a day)');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('Esc on a focused event keeps focus on it', async () => {
    const d = addDaysYmd(today, 1);
    const [id] = await insert('events', [event(`QA focus ${tag(4)}`, d, '10:00', '11:00')]);
    await go(`#/week/${d}`);
    const key = `${id}@${d}`;
    await page.waitFor(`.ev[data-ev="${key}"]`, 4000);
    await page.evaluate((k) => document.querySelector(`.ev[data-ev="${k}"]`).focus(), key);
    await page.press('Escape');
    await sleep(100);
    assert.equal((await focused()).ev, key, 'focus did not drop to the page');
  });

  test('quick add in the Tasks panel says which day a task went to when it is not the panel’s day', async () => {
    await withScreenshot(page, 'qa-schedule-cross-quickadd', async () => {
      await go(`#/week/${today}`);
      if (await page.evaluate(() => document.querySelector('#panel').hidden)) await page.click('#topbar [data-toggle-panel]');
      await page.waitFor('#panel:not([hidden]) [data-panel-add]', 3000);
      const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
      const later = `QA call ${tag(5)}`;
      await page.click('[data-panel-add]');
      await page.type(`${later} tomorrow 3pm`);
      await page.press('Enter');
      await page.waitFor((t) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(t)), { timeout: 4000, args: [later] });
      assert.ok((await toasts()).some((t) => t.startsWith(`Added “${later}” · Tomorrow, 3pm`)), `the toast names the day and time: ${JSON.stringify(await toasts())}`);
      const plain = `QA plain ${tag(5)}`;
      await page.type(plain);
      await page.press('Enter');
      await page.waitFor((t) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(t)), { timeout: 4000, args: [plain] });
      const t2 = (await toasts()).find((t) => t.includes(plain));
      assert.ok(t2.startsWith(`Added “${plain}”`) && !t2.includes(' · '), `an undated task is simply added: ${t2}`);
      await page.click('#topbar [data-toggle-panel]');
      await settle(page, 200);
    });
  });

  test('a link to a task (from Tasks) opens the closed panel with that task in view and highlighted', async () => {
    await go(`#/week/${today}`);
    if (!(await page.evaluate(() => document.querySelector('#panel').hidden))) await page.click('#topbar [data-toggle-panel]');
    await settle(page, 300);
    const [tid] = await insert('tasks', [task(`QA linked ${tag(5)}`)]);
    await settle(page, 200);
    await go(`#/day/${today}/task/${tid}`);
    await page.waitFor((id) => !!document.querySelector(`#panel:not([hidden]) [data-ptask="${id}"].flash`), { timeout: 3000, args: [tid], message: 'the linked task highlighted in the panel' });
    await page.click('#topbar [data-toggle-panel]');
    await settle(page, 300);
  });

  test('1024px: the open Tasks panel covers no day, takes focus and gives it back; a task drags onto the last day', async () => {
    await withScreenshot(page, 'qa-schedule-cross-panel-1024', async () => {
      await page.setViewport(1024, 768, false);
      try {
        const D = addDaysYmd(today, 21);
        const title = `QA drag ${tag(5)}`;
        const [tid] = await insert('tasks', [task(title)]);
        await go(`#/week/${D}`);
        await page.evaluate(() => document.querySelector('#topbar [data-toggle-panel]').focus());
        await page.press('Enter');
        await page.waitFor('#panel:not([hidden])', 3000);
        await settle(page, 300);
        const f = await focused();
        assert.equal(f.id, 'panel', `the panel takes focus (itself: Tab goes on into it, i closes it): ${JSON.stringify(f)}`);
        const cover = await page.evaluate(() => {
          const p = document.querySelector('#panel').getBoundingClientRect();
          const under = [...document.querySelectorAll('#view .col, #view [data-goto-day]')].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.right > p.left + 0.5 && r.bottom > p.top && r.top < p.bottom;
          });
          return { under: under.map((el) => el.dataset.date || el.dataset.gotoDay), cols: document.querySelectorAll('#view .grid-body .col').length };
        });
        assert.equal(cover.cols, 7);
        assert.deepEqual(cover.under, [], 'no day sits under the panel');

        // Drag the task onto the week's last day at 11am.
        const from = await page.evaluate((id) => {
          const r = document.querySelector(`#panel [data-ptask="${id}"]`).getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, tid);
        const to = await page.evaluate(() => {
          const sc = document.querySelector('.grid-scroll');
          const body = document.querySelector('.grid-body');
          const hour = parseFloat(getComputedStyle(body).getPropertyValue('--hour'));
          sc.scrollTop = hour * 9;
          const col = [...document.querySelectorAll('.grid-body .col')].at(-1);
          const c = col.getBoundingClientRect();
          return { x: c.left + c.width / 2, y: body.getBoundingClientRect().top + hour * (11 + 10 / 60), date: col.dataset.date };
        });
        await html5Drag(from, to);
        await page.waitFor(async (id) => !!(await import('/shared/store.js')).db.get('tasks', id)?.time, { timeout: 5000, args: [tid], message: 'the dropped task to get a time' });
        const t = await page.evaluate(async (id) => (await import('/shared/store.js')).db.get('tasks', id), tid);
        assert.deepEqual([t.date, t.time], [to.date, '11:00'], 'planned on the last day of the week, 11am');

        // Close with the panel's own ×: focus goes back to the Tasks button.
        await page.evaluate(() => document.querySelector('#panel [data-toggle-panel]').focus());
        await page.press('Enter');
        await settle(page, 300);
        assert.equal(await page.evaluate(() => document.querySelector('#panel').hidden), true);
        assert.equal((await focused()).toggle, 'panel', 'focus is back on the button that opened it');
      } finally {
        await page.setViewport(1440, 900, false);
        await settle(page, 300);
      }
    });
  });

  test('≤900px the drawer is a modal dialog (focus in and kept, Esc or a pick closes it, focus back); wider the button says what it does', async () => {
    await withScreenshot(page, 'qa-schedule-cross-drawer', async () => {
      const btn = () => page.evaluate(() => {
        const b = document.querySelector('#topbar [data-nav-toggle]');
        return { name: b.getAttribute('aria-label'), expanded: b.getAttribute('aria-expanded'), popup: b.getAttribute('aria-haspopup'), tip: b.dataset.tip };
      });
      await go(`#/week/${today}`);
      assert.deepEqual(await btn(), { name: 'Hide sidebar', expanded: null, popup: null, tip: 'Hide sidebar' });
      await page.click('#topbar [data-nav-toggle]');
      await settle(page, 300);
      assert.deepEqual(await btn(), { name: 'Show sidebar', expanded: null, popup: null, tip: 'Show sidebar' });
      await page.click('#topbar [data-nav-toggle]');
      await settle(page, 300);

      await page.setViewport(800, 900, false);
      try {
        await settle(page, 400);
        assert.deepEqual(await btn(), { name: 'Main menu', expanded: 'false', popup: 'dialog', tip: 'Main menu' });
        const layers = () =>
          page.evaluate(() => ({
            open: document.querySelector('#shell').classList.contains('nav-open'),
            role: document.querySelector('#sidebar').getAttribute('role'),
            modal: document.querySelector('#sidebar').getAttribute('aria-modal'),
            mainInert: document.querySelector('#main').inert,
            expanded: document.querySelector('#topbar [data-nav-toggle]').getAttribute('aria-expanded'),
          }));
        await page.evaluate(() => document.querySelector('#topbar [data-nav-toggle]').focus());
        await page.press('Enter');
        await settle(page, 400);
        assert.deepEqual(await layers(), { open: true, role: 'dialog', modal: 'true', mainInert: true, expanded: 'true' });
        let f = await focused();
        assert.ok(f.inSidebar && /Week/.test(await page.evaluate(() => document.activeElement.textContent)), `focus moves in, to the current view: ${JSON.stringify(f)}`);
        for (let i = 0; i < 40; i++) {
          await page.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
          f = await focused();
          assert.ok(f.inSidebar, `Tab ${i + 1} stays in the drawer: ${JSON.stringify(f)}`);
        }
        await page.press('Escape');
        await settle(page, 300);
        assert.deepEqual(await layers(), { open: false, role: null, modal: null, mainInert: false, expanded: 'false' });
        assert.equal((await focused()).toggle, 'nav', 'Esc gives focus back to the menu button');
        // A pick (a view) closes it too, focus back on the button.
        await page.press('Enter');
        await settle(page, 400);
        await page.evaluate(() => document.querySelector('#side-views [data-view="month"]').focus());
        await page.press('Enter');
        await settle(page, 400);
        assert.equal(await page.evaluate(() => location.hash.split('/')[1]), 'month');
        assert.deepEqual(await layers(), { open: false, role: null, modal: null, mainInert: false, expanded: 'false' });
        assert.equal((await focused()).toggle, 'nav');
        // Create in the drawer: the drawer goes, the Create sheet opens, and Esc there lands on the menu button.
        await page.press('Enter');
        await settle(page, 400);
        await page.evaluate(() => document.querySelector('#sidebar [data-create]').focus());
        await page.press('Enter');
        await page.waitFor('.modal.qc-modal', 3000);
        assert.equal((await layers()).open, false, 'the drawer closed for Create');
        await page.press('Escape');
        await settle(page, 400);
        assert.equal((await focused()).toggle, 'nav');
        // Opened, then the window widened past 900px: the drawer is the sidebar again, nothing inert.
        await page.click('#topbar [data-nav-toggle]');
        await settle(page, 300);
        await page.setViewport(1100, 900, false);
        await settle(page, 400);
        assert.deepEqual(await layers(), { open: false, role: null, modal: null, mainInert: false, expanded: null });
      } finally {
        await page.setViewport(1440, 900, false);
        await settle(page, 300);
      }
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
