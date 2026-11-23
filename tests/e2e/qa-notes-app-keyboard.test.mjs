// notes-app fixes, keyboard (real key presses in headless Chrome against an isolated server):
//   Enter / Space   activate the focused link, button or toast action (the page's shortcuts never cancel
//                   them); a focused row opens on Enter on phones, and Enter edits the open note on a desk
//   single keys     Settings > Keyboard > Single-key shortcuts off: N, T, P… do nothing (WCAG 2.1.4)
//   arrows          only move through notes from the list; in the sidebar they move between its items,
//                   Alt+Shift+↑/↓ moves a folder; Home / End / Page keys in the list; phones move focus only
//   focus           kept on the row after P (pin); after phone screen changes; after Esc in search; after
//                   Quick Note; the search filter chips can be reached with Tab
//   day picker      one tab stop, arrows move by day, focus starts on the day shown, days with a note say so
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp as openAppHash, settle, withScreenshot } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Load the page afresh (going to a URL that differs only in its hash would keep the page as it is). */
async function openApp(page, url, opts) {
  await page.goto('about:blank');
  return openAppHash(page, url, opts);
}

/** "tag#id.class[name]" of the focused element ('BODY' when nothing has focus). */
const focused = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'BODY';
    return `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}${typeof a.className === 'string' && a.className ? `.${a.className.trim().split(/\s+/).join('.')}` : ''}[${(a.getAttribute('aria-label') || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}]`;
  });
const hash = (page) => page.evaluate(() => location.hash);
const focusEl = (page, sel) => page.evaluate((s) => document.querySelector(s)?.focus(), sel);
const setSetting = (page, patch) =>
  page.evaluate(async (p) => {
    const { settings } = await import('/shared/store.js');
    settings.set(p);
  }, patch);

