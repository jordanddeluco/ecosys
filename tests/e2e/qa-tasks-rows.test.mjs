// QA regression (tasks): task rows, the details pane and undo, at 1440x900 with real keys and clicks.
//   rows      a list of list items; the name is a button described by its meta line; priority is said in
//             words (the circle's name, and P2/P3 in the meta line), not only by the ring's colour;
//             the deadline reads "Deadline …" and the date never says "Due"; a long list name ends in "…"
//   keyboard  Tab from the circle reaches the name; Enter there opens the details with focus in the name;
//             one Esc closes them from a text field and focus goes back to the row
//   menus     the pane's … menu has no "Open details" (the row's has); the priority hint is one keycap group
//   views     a row picked in one view is not carried into the next one, which opens at its top
//   search    Ctrl+K "settings" + Enter opens Settings: "Add task “…”" comes after every match
//   undo      takes back only its own change (a rename made since stays); Ctrl+Z toasts read as sentences
//             ("Undid moving “…” to …", "Undid deleting the list “…”"), for every kind of change
//   motion    a completed row folds away: the row below glides up instead of jumping; a repeating task too
//             where it leaves its place (Today), while in a list, where it stays, nothing moves
//   suggestions  a list taller than the card fades its rows at the foot, never the card (edge, shadow, colour)
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Create a task through the app's model (dates as day offsets from today). */
const addTask = (page, fields) =>
  page.evaluate(async (f) => {
    const { createTask, createList } = await import('/shared/model.js');
    const { todayYmd, addDaysYmd } = await import('/shared/dates.js');
    const t = todayYmd();
    const listId = f.listName ? createList({ name: f.listName }).id : f.listId || null;
    return createTask({ ...f, listId, date: f.dateIn == null ? null : addDaysYmd(t, f.dateIn), deadline: f.deadlineIn == null ? null : addDaysYmd(t, f.deadlineIn) }).id;
  }, fields);
const getTask = (page, id) => page.evaluate(async (id) => (await import('/shared/store.js')).db.get('tasks', id), id);
const lastToast = (page) => page.evaluate(() => [...document.querySelectorAll('.toast .toast-msg')].map((x) => x.innerText).at(-1));
const rowOf = (id) => `.task[data-id="${id}"]`;
const go = async (page, hash) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await settle(page, 300);
};

