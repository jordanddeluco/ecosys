// QA regression (tasks): the sidebar and the details pane at each width, with real keys, clicks and touches.
//   1440  Mod+\ hides the sidebar (kept in settings) and the menu button brings it back; the button is named
//         for what it does ("Hide sidebar" / "Show sidebar") and its tooltip, with Mod+\, shows either way
//   1024  the details pane takes the sidebar's place: the list is pushed aside, never covered, and stays usable
//    800  the pane covers the list as a modal sheet: the page behind is inert and focus is in the pane; a press
//         on the dimmed list closes it and focus goes back to the task's row; Mod+\ over the sheet closes it
//         and opens the lists drawer, never two modal layers at once
//    390  the lists drawer is a modal dialog: focus moves in, Tab stays in, Esc closes it and focus returns to
//         the button that opened it; picking a list closes it too
//    390  swipes start anywhere on a row, its name included: right completes, left picks a date, and a tap on
//         the name opens the details
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Add an open task due today (through the app's own model, as the composer would). */
const addToday = (page, title) =>
  page.evaluate(async (title) => {
    const { createTask } = await import('/shared/model.js');
    const { todayYmd } = await import('/shared/dates.js');
    return createTask({ title, date: todayYmd() }).id;
  }, title);

const gridColumns = (page) => page.evaluate(() => getComputedStyle(document.querySelector('#shell')).gridTemplateColumns.split(' ').map((x) => Math.round(parseFloat(x))));
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return { tag: a?.tagName.toLowerCase(), name: a?.getAttribute('aria-label') || a?.innerText?.trim() || '', inSidebar: !!document.querySelector('#sidebar')?.contains(a), inPane: !!document.querySelector('#inspector')?.contains(a) };
});

/** Click the name of the task titled `title` (the name is the row's button that opens its details). */
const openByName = (page, title) => page.click((t) => [...document.querySelectorAll('.task .task-title')].find((b) => b.textContent.trim() === t), { args: [title] });

/** Move the mouse onto `selector` (from elsewhere) and read the tooltip that shows, or null. */
async function tipOver(page, selector) {
  const c = await page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 600 });
  await sleep(200);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
  const text = await page
    .waitFor(() => document.querySelector('.tooltip.on')?.innerText.replace(/\s+/g, ' ').trim() || false, { timeout: 2000 })
    .catch(() => null);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 600 });
  return text;
}

const touch = (page, type, x, y) => page.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
/** A touch on the name of the task with `id`, 40px in: dx 0 is a tap, else a horizontal swipe of dx px. */
async function touchName(page, id, dx = 0) {
  // Once the last swipe has slid back and a closed sheet's scrim (kept a moment to take the closing tap) is gone.
  await page.waitFor(() => !document.querySelector('.swipe-bg, .pop-scrim'), { timeout: 3000, message: 'the page to settle' });
  const p = await page.evaluate((id) => {
    const el = document.querySelector(`.task[data-id="${id}"] .task-title`);
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    const x = b.x + Math.min(40, b.width / 2);
    const y = b.y + b.height / 2;
    return { x, y, on: document.elementFromPoint(x, y)?.closest('.task-title') === el };
  }, id);
  assert.ok(p.on, 'the touch lands on the name');
  await touch(page, 'touchStart', p.x, p.y);
  for (let i = 1; dx && i <= 12; i++) {
    await touch(page, 'touchMove', p.x + (i * dx) / 12, p.y);
    await sleep(16);
  }
  const bg = await page.evaluate(() => document.querySelector('.swipe-bg')?.className || null);
  await touch(page, 'touchEnd', p.x + dx, p.y);
  return bg;
}

