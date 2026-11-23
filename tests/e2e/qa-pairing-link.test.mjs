// QA (pairing): the pairing link in a real Chrome (lead decision 1).
//  - A browser that never opened the link works from its own copy, sends ecosys nothing, and shows one
//    calm, dismissible notice saying how to connect it.
//  - The printed link (http://127.0.0.1:PORT/#pair=<secret>) pairs the browser: the secret is kept,
//    it leaves the address bar and the tab's history, the route after it is kept, and sync comes online.
//  - Opened in a tab that is already showing ecosys, it connects that tab without a reload.
//  - A wrong secret is refused and forgotten (the same notice); the right link then connects the tab.
//  - The notice in Light, Dim and Lights out at 1440 and 390 (screenshots in the e2e artifacts folder).
// Tabs here are opened with { pair: false }: they start as a browser that never saw the link.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useE2E, waitForApp, waitForSync, settle, withScreenshot, artifactPath, formatErrors } from './helpers.mjs';
import { startServer, E2E_PAIR_SECRET } from './server.mjs';

const KEY = 'ecosys:v1:pair';
const NOTICE = "This browser isn't connected to ecosys on this computer. Open the link shown where ecosys is running to connect it.";
const status = (page) => page.evaluate(() => window.ecosysSync?.status);
/** The pairing notices on screen (their text, with typographic apostrophes read as plain ones). */
const notices = (page) =>
  page.evaluate(() => [...document.querySelectorAll('[data-pairing]')].filter((el) => !el.classList.contains('leaving')).map((el) => (el.querySelector('.toast-msg')?.textContent || '').replace(/’/g, "'")));
/** Console errors other than the 403s Chrome logs for the refused requests (that is the point here). */
const otherErrors = (page) => page.consoleErrors().filter((e) => !/status of 403|favicon\.ico/.test(`${e.text} ${e.url || ''}`));

async function unpairedTab(ctx, { width = 1440, height = 900, mobile = false } = {}) {
  const page = await ctx.browser.newPage({ isolated: true, pair: false });
  await page.setViewport(width, height, mobile);
  await page.emulateColorScheme('light');
  return page;
}

