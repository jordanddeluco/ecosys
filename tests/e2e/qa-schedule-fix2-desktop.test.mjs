// QA fix round 2 (schedule) on a desktop:
// - perf: the Schedule view is drawn a week at a time as it scrolls into view and redrawn in place (a change
//   keeps the weeks it didn't touch, and the scroll); Show more from the keyboard goes on to the first new day;
// - links in an event's description and place, and in a task's notes, are clickable in their cards;
// - the Year view marks the days that have plans (the mini month's rule and words);
// - Ctrl+\ hides and shows the sidebar (the drawer when narrow), and the menu button's glyph says which;
// - `i` with nothing focused opens the Tasks panel without taking focus: the arrow keys still step the range;
// - from 901 to 1280px the open panel takes the sidebar's place; narrowed day heads keep their circles in
//   their columns and the daily-note mark off the weekday (960 and 700px);
// - the mini month's tab stop follows the date after j / k;
// - a typed date range in Create ("Trip dec 20-28") is one all-day event over those days.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymdOf = (t) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  return ymdOf(new Date(y, m - 1, d + n, 12));
};
/** The next `MM-DD` on or after `today` ('YYYY-MM-DD'), as the parser reads "dec 20". */
const nextDate = (today, mmdd) => (`${today.slice(0, 4)}-${mmdd}` >= today ? `${today.slice(0, 4)}-${mmdd}` : `${+today.slice(0, 4) + 1}-${mmdd}`);

