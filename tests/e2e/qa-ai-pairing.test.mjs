// QA (ai): Connect AI and browser pairing (lead decision 1). shared/ai.js sends shared/pair.js apiHeaders() with
// every /api request, and a browser ecosys doesn't know is told how to connect it instead of meeting an error:
//   unpaired   sync heard it: Connect AI explains it in the pairing notice's words and says where the link starts,
//              asks for nothing that would be refused (no /api/ai request, no 403), and its status says 'unpaired'
//   paired     the link opened in another tab: the sheet loads by itself, and every request sent the secret
//   refused    a request of the sheet's own is refused (a stale secret) while sync stays online: the sheet explains,
//              no raw error toast, nothing changed on the server, and it loads again once the link is opened
// The isolated server pairs browsers (it keeps the secret in <data folder>/pair.json); the test skips otherwise.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useE2E, openApp, waitForApp, settle, withScreenshot, formatErrors } from './helpers.mjs';

const KEY = 'ecosys:v1:pair';
const NOTICE = 'This browser isn’t connected to ecosys on this computer. Open the link shown where ecosys is running to connect it.';

/** The isolated server's pairing secret: the harness's (server.secret), else <data folder>/pair.json. */
function pairSecret(server) {
  for (const k of ['secret', 'pairSecret', 'pairingSecret']) if (typeof server[k] === 'string' && server[k]) return server[k];
  try {
    return JSON.parse(readFileSync(join(server.dataDir, 'pair.json'), 'utf8')).secret || null;
  } catch {
    return null;
  }
}
/** server.api() with the pairing secret (sending it again once the harness does is harmless). */
const api = (server, path, opts = {}) => {
  const s = pairSecret(server);
  return server.api(path, { ...opts, headers: { ...(s ? { 'X-Ecosys': s } : {}), ...(opts.headers || {}) } });
};
/** A page of this origin that runs no app (to reach its localStorage before an app loads). */
const blank = (page, server) => page.goto(server.url('shared/icons/ai.svg'));
/** Console errors, less the favicon.ico Chrome asks for on that image page (not ecosys's). */
const consoleErrors = (page) => page.consoleErrors().filter((e) => !/favicon\.ico/.test(`${e.text} ${e.url || ''}`));
/** Open `path` as a paired browser: the secret is stored first, as opening the pairing link does. */
async function openPaired(page, server, path) {
  await blank(page, server);
  await page.evaluate((k, s) => localStorage.setItem(k, s), KEY, pairSecret(server));
  return openApp(page, server.url(path));
}
/** Open `path` as a browser ecosys doesn't know, and wait until sync has heard so. */
async function openUnpaired(page, server, path) {
  await blank(page, server);
  await page.evaluate((k) => localStorage.removeItem(k), KEY);
  await page.goto(server.url(path));
  await waitForApp(page);
  await page.waitFor(() => window.ecosysSync?.status === 'unpaired', { timeout: 10000, message: 'sync to find this browser unpaired' });
  await settle(page, 300);
}
/** "Another tab opened the pairing link": the secret lands in localStorage and this tab hears of it. */
const pairFromAnotherTab = (page, secret) =>
  page.evaluate(
    (k, s) => {
      localStorage.setItem(k, s);
      window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: s, storageArea: localStorage }));
    },
    KEY,
    secret,
  );

// Every /api request the page makes, with the X-Ecosys header it carried (installed before the page's scripts).
const RECORD = `(() => {
  const real = window.fetch.bind(window);
  window.__qaApi = [];
  window.fetch = (input, init = {}) => {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname.startsWith('/api/')) {
        const h = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined) || undefined);
        window.__qaApi.push({ path: url.pathname, method: String(init.method || 'GET').toUpperCase(), key: h.get('X-Ecosys') });
      }
    } catch {}
    return real(input, init);
  };
})();`;
const aiCalls = (page) => page.evaluate(() => (window.__qaApi || []).filter((r) => r.path.startsWith('/api/ai')));
const openPanel = (page) =>
  page.evaluate(() => {
    import('/shared/ai.js').then((m) => m.openAIPanel());
    return true;
  });
const sheetText = (page) => page.evaluate(() => document.querySelector('.modal.ai-panel')?.innerText || '');
const toastsText = (page) => page.evaluate(() => [...document.querySelectorAll('.toasts .toast:not([data-pairing]) .toast-msg')].map((t) => t.textContent).join(' | '));