describe('qa notes-app: keyboard', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });

  test('Enter opens a focused sidebar link (folder, Today, a tag, Recently Deleted) and activates buttons', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-notes-app-enter', async () => {
      await openApp(page, server.url('notes/#/all'));
      for (const [sel, want] of [
        ['#nav a.n-folder', /^#\/folder\/[^/]+/],
        ['#nav a[data-key="today"]', /^#\/today/],
        ['#nav a.n-tag', /^#\/tag\//],
        ['#sidefoot a[data-key="trash"]', /^#\/trash/],
      ]) {
        await openApp(page, server.url('notes/#/all'), { settleMs: 200 });
        await focusEl(page, sel);
        await page.press('Enter');
        await sleep(400);
        assert.match(await hash(page), want, `Enter on ${sel}`);
        assert.ok(!(await page.evaluate(() => document.activeElement?.classList.contains('ne-doc'))), 'focus did not jump into the editor');
      }
      await openApp(page, server.url('notes/#/all'), { settleMs: 200 });
      await focusEl(page, '[data-select-mode]');
      await page.press('Enter');
      await sleep(300);
      assert.equal(await page.evaluate(() => document.querySelector('[data-select-mode]').getAttribute('aria-pressed')), 'true', 'Enter on Select turns Select mode on');
      await page.press('Escape');
      // A toast's Undo: delete the open note from the list, then Undo with Enter.
      await openApp(page, server.url('notes/#/all'), { settleMs: 200 });
      const id = await page.evaluate(() => {
        const r = document.querySelector('#list .nrow.open');
        r.focus();
        return r.dataset.id;
      });
      await page.press('Delete');
      await page.waitFor(() => [...document.querySelectorAll('.toast button')].some((b) => /undo/i.test(b.textContent)), { timeout: 5000, message: 'the Undo toast' });
      await page.evaluate(() => [...document.querySelectorAll('.toast button')].find((b) => /undo/i.test(b.textContent)).focus());
      await page.press('Enter');
      await sleep(500);
      const trashed = await page.evaluate(async (x) => {
        const { db } = await import('/shared/store.js');
        const n = db.get('notes', x);
        return n ? n.trashedAt || null : 'gone';
      }, id);
      assert.equal(trashed, null, 'Enter on Undo brought the note back');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('Single-key shortcuts off: N and T do nothing, Enter and Esc still work; on again: T opens Today', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/all'));
    await setSetting(page, { shellSingleKeys: false });
    try {
      await page.evaluate(() => document.activeElement?.blur());
      const before = await hash(page);
      for (const k of ['n', 't', 'v', 'p', '/']) {
        await page.press(k);
        await sleep(150);
      }
      assert.equal(await hash(page), before, 'no single key did anything');
      assert.ok(!(await page.evaluate(() => document.activeElement === document.querySelector('#q'))), '/ did not focus search');
      await page.evaluate(() => document.querySelector('#list .nrow.open').focus());
      await page.press('Enter');
      await sleep(300);
      assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('ne-doc')), 'Enter on the open row still edits the note');
    } finally {
      await setSetting(page, { shellSingleKeys: true });
    }
    await page.evaluate(() => document.activeElement?.blur());
    await page.press('t');
    await sleep(400);
    assert.match(await hash(page), /^#\/today/);
  });

  test('arrows: from the sidebar they move between its items (not to another note); Alt+Shift+↑ moves a folder up', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/all'));
    const before = await hash(page);
    await focusEl(page, '#nav a[data-key="all"]');
    await page.press('ArrowDown');
    await sleep(300);
    assert.equal(await hash(page), before, 'ArrowDown on a sidebar link opened no note');
    assert.match(await focused(page), /data-key|Today|nav-item/, `focus moved to the next sidebar item: ${await focused(page)}`);
    assert.match(await focused(page), /Today/);
    // A top-level folder that is not the first one moves up with Alt+Shift+ArrowUp.
    const order = () => page.evaluate(() => [...document.querySelectorAll('#nav .n-frow')].filter((r) => getComputedStyle(r).getPropertyValue('--depth').trim() === '0').map((r) => r.querySelector('.n-folder .truncate').textContent));
    const top = await order();
    assert.ok(top.length >= 2, `two top-level folders: ${top}`);
    const last = top.at(-1);
    await page.evaluate((n) => [...document.querySelectorAll('#nav a.n-folder')].find((a) => a.querySelector('.truncate').textContent === n).focus(), last);
    await page.press('Alt+Shift+ArrowUp');
    await sleep(500);
    const after = await order();
    assert.equal(after.indexOf(last), top.length - 2, `"${last}" moved up one place: ${after}`);
    assert.match(await focused(page), new RegExp(last), 'the folder keeps the focus');
  });

  test('the list: Home / End open the first / last note; P keeps the focus on the row', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/all'));
    const ids = await page.evaluate(() => [...document.querySelectorAll('#list [data-id]')].map((r) => r.dataset.id));
    await page.evaluate(() => document.querySelector('#list .nrow.open').focus());
    await page.press('End');
    await sleep(500);
    assert.ok((await hash(page)).includes(ids.at(-1)), 'End opens the last note');
    assert.match(await focused(page), new RegExp(`row-${ids.at(-1)}`));
    await page.press('Home');
    await sleep(500);
    assert.ok((await hash(page)).includes(ids[0]), 'Home opens the first note');
    // Pin the focused (unpinned) note: its row moves to Pinned and keeps the focus.
    await page.press('End');
    await sleep(400);
    const id = ids.at(-1);
    await page.press('p');
    await page.waitFor((x) => document.querySelector(`#row-${x}`)?.getAttribute('aria-describedby') === 'ng-pinned', { timeout: 5000, args: [id], message: 'the row in Pinned' });
    await sleep(300);
    assert.match(await focused(page), new RegExp(`row-${id}`), 'the pinned row still has the focus');
    await page.press('p'); // unpin again
    await sleep(400);
    assert.match(await focused(page), new RegExp(`row-${id}`), 'and after unpinning');
  });

  test('search: Tab reaches the filter chips; Esc returns to the note you were reading, with the focus on its row', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/all'));
    const { id, title } = await page.evaluate(() => {
      const r = document.querySelector('#list .nrow.open');
      return { id: r.dataset.id, title: r.querySelector('.nrow-title').textContent };
    });
    await page.press('/');
    await sleep(200);
    await page.press('Tab');
    await sleep(400);
    assert.match(await focused(page), /n-schip|chip/, `Tab reaches the chips: ${await focused(page)}`);
    assert.equal(await page.evaluate(() => document.querySelector('#searchopts').hidden), false, 'the chips stay shown');
    await page.press('Shift+Tab');
    await page.type(title.slice(0, 4));
    await sleep(500);
    assert.ok((await hash(page)).includes(id), 'the open note stays open while searching');
    await page.press('Escape');
    await sleep(500);
    assert.ok((await hash(page)).includes(id), 'Esc returns to that note');
    assert.match(await focused(page), new RegExp(`row-${id}`), 'the focus is on its row');
  });

  test('day picker: focus starts on the day shown, arrows move it, days with a note say so', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/today'));
    await page.waitFor('[data-day-cal]', 5000);
    await page.click('[data-day-cal]');
    await sleep(400);
    const day = await page.evaluate(() => document.activeElement?.dataset?.date);
    assert.match(String(day), /^\d{4}-\d{2}-\d{2}$/, 'a day has the focus (not "Previous month")');
    const label = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
    assert.match(label, /has a note/, `today's note is spoken: ${label}`);
    const stops = await page.evaluate(() => [...document.querySelectorAll('.n-daycal .mc-day')].filter((b) => b.tabIndex === 0).length);
    assert.equal(stops, 1, 'one tab stop for the days');
    await page.press('ArrowRight');
    await sleep(200);
    const next = await page.evaluate(() => document.activeElement?.dataset?.date);
    assert.notEqual(next, day, 'ArrowRight moves to the next day');
    await page.press('Enter');
    await sleep(500);
    assert.ok((await hash(page)).includes(next), 'Enter opens that day');
  });

  test('Quick Note gives the focus back when it closes', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/all'));
    // Quick Note opens over the list while a row has the focus (as from the palette or another app's link).
    const id = await page.evaluate(() => {
      const r = document.querySelector('#list .nrow.open');
      r.focus();
      location.hash = '#/quick';
      return r.dataset.id;
    });
    await page.waitFor(() => document.querySelector('.n-quick .ne-doc'), { timeout: 5000, message: 'Quick Note' });
    await page.press('Escape');
    await sleep(400);
    assert.match(await focused(page), new RegExp(`row-${id}`), 'the focus is back on the row it came from');
  });
});