describe('qa schedule fix round 2: desktop', () => {
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
        return db.batch(() => recs.map((r) => db.insert(c, r).id));
      },
      collection,
      records,
    );
  const event = (title, date, start, end, extra = {}) => ({ title, calendarId: null, start: `${date}T${start}`, end: `${date}T${end}`, allDay: false, location: '', notes: '', repeat: null, exdates: [], until: null, ...extra });
  const hash = () => page.evaluate(() => location.hash);
  const blur = () => page.evaluate(() => document.activeElement?.blur());

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('schedule/'));
    today = await browserToday(page);
    await page.evaluate(async () => (await import('/shared/store.js')).settings.set({ timeFormat: '12h', schedulePanel: false, scheduleNavCollapsed: false }));
    await settle(page, 200);
  });

  test('Schedule view: drawn a week at a time as it scrolls, redrawn in place; Show more from the keyboard goes on to the new days', async () => {
    await withScreenshot(page, 'qa-schedule-fix2-agenda', async () => {
      // Sixty quiet days far from the sample data, six events a day: 360 rows, far more than a few screens.
      const start = addDaysYmd(today, 400);
      const recs = [];
      for (let d = 0; d < 60; d++) for (let h = 8; h < 14; h++) recs.push(event(`QA ag ${d}-${h}`, addDaysYmd(start, d), `${String(h).padStart(2, '0')}:00`, `${String(h).padStart(2, '0')}:30`));
      await insert('events', recs);
      await go(`#/agenda/${start}`);
      const drawn = () => page.evaluate(() => ({ chunks: document.querySelectorAll('.agenda .ag-chunk').length, rows: document.querySelectorAll('.agenda .ag-item').length, days: [...document.querySelectorAll('.agenda .ag-date')].map((b) => b.dataset.gotoDay) }));
      const first = await drawn();
      assert.equal(first.days[0], start, 'it starts on its first day');
      assert.ok(first.chunks >= 1 && first.chunks <= 2 && first.rows < 120, `only the first weeks are drawn, not all 60 days: ${JSON.stringify({ chunks: first.chunks, rows: first.rows })}`);

      // Scrolling to the end of what is drawn draws the next week.
      await page.evaluate(() => {
        const sc = document.querySelector('.agenda');
        sc.scrollTop = sc.scrollHeight;
      });
      await page.waitFor((n) => document.querySelectorAll('.agenda .ag-chunk').length > n, { timeout: 4000, args: [first.chunks], message: 'the next week drawn as it comes into view' });

      // A change redraws in place: the weeks it didn't touch are the same elements, and the scroll stays.
      const before = await page.evaluate(() => {
        const sc = document.querySelector('.agenda');
        sc.scrollTop = 600;
        document.querySelector('.agenda .ag-chunk').dataset.qaKeep = '1';
        return sc.scrollTop;
      });
      const renamed = `QA renamed ${tag(4)}`;
      await page.evaluate(
        async (title, day) => {
          const { db } = await import('/shared/store.js');
          const e = db.all('events').find((x) => x.title === `QA ag ${day}-9`);
          db.update('events', e.id, { title });
        },
        renamed,
        8,
      );
      await page.waitFor((t) => [...document.querySelectorAll('.agenda .ag-item .what')].some((x) => x.textContent === t), { timeout: 4000, args: [renamed], message: 'the renamed event redrawn' });
      const after = await page.evaluate(() => ({ kept: document.querySelector('.agenda .ag-chunk')?.dataset.qaKeep === '1', top: document.querySelector('.agenda').scrollTop }));
      assert.equal(after.kept, true, 'the first week, which did not change, is the same element (not rebuilt)');
      assert.ok(Math.abs(after.top - before) <= 1, `the scroll position stays: ${before} → ${after.top}`);

      // Show more from the keyboard: 60 more days, and focus goes on to the first new day that has plans.
      await insert('events', [event(`QA later ${tag(4)}`, addDaysYmd(start, 75), '10:00', '11:00')]);
      await settle(page, 200);
      await page.evaluate(() => document.querySelector('[data-step-view]').focus());
      await page.press('Enter');
      await settle(page, 300);
      const f = await page.evaluate(() => document.activeElement?.dataset.gotoDay || null);
      assert.ok(f && f >= addDaysYmd(start, 60), `focus is on the first new day with plans (${f})`);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('links in a description, a place and a task’s notes are clickable in their cards', async () => {
    await withScreenshot(page, 'qa-schedule-fix2-links', async () => {
      const d = addDaysYmd(today, 30);
      const noteUrl = ctx.server.url('notes/#/n/n_qalink');
      const [id] = await insert('events', [event(`QA links ${tag(4)}`, d, '10:00', '11:00', { location: 'https://zoom.us/j/987654', notes: `Join: https://zoom.us/j/987654 and see ${noteUrl}\nQuestions: ops@example.com` })]);
      await go(`#/week/${d}`);
      await page.waitFor(`.ev[data-ev="${id}@${d}"]`, 4000);
      await page.evaluate((k) => document.querySelector(`.ev[data-ev="${k}"]`).scrollIntoView({ block: 'center' }), `${id}@${d}`);
      await page.click((k) => document.querySelector(`.ev[data-ev="${k}"]`), { args: [`${id}@${d}`] });
      await page.waitFor('.ev-pop .ep-rows', 3000);
      const links = await page.evaluate(() => [...document.querySelectorAll('.ev-pop .ep-rows a')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent, target: a.getAttribute('target'), rel: a.getAttribute('rel') })));
      assert.deepEqual(links, [
        { href: 'https://zoom.us/j/987654', text: 'https://zoom.us/j/987654', target: '_blank', rel: 'noopener noreferrer' },
        { href: 'https://zoom.us/j/987654', text: 'https://zoom.us/j/987654', target: '_blank', rel: 'noopener noreferrer' },
        { href: noteUrl, text: noteUrl, target: null, rel: null },
        { href: 'mailto:ops@example.com', text: 'ops@example.com', target: null, rel: null },
      ]);
      const glyph = await page.evaluate(() => [...document.querySelectorAll('.ev-pop .ep-rows .r')].find((r) => r.querySelector('.notes'))?.querySelector('svg')?.innerHTML || '');
      assert.match(glyph, /M4 5\.5h16M4 10h16M4 14\.5h16M4 19h9\.5/, 'the description row has the text-lines glyph, not the list');
      await page.press('Escape');
      await settle(page, 200);

      // A task's notes too (Notes' Copy link in a task).
      const [tid] = await insert('tasks', [{ title: `QA task link ${tag(4)}`, date: d, time: '14:00', duration: 60, deadline: null, done: false, tags: [], checklist: [], listId: null, priority: 0, notes: `Brief: ${noteUrl}`, repeat: null, order: 1 }]);
      await page.waitFor(`.ev[data-task="${tid}"]`, 4000);
      await page.evaluate((t) => document.querySelector(`.ev[data-task="${t}"]`).scrollIntoView({ block: 'center' }), tid);
      await page.click((t) => document.querySelector(`.ev[data-task="${t}"] .tb-text`), { args: [tid] });
      await page.waitFor('.task-pop .ep-rows', 3000);
      const tl = await page.evaluate(() => [...document.querySelectorAll('.task-pop .ep-rows a')].map((a) => [a.getAttribute('href'), a.getAttribute('target')]));
      assert.deepEqual(tl, [[noteUrl, null]], 'the link to the note opens in place');
      await page.press('Escape');
      await settle(page, 200);
    });
  });

  test('the Year view marks the days that have plans, and says so', async () => {
    const y = +today.slice(0, 4) + 3;
    const day = `${y}-05-14`;
    // Without the sample's repeating events, which reach that year too.
    await page.evaluate(async () => {
      const { db } = await import('/shared/store.js');
      db.batch(() => db.all('events').forEach((e) => e.repeat && db.remove('events', e.id)));
    });
    await insert('events', [event(`QA year ${tag(4)}`, day, '09:00', '10:00')]);
    await go(`#/year/${day}`);
    const r = await page.evaluate((a, b) => {
      const at = (k) => document.querySelector(`.ym-day[data-goto-day="${k}"]`);
      return { busy: at(a).classList.contains('busy'), label: at(a).getAttribute('aria-label'), other: at(b).classList.contains('busy'), otherLabel: at(b).getAttribute('aria-label'), dot: getComputedStyle(at(a), '::after').content };
    }, day, `${y}-05-15`);
    assert.equal(r.busy, true);
    assert.match(r.label, /, has plans$/, 'the dot is spoken, in the mini month’s words');
    assert.equal(r.other, false);
    assert.doesNotMatch(r.otherLabel, /has plans/);
    assert.notEqual(r.dot, 'none', 'a dot is drawn');
  });

  test('Ctrl+\\ hides and shows the sidebar (the drawer when narrow); the button’s glyph and tooltip say so', async () => {
    await withScreenshot(page, 'qa-schedule-fix2-sidebar', async () => {
      await go(`#/week/${today}`);
      const btn = () =>
        page.evaluate(() => {
          const b = document.querySelector('#topbar [data-nav-toggle]');
          return { name: b.getAttribute('aria-label'), keys: b.dataset.keys, glyph: b.querySelector('svg')?.innerHTML || '', collapsed: document.querySelector('#shell').classList.contains('nav-collapsed'), open: document.querySelector('#shell').classList.contains('nav-open') };
        });
      let b = await btn();
      assert.deepEqual([b.name, b.keys, b.collapsed], ['Hide sidebar', 'mod \\', false]);
      assert.match(b.glyph, /M9\.2 3\.8v16\.4/, 'wide, the button has the sidebar glyph');
      await blur();
      await page.press('Control+\\');
      await settle(page, 300);
      b = await btn();
      assert.deepEqual([b.name, b.collapsed], ['Show sidebar', true]);
      // Also while typing (as in Tasks and Notes): from the Tasks panel's text field.
      await page.click('#topbar [data-toggle-panel]');
      await page.waitFor('#panel:not([hidden]) [data-panel-add]', 3000);
      await page.click('[data-panel-add]');
      await page.press('Control+\\');
      await settle(page, 300);
      b = await btn();
      assert.deepEqual([b.name, b.collapsed], ['Hide sidebar', false]);
      await page.click('#topbar [data-toggle-panel]');
      await settle(page, 300);

      await page.setViewport(800, 900, false);
      try {
        await settle(page, 400);
        b = await btn();
        assert.equal(b.name, 'Main menu');
        assert.doesNotMatch(b.glyph, /M9\.2 3\.8v16\.4/, 'narrow, it opens the drawer: the menu glyph');
        await blur();
        await page.press('Control+\\');
        await settle(page, 400);
        assert.equal((await btn()).open, true, 'Ctrl+\\ opens the drawer');
        await page.press('Control+\\');
        await settle(page, 400);
        assert.equal((await btn()).open, false, '…and closes it');
      } finally {
        await page.setViewport(1440, 900, false);
        await settle(page, 300);
      }
      // The shortcuts sheet lists it.
      await blur();
      await page.press('?');
      await page.waitFor('.modal', 3000);
      const listed = await page.evaluate(() => /Sidebar/.test(document.querySelector('.modal')?.textContent || ''));
      assert.equal(listed, true, 'the keyboard shortcuts list the sidebar');
      await page.press('Escape');
      await settle(page, 200);
    });
  });

  test('Ctrl+\\ over the Tasks sheet (600px): the sheet closes first and the drawer opens; Esc gives focus back to the menu button', async () => {
    await page.setViewport(600, 900, false);
    try {
      await go(`#/day/${today}`);
      await blur();
      await page.press('i');
      await page.waitFor(() => document.querySelector('#panel')?.getAttribute('aria-modal') === 'true', { timeout: 3000, message: 'the Tasks sheet open (a modal dialog)' });
      await page.press('Control+\\');
      await settle(page, 400);
      const s = await page.evaluate(() => ({ sheet: !document.querySelector('#panel').hidden, drawer: document.querySelector('#shell').classList.contains('nav-open'), inSidebar: !!document.activeElement?.closest('#sidebar') }));
      assert.deepEqual(s, { sheet: false, drawer: true, inSidebar: true }, 'two modal layers never stack');
      await page.press('Escape');
      await settle(page, 300);
      assert.equal(await page.evaluate(() => document.activeElement?.matches('#topbar [data-nav-toggle]')), true);
    } finally {
      await page.setViewport(1440, 900, false);
      await settle(page, 300);
    }
  });

  test('i with nothing focused opens the Tasks panel beside the calendar without taking focus: the arrow keys still step the week', async () => {
    await go(`#/week/${today}`);
    if (!(await page.evaluate(() => document.querySelector('#panel').hidden))) await page.click('#topbar [data-toggle-panel]');
    await settle(page, 300);
    await blur();
    const h0 = await hash();
    await page.press('i');
    await settle(page, 300);
    assert.equal(await page.evaluate(() => document.querySelector('#panel').hidden), false);
    await page.press('ArrowRight');
    await settle(page, 300);
    const h1 = await hash();
    assert.equal(h1.split('/')[2], addDaysYmd(h0.split('/')[2], 7), `ArrowRight steps a week with the panel open (${h0} → ${h1})`);
    await page.press('i');
    await settle(page, 300);
    assert.equal(await page.evaluate(() => document.querySelector('#panel').hidden), true);
    await page.press('ArrowRight');
    await settle(page, 300);
    assert.equal((await hash()).split('/')[2], addDaysYmd(h1.split('/')[2], 7), 'and again once it is closed');
  });

  for (const width of [960, 700]) {
    test(`${width}px with the Tasks panel open: each day head keeps its circle in its column and the note mark off the weekday`, async () => {
      await withScreenshot(page, `qa-schedule-fix2-panel-${width}`, async () => {
        // A daily note on every day of the week shown (whatever day it starts on), so each head has its note mark.
        const start = addDaysYmd(today, width === 960 ? 14 : 28);
        await page.evaluate(async (s) => {
          const { db } = await import('/shared/store.js');
          const [y, m, d] = s.split('-').map(Number);
          db.batch(() => {
            for (let i = -7; i < 7; i++) {
              const t = new Date(y, m - 1, d + i, 12);
              db.insert('notes', { title: `QA day ${i}`, day: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`, blocks: [] });
            }
          });
        }, start);
        await page.setViewport(width, 800, false);
        try {
          await go(`#/week/${start}`);
          if (await page.evaluate(() => document.querySelector('#panel').hidden)) await page.click('#topbar [data-toggle-panel]');
          await page.waitFor('#panel:not([hidden])', 3000);
          await settle(page, 400);
          const r = await page.evaluate(() => {
            const heads = [...document.querySelectorAll('.grid-head .day-head')];
            const inside = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
            const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
            return {
              heads: heads.length,
              cols: document.querySelectorAll('.grid-body .col').length,
              spill: heads.filter((h) => !inside(h.querySelector('.dnum').getBoundingClientRect(), h.getBoundingClientRect())).map((h) => h.querySelector('[data-goto-day]').dataset.gotoDay),
              onDow: heads.filter((h) => {
                const n = h.querySelector('.day-note');
                return n && n.getClientRects().length && hit(n.getBoundingClientRect(), h.querySelector('.dow').getBoundingClientRect());
              }).length,
              marks: heads.filter((h) => h.querySelector('.day-note')?.getClientRects().length).length,
              sidebarHidden: getComputedStyle(document.querySelector('#sidebar')).visibility === 'hidden' || document.querySelector('#sidebar').getBoundingClientRect().right <= 0,
              menu: document.querySelector('#topbar [data-nav-toggle]').getAttribute('aria-label'),
            };
          });
          assert.deepEqual([r.heads, r.cols], [7, 7]);
          assert.deepEqual(r.spill, [], 'every date circle stays in its column');
          assert.equal(r.onDow, 0, 'no daily-note mark sits on a weekday label');
          if (width === 960) {
            assert.equal(r.marks, 7, 'at 960px the note marks still show');
            assert.equal(r.sidebarHidden, true, 'from 901 to 1280px the open panel takes the sidebar’s place');
            assert.equal(r.menu, 'Show sidebar');
            // Showing the sidebar closes the panel, as in Tasks.
            await page.click('#topbar [data-nav-toggle]');
            await settle(page, 400);
            const s = await page.evaluate(() => ({ panel: !document.querySelector('#panel').hidden, menu: document.querySelector('#topbar [data-nav-toggle]').getAttribute('aria-label') }));
            assert.deepEqual(s, { panel: false, menu: 'Hide sidebar' });
          } else {
            await page.click('#topbar [data-toggle-panel]');
            await settle(page, 300);
          }
          assert.deepEqual(page.consoleErrors(), []);
        } finally {
          await page.setViewport(1440, 900, false);
          await settle(page, 300);
        }
      });
    });
  }

  test('the mini month’s tab stop follows the date after j / k, not the 1st of the month', async () => {
    await go(`#/week/${today}`);
    // Move the mini month's focus into next month with Page Down, then step the range back a week with k:
    // the mini month shows the date's month again, where the day last moved to is not.
    await page.evaluate(() => document.querySelector('#minical .mc-day[tabindex="0"]').focus());
    await page.press('PageDown');
    await settle(page, 150);
    await blur();
    await page.press('k');
    await settle(page, 300);
    const r = await page.evaluate(() => ({ date: location.hash.split('/')[2], stop: document.querySelector('#minical .mc-day[tabindex="0"]')?.dataset.date, stops: document.querySelectorAll('#minical .mc-day[tabindex="0"]').length }));
    assert.equal(r.date, addDaysYmd(today, -7));
    assert.deepEqual([r.stops, r.stop], [1, r.date], `the one tab stop is on the date in focus (${r.date}), not the month's first day`);
  });

  test('Create: a typed date range ("Trip dec 20-28") is one all-day event over those days', async () => {
    await withScreenshot(page, 'qa-schedule-fix2-range', async () => {
      await go(`#/week/${today}`);
      await blur();
      await page.press('c');
      await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Title', 4000);
      const title = `Trip ${tag()}`;
      await page.type(`${title} dec 20-28`);
      await settle(page, 200);
      const when = await page.evaluate(() => document.querySelector('.qc-when')?.textContent.replace(/\s+/g, ' ').trim());
      assert.match(when, /^December 20 – December 28 · All day$/, `the card says so: ${when}`);
      await page.clickText('button', /^Save$/);
      const e = await ctx.server.waitForState((s) => s.data.events.find((x) => x.title.startsWith(title)), 10000, 'the event on the server');
      const y = nextDate(today, '12-28').slice(0, 4);
      assert.deepEqual({ title: e.title, allDay: e.allDay, start: e.start, end: e.end }, { title, allDay: true, start: `${y}-12-20`, end: `${y}-12-28` });
    });
  });
});
