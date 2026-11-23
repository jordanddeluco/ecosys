// QA regressions for the shell (shared/shell.js, shared/minical.js) at 1440x900, follow-ups from the other
// areas:
//   undo   an Undo, by Ctrl+Z or by the toast's Undo button, that finds nothing left to take back (the
//          task was deleted since, here by an assistant through the server) says so, leaves the task
//          deleted, and leaves nothing to redo; a redo that finds nothing left says so as well
//   dates  the date picker's PageUp / PageDown keep the day (Mar 30 to Apr 30), or take the month's last
//          one (Mar 30 to Feb 28); its calendar's Today is a word, and takes it back to this month
//   keys   the Settings shortcut in menus is a ',' keycap (not the word "Comma"), and a key, not a speck
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot, tag, browserToday, waitForSyncIdle } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTHING_TO_UNDO = 'Nothing to undo: it was changed or deleted since';
const NOTHING_TO_REDO = 'Nothing to redo: it was changed or deleted since';

/** Run code in the page with the shell (s) and the store (store) in scope. */
const inPage = (page, body, ...args) =>
  page.evaluate(
    new Function('...args', `return (async () => { const s = await import('/shared/shell.js'); const store = await import('/shared/store.js'); ${body} })();`),
    ...args,
  );

describe('qa shell: nothing left to undo, date picker paging, the comma keycap', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let today;

  before(async () => {
    await openApp(ctx.page, ctx.server.url('tasks/#/inbox'));
    today = await browserToday(ctx.page);
  });

  const toasts = () => ctx.page.evaluate(() => [...document.querySelectorAll('.toast:not(.leaving) .toast-msg')].map((m) => m.textContent));
  const waitToast = (text, message) =>
    ctx.page.waitFor((text) => [...document.querySelectorAll('.toast:not(.leaving) .toast-msg')].some((m) => m.textContent === text), { args: [text], timeout: 4000, message });
  const inStore = (id) => inPage(ctx.page, 'return !!store.db.get("tasks", args[0]);', id);
  const onServer = async (id) => (await ctx.server.state()).data.tasks.some((t) => t.id === id);

  /** A task in the Inbox, on screen and on the server. */
  async function newTask() {
    const { page, server } = ctx;
    const title = `QA undo ${tag()}`;
    const id = await inPage(page, 'return store.db.insert("tasks", { title: args[0] }).id;', title);
    await page.waitFor((id) => !!document.querySelector(`.task[data-id="${id}"] .task-title`), { args: [id], timeout: 5000, message: 'the task row' });
    await server.waitForState((s) => s.data.tasks.some((t) => t.id === id), 8000, 'the task on the server');
    return { id, title };
  }
  /**
   * "Add to Today" from the row's menu: a change with an Undo (toast and Ctrl+Z). `whilePlanned` runs once
   * the page has it, before waiting for the server to have it too (so nobody deletes it there first).
   */
  async function addToToday(id, whilePlanned) {
    const { page } = ctx;
    await page.click((id) => document.querySelector(`.task[data-id="${id}"] .task-title`), { args: [id], button: 'right' });
    await page.waitFor('[role="menu"] .menu-item', 3000);
    await page.clickText('menuitem', 'Add to Today');
    await page.waitFor(async ([id, today]) => (await import('/shared/store.js')).db.get('tasks', id)?.date === today, { args: [[id, today]], timeout: 4000, message: 'the task planned for today' });
    await whilePlanned?.();
    await ctx.server.waitForState((s) => s.data.tasks.find((t) => t.id === id)?.date === today, 8000, 'the plan on the server');
  }
  /** Delete the task as an assistant would: through the server, which tells the open page. */
  async function deleteElsewhere(id) {
    const r = await ctx.server.api('api/ops', { method: 'POST', body: { client: 'qashelljsundo001', ops: [{ op: 'del', c: 'tasks', id }] } });
    assert.equal(r.status, 200, r.text);
    await ctx.page.waitFor(async (id) => !(await import('/shared/store.js')).db.get('tasks', id), { args: [id], timeout: 8000, message: 'the deletion to reach the page' });
    await settle(ctx.page, 150);
  }
  /** The task is gone here and stays gone on the server once the page has sent everything. */
  async function staysDeleted(id, what) {
    assert.equal(await inStore(id), false, `${what}: the task stays deleted in the page`);
    await waitForSyncIdle(ctx.page);
    await sleep(250);
    assert.equal(await onServer(id), false, `${what}: and on the server`);
  }

  test('Ctrl+Z after the task was deleted elsewhere says nothing is left, keeps it deleted, and leaves no redo', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-shell-undo-nothing-left', async () => {
      await openApp(page, ctx.server.url('tasks/#/inbox'));
      const { id } = await newTask();
      await addToToday(id);
      await deleteElsewhere(id);
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+z');
      await waitToast(NOTHING_TO_UNDO, 'the "Nothing to undo" toast');
      assert.ok(!(await toasts()).some((t) => t.startsWith('Undid')), `no "Undid …" toast (${JSON.stringify(await toasts())})`);
      await staysDeleted(id, 'Ctrl+Z');
      // The undo took nothing back, so there is nothing to redo.
      await page.press('Control+Shift+z');
      await waitToast('Nothing to redo', 'the "Nothing to redo" toast');
      await staysDeleted(id, 'Ctrl+Shift+Z');
    });
  });

  test('the toast’s Undo after the task was deleted elsewhere says nothing is left and keeps it deleted', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-shell-undo-toast-nothing-left', async () => {
      await openApp(page, ctx.server.url('tasks/#/inbox'));
      const { id } = await newTask();
      // Rest the pointer on the toast as soon as it shows: that keeps it up while the assistant deletes the task.
      await addToToday(id, async () => {
        const at = await page.waitFor(
          () => {
            const t = [...document.querySelectorAll('.toast:not(.leaving)')].find((x) => x.querySelector('button')?.textContent === 'Undo');
            const r = t?.getBoundingClientRect();
            return r ? { x: r.left + 20, y: r.top + r.height / 2 } : null;
          },
          { timeout: 3000, message: 'the toast with Undo' },
        );
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      });
      await deleteElsewhere(id);
      await page.click(() => [...document.querySelectorAll('.toast:not(.leaving) button')].find((b) => b.textContent === 'Undo'));
      await waitToast(NOTHING_TO_UNDO, 'the "Nothing to undo" toast after the toast’s Undo');
      await staysDeleted(id, 'the toast’s Undo');
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 860 });
    });
  });

  test('a redo after the task was deleted elsewhere says nothing is left, and leaves nothing to undo', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-shell-redo-nothing-left', async () => {
      await openApp(page, ctx.server.url('tasks/#/inbox'));
      const { id, title } = await newTask();
      await addToToday(id);
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+z');
      await page.waitFor(async (id) => (await import('/shared/store.js')).db.get('tasks', id)?.date === null, { args: [id], timeout: 4000, message: 'the date taken back' });
      await waitToast(`Undid scheduling “${title}” for today`, 'an "Undid …" toast for an undo that did something');
      await ctx.server.waitForState((s) => s.data.tasks.find((t) => t.id === id)?.date === null, 8000, 'the undo on the server');
      await deleteElsewhere(id);
      await page.press('Control+Shift+z');
      await waitToast(NOTHING_TO_REDO, 'the "Nothing to redo" toast');
      assert.ok(!(await toasts()).some((t) => t.startsWith('Redid')), `no "Redid …" toast (${JSON.stringify(await toasts())})`);
      await staysDeleted(id, 'Ctrl+Shift+Z');
      // The redo did nothing, so nothing went back on the undo stack.
      await page.press('Control+z');
      await waitToast('Nothing to undo', 'the plain "Nothing to undo" toast');
      await staysDeleted(id, 'Ctrl+Z after the redo');
    });
  });

  test('the date picker’s PageUp and PageDown keep the day, or take the month’s last; Today is a word', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-shell-date-picker-paging', async () => {
      await openApp(page, ctx.server.url('tasks/#/today'));
      const y = Number(today.slice(0, 4)) + 1;
      const febLast = new Date(y, 2, 0).getDate();
      await inPage(
        page,
        `const b = document.createElement('button'); b.id = 'qa-dp'; b.textContent = 'date'; b.style.cssText = 'position:fixed;left:600px;top:100px';
        document.body.append(b);
        s.openDatePicker(b, { value: args[0] });`,
        `${y}-03-30`,
      );
      await page.waitFor('.dp-pop [data-date]', 3000);
      await page.evaluate((d) => document.querySelector(`.dp-pop [data-date="${d}"]`).focus(), `${y}-03-30`);
      const focused = () => page.evaluate(() => document.activeElement?.dataset?.date || document.activeElement?.className || null);
      const heading = () => page.evaluate(() => document.querySelector('.dp-pop .mc-head strong').textContent);
      const monthName = (ymd) => page.evaluate((ymd) => new Date(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), ymd);
      for (const [key, want] of [
        ['PageDown', `${y}-04-30`],
        ['PageDown', `${y}-05-30`],
        ['PageUp', `${y}-04-30`],
        ['PageUp', `${y}-03-30`],
        ['PageUp', `${y}-02-${String(febLast).padStart(2, '0')}`],
        ['PageDown', `${y}-03-${String(febLast).padStart(2, '0')}`],
      ]) {
        await page.press(key);
        await page.waitFor((want) => document.activeElement?.dataset?.date === want, { args: [want], timeout: 2000, message: `${key} to focus ${want} (focus is on ${await focused()})` });
        assert.equal(await heading(), await monthName(want), `${key}: the calendar shows the month of ${want}`);
      }
      // Its Today is a word, not a bare dot, and goes back to this month.
      const btn = await page.evaluate(() => {
        const b = document.querySelector('.dp-pop .mc-today');
        return b && { text: b.textContent.trim(), dot: !!b.querySelector('svg') };
      });
      assert.deepEqual(btn, { text: 'Today', dot: false });
      await page.click('.dp-pop .mc-today'); // (the quick "Today" row above it would pick the day instead)
      await page.waitFor((want) => document.querySelector('.dp-pop .mc-head strong')?.textContent === want, { args: [await monthName(today)], timeout: 2000, message: 'Today to show this month' });
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.dp-pop'), 2000);
      await page.evaluate(() => document.getElementById('qa-dp')?.remove());
    });
  });

  test('menus show the Settings shortcut as a "," keycap that is a key, not a speck', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-shell-comma-keycap', async () => {
      await openApp(page, ctx.server.url('tasks/#/today'));
      for (const opener of ['[data-app-menu]', '[data-view-menu]']) {
        await page.click(opener);
        await page.waitFor('[role="menu"] .menu-item', 3000);
        const r = await page.evaluate(() => {
          const b = [...document.querySelectorAll('[role="menu"] .menu-item')].find((x) => x.querySelector('.grow')?.textContent.trim() === 'Settings');
          const k = b?.querySelector('.hint kbd');
          return b && { text: k?.textContent, punct: !!k?.classList.contains('kbd-punct'), width: k ? Math.round(k.getBoundingClientRect().width) : 0, aria: b.getAttribute('aria-keyshortcuts'), hidden: b.querySelector('.hint')?.getAttribute('aria-hidden') };
        });
        assert.ok(r, `${opener}: a Settings item`);
        assert.equal(r.text, ',', `${opener}: the keycap is a comma, not the word "Comma"`);
        assert.ok(r.punct, `${opener}: drawn as a punctuation keycap`);
        assert.ok(r.width >= 14, `${opener}: a key you can see, not a speck (${r.width}px wide)`);
        assert.equal(r.aria, ',', `${opener}: announced as aria-keyshortcuts`);
        assert.equal(r.hidden, 'true', `${opener}: the keycap itself is not read as part of the name`);
        await page.press('Escape');
        await page.waitFor(() => !document.querySelector('[role="menu"]'), 2000);
      }
    });
  });
});