describe('qa notes-app: keyboard on a phone', () => {
  const ctx = useE2E({ width: 390, height: 844, mobile: true, scheme: 'light' });

  test('Enter on a row opens the note (focus on Back); Esc returns to the row; arrows move the focus only', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-notes-app-phone-keys', async () => {
      await openApp(page, server.url('notes/#/all'));
      const ids = await page.evaluate(() => [...document.querySelectorAll('#list [data-id]')].map((r) => r.dataset.id));
      await page.evaluate(() => document.querySelector('#list [data-id]').focus());
      await page.press('ArrowDown');
      await sleep(400);
      assert.equal(await page.evaluate(() => document.querySelector('#shell').dataset.screen), 'list', 'ArrowDown opened no note');
      assert.match(await focused(page), new RegExp(`row-${ids[1]}`), 'ArrowDown moved the focus to the next row');
      await page.press('Enter');
      await sleep(600);
      assert.equal(await page.evaluate(() => document.querySelector('#shell').dataset.screen), 'note', 'Enter opened the note');
      assert.ok((await hash(page)).includes(ids[1]));
      assert.match(await focused(page), /n-back/, `the focus is on Back: ${await focused(page)}`);
      await page.press('Escape');
      await sleep(600);
      assert.equal(await page.evaluate(() => document.querySelector('#shell').dataset.screen), 'list');
      assert.match(await focused(page), new RegExp(`row-${ids[1]}`), `back on the row you came from: ${await focused(page)}`);
      await page.press(' ');
      await sleep(600);
      assert.equal(await page.evaluate(() => document.querySelector('#shell').dataset.screen), 'note', 'Space opens it too');
      await settle(page, 100);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
