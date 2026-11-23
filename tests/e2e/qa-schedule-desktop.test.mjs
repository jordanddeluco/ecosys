// QA wave 1, schedule fixes (desktop, 1440x900): short and overlapping events, keyboard and headings,
// the now label, the recurring-change dialog, task card icons, undo, quick create (highlighted words, keep
// in title, calendar-coloured preview, nested pickers), task length, Custom repeat, overnight events,
// the Schedule view's task rows, month grid keys, Year scrolling, the Tasks panel and collapsed sidebar,
// and text contrast. Then the verifier's follow-ups: block times fitted in fractions of a pixel and never
// left half below a block, mid-length times in 98px columns (tasks sized like events), and create ghosts
// drawn like the blocks they become.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, browserToday, withScreenshot, tag } from './helpers.mjs';
import { untilAfter } from '../../schedule/grid.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const dow = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getDay();
};

describe('qa schedule: desktop fixes', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let page;
  let today;
  let D; // a day two weeks ahead: never in today's week, so no now line

  const go = async (hash) => {
    await page.evaluate((h) => (location.hash = h), hash);
    await settle(page, 350);
  };
  const shortcut = async (key) => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.press(key);
  };
  /** Insert records through the page's own store (they sync to the server like any edit). */
  const insert = (collection, records) =>
    page.evaluate(
      async (c, recs) => {
        const { db } = await import('/shared/store.js');
        return recs.map((r) => db.insert(c, r).id);
      },
      collection,
      records,
    );
  const event = (title, date, start, end, extra = {}) => ({ title, calendarId: null, start: `${date}T${start}`, end: `${extra.endDate || date}T${end}`, allDay: false, location: '', notes: '', repeat: null, exdates: [], until: null, ...extra, endDate: undefined });
  const calendarId = (name) => page.evaluate(async (n) => (await import('/shared/store.js')).db.all('calendars').find((c) => c.name === n)?.id, name);
  const listId = (name) => page.evaluate(async (n) => (await import('/shared/store.js')).db.all('lists').find((l) => l.name === n)?.id, name);
  const record = (collection, id) => page.evaluate(async (c, i) => (await import('/shared/store.js')).db.get(c, i), collection, id);
  const blockOf = (id) => `.ev[data-ev^="${id}@"]`;
  const mouseDrag = async (from, to, steps = 12) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(80);
    for (let i = 1; i <= steps; i++) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, button: 'left', buttons: 1 });
      await sleep(16);
    }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const mouseClick = async (x, y) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  /**
   * Every block time on the grid that shows cut off: its visible text wider than its box (measured in fractions
   * of a pixel; scrollWidth and clientWidth round), or its line ending less than 1px above the block's bottom.
   * A short block's one-line time wraps out of sight (its line clips it) unless it fits, so only its width counts.
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
  /** Viewport point of a time on a day column (scrolled into view first). */
  const slotPoint = (date, minutes) =>
    page.evaluate(
      (d, mins) => {
        const body = document.querySelector('.grid-body');
        const hour = parseFloat(getComputedStyle(body).getPropertyValue('--hour'));
        document.querySelector('.grid-scroll').scrollTop = Math.max(0, (hour * mins) / 60 - 200);
        const col = document.querySelector(`.col[data-date="${d}"]`).getBoundingClientRect();
        const b = body.getBoundingClientRect();
        return { x: col.left + col.width / 2, y: b.top + (hour * mins) / 60 + 8, hour };
      },
      date,
      minutes,
    );

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('schedule/'));
    today = await browserToday(page);
    D = addDaysYmd(today, 14);
    await page.evaluate(async () => (await import('/shared/store.js')).settings.set({ timeFormat: '12h', theme: 'light' }));
    await settle(page, 200);
  });

  test('short events are drawn readable, back-to-back ones sit side by side, and keep their stored length', async () => {
    await withScreenshot(page, 'qa-schedule-short', async () => {
      const cal = await calendarId('Work');
      const [a, b] = await insert('events', [event(`QA short ${tag(4)}`, D, '09:30', '09:45', { calendarId: cal }), event(`QA short ${tag(4)}`, D, '09:45', '10:00', { calendarId: cal })]);
      await go(`#/week/${D}`);
      await page.waitFor(blockOf(b), 4000);
      const r = await page.evaluate(
        (ids) =>
          ids.map((id) => {
            const el = document.querySelector(`.ev[data-ev^="${id}@"]`);
            const box = el.getBoundingClientRect();
            const title = el.querySelector('.ev-title');
            return { h: box.height, left: box.left, right: box.right, top: el.dataset.top, bottom: el.dataset.bottom, fontSize: parseFloat(getComputedStyle(title).fontSize), clipped: title.getBoundingClientRect().bottom > box.bottom + 0.5 };
          }),
        [a, b],
      );
      assert.ok(r[0].h >= 13, `a 15-minute event is at least 13px tall (was a 10px sliver): ${r[0].h}`);
      assert.ok(r[0].fontSize >= 11, `its text is at least 11px: ${r[0].fontSize}`);
      assert.equal(r[0].clipped, false, 'its title is not cut off at the bottom');
      assert.deepEqual([r[0].top, r[0].bottom], ['570', '585'], 'the block still carries its stored 9:30 – 9:45 for dragging');
      assert.ok(r[0].right <= r[1].left + 1 || r[1].right <= r[0].left + 1, `back-to-back 15-minute events sit side by side: ${JSON.stringify(r)}`);
    });
  });

  test('events starting within 30 minutes sit side by side; a later starter still cascades', async () => {
    await withScreenshot(page, 'qa-schedule-overlap', async () => {
      const d = addDaysYmd(D, 1);
      const [early, close, base, late] = await insert('events', [event(`QA ov ${tag(4)}`, d, '10:00', '11:30'), event(`QA ov ${tag(4)}`, d, '10:15', '11:00'), event(`QA cas ${tag(4)}`, d, '13:00', '15:00'), event(`QA cas ${tag(4)}`, d, '14:00', '15:00')]);
      await go(`#/week/${d}`);
      await page.waitFor(blockOf(late), 4000);
      const box = (id) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), blockOf(id));
      const [e, c, b, l] = [await box(early), await box(close), await box(base), await box(late)];
      assert.ok(e.right <= c.left + 1, `the 10:00 event is not drawn under the 10:15 one (title hidden): ${e.right} vs ${c.left}`);
      assert.ok(b.right > l.left + 10, 'a 13:00 event still stretches under one starting an hour later (Google)');
    });
  });

  test('arrow keys stay with a focused event; with nothing focused they change the week; j keeps focus in the view', async () => {
    await withScreenshot(page, 'qa-schedule-arrows', async () => {
      const [id] = await insert('events', [event(`QA arrows ${tag(4)}`, D, '15:00', '16:00')]);
      await go(`#/week/${D}`);
      await page.waitFor(blockOf(id), 4000);
      await page.evaluate((s) => document.querySelector(s).focus(), blockOf(id));
      await page.press('ArrowRight');
      await settle(page, 200);
      let st = await page.evaluate(() => ({ hash: location.hash, ev: document.activeElement?.dataset?.ev || null }));
      assert.equal(st.hash, `#/week/${D}`, 'ArrowRight on a focused event does not change the week');
      assert.ok(st.ev?.startsWith(`${id}@`), 'and the event keeps focus');
      await shortcut('ArrowRight');
      await settle(page, 200);
      st = await page.evaluate(() => location.hash);
      assert.equal(st, `#/week/${addDaysYmd(D, 7)}`, 'with nothing focused ArrowRight goes to the next week');
      await go(`#/week/${D}`);
      await page.waitFor(blockOf(id), 4000);
      await page.evaluate((s) => document.querySelector(s).focus(), blockOf(id));
      await page.press('j');
      await settle(page, 200);
      st = await page.evaluate(() => ({ hash: location.hash, inView: !!document.activeElement?.closest('#view'), day: document.activeElement?.dataset?.gotoDay || null }));
      assert.equal(st.hash, `#/week/${addDaysYmd(D, 7)}`);
      assert.ok(st.inView && st.day, `j from an event keeps focus in the view, on a day: ${JSON.stringify(st)}`);
    });
  });

  test('headings: an h1 names the range, the view is a labelled region, months are h2 in Year and Schedule', async () => {
    await go(`#/week/${D}`);
    const h = await page.evaluate(() => ({ h1: document.querySelectorAll('h1').length, title: !!document.querySelector('h1 #range-title'), role: document.querySelector('#view').getAttribute('role'), label: document.querySelector('#view').getAttribute('aria-label') }));
    assert.deepEqual([h.h1, h.title, h.role], [1, true, 'region']);
    assert.match(h.label, /^Week, /);
    await go(`#/year/${D}`);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.ym h2').length), 12);
    await go(`#/agenda/${D}`);
    const first = await page.evaluate(() => document.querySelector('.agenda h2')?.textContent);
    const want = await page.evaluate((d) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), D);
    assert.equal(first, want, 'the Schedule view has a heading for its first month too');
  });

  test('the now label uses the hour labels’ format and the faint now rule sits under events', async () => {
    await go(`#/week/${today}`);
    const r = await page.evaluate(() => ({ now: document.querySelector('.now-label')?.textContent, hour: document.querySelector('.gutter .hr[data-h="7"]')?.textContent, rule: getComputedStyle(document.querySelector('.now-rule')).zIndex }));
    assert.match(r.now, /^\d{1,2}:\d{2} (AM|PM)$/, `'7:24 PM' beside '7 PM': ${r.now}`);
    assert.equal(r.hour, '7 AM');
    assert.equal(r.rule, '1', 'events (z-index 2 and up) sit above the faint now rule');
    await page.evaluate(async () => (await import('/shared/store.js')).settings.set({ timeFormat: '24h' }));
    await settle(page, 300);
    assert.match(await page.evaluate(() => document.querySelector('.now-label').textContent), /^\d{2}:\d{2}$/);
    await page.evaluate(async () => (await import('/shared/store.js')).settings.set({ timeFormat: '12h' }));
    await settle(page, 300);
  });

  test("a week without today opens with the day's first hour label whole", async () => {
    await go(`#/week/${addDaysYmd(D, 7)}`);
    const r = await page.evaluate(() => {
      const sc = document.querySelector('.grid-scroll');
      const hour = parseFloat(getComputedStyle(document.querySelector('.grid-body')).getPropertyValue('--hour'));
      const label = document.querySelector('.gutter .hr[data-h="8"]').getBoundingClientRect();
      return { top: sc.scrollTop, want: 7.75 * hour, labelTop: label.top, scTop: sc.getBoundingClientRect().top };
    });
    assert.ok(Math.abs(r.top - r.want) <= 2, `scrolled a quarter hour above 8 AM: ${r.top} vs ${r.want}`);
    assert.ok(r.labelTop >= r.scTop, 'the 8 AM label is not cut by the all-day row');
  });

  test("the recurring-change dialog makes 'This event' the primary, focused choice", async () => {
    await withScreenshot(page, 'qa-schedule-scope', async () => {
      const d = addDaysYmd(D, 2);
      const [id] = await insert('events', [event(`QA weekly ${tag(4)}`, d, '11:00', '12:00', { repeat: { freq: 'week', interval: 1, days: [dow(d)] } })]);
      await go(`#/week/${d}`);
      await page.waitFor(`.ev[data-ev="${id}@${d}"]`, 4000);
      const r = await page.evaluate((s) => {
        const el = document.querySelector(s);
        el.scrollIntoView({ block: 'center' });
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + 12, hour: parseFloat(getComputedStyle(document.querySelector('.grid-body')).getPropertyValue('--hour')) };
      }, `.ev[data-ev="${id}@${d}"]`);
      await mouseDrag({ x: r.x, y: r.y }, { x: r.x, y: r.y + r.hour });
      await page.waitFor('.modal.choice', 4000);
      const dlg = await page.evaluate(() => ({ primary: [...document.querySelectorAll('.modal.choice .btn-primary')].map((b) => b.textContent), focused: document.activeElement?.textContent }));
      assert.deepEqual(dlg.primary, ['This event'], 'only "This event" is styled as the primary choice');
      assert.equal(dlg.focused, 'This event', 'and it has focus');
      await page.press('Escape');
      await settle(page, 300);
      const ev = await record('events', id);
      assert.equal(ev.start, `${d}T11:00`, 'cancelling the dialog changes nothing');
    });
  });

  test('a task card removes from the calendar with the no-date glyph, and deadlines show the deadline glyph (card and panel)', async () => {
    await withScreenshot(page, 'qa-schedule-task-icons', async () => {
      const deadline = addDaysYmd(D, 3);
      const [timed, undated] = await insert('tasks', [
        { title: `QA dl card ${tag(4)}`, date: D, time: '15:00', duration: 60, deadline, done: false, tags: [], checklist: [], listId: null, priority: 0, notes: '', repeat: null, order: 1 },
        { title: `QA dl panel ${tag(4)}`, date: null, time: null, duration: null, deadline, done: false, tags: [], checklist: [], listId: null, priority: 3, notes: '', repeat: null, order: -1 },
      ]);
      await go(`#/week/${D}`);
      await page.waitFor(`.ev[data-task="${timed}"]`, 4000);
      await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), `.ev[data-task="${timed}"]`);
      await page.click(`.ev[data-task="${timed}"] .tb-text`);
      await page.waitFor('.menu.task-pop', 4000);
      const card = await page.evaluate(() => ({ undate: document.querySelector('.task-pop [data-pop="undate"] svg')?.innerHTML || '', deadline: [...document.querySelectorAll('.task-pop .ep-rows .r')].find((r) => /Deadline/.test(r.textContent))?.querySelector('svg')?.innerHTML || '' }));
      assert.match(card.undate, /M4 4\.2 20\.5 20\.7/, '"Remove from calendar" uses the struck-through calendar (no-date), not the trash');
      assert.match(card.deadline, /M5\.4 12H20M20 6\.6v10\.8/, 'the deadline row uses the deadline glyph (the now dot running into a stop)');
      assert.doesNotMatch(card.deadline, /M5\.5 21\.2V3\.6/, 'not the priority flag');
      await page.press('Escape');
      await settle(page, 200);
      await shortcut('i');
      await page.waitFor(`[data-ptask="${undated}"]`, 4000);
      const meta = await page.evaluate((id) => document.querySelector(`[data-ptask="${id}"] .tt-meta`)?.innerHTML || '', undated);
      assert.match(meta, /M5\.4 12H20M20 6\.6v10\.8/, 'the panel shows the deadline with the deadline glyph');
      assert.doesNotMatch(meta, /M5\.5 21\.2V3\.6/);
      await shortcut('i');
      await settle(page, 200);
    });
  });

  test('undoing "Remove from calendar" keeps an edit made to the task since', async () => {
    await withScreenshot(page, 'qa-schedule-undo', async () => {
      const title = `QA undo rm ${tag(4)}`;
      const [id] = await insert('tasks', [{ title, date: D, time: null, duration: null, deadline: null, done: false, tags: [], checklist: [], listId: null, priority: 0, notes: '', repeat: null, order: 1 }]);
      await go(`#/week/${D}`);
      await page.waitFor(`.ad-item[data-task="${id}"]`, 4000);
      await page.click(`.ad-item[data-task="${id}"] .t`);
      await page.waitFor('.task-pop [data-pop="undate"]', 4000);
      await page.click('.task-pop [data-pop="undate"]');
      await page.waitFor(async (i) => (await import('/shared/store.js')).db.get('tasks', i)?.date === null, { timeout: 4000, args: [id], message: 'the task to leave the calendar' });
      // Another tab (or app) renames it afterwards.
      await page.evaluate(async (i, t) => (await import('/shared/store.js')).db.update('tasks', i, { title: t }), id, `${title} renamed`);
      await shortcut('Control+z');
      await settle(page, 300);
      const t = await record('tasks', id);
      assert.equal(t.date, D, 'undo puts it back on its day');
      assert.equal(t.title, `${title} renamed`, 'and keeps the rename made since');
    });
  });

  test('quick create: read words are highlighted, × keeps them in the title, the preview takes the calendar colour, nested pickers keep the card open', async () => {
    await withScreenshot(page, 'qa-schedule-quick-create', async () => {
      const d = addDaysYmd(D, 4);
      await go(`#/week/${d}`);
      const p = await slotPoint(d, 10 * 60);
      await mouseClick(p.x, p.y);
      await page.waitFor('.menu.qc-pop', 4000);
      await page.type(`QA qc ${tag(4)} 1pm at Room four #Work`);
      await settle(page, 200);
      const r = await page.evaluate(() => ({
        marks: [...document.querySelectorAll('.qc-pop .qc-mirror mark')].map((m) => m.textContent),
        when: document.querySelector('.qc-pop [data-when-edit]')?.getAttribute('aria-label'),
        ev: document.querySelector('.ev.ghost:not([style*="visibility: hidden"])')?.style.getPropertyValue('--ev'),
        keeps: [...document.querySelectorAll('.qc-pop [data-keep]')].map((b) => b.dataset.keep),
      }));
      assert.deepEqual(r.marks, ['1pm', 'at Room four', '#Work'], 'every word the parser read is highlighted');
      assert.match(r.when, /^Date and time: .+, 1 – 2pm\. Change$/, `the button's name includes the time: ${r.when}`);
      assert.equal(r.ev, 'var(--c-blue)', 'the preview is drawn in the Work calendar’s colour, not the accent');
      assert.deepEqual(r.keeps.sort(), ['location', 'when']);
      await page.click('.qc-pop [data-keep="location"]');
      await settle(page, 150);
      const after = await page.evaluate(() => ({ value: document.querySelector('.qc-pop .qc-title').value, where: document.querySelector('.qc-pop [data-where]').hidden }));
      assert.match(after.value, /"at Room four"/, 'the place words are quoted, so they stay in the title');
      assert.equal(after.where, true, 'and the place line goes away');
      // The date field inside the card opens a picker; using it keeps the card open (the shell nests popovers).
      await page.click('.qc-pop [data-when-edit]');
      await page.waitFor('.qc-pop [name="qcDate"]', 3000);
      await page.click('.qc-pop [name="qcDate"]');
      await page.waitFor('.dp-pop', 3000);
      await page.click('.dp-pop [data-mc="next"]');
      await settle(page, 150);
      const pick = await page.evaluate(() => document.querySelector('.dp-pop .mc-day:not(.out)[data-date$="-15"]')?.dataset.date);
      await page.click(`.dp-pop [data-date="${pick}"]`);
      await settle(page, 200);
      const st = await page.evaluate(() => ({ open: !!document.querySelector('.menu.qc-pop'), date: document.querySelector('.qc-pop [name="qcDate"]')?.value }));
      assert.deepEqual(st, { open: true, date: pick }, 'the card stayed open and took the picked day');
      await page.press('Escape');
      await settle(page, 200);
      assert.equal(await page.evaluate(() => !!document.querySelector('.menu.qc-pop, .ev.ghost')), false);
    });
  });

  test('Create > Task with a typed time and no slot saves no length of its own (the default task block)', async () => {
    const title = `QA tasklen ${tag(4)}`;
    await go(`#/week/${D}`);
    await shortcut('c');
    await page.waitFor('.modal.qc-modal', 4000);
    await page.clickText('button', /^Task$/);
    await page.click('.qc-modal .qc-title');
    await page.type(`${title} tomorrow 3pm`);
    await settle(page, 150);
    const shown = await page.evaluate(() => document.querySelector('.qc-modal [data-when-edit] .sub')?.textContent);
    assert.equal(shown, '· 3 – 3:30pm', 'the card shows the default task block');
    await page.press('Enter');
    const t = await ctx.server.waitForState((s) => s.data.tasks.find((x) => x.title === title), 10000, 'the task on the server');
    assert.deepEqual([t.time, t.duration], ['15:00', null]);
  });

  test('Custom repeat (the shared picker) and Ends: every 2 weeks on Mon and Wed, ending after 4 times', async () => {
    await withScreenshot(page, 'qa-schedule-custom-repeat', async () => {
      const title = `QA custom ${tag(4)}`;
      await go(`#/week/${D}`);
      await shortcut('c');
      await page.waitFor('.qc-title', 4000);
      await page.type(title);
      await page.clickText('button', 'More options');
      await page.waitFor('.modal.editor [name="repeat"]', 4000);
      assert.equal(await page.evaluate(() => document.querySelector('.editor [data-until-row]').hidden), true, 'no Ends row while the event does not repeat');
      await page.click('.modal.editor [name="repeat"]');
      await page.clickText('menuitemradio', /^Custom/);
      await page.waitFor('.rp-pop [name="interval"]', 4000);
      await page.click('.rp-pop [name="interval"]');
      await page.press('Control+a');
      await page.type('2');
      await page.click('.rp-pop [data-rp-unit="week"]');
      for (const d of [1, 3]) if ((await page.evaluate((x) => document.querySelector(`.rp-pop [data-rp-day="${x}"]`).getAttribute('aria-pressed'), d)) !== 'true') await page.click(`.rp-pop [data-rp-day="${d}"]`);
      for (const d of [0, 2, 4, 5, 6]) if ((await page.evaluate((x) => document.querySelector(`.rp-pop [data-rp-day="${x}"]`).getAttribute('aria-pressed'), d)) === 'true') await page.click(`.rp-pop [data-rp-day="${d}"]`);
      assert.equal(await page.evaluate(() => document.querySelector('.rp-pop [data-rp-sum]').textContent), 'Every 2 weeks on Mon, Wed');
      await page.clickText('button', /^Done$/);
      await page.waitFor(() => !document.querySelector('.rp-pop'), { timeout: 3000 });
      assert.equal(await page.evaluate(() => document.querySelector('.editor [name="repeat"]').textContent.trim()), 'Every 2 weeks on Mon, Wed');
      // Ends: After 4 times (kept as the date of the 4th time).
      await page.click('.modal.editor [name="ends"]');
      await page.clickText('menuitemradio', /^After$/);
      await page.click('.modal.editor [name="count"]');
      await page.press('Control+a');
      await page.type('4');
      const start = await page.evaluate(() => document.querySelector('.editor [name="startDate"]').value);
      await page.clickText('button', /^Save$/);
      const ev = await ctx.server.waitForState((s) => s.data.events.find((x) => x.title === title), 10000, 'the event on the server');
      const rule = { freq: 'week', interval: 2, days: [1, 3] };
      assert.deepEqual(ev.repeat, rule);
      assert.equal(ev.start.slice(0, 10), start);
      assert.equal(ev.until, untilAfter(rule, start, 4), 'the series ends on its 4th time');
    });
  });

  test('Ends On a date: a series is never cut before its first day', async () => {
    const title = `QA ends ${tag(4)}`;
    const d = addDaysYmd(D, 3);
    const [id] = await insert('events', [event(title, d, '08:00', '08:30', { repeat: { freq: 'day', interval: 1 } })]);
    await go(`#/week/${d}`);
    await page.waitFor(`.ev[data-ev="${id}@${d}"]`, 4000);
    await page.evaluate((s) => document.querySelector(s).focus(), `.ev[data-ev="${id}@${d}"]`);
    await page.press('e');
    await page.waitFor('.modal.editor [name="ends"]', 4000);
    assert.equal(await page.evaluate(() => document.querySelector('.editor [name="ends"]').value), 'never');
    await page.click('.modal.editor [name="ends"]');
    await page.clickText('menuitemradio', /^On$/);
    assert.equal(await page.evaluate(() => !!document.querySelector('.editor [data-ends-part="on"]:not([hidden]) [name="until"]')), true, 'the date shows for On');
    // Pick a day before the series starts: it ends on its first day instead of vanishing.
    await page.evaluate((x) => {
      const f = document.querySelector('.editor [name="until"]');
      f.value = x;
      f.dispatchEvent(new Event('change', { bubbles: true }));
    }, addDaysYmd(d, -3));
    await page.clickText('button', /^Save$/);
    await page.waitFor('.modal.choice', 4000);
    await page.clickText('button', /^All events$/);
    await ctx.server.waitForState((s) => s.data.events.find((x) => x.id === id)?.until === d, 10000, 'until clamped to the first day');
  });

  test('an overnight event says when it ends on its second day (Month and Schedule)', async () => {
    const d = addDaysYmd(D, 5);
    const next = addDaysYmd(d, 1);
    const [id] = await insert('events', [event(`QA red-eye ${tag(4)}`, d, '23:00', '06:30', { endDate: next })]);
    await go(`#/month/${d}`);
    await page.waitFor(`.mcell[data-mdate="${next}"] [data-ev^="${id}@"]`, 4000);
    const m = await page.evaluate((i, a, b) => ({ first: document.querySelector(`.mcell[data-mdate="${a}"] [data-ev^="${i}@"] .t`)?.textContent, second: document.querySelector(`.mcell[data-mdate="${b}"] [data-ev^="${i}@"] .t`)?.textContent }), id, d, next);
    assert.deepEqual(m, { first: '11pm', second: 'until 6:30am' });
    await go(`#/agenda/${d}`);
    const ag = await page.evaluate((i, b) => document.querySelector(`.ag-day:has([data-goto-day="${b}"]) [data-ev^="${i}@"] .when`)?.textContent, id, next);
    assert.equal(ag, 'Until 6:30am');
  });

  test('Schedule view: an untimed task says "Any time" and its list is a coloured dot, not a place', async () => {
    const d = addDaysYmd(D, 6);
    const list = await listId('Errands');
    const [id] = await insert('tasks', [{ title: `QA anytime ${tag(4)}`, date: d, time: null, duration: null, deadline: null, done: false, tags: [], checklist: [], listId: list, priority: 0, notes: '', repeat: null, order: 1 }]);
    await go(`#/agenda/${d}`);
    await page.waitFor(`.ag-item[data-task="${id}"]`, 4000);
    const r = await page.evaluate((i) => {
      const row = document.querySelector(`.ag-item[data-task="${i}"]`);
      return { when: row.querySelector('.when').textContent, dot: !!row.querySelector('.where.list .swatch-dot'), list: row.querySelector('.where.list')?.textContent };
    }, id);
    assert.deepEqual(r, { when: 'Any time', dot: true, list: 'Errands' });
  });

  test('Month view: a grid with one tab stop for its days, moved with the arrow keys and Page Down', async () => {
    await withScreenshot(page, 'qa-schedule-month-keys', async () => {
      await go(`#/month/${D}`);
      const sem = await page.evaluate(() => ({ grid: !!document.querySelector('.month[role="grid"]'), heads: document.querySelectorAll('.month [role="columnheader"]').length, cells: document.querySelectorAll('.month [role="gridcell"]').length, rows: document.querySelectorAll('.month [role="row"]').length, stops: document.querySelectorAll('.mnum[tabindex="0"]').length }));
      assert.deepEqual([sem.grid, sem.heads, sem.stops], [true, 7, 1]);
      assert.equal(sem.rows, sem.cells / 7 + 1, 'a row per week plus the weekday header');
      const start = await page.evaluate(() => {
        const n = document.querySelector('.mnum[tabindex="0"]');
        n.focus();
        const cell = n.closest('.mcell');
        const outside = [...document.querySelectorAll('.month-grid button, .month-grid [tabindex], .month-grid a[href]')].filter((el) => el.tabIndex >= 0 && !cell.contains(el));
        return { day: n.dataset.gotoDay, outside: outside.length };
      });
      assert.equal(start.outside, 0, 'only the focused day is in the Tab order');
      await page.press('ArrowRight');
      await settle(page, 100);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.gotoDay), addDaysYmd(start.day, 1));
      await page.press('ArrowDown');
      await settle(page, 100);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.gotoDay), addDaysYmd(start.day, 8));
      const before = await page.evaluate(() => location.hash);
      await page.press('PageDown');
      await settle(page, 300);
      const st = await page.evaluate(() => ({ day: document.activeElement.dataset.gotoDay, hash: location.hash, stops: document.querySelectorAll('.mnum[tabindex="0"]').length }));
      assert.notEqual(st.hash, before, 'Page Down shows the next month');
      assert.equal(st.day.slice(5, 7), addDaysYmd(`${addDaysYmd(start.day, 8).slice(0, 7)}-01`, 31).slice(5, 7), 'with focus on the same day of that month');
      assert.equal(st.stops, 1);
    });
  });

  test('1024px: Year opens on this month, the Tasks panel opens below the top bar, a collapsed sidebar keeps Create', async () => {
    await withScreenshot(page, 'qa-schedule-1024', async () => {
      await page.setViewport(1024, 768, false);
      try {
        await go(`#/year/${today}`);
        const y = await page.evaluate(() => {
          const sc = document.querySelector('.year').getBoundingClientRect();
          const m = document.querySelector('.ym.current').getBoundingClientRect();
          return { inView: m.top >= sc.top - 1 && m.bottom <= sc.bottom + 1, cols: getComputedStyle(document.querySelector('.year-grid')).gridTemplateColumns.split(' ').length };
        });
        assert.equal(y.inView, true, 'the current month is in view');
        assert.equal(y.cols, 3, 'three months a row at 1024px');
        await go(`#/week/${D}`);
        await page.click('#topbar [data-toggle-panel]');
        await page.waitFor('#panel:not([hidden])', 3000);
        await settle(page, 300);
        const p = await page.evaluate(() => {
          const top = document.querySelector('#panel').getBoundingClientRect().top;
          const bar = document.querySelector('#topbar').getBoundingClientRect().bottom;
          const s = document.querySelector('#topbar .top-search').getBoundingClientRect();
          return { top, bar, searchFree: document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2)?.closest('.top-search') !== null };
        });
        assert.ok(Math.abs(p.top - p.bar) <= 1, `the panel starts below the top bar: ${p.top} vs ${p.bar}`);
        assert.equal(p.searchFree, true, 'Search is not covered');
        await page.click('#topbar [data-toggle-panel]');
        await settle(page, 200);
        await page.click('#topbar [data-nav-toggle]');
        await settle(page, 300);
        assert.equal(await page.evaluate(() => !!document.querySelector('#topbar .top-create')?.offsetParent), true, 'Create is in the top bar while the sidebar is hidden');
        await page.click('#topbar [data-nav-toggle]');
        await settle(page, 300);
      } finally {
        await page.setViewport(1440, 900, false);
        await settle(page, 300);
      }
    });
  });

  test('event text meets WCAG AA: Light times on pale tints, past events, hour labels', async () => {
    const yesterday = addDaysYmd(today, -1);
    const cal = (await insert('calendars', [{ name: `QA yellow ${tag(4)}`, color: 'yellow', visible: true, order: 50 }]))[0];
    const [past, future] = await insert('events', [event(`QA past ${tag(4)}`, yesterday, '10:00', '11:00', { calendarId: cal }), event(`QA future ${tag(4)}`, D, '10:00', '11:00', { calendarId: cal })]);
    const measure = (id) =>
      page.evaluate((s) => {
        const parse = (c) => {
          let m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
          if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]];
          m = c.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)/);
          return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
        };
        const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        const L = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
        const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
        const cr = (a, b) => (Math.max(L(a), L(b)) + 0.05) / (Math.min(L(a), L(b)) + 0.05);
        const pageBg = parse(getComputedStyle(document.body).backgroundColor);
        const el = document.querySelector(s);
        const bg = over(parse(getComputedStyle(el).backgroundColor), pageBg);
        const col = (x) => over(parse(getComputedStyle(x).color), bg);
        const op = +getComputedStyle(el).opacity;
        const hr = document.querySelector('.gutter .hr');
        return { title: cr(col(el.querySelector('.ev-title')), bg), time: cr(col(el.querySelector('.ev-time')), bg), opacity: op, hour: cr(over(parse(getComputedStyle(hr).color), pageBg), pageBg) };
      }, blockOf(id));
    await go(`#/week/${D}`);
    await page.waitFor(blockOf(future), 4000);
    const f = await measure(future);
    await go(`#/week/${yesterday}`);
    await page.waitFor(`${blockOf(past)}.past`, 4000);
    const p = await measure(past);
    for (const [what, v] of Object.entries({ 'yellow event title': f.title, 'yellow event time': f.time, 'past title': p.title, 'past time': p.time, 'hour label': f.hour })) assert.ok(v >= 4.5, `${what}: ${v.toFixed(2)}:1`);
    assert.equal(p.opacity, 1, 'past events are not faded with opacity');
  });

  test('a block’s time shows whole or not at all, measured in fractions of a pixel (a 3-day cluster, window widths, 1054px)', async () => {
    await withScreenshot(page, 'qa-schedule-fit-widths', async () => {
      const d = addDaysYmd(today, 30); // a week of its own
      const [work, personal, family] = [await calendarId('Work'), await calendarId('Personal'), await calendarId('Family')];
      await insert('events', [
        event('Roadmap review', d, '10:00', '11:30', { calendarId: work, location: 'Room 1' }),
        event('Hiring sync', d, '10:15', '11:00', { calendarId: personal }),
        event('Pick up parcel', d, '10:30', '11:00', { calendarId: family }),
        event('Coffee chat', d, '10:30', '11:30', { calendarId: work }),
      ]);
      const next = addDaysYmd(d, 7);
      await insert('tasks', [{ title: 'Prepare quarterly review slides', date: next, time: '14:00', duration: 90, deadline: null, done: false, tags: [], checklist: [], listId: await listId('Work'), priority: 0, notes: '', repeat: null, order: 1 }]);
      const days = await page.evaluate(async () => (await import('/shared/store.js')).settings.get().scheduleDays);
      await page.evaluate(async () => (await import('/shared/store.js')).settings.set({ scheduleDays: 3 }));
      try {
        await go(`#/days/${d}`);
        await page.waitFor(() => document.querySelectorAll('.ev[data-ev]').length >= 4, 4000);
        // '10 – 11:30am' was 70.44px in a 69.58px box: rounded to 70 and 70, it kept its ellipsis ('10 – 11:30a…').
        assert.deepEqual(await cutTimes(), [], 'a 3-day view at 1440px');
        for (let w = 1424; w <= 1456; w += 4) {
          await page.setViewport(w, 900, false);
          await settle(page, 300); // the resize render waits 120ms
          assert.deepEqual(await cutTimes(), [], `a 3-day view at ${w}px`);
        }
        // A 90-minute task in a week at 1054px: its '2 – 3:30pm' was 0.17px too wide ('2 – 3:30p…').
        await page.setViewport(1054, 900, false);
        await settle(page, 300);
        await go(`#/week/${next}`);
        assert.deepEqual(await cutTimes(), [], 'a week at 1054px');
      } finally {
        await page.evaluate(async (n) => (await import('/shared/store.js')).settings.set({ scheduleDays: n }), days ?? 4);
        await page.setViewport(1440, 900, false);
        await settle(page, 300);
      }
    });
  });

  test('98px day columns (1024px, sidebar open): a mid-length event keeps a time that fits; a two-line title drops it, for tasks too', async () => {
    await withScreenshot(page, 'qa-schedule-fit-1024', async () => {
      const d = addDaysYmd(today, 37); // a week of its own
      const [personal, work] = [await calendarId('Personal'), await calendarId('Work')];
      // At 8pm: the sample data's Gym repeats at 6pm on some weekdays (two side by side are narrower).
      const [gym, crit, lunch] = await insert('events', [
        event('Gym', d, '20:00', '21:15', { calendarId: personal }),
        event('Design crit', addDaysYmd(d, 1), '15:00', '16:00', { calendarId: work }),
        event('Lunch with Sam', d, '12:30', '13:30', { calendarId: personal, location: 'Cafe Luna' }),
      ]);
      const [tid] = await insert('tasks', [{ title: 'Write the long quarterly summary', date: addDaysYmd(d, 2), time: '15:00', duration: 60, deadline: null, done: false, tags: [], checklist: [], listId: await listId('Work'), priority: 0, notes: '', repeat: null, order: 1 }]);
      await page.setViewport(1024, 768, false);
      try {
        await go(`#/week/${d}`);
        await page.waitFor(blockOf(gym), 4000);
        const r = await page.evaluate(
          (ids) => {
            const info = (el) => {
              const title = el.querySelector('.ev-title');
              return { cls: el.className, time: getComputedStyle(el.querySelector('.ev-time')).display, lines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)) };
            };
            const ev = (id) => info(document.querySelector(`.ev[data-ev^="${id}@"]`));
            return { narrow: document.querySelector('#view').classList.contains('narrow-cols'), col: document.querySelector('.grid-body .col').getBoundingClientRect().width, gym: ev(ids[0]), crit: ev(ids[1]), lunch: ev(ids[2]), task: info(document.querySelector(`.ev[data-task="${ids[3]}"]`)) };
          },
          [gym, crit, lunch, tid],
        );
        assert.equal(r.narrow, true, `day columns under 120px: ${r.col}`);
        assert.deepEqual([r.gym.time !== 'none', r.gym.lines], [true, 1], `'Gym 8 – 9:15pm' fits, so its time shows (hidden before): ${JSON.stringify(r.gym)}`);
        assert.deepEqual([r.crit.time !== 'none', r.crit.lines], [true, 1], `'Design crit 3 – 4pm' too: ${JSON.stringify(r.crit)}`);
        assert.deepEqual([r.lunch.time, r.lunch.lines], ['none', 2], 'a title that does not fit on one line takes two, without the time');
        assert.deepEqual([r.task.time, r.task.lines], ['none', 2], 'a task of the same length does the same (its time was cut at the bottom)');
        assert.match(r.task.cls, /\bmid\b/, 'tasks are sized like events');
        assert.deepEqual(await cutTimes(), []);
      } finally {
        await page.setViewport(1440, 900, false);
        await settle(page, 300);
      }
    });
  });

  test('create ghosts are drawn like the blocks they become: 15 minutes is one readable line; no time sits half below one', async () => {
    await withScreenshot(page, 'qa-schedule-fit-ghost', async () => {
      const d = addDaysYmd(today, 44);
      await go(`#/week/${d}`);
      const g = await page.evaluate((x) => {
        const body = document.querySelector('.grid-body');
        const hour = parseFloat(getComputedStyle(body).getPropertyValue('--hour'));
        document.querySelector('.grid-scroll').scrollTop = hour * 11;
        const col = document.querySelector(`.col[data-date="${x}"]`).getBoundingClientRect();
        return { x: col.left + col.width / 2, top: body.getBoundingClientRect().top, hour };
      }, d);
      const y = (mins) => g.top + (g.hour * mins) / 60;
      const ghost = () =>
        page.evaluate(() => {
          const el = [...document.querySelectorAll('.ev.ghost')].at(-1);
          const b = el.getBoundingClientRect();
          const title = el.querySelector('.ev-title').getBoundingClientRect();
          return { h: b.height, cls: el.className, time: getComputedStyle(el.querySelector('.ev-time')).display, titleCut: title.bottom > b.bottom + 0.5 };
        });
      const move = async (yy) => {
        for (let i = 0; i < 3; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x, y: yy + i * 0.5, button: 'left', buttons: 1 });
        await sleep(60);
      };
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x, y: y(14 * 60) + 2 });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: y(14 * 60) + 2, button: 'left', buttons: 1, clickCount: 1 });
      await move(y(14 * 60 + 15) - 2);
      const quarter = await ghost();
      assert.ok(quarter.h >= 13, `a 15-minute ghost is drawn at least 20 minutes tall, like the event it makes: ${quarter.h}px`);
      assert.match(quarter.cls, /\bshort\b.*\btiny\b/, 'one line, in the small type');
      assert.equal(quarter.titleCut, false, 'its title is not cut in half');
      assert.deepEqual(await cutTimes(), []);
      await move(y(15 * 60) - 2);
      const hour = await ghost();
      assert.match(hour.cls, /\bmid\b/);
      assert.notEqual(hour.time, 'none', 'an hour has room for the time under the title');
      assert.deepEqual(await cutTimes(), []);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: y(15 * 60) - 1, button: 'left', buttons: 0, clickCount: 1 });
      await page.waitFor('.menu.qc-pop', 4000);
      await page.type('Quarterly budget review with the finance team');
      await settle(page, 200);
      const typed = await ghost();
      assert.notEqual(typed.time, 'none', 'a long title keeps to one line above the time, as the saved event will');
      assert.deepEqual(await cutTimes(), []);
      await page.press('Escape');
      await settle(page, 200);
      assert.equal(await page.evaluate(() => !!document.querySelector('.menu.qc-pop, .ev.ghost')), false);
    });
  });
});