describe('QA ai: Connect AI in a browser ecosys doesn’t know yet (pairing)', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let secret = null;

  test('unpaired: Connect AI explains how to connect this browser and asks nothing that would be refused', async (t) => {
    secret = pairSecret(ctx.server);
    if (!secret) return t.skip('this server does not pair browsers (no pair.json)');
    // A browser that never saw the pairing link (the harness pairs its tabs unless told not to).
    const page = await ctx.browser.newPage({ isolated: true, pair: false });
    try {
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORD });
      await withScreenshot(page, 'qa-ai-pairing-unpaired', async () => {
        await openUnpaired(page, ctx.server, 'tasks/');
        await openPanel(page);
        await page.waitFor(() => /Connect this browser to ecosys/.test(document.querySelector('.modal.ai-panel .ai-hero-title')?.textContent || ''), {
          timeout: 8000,
          message: 'Connect AI to explain that this browser isn’t connected',
        });
        const text = await sheetText(page);
        assert.ok(text.includes(NOTICE), `the sheet says what the pairing notice says (got: ${text.slice(0, 300)})`);
        const origin = new URL(ctx.server.url('')).origin;
        assert.ok(text.includes(`${origin}/#pair=`), 'it shows how the pairing link starts');
        assert.ok(!/Can’t reach ecosys|isn’t answering/.test(text), 'it does not claim ecosys is down: ecosys runs, it just doesn’t know this browser');
        const st = await page.evaluate(() => import('/shared/ai.js').then((m) => m.aiStatus()));
        assert.equal(st.online, false);
        assert.equal(st.reason, 'unpaired', 'the AI status says why: unpaired');
        assert.deepEqual(await aiCalls(page), [], 'no /api/ai request was made: it would only have been refused');
        const errs = consoleErrors(page);
        assert.equal(errs.length, 0, `no console errors (no 403s):\n${formatErrors(errs)}`);
      });

      await withScreenshot(page, 'qa-ai-pairing-paired', async () => {
        await pairFromAnotherTab(page, secret);
        await page.waitFor(() => document.querySelectorAll('.modal.ai-panel .ai-row').length === 4, {
          timeout: 15000,
          message: 'the sheet to load by itself once this browser is connected',
        });
        await page.waitFor(() => window.ecosysSync?.status === 'online', { timeout: 10000, message: 'sync to come online' });
        const calls = await aiCalls(page);
        assert.ok(calls.length > 0, 'the sheet asked ecosys once it was connected');
        assert.deepEqual(
          calls.filter((c) => c.key !== secret),
          [],
          'every /api/ai request carried the pairing secret (shared/pair.js apiHeaders()), never the legacy "1"',
        );
        const st = await page.evaluate(() => import('/shared/ai.js').then((m) => m.aiStatus()));
        assert.equal(st.online, true, 'the AI status is back online');
        assert.equal(consoleErrors(page).length, 0, `no console errors:\n${formatErrors(consoleErrors(page))}`);
      });
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('refused: a request of the sheet’s own is refused while sync stays online, and it recovers once paired', async (t) => {
    if (!secret) return t.skip('this server does not pair browsers (no pair.json)');
    const page = await ctx.browser.newPage({ isolated: true });
    try {
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORD });
      await withScreenshot(page, 'qa-ai-pairing-refused', async () => {
        await openPaired(page, ctx.server, 'tasks/');
        await openPanel(page);
        await page.waitFor(() => document.querySelectorAll('.modal.ai-panel .ai-row').length === 4, { timeout: 10000, message: 'Connect AI to load' });
        // The stored secret goes stale (as when the data folder's secret was made anew); sync's stream stays open.
        await page.evaluate((k) => localStorage.setItem(k, 'stale_secret_0123456789abcdefghijklmnop'), KEY);
        await page.clickText('button', 'Read only');
        await page.waitFor(() => /Connect this browser to ecosys/.test(document.querySelector('.modal.ai-panel .ai-hero-title')?.textContent || ''), {
          timeout: 8000,
          message: 'the sheet to explain that this browser isn’t connected',
        });
        assert.equal(await page.evaluate(() => window.ecosysSync?.status), 'online', 'sync never heard of it (its stream opened before)');
        assert.equal(await page.evaluate((k) => localStorage.getItem(k)), null, 'the refused secret is forgotten (pair.js markRejected)');
        const toasts = await toastsText(page);
        assert.doesNotMatch(toasts, /pairing_required|Couldn’t change AI access/, `no raw error toast (toasts: ${toasts || 'none'})`);
        const st = await api(ctx.server, 'api/ai/status');
        assert.equal(st.json?.mode, 'write', 'nothing changed on the server');

        // The pairing link opened in another tab: the sheet loads again by itself, though sync never went offline.
        await pairFromAnotherTab(page, secret);
        await page.waitFor(() => document.querySelectorAll('.modal.ai-panel .ai-row').length === 4, { timeout: 10000, message: 'the sheet to load again once paired' });
        const pressed = await page.evaluate(() => document.querySelector('.ai-access [aria-pressed="true"]')?.textContent.trim());
        assert.equal(pressed, 'Read & write', 'it shows the server’s AI access, unchanged');
        const st2 = await page.evaluate(() => import('/shared/ai.js').then((m) => m.aiStatus()));
        assert.equal(st2.online, true);
        // The one refused request is the only console error: Chrome logs the 403 it got.
        const errs = consoleErrors(page).filter((e) => !/status of 403/.test(e.text));
        assert.equal(errs.length, 0, `no other console errors:\n${formatErrors(errs)}`);
      });
    } finally {
      await page.close().catch(() => {});
    }
  });
});