describe('qa tasks: rows, details, undo', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let page;
  const k = tag();
  const ids = {};

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('tasks/'));
    ids.p2 = await addTask(page, { title: `Prio two ${k}`, priority: 2, dateIn: 0 });
    ids.p3 = await addTask(page, { title: `Prio three ${k}`, priority: 1, dateIn: 0 });
    ids.dl = await addTask(page, { title: `Expense report ${k}`, dateIn: 2, deadlineIn: 4 });
    ids.long = await addTask(page, { title: `Long list ${k}`, dateIn: 0, listName: `Quarterly planning and stakeholder alignment for the whole team ${k}` });
    await go(page, '#/today');
  });

  test('rows: list semantics, a named button, priority in words, "Deadline" never "Due", list names end in an ellipsis', async () => {
    await withScreenshot(page, 'qa-tasks-rows-semantics', async () => {
      const r = await page.evaluate((ids) => {
        const row = (id) => document.querySelector(`.task[data-id="${id}"]`);
        const title = row(ids.p2).querySelector('.task-title');
        const described = (title.getAttribute('aria-describedby') || '').split(/\s+/).map((x) => document.getElementById(x)?.innerText.replace(/\s+/g, ' ').trim()).join(' | ');
        const where = row(ids.long).querySelector('.where .truncate');
        return {
          listRole: row(ids.p2).parentElement.getAttribute('role'),
          itemRole: row(ids.p2).getAttribute('role'),
          titleTag: title.tagName,
          described,
          check2: row(ids.p2).querySelector('[data-check]').getAttribute('aria-label'),
          meta2: row(ids.p2).querySelector('.task-meta').innerText,
          meta3: row(ids.p3).querySelector('.task-meta').innerText,
          whereEllipsis: where ? getComputedStyle(where).textOverflow === 'ellipsis' && where.scrollWidth > where.clientWidth : 'no .truncate',
        };
      }, ids);
      assert.equal(r.listRole, 'list');
      assert.equal(r.itemRole, 'listitem');
      assert.equal(r.titleTag, 'BUTTON', 'the name is a button');
      assert.match(r.described, /P2/, `the name is described by its meta line (${r.described})`);
      assert.match(r.check2, /priority 2$/i, 'the circle says the priority');
      assert.match(r.meta2, /\bP2\b/);
      assert.match(r.meta3, /\bP3\b/);
      assert.equal(r.whereEllipsis, true, 'a long list name is cut with an ellipsis');

      await go(page, '#/upcoming');
      const meta = await page.evaluate((id) => document.querySelector(`.task[data-id="${id}"] .task-meta`)?.innerText || '', ids.dl);
      assert.match(meta, /Deadline /, `the deadline reads "Deadline …" (${meta})`);
      assert.doesNotMatch(meta, /\bDue\b/);
      await go(page, `#/task/${ids.dl}`);
      await page.waitFor('#inspector [data-dp="date"]', 3000);
      const pane = await page.evaluate(() => ({ date: document.querySelector('#inspector [data-dp="date"]').innerText, dateName: document.querySelector('#inspector [data-dp="date"]').getAttribute('aria-label'), deadline: document.querySelector('#inspector [data-dp="deadline"]').innerText }));
      assert.doesNotMatch(pane.date, /\bDue\b/, `the date row doesn't say "Due" (${pane.date})`);
      assert.match(pane.dateName, /^Date: /);
      assert.match(pane.deadline, /^Deadline /);
      await page.press('Escape');
    });
  });

  test('keyboard: Tab reaches the name, Enter opens the details there, one Esc closes them and returns to the row', async () => {
    await withScreenshot(page, 'qa-tasks-rows-keyboard', async () => {
      await go(page, '#/today');
      await page.evaluate((id) => document.querySelector(`.task[data-id="${id}"] [data-check]`).focus(), ids.p2);
      await page.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.matches('.task-title[data-open]')), true, 'Tab from the circle lands on the name');
      await page.press('Enter');
      await page.waitFor(() => document.activeElement?.matches('#inspector [data-f="title"]'), { timeout: 3000, message: "focus in the pane's name" });
      await page.press('Escape');
      await page.waitFor(() => document.querySelector('#inspector').hidden, { timeout: 3000, message: 'one Esc to close the pane' });
      assert.equal(await page.evaluate((id) => !!document.activeElement?.closest(`.task[data-id="${id}"]`), ids.p2), true, 'focus is back on the row');
    });
  });

  test("menus: the pane's … has no Open details; the priority hint is one keycap group", async () => {
    await withScreenshot(page, 'qa-tasks-rows-menus', async () => {
      await go(page, `#/task/${ids.p2}`);
      await page.click('#inspector [data-dp="more"]');
      await page.waitFor('.menu [role="menu"]', 3000);
      const pane = await page.evaluate(() => [...document.querySelectorAll('.menu .menu-item .grow')].map((x) => x.innerText.trim()));
      const hint = await page.evaluate(() => {
        const b = [...document.querySelectorAll('.menu .menu-item')].find((x) => x.querySelector('.grow')?.innerText.startsWith('Priority'));
        const h = b?.querySelector('.hint');
        return h ? { groups: h.children.length, first: h.firstElementChild?.className } : null;
      });
      await page.press('Escape');
      await page.press('Escape');
      await settle(page, 200);
      assert.ok(!pane.includes('Open details'), `pane menu: ${pane.join(', ')}`);
      assert.deepEqual(hint, { groups: 1, first: 'keys' }, 'the "1 to 4" hint is one .keys group (hidden whole on touch screens)');
      await page.click((id) => document.querySelector(`.task[data-id="${id}"] .task-title`), { args: [ids.p3], button: 'right' });
      await page.waitFor('.menu [role="menu"]', 3000);
      const row = await page.evaluate(() => [...document.querySelectorAll('.menu .menu-item .grow')].map((x) => x.innerText.trim()));
      await page.press('Escape');
      assert.ok(row.includes('Open details'), "the row's menu still opens the details");
    });
  });

  test('views: a row picked in one view is not carried into the next, which opens at its top', async () => {
    await withScreenshot(page, 'qa-tasks-rows-views', async () => {
      await go(page, '#/today');
      // Pick the row with the mouse, close its details, then switch views from the sidebar.
      await page.click((id) => document.querySelector(`.task[data-id="${id}"] .task-title`), { args: [ids.p3] });
      await page.waitFor(() => !document.querySelector('#inspector').hidden, 3000);
      await page.press('Escape');
      await page.waitFor(() => document.querySelector('#inspector').hidden, 3000);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.task.sel').length), 1);
      await page.click('.nav-item[data-nav="upcoming"]');
      await page.waitFor(() => location.hash === '#/upcoming', 3000);
      await settle(page, 300);
      const r = await page.evaluate(() => ({ top: document.querySelector('#main').scrollTop, sel: document.querySelectorAll('.task.sel').length }));
      assert.deepEqual(r, { top: 0, sel: 0 });
    });
  });

  test('search: Enter on "settings" opens Settings; "Add task “…”" comes after every match', async () => {
    await withScreenshot(page, 'qa-tasks-rows-search', async () => {
      await go(page, '#/today');
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+k');
      await page.waitFor(() => document.activeElement?.matches('.palette input'), 4000);
      await page.type('settings');
      await settle(page, 250);
      const rows = await page.evaluate(() => [...document.querySelectorAll('.palette-list [data-r]')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
      assert.ok(rows.at(-1).startsWith('Add task'), `Add task is last (${rows.join(' | ')})`);
      await page.press('Enter');
      await page.waitFor(() => !!document.querySelector('.modal.settings'), { timeout: 4000, message: 'Settings to open' });
      assert.equal(await page.evaluate(() => !document.querySelector('.composer-box')?.hidden), false, 'the composer did not open');
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.modal.settings'), 3000);
    });
  });

  test('undo: takes back only its own change; Ctrl+Z toasts read as sentences', async () => {
    await withScreenshot(page, 'qa-tasks-rows-undo', async () => {
      const id = await addTask(page, { title: `Undo check ${k}`, dateIn: 0 });
      await go(page, `#/task/${id}`);
      await page.click('#inspector [data-dp="list"]');
      await page.waitFor('.menu [role="menu"]', 3000);
      await page.clickText('menuitem', /Quarterly planning/);
      await settle(page, 200);
      const moved = await getTask(page, id);
      // Renamed elsewhere (another tab, an assistant) after the move.
      await page.evaluate(async (id) => (await import('/shared/store.js')).db.update('tasks', id, { title: 'Renamed elsewhere' }), id);
      await page.press('Escape');
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+z');
      await settle(page, 250);
      const back = await getTask(page, id);
      assert.notEqual(moved.listId, back.listId, 'the move is taken back');
      assert.equal(back.title, 'Renamed elsewhere', 'the rename made since stays');
      // Named as the task was when it moved.
      assert.match(await lastToast(page), new RegExp(`^Undid moving “Undo check ${k}” to Quarterly planning`));

      // A date removed in the details: "Undid removing the date from …", and Ctrl+Shift+Z: "Redid …".
      await go(page, `#/task/${id}`);
      await page.click('#inspector [data-clear="date"]');
      await page.waitFor(async (id) => (await import('/shared/store.js')).db.get('tasks', id)?.date === null, { timeout: 3000, args: [id] });
      await page.press('Escape');
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+z');
      await page.waitFor(async (id) => !!(await import('/shared/store.js')).db.get('tasks', id)?.date, { timeout: 3000, args: [id], message: 'the date back' });
      assert.equal(await lastToast(page), 'Undid removing the date from “Renamed elsewhere”');
      await page.press('Control+Shift+z');
      await page.waitFor(async (id) => (await import('/shared/store.js')).db.get('tasks', id)?.date === null, { timeout: 3000, args: [id], message: 'the date removed again' });
      assert.equal(await lastToast(page), 'Redid removing the date from “Renamed elsewhere”');
      await page.press('Control+z');
      await page.waitFor(async (id) => !!(await import('/shared/store.js')).db.get('tasks', id)?.date, { timeout: 3000, args: [id] });

      // An empty list deleted from its page: "Undid deleting the list “…”".
      const listId = await page.evaluate(async (name) => (await import('/shared/model.js')).createList({ name }).id, `Doomed ${k}`);
      await go(page, `#/list/${listId}`);
      await page.click('#head-actions [data-view-menu]');
      await page.clickText('menuitem', 'Delete list…');
      await page.waitFor(async (id) => !(await import('/shared/store.js')).db.get('lists', id), { timeout: 3000, args: [listId], message: 'the list deleted' });
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+z');
      await page.waitFor(async (id) => !!(await import('/shared/store.js')).db.get('lists', id), { timeout: 3000, args: [listId], message: 'the list back' });
      assert.equal(await lastToast(page), `Undid deleting the list “Doomed ${k}”`);

      // Delete, then Ctrl+Z: the task is back, and the toast reads as a sentence.
      await go(page, '#/today');
      await page.evaluate((id) => document.querySelector(`.task[data-id="${id}"] [data-check]`).focus(), id);
      await page.press('Delete');
      await page.waitFor((id) => !document.querySelector(`.task[data-id="${id}"]`), { timeout: 3000, args: [id] });
      await page.press('Control+z');
      await page.waitFor((id) => !!document.querySelector(`.task[data-id="${id}"]`), { timeout: 3000, args: [id], message: 'the task back' });
      const toast = await page.evaluate(() => [...document.querySelectorAll('.toast .toast-msg')].map((x) => x.innerText).at(-1));
      assert.equal(toast, 'Undid deleting “Renamed elsewhere”');
    });
  });

  test('motion: a completed row folds away and the row below glides up; a repeating one too where it leaves', async () => {
    await withScreenshot(page, 'qa-tasks-rows-fold', async () => {
      /** Complete task `a` from its circle and follow the row of task `b` frame by frame: its y positions. */
      const follow = (a, b) =>
        page.evaluate(
          async (a, b) => {
            document.querySelector(`.task[data-id="${a}"] [data-check]`).click();
            const out = [];
            const t0 = performance.now();
            while (performance.now() - t0 < 1100) {
              const r = document.querySelector(`.task[data-id="${b}"]`);
              if (r) out.push(Math.round(r.getBoundingClientRect().y));
              await new Promise((res) => requestAnimationFrame(res));
            }
            return out;
          },
          a,
          b,
        );
      const glides = (ys, what) => {
        const first = ys[0];
        const last = ys.at(-1);
        assert.ok(last < first, `${what}: the row below moved up (${first} → ${last})`);
        const between = new Set(ys.filter((y) => y < first && y > last));
        assert.ok(between.size >= 2, `${what}: it glided through ${between.size} in-between positions (${[...new Set(ys)].join(', ')})`);
      };
      const daily = { freq: 'day', interval: 1 };

      await go(page, '#/today');
      const a = await addTask(page, { title: `Fold one ${k}`, dateIn: 0, order: -1001 });
      const b = await addTask(page, { title: `Fold two ${k}`, dateIn: 0, order: -1000 });
      await settle(page, 300);
      glides(await follow(a, b), 'a task');

      // Completed in Today, a daily task moves on to tomorrow: its row leaves too, and folds the same way.
      const c = await addTask(page, { title: `Fold daily ${k}`, dateIn: 0, order: -1001, repeat: daily });
      await settle(page, 300);
      glides(await follow(c, b), 'a daily task in Today');
      assert.ok((await getTask(page, c)).date > (await getTask(page, b)).date, 'the daily task moved on');

      // In a list it stays (with its next date): the row below doesn't move at all.
      const d = await addTask(page, { title: `Stay daily ${k}`, dateIn: 0, listName: `Daily list ${k}`, order: -1001, repeat: daily });
      const { listId } = await getTask(page, d);
      const e = await addTask(page, { title: `Stay below ${k}`, listId, order: -1000 });
      await go(page, `#/list/${listId}`);
      const ys = await follow(d, e);
      assert.equal(new Set(ys).size, 1, `in a list, the row below stays put (${[...new Set(ys)].join(', ')})`);
      assert.equal(await page.evaluate((id) => !!document.querySelector(`.task[data-id="${id}"]`), d), true, 'the daily task is still in its list');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('suggestions: a list taller than the card fades its rows at the foot, never the card itself', async () => {
    await withScreenshot(page, 'qa-tasks-rows-suggestions', async () => {
      // Lights out, where a card faded to transparent would show the black page through it.
      const theme = await page.evaluate(async () => (await import('/shared/store.js')).settings.get().theme);
      await page.evaluate(async () => (await import('/shared/store.js')).settings.set({ theme: 'dark' }));
      for (let i = 0; i < 5; i++) await addTask(page, { title: `Someday ${i} ${k}` });
      for (let i = 1; i <= 5; i++) await addTask(page, { title: `Soon ${i} ${k}`, dateIn: i });
      await page.setViewport(1440, 560, false);
      await go(page, '#/today');
      await page.click('#head-actions [data-suggestions]');
      await page.waitFor(() => document.querySelector('.menu.sugg')?.classList.contains('more'), { timeout: 3000, message: 'a suggestions card that scrolls' });
      await settle(page, 250); // the card pops in
      const r = await page.evaluate(() => {
        const el = document.querySelector('.menu.sugg');
        const cs = getComputedStyle(el);
        const veil = getComputedStyle(el, '::after');
        const b = el.getBoundingClientRect();
        return { mask: [cs.maskImage, cs.webkitMaskImage], shadow: cs.boxShadow, bg: cs.backgroundColor, veil: veil.position, x: Math.round(b.x + b.width / 2), y: Math.floor(b.bottom) - 1 };
      });
      assert.deepEqual(r.mask.filter((m) => m && m !== 'none'), [], 'the card is not masked');
      assert.notEqual(r.shadow, 'none', 'the card keeps its shadow');
      assert.equal(r.veil, 'sticky', 'the rows fade under a veil kept at the foot');
      // The card's last pixel row is the card's own colour, not the page's.
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: 1, height: 1, scale: 1 } });
      const px = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
      }, data);
      const bg = r.bg.match(/\d+/g).slice(0, 3).map(Number);
      assert.ok(px.every((v, i) => Math.abs(v - bg[i]) <= 12), `the card's foot is ${px} (its colour ${bg})`);
      // Scrolled to the end, nothing is cut off: no veil.
      await page.evaluate(() => {
        const el = document.querySelector('.menu.sugg');
        el.scrollTop = el.scrollHeight;
      });
      await page.waitFor(() => !document.querySelector('.menu.sugg').classList.contains('more'), { timeout: 2000, message: 'no veil at the end' });
      await page.press('Escape');
      await page.setViewport(1440, 900, false);
      await page.evaluate(async (theme) => (await import('/shared/store.js')).settings.set({ theme }), theme);
      await settle(page, 200);
    });
  });
});