describe('QA pairing: the pairing link connects a browser; one that never opened it is told how', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });

  test('harness: e2e servers share one secret, unless a test lets the server make its own', async () => {
    assert.equal(ctx.server.secret, E2E_PAIR_SECRET);
    const own = await startServer({ env: { ECOSYS_E2E_PAIR_SECRET: '' } });
    try {
      assert.match(own.secret, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(own.secret, E2E_PAIR_SECRET, 'a first start makes its own');
      assert.equal(JSON.parse(readFileSync(join(own.dataDir, 'pair.json'), 'utf8')).secret, own.secret, 'read where the server keeps it');
      assert.equal((await own.api('api/state')).status, 200, 'api() sends it');
      assert.equal((await own.api('api/state', { xEcosys: E2E_PAIR_SECRET })).status, 403, 'another secret is refused');
      assert.equal((await own.api('api/state', { xEcosys: false })).status, 403);
    } finally {
      await own.stop();
    }
  });

  test('a browser that never opened the link works from its own copy, sends nothing, and shows one calm notice', async () => {
    const { server } = ctx;
    const before = await server.state();
    const page = await unpairedTab(ctx);
    try {
      await withScreenshot(page, 'qa-pairing-unpaired', async () => {
        await page.goto(server.url('tasks/'));
        await waitForApp(page);
        await page.waitFor(() => window.ecosysSync?.status === 'unpaired', { timeout: 15000, message: 'sync to find this browser unpaired' });
        await page.waitFor('[data-pairing]', { timeout: 5000, message: 'the pairing notice' });
        await settle(page, 500);
        assert.deepEqual(await notices(page), [NOTICE], 'one notice, in the agreed words');
        assert.equal(await page.evaluate((k) => localStorage.getItem(k), KEY), null, 'nothing stored');
        assert.ok((await page.text()).length > 50, 'the app is on screen, from its own copy');
        // It is dismissible, and stays dismissed on this page.
        await page.clickText('[data-pairing] button', 'Hide');
        await page.waitFor('[data-pairing]', { state: 'hidden', timeout: 3000 });
        await settle(page, 1500);
        assert.deepEqual(await notices(page), []);
        assert.deepEqual(otherErrors(page), [], formatErrors(otherErrors(page)));
      });
      const after = await server.state();
      assert.equal(after.rev, before.rev, 'the server got nothing from this browser');
      assert.equal(after.initialized, before.initialized);
    } finally {
      await page.close();
    }
  });

  test('the printed link pairs the browser, leaves the address bar and the history, and sync comes online', async () => {
    const { server } = ctx;
    const page = await unpairedTab(ctx);
    try {
      await withScreenshot(page, 'qa-pairing-link', async () => {
        const link = server.pairingLink('');
        assert.equal(link, `http://127.0.0.1:${server.port}/#pair=${server.secret}`, 'the link ecosys prints');
        await page.goto(link);
        await waitForApp(page);
        await waitForSync(page, 20000);
        assert.equal(await page.url(), server.url(''), 'the secret left the address bar');
        assert.equal(await page.evaluate((k) => localStorage.getItem(k), KEY), server.secret, 'and is kept for this browser');
        const { entries } = await page.send('Page.getNavigationHistory');
        assert.ok(entries.length > 0 && entries.every((e) => !e.url.includes(server.secret)), `no history entry holds it: ${entries.map((e) => e.url).join(', ')}`);
        assert.ok(!(await page.evaluate((s) => document.documentElement.outerHTML.includes(s), server.secret)), 'nor the page');
        await settle(page, 800);
        assert.deepEqual(await notices(page), [], 'no notice once paired');
        // Every app of this browser is connected now, the event stream too.
        await page.goto(server.url('schedule/'));
        await waitForApp(page);
        await waitForSync(page);
        assert.deepEqual(otherErrors(page), [], formatErrors(otherErrors(page)));
      });
    } finally {
      await page.close();
    }
  });

  test('a link to an app keeps the route after the secret', async () => {
    const { server } = ctx;
    const page = await unpairedTab(ctx);
    try {
      await withScreenshot(page, 'qa-pairing-route', async () => {
        await page.goto(`${server.url('tasks/')}#pair=${server.secret}&/today`);
        await waitForApp(page);
        await waitForSync(page, 20000);
        assert.equal(await page.url(), `${server.url('tasks/')}#/today`);
        assert.equal(await page.evaluate((k) => localStorage.getItem(k), KEY), server.secret);
      });
    } finally {
      await page.close();
    }
  });

  test('opened in a tab that is already showing ecosys, the link connects it without a reload; a wrong secret is refused first', async () => {
    const { server } = ctx;
    const page = await unpairedTab(ctx);
    try {
      await withScreenshot(page, 'qa-pairing-same-tab', async () => {
        // A link with a stale secret (another data folder's, say): stored, refused, forgotten, the notice.
        await page.goto(`${server.url('tasks/')}#pair=Stale_secret_of_another_folder_0123456789ab`);
        await waitForApp(page);
        await page.waitFor(() => window.ecosysSync?.status === 'unpaired', { timeout: 15000, message: 'the stale secret to be refused' });
        await page.waitFor('[data-pairing]', { timeout: 5000 });
        assert.equal(await page.evaluate((k) => localStorage.getItem(k), KEY), null, 'the refused secret is forgotten');
        assert.equal(await page.url(), server.url('tasks/'), 'and gone from the address bar');
        const marker = await page.evaluate(() => (window.__qaSameDocument = Math.random()));
        // The right link, opened in this very tab (only the hash changes: no reload).
        await page.goto(`${server.url('tasks/')}#pair=${server.secret}`);
        await waitForSync(page, 20000);
        assert.equal(await page.evaluate(() => window.__qaSameDocument), marker, 'the same page, not reloaded');
        assert.equal(await page.url(), server.url('tasks/'));
        await page.waitFor('[data-pairing]', { state: 'hidden', timeout: 3000, message: 'the notice to go once paired' });
        assert.equal(await status(page), 'online');
      });
    } finally {
      await page.close();
    }
  });

  test('visual: the notice in Light, Dim and Lights out, at 1440 and 390', async () => {
    const { server } = ctx;
    const shots = [];
    for (const [vw, vh, mobile] of [[1440, 900, false], [390, 844, true]]) {
      for (const theme of ['light', 'dim', 'dark']) {
        const page = await unpairedTab(ctx, { width: vw, height: vh, mobile });
        try {
          // Settings first (a page of this origin that runs no app), as a browser that chose this theme.
          await page.goto(server.url('shared/icons/ai.svg'));
          await page.evaluate((t) => localStorage.setItem('ecosys:v1:settings', JSON.stringify({ theme: t })), theme);
          await page.goto(server.url('tasks/'));
          await waitForApp(page);
          await page.waitFor('[data-pairing]', { timeout: 15000 });
          await settle(page, 700);
          const box = await page.evaluate(() => {
            const el = document.querySelector('[data-pairing]');
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return { left: r.left, right: r.right, bottom: r.bottom, width: r.width, vw: innerWidth, vh: innerHeight, color: cs.color, bg: cs.backgroundColor, theme: document.documentElement.dataset.theme, hideTarget: el.querySelector('button').getBoundingClientRect().height };
          });
          assert.equal(box.theme, theme);
          assert.ok(box.left >= 0 && box.right <= box.vw && box.bottom <= box.vh, `${theme} ${vw}: the notice fits the screen (${JSON.stringify(box)})`);
          assert.ok(box.hideTarget >= 24, `${theme} ${vw}: Hide is a real target (${box.hideTarget}px)`);
          assert.notEqual(box.color, box.bg);
          shots.push(await page.screenshot(artifactPath(`qa-pairing-notice-${theme}-${vw}.png`)));
        } finally {
          await page.close();
        }
      }
    }
    assert.equal(shots.length, 6);
  });
});