describe('qa tasks: sidebar and details pane by width', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let page;
  const title = `Layout check ${tag()}`;

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('tasks/'));
    await addToday(page, title);
    await page.evaluate(() => (location.hash = '#/today'));
    await page.waitFor((t) => [...document.querySelectorAll('.task .task-title')].some((b) => b.textContent.trim() === t), { timeout: 5000, args: [title], message: 'the new task in Today' });
  });

  test('1440: Mod+\\ hides the sidebar and keeps it hidden; the menu button shows it again', async () => {
    await withScreenshot(page, 'qa-tasks-layout-collapse', async () => {
      await page.setViewport(1440, 900, false);
      await settle(page, 300);
      const toggle = '#topbar [data-toggle-nav]';
      const button = () => page.evaluate((s) => { const b = document.querySelector(s); return { name: b.getAttribute('aria-label'), expanded: b.getAttribute('aria-expanded'), popup: b.getAttribute('aria-haspopup') }; }, toggle);
      assert.equal(await page.evaluate((s) => document.querySelector(s).checkVisibility(), toggle), true, 'the sidebar button shows on desktop');
      // Named for what it does, with no expanded state (that is the drawer's, when narrow), so its tooltip shows
      // while the sidebar does: that is where Mod+\ can be learnt.
      assert.deepEqual(await button(), { name: 'Hide sidebar', expanded: null, popup: null });
      assert.match((await tipOver(page, toggle)) || 'no tooltip', /^Hide sidebar\b.*\\$/, 'the tooltip, with Mod+\\, shows while the sidebar does');
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+\\');
      await page.waitFor(() => getComputedStyle(document.querySelector('#sidebar')).visibility === 'hidden', { timeout: 3000, message: 'the sidebar to hide' });
      await sleep(350); // the columns slide
      assert.equal((await gridColumns(page))[0], 0, 'the sidebar column is closed');
      assert.equal((await button()).name, 'Show sidebar');
      assert.match((await tipOver(page, toggle)) || 'no tooltip', /^Show sidebar\b.*\\$/);
      assert.equal(await page.evaluate(async () => (await import('/shared/store.js')).settings.get().tasksNavCollapsed), true, 'the choice is kept in settings');
      await page.click(toggle);
      await page.waitFor(() => getComputedStyle(document.querySelector('#sidebar')).visibility === 'visible', { timeout: 3000, message: 'the sidebar to come back' });
      await sleep(350);
      assert.ok((await gridColumns(page))[0] > 200, 'the sidebar column is open again');
      assert.equal((await button()).name, 'Hide sidebar');
    });
  });

  test('1024: the details pane pushes the list instead of covering it', async () => {
    await withScreenshot(page, 'qa-tasks-layout-1024', async () => {
      await page.setViewport(1024, 768, false);
      await settle(page, 300);
      await openByName(page, title);
      await page.waitFor(() => !document.querySelector('#inspector').hidden, { timeout: 3000, message: 'the details pane' });
      await sleep(400); // the pane slides in
      const r = await page.evaluate(() => {
        const pane = document.querySelector('#inspector').getBoundingClientRect();
        const rows = [...document.querySelectorAll('.task')].map((x) => x.getBoundingClientRect().right);
        return { paneLeft: Math.round(pane.left), rowsRight: Math.round(Math.max(...rows)), position: getComputedStyle(document.querySelector('#inspector')).position, sidebar: getComputedStyle(document.querySelector('#sidebar')).visibility, mainInert: document.querySelector('#main').inert };
      });
      assert.equal(r.position, 'static', 'the pane sits in the layout (no overlay)');
      assert.ok(r.rowsRight <= r.paneLeft, `no row runs under the pane (rows end at ${r.rowsRight}, pane starts at ${r.paneLeft})`);
      assert.equal(r.sidebar, 'hidden', 'the pane took the sidebar’s place');
      assert.equal(r.mainInert, false, 'the list stays usable');
      // The sidebar button offers the hidden sidebar; pressing it brings the sidebar back (closing the pane).
      assert.equal(await page.evaluate(() => document.querySelector('#topbar [data-toggle-nav]').getAttribute('aria-label')), 'Show sidebar');
      await page.click('#topbar [data-toggle-nav]');
      await page.waitFor(() => document.querySelector('#inspector').hidden && getComputedStyle(document.querySelector('#sidebar')).visibility === 'visible', { timeout: 3000, message: 'the sidebar back, the pane closed' });
    });
  });

  test('800: the pane is a modal sheet; a press on the dimmed list closes it and focus returns to the row', async () => {
    await withScreenshot(page, 'qa-tasks-layout-800', async () => {
      await page.setViewport(800, 900, false);
      await settle(page, 300);
      await openByName(page, title);
      await page.waitFor(() => !document.querySelector('#inspector').hidden, { timeout: 3000, message: 'the details pane' });
      await settle(page, 300);
      const s = await page.evaluate(() => ({ mainInert: document.querySelector('#main').inert, role: document.querySelector('#inspector').getAttribute('role'), modal: document.querySelector('#inspector').getAttribute('aria-modal') }));
      assert.deepEqual(s, { mainInert: true, role: 'dialog', modal: 'true' });
      assert.ok((await focused(page)).inPane, 'focus is in the pane');
      // A press on the dimmed list, left of the pane.
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 120, y: 450 });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 450, button: 'left', buttons: 1, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 120, y: 450, button: 'left', buttons: 0, clickCount: 1 });
      await page.waitFor(() => document.querySelector('#inspector').hidden, { timeout: 3000, message: 'the pane to close' });
      assert.equal(await page.evaluate(() => document.querySelector('#main').inert), false);
      const f = await page.evaluate(() => document.activeElement?.closest('.task')?.querySelector('.task-title')?.textContent.trim() || null);
      assert.equal(f, title, "focus is back on the task's row");
    });
  });

  test('800: Mod+\\ over the sheet closes it and opens the lists drawer: never two modal layers', async () => {
    await withScreenshot(page, 'qa-tasks-layout-800-drawer', async () => {
      await page.setViewport(800, 900, false);
      await settle(page, 300);
      const name = await page.evaluate(() => {
        const b = document.querySelector('#topbar [data-toggle-nav]');
        return [b.getAttribute('aria-label'), b.getAttribute('aria-haspopup'), b.getAttribute('aria-expanded')].join(' ');
      });
      assert.equal(name, 'Lists dialog false', 'narrow, the menu button opens the Lists dialog');
      await openByName(page, title);
      await page.waitFor(() => document.querySelector('#inspector').contains(document.activeElement), { timeout: 3000, message: 'focus in the sheet' });
      await page.press('Control+\\');
      await page.waitFor(() => document.querySelector('#shell').classList.contains('nav-open'), { timeout: 3000, message: 'the drawer to open' });
      await settle(page, 300);
      const s = await page.evaluate(() => ({
        pane: !document.querySelector('#inspector').hidden,
        modals: [...document.querySelectorAll('[aria-modal="true"]')].map((x) => x.id),
        focusInDrawer: document.querySelector('#sidebar').contains(document.activeElement),
      }));
      assert.deepEqual(s, { pane: false, modals: ['sidebar'], focusInDrawer: true });
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('#shell').classList.contains('nav-open'), { timeout: 3000, message: 'the drawer to close' });
      const f = await page.evaluate(() => document.activeElement?.closest('.task')?.querySelector('.task-title')?.textContent.trim() || null);
      assert.equal(f, title, "focus is back on the task's row");
    });
  });

  test("390: the drawer takes focus, keeps Tab inside, and Esc returns focus to the button that opened it", async () => {
    await withScreenshot(page, 'qa-tasks-layout-drawer', async () => {
      await page.setViewport(390, 844, true);
      await settle(page, 300);
      await page.evaluate(() => document.querySelector('#topbar [data-toggle-nav]').focus());
      await page.press('Enter');
      await page.waitFor(() => document.querySelector('#sidebar').contains(document.activeElement), { timeout: 3000, message: 'focus in the drawer' });
      const s = await page.evaluate(() => ({ role: document.querySelector('#sidebar').getAttribute('role'), modal: document.querySelector('#sidebar').getAttribute('aria-modal'), mainInert: document.querySelector('#main').inert, expanded: [...document.querySelectorAll('[data-toggle-nav]')].map((b) => b.getAttribute('aria-expanded')) }));
      assert.equal(s.role, 'dialog');
      assert.equal(s.modal, 'true');
      assert.equal(s.mainInert, true, 'the page behind the drawer is inert');
      assert.ok(s.expanded.every((x) => x === 'true'), `every sidebar button says expanded (${s.expanded})`);
      for (let i = 0; i < 25; i++) {
        await page.press('Tab');
        assert.ok((await focused(page)).inSidebar, `Tab #${i + 1} stays in the drawer`);
      }
      await page.press('Shift+Tab');
      assert.ok((await focused(page)).inSidebar, 'Shift+Tab stays in the drawer');
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('#shell').classList.contains('nav-open'), { timeout: 3000, message: 'the drawer to close' });
      const f = await page.evaluate(() => document.activeElement === document.querySelector('#topbar [data-toggle-nav]'));
      assert.ok(f, 'focus is back on the menu button');
      assert.equal(await page.evaluate(() => document.querySelector('#main').inert), false);
      // From the tab bar: Browse opens it, picking a list closes it and lands on that list.
      await page.click('#tabbar [data-toggle-nav]');
      await page.waitFor(() => document.querySelector('#shell').classList.contains('nav-open'), { timeout: 3000, message: 'the drawer to open from Browse' });
      await settle(page, 400);
      await page.click('.nav-item[data-nav="inbox"]');
      await page.waitFor(() => location.hash === '#/inbox' && !document.querySelector('#shell').classList.contains('nav-open'), { timeout: 3000, message: 'Inbox, drawer closed' });
      assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY', 'focus is not dropped to the page');
      await page.setViewport(1440, 900, false);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('390: a swipe can start on the name: right completes, left picks a date; a tap on the name opens the details', async () => {
    await withScreenshot(page, 'qa-tasks-layout-swipe', async () => {
      await page.setViewport(390, 844, true);
      const k = tag();
      const ids = {};
      for (const w of ['right', 'left', 'tap']) ids[w] = await addToday(page, `Swipe ${w} ${k}`);
      await page.evaluate(() => (location.hash = '#/today'));
      await settle(page, 400);
      const paneOpen = () => page.evaluate(() => !document.querySelector('#inspector').hidden);

      assert.equal(await touchName(page, ids.right, 200), 'swipe-bg right', 'the swipe shows its background');
      await page.waitFor(async (id) => (await import('/shared/store.js')).db.get('tasks', id)?.done === true, { timeout: 3000, args: [ids.right], message: 'the task to be completed' });
      assert.equal(await paneOpen(), false, 'a swipe does not also open the task');

      assert.equal(await touchName(page, ids.left, -200), 'swipe-bg left');
      await page.waitFor('.menu.dp-pop', { timeout: 3000, message: 'the date picker' });
      assert.equal(await paneOpen(), false);
      await page.press('Escape');
      await page.waitFor('.menu.dp-pop', { timeout: 3000, state: 'hidden', message: 'the date picker to close' });

      // A short swipe, which the browser still ends with a click, opens nothing either.
      await touchName(page, ids.tap, 14);
      await sleep(500);
      assert.equal(await paneOpen(), false, 'a short swipe does not open the task');

      assert.equal(await touchName(page, ids.tap), null, 'a tap is no swipe');
      await page.waitFor(() => document.querySelector('#inspector').getAttribute('role') === 'dialog' && document.querySelector('#inspector').contains(document.activeElement), { timeout: 3000, message: 'the details sheet, with focus in it' });
      assert.equal(await page.evaluate(() => document.querySelector('#inspector [data-f="title"]').value), `Swipe tap ${k}`);
      await page.press('Escape');
      await page.waitFor(() => document.querySelector('#inspector').hidden, { timeout: 3000, message: 'the sheet to close' });
      await page.setViewport(1440, 900, false);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
