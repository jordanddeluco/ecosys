// QA regression (tasks): long views and redraws, at 1440x900.
//   Upcoming   draws its two weeks and only the first of the later months' tasks (it drew every future
//              task: 2,400 rows, a second per switch); a month's header still counts all its tasks; "Show
//              later" draws 200 more, and the last page moves focus on to the first row it brought in
//   reveal     a later task opened by a #/task link is drawn, selected and open in the details
//   add        a task added from Upcoming past the drawn ones says where it went ("Added for …", View)
//   redraw     a change redraws only what changed: other rows, the section and the sidebar items are the
//              same elements; the changed row is updated in place; a change from the server draws too
//   rows       skip layout and paint out of view (content-visibility) with a clip margin, so the circle's
//              focus ring is not cut off
//   composer   a key that changes no chip leaves the chips as they are
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot, tag, browserToday } from './helpers.mjs';

const go = async (page, hash) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await settle(page, 300);
};
const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
/** Rows drawn after Upcoming's two weeks (the month sections), and what else is there. */
const laterState = (page) =>
  page.evaluate(() => {
    const months = [...document.querySelectorAll('#view-body > section.section:not(.day):not([aria-label])')];
    return {
      rows: months.reduce((s, m) => s + m.querySelectorAll('.task[data-id]').length, 0),
      perMonth: months.map((m) => ({ shown: m.querySelectorAll('.task[data-id]').length, count: +m.querySelector('.section-head .count').textContent })),
      more: !!document.querySelector('[data-more-later]'),
    };
  });

describe('qa tasks: long views and redraws', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let page;
  let today;
  const k = tag();
  const N = 420;
  let later = []; // ids of the later tasks, in the order Upcoming lists them

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('tasks/'));
    today = await browserToday(page);
    // 420 tasks after the two weeks, two a day, plus 30 for today.
    later = await page.evaluate(
      async (k, N) => {
        const { db } = await import('/shared/store.js');
        const { createTask } = await import('/shared/model.js');
        const { todayYmd, addDaysYmd } = await import('/shared/dates.js');
        const t0 = todayYmd();
        return db.batch(() => {
          for (let i = 0; i < 30; i++) createTask({ title: `Today ${k} ${String.fromCharCode(97 + (i % 26))}${i}`, date: t0, order: i });
          return Array.from({ length: N }, (_, i) => createTask({ title: `Later ${k} ${i}`, date: addDaysYmd(t0, 20 + (i >> 1)), order: i }).id);
        });
      },
      k,
      N,
    );
    await page.waitFor(() => window.ecosysSync?.online && !window.ecosysSync.pending, { timeout: 20000, message: 'the tasks synced' });
  });

  test('Upcoming draws the first later tasks; Show later draws more; month headers count them all', async () => {
    await withScreenshot(page, 'qa-tasks-redraw-upcoming', async () => {
      await go(page, '#/today');
      await go(page, '#/upcoming');
      let s = await laterState(page);
      assert.ok(s.rows > 0 && s.rows <= 50, `at most 50 later rows drawn at first (${s.rows})`);
      assert.ok(s.more, 'a "Show later" button');
      const total = await page.evaluate(async (end) => (await import('/shared/store.js')).db.all('tasks').filter((t) => !t.done && t.date > end).length, addDays(today, 13));
      // Each month's header counts all its tasks, also the month cut short.
      const counts = await page.evaluate(async (end) => {
        const { db } = await import('/shared/store.js');
        return [...document.querySelectorAll('#view-body > section.section:not(.day):not([aria-label])')].map((m) => {
          const month = db.get('tasks', m.querySelector('.task[data-id]').dataset.id).date.slice(0, 7);
          return { shown: +m.querySelector('.section-head .count').textContent, all: db.all('tasks').filter((t) => !t.done && t.date > end && t.date.startsWith(month)).length };
        });
      }, addDays(today, 13));
      assert.ok(counts.every((c) => c.shown === c.all), `month counts ${JSON.stringify(counts)}`);
      assert.ok(s.perMonth.some((m) => m.count > m.shown), 'a month is cut short');
      const allRows = await page.evaluate(() => document.querySelectorAll('.task[data-id]').length);
      assert.ok(allRows < 200, `the whole view draws a few rows, not every future task (${allRows} of ${total + 30})`);

      await page.click('[data-more-later]');
      await settle(page, 200);
      s = await laterState(page);
      assert.ok(s.rows > 50 && s.rows <= 250, `200 more (${s.rows})`);
      assert.ok(s.more);

      // The last pages from the keyboard: once everything is drawn the button goes, and focus goes on to the
      // first row it brought in.
      for (let i = 0; i < 5 && (await laterState(page)).more; i++) {
        await page.evaluate(() => document.querySelector('[data-more-later]').focus());
        await page.press('Enter');
        await settle(page, 150);
      }
      s = await laterState(page);
      assert.equal(s.more, false, 'nothing left to show');
      assert.equal(s.rows, total, 'every later task drawn');
      const f = await page.evaluate(() => document.activeElement?.closest('.task[data-id]')?.dataset.id || document.activeElement?.tagName);
      assert.ok(later.includes(f), `focus moved on to a row the last page drew (${f})`);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('a later task opened from a link is drawn, selected and open in the details', async () => {
    await withScreenshot(page, 'qa-tasks-redraw-reveal', async () => {
      await go(page, '#/today');
      const id = later.at(-1);
      await page.evaluate((id) => (location.hash = `#/task/${id}`), id);
      await page.waitFor((id) => document.querySelector(`.task.sel[data-id="${id}"]`) && !document.querySelector('#inspector').hidden, { timeout: 5000, args: [id], message: 'the row drawn, selected and open' });
      await settle(page, 300);
      assert.equal(await page.evaluate(() => location.hash), '#/upcoming');
      assert.equal(await page.evaluate(() => document.querySelector('#inspector [data-f="title"]').value), `Later ${k} ${N - 1}`);
      const inView = await page.evaluate((id) => {
        const r = document.querySelector(`.task[data-id="${id}"]`).getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }, id);
      assert.ok(inView, 'scrolled to it');
      await page.press('Escape');
    });
  });

  test('a task added from Upcoming past the drawn ones says where it went', async () => {
    await withScreenshot(page, 'qa-tasks-redraw-added', async () => {
      await go(page, '#/today');
      await go(page, '#/upcoming');
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('q');
      await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', 3000);
      const far = addDays(today, 300);
      await page.type(`Far away ${k} ${far}`);
      await page.press('Enter');
      const t = await page.waitFor(async (title) => (await import('/shared/store.js')).db.all('tasks').find((x) => x.title === title) || null, { timeout: 4000, args: [`Far away ${k}`] });
      assert.equal(t.date, far);
      await page.waitFor(() => [...document.querySelectorAll('.toast .toast-msg')].some((x) => x.innerText.startsWith('Added for ')), { timeout: 3000, message: 'an "Added for …" toast' });
      await page.clickText('button', 'View');
      await page.waitFor((id) => !!document.querySelector(`.task.sel[data-id="${id}"]`), { timeout: 4000, args: [t.id], message: 'View draws and selects it' });
      await page.press('Escape');
      await page.press('Escape');
    });
  });

  test('a change redraws only what changed (also one from the server)', async () => {
    await withScreenshot(page, 'qa-tasks-redraw-patch', async () => {
      await go(page, '#/today');
      const ids = await page.evaluate(() => [...document.querySelectorAll('#view-body .task[data-id]')].map((r) => r.dataset.id));
      assert.ok(ids.length >= 30);
      const mark = () =>
        page.evaluate(() => {
          for (const el of document.querySelectorAll('#view-body .task[data-id], #view-body > *, #nav a.nav-item')) el.__kept = true;
        });
      const kept = () =>
        page.evaluate(() => ({
          rows: [...document.querySelectorAll('#view-body .task[data-id]')].filter((r) => !r.__kept).map((r) => r.dataset.id),
          blocks: [...document.querySelectorAll('#view-body > *')].filter((b) => !b.__kept && !b.matches('.toast')).length,
          nav: [...document.querySelectorAll('#nav a.nav-item')].filter((a) => !a.__kept).length,
        }));
      // One done today first, so the view's Completed toggle is there before the elements are marked.
      await page.evaluate(async (id) => (await import('/shared/model.js')).toggleTask(id), ids.at(-1));
      await page.waitFor((id) => !document.querySelector(`.task[data-id="${id}"]`) && !!document.querySelector('[data-toggle-done]'), { timeout: 3000, args: [ids.at(-1)] });
      // A rename here: the row is updated in place, nothing else is touched.
      await mark();
      const a = ids[3];
      await page.evaluate(async (id) => (await import('/shared/store.js')).db.update('tasks', id, { title: 'Renamed in place' }), a);
      await page.waitFor((id) => document.querySelector(`.task[data-id="${id}"] .task-title`)?.textContent === 'Renamed in place', { timeout: 3000, args: [a] });
      assert.deepEqual(await kept(), { rows: [], blocks: 0, nav: 0 }, 'every element kept, the renamed row updated in place');

      // A completion: its row goes, the count in the sidebar changes in place, the other rows stay.
      const badge = () => page.evaluate(() => +document.querySelector('#nav a[data-nav="today"] .badge')?.textContent || 0);
      const before = await badge();
      await mark();
      const b = ids[5];
      await page.evaluate(async (id) => (await import('/shared/model.js')).toggleTask(id), b);
      await page.waitFor((id) => !document.querySelector(`.task[data-id="${id}"]`), { timeout: 3000, args: [b] });
      assert.equal(await badge(), before - 1, 'the Today count went down');
      assert.deepEqual(await kept(), { rows: [], blocks: 0, nav: 0 }, 'the other rows, the section and the sidebar items are the same elements');

      // A change from elsewhere (the server tells the page) is drawn too.
      await mark();
      const c = ids[7];
      const item = await page.evaluate(async (id) => ({ ...(await import('/shared/store.js')).db.get('tasks', id), title: 'Renamed on the server', updatedAt: Date.now() + 1000 }), c);
      const r = await ctx.server.api('api/ops', { method: 'POST', body: { client: 'qataskredraw0001', ops: [{ op: 'put', c: 'tasks', item }] } });
      assert.equal(r.status, 200, r.text);
      await page.waitFor((id) => document.querySelector(`.task[data-id="${id}"] .task-title`)?.textContent === 'Renamed on the server', { timeout: 6000, args: [c], message: "the server's change drawn" });
      assert.deepEqual((await kept()).rows, [], 'rows kept');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test("rows skip layout out of view, and keep the circle's focus ring whole", async () => {
    const s = await page.evaluate(() => {
      const r = document.querySelector('#view-body .task[data-id]');
      const cs = getComputedStyle(r);
      return { cv: cs.contentVisibility, margin: cs.overflowClipMargin, supported: CSS.supports('overflow-clip-margin', '1px') };
    });
    if (!s.supported) return; // rows draw as before where the clip margin isn't supported
    assert.equal(s.cv, 'auto');
    assert.ok(parseFloat(s.margin) >= 6, `clip margin ${s.margin}`);
  });

  test('composer: a key that changes no chip leaves the chips as they are', async () => {
    await withScreenshot(page, 'qa-tasks-redraw-chips', async () => {
      await go(page, '#/inbox');
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('q');
      await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', 3000);
      await page.type('Water the');
      await settle(page, 100);
      await page.evaluate(() => document.querySelectorAll('.cb-chips > *').forEach((c) => (c.__kept = true)));
      await page.type(' plants');
      await settle(page, 100);
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('.cb-chips > *')].every((c) => c.__kept)), 'chips kept');
      await page.type(' tomorrow');
      await page.waitFor(() => document.querySelector('[data-cc="date"]')?.getAttribute('aria-label') === 'Date: Tomorrow', { timeout: 3000, message: 'the date chip updated' });
      await page.press('Escape');
    });
  });
});
