// QA for what Home keeps now that it is an app launcher (the completeness review's list), against an isolated server:
//   quick actions  the jot box is gone, so Notes' icon has iOS-style quick actions: Quick note and Today's note, from a
//                  right-click, Shift+F10 (the context-menu key) or a long press on touch. The press that opens them
//                  never opens Notes, a tap still does, Escape puts focus back on Notes, and only Notes has them
//   N              opens Notes' Quick note sheet, and does nothing while single-key shortcuts are off
//   palette        Ctrl+K still has "Today's note" and "Quick note" on Home (the shell's shared Notes commands)
//   header         Search opens the palette, Appearance lists the four themes, Settings opens
//   time           the date and greeting move on past midnight (the tick and a return to the tab redraw them)
//   AI             read-only access is shown (the lock before "AI") and said in every state; never in write mode
//   contrast       names, captions, date and greeting keep 4.5:1 on the real backdrop in Light, Dim and Lights out,
//                  at 1440 and 390 (measured on a screenshot of the page with the words hidden)
//   pairing        the pairing link opens Home paired and leaves the address bar clean (once the server pairs)
// Home's console stays clean throughout (checked before each trip to Notes, whose page is not this file's subject).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useE2E, openApp, settle, waitForSync, withScreenshot, browserToday } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTES = '.launch-app[data-app="notes"]';
const MENU = '.menu.launch-actions';

/** Load Home afresh: what another app's page logged before is not Home's. */
async function openHome(page, server) {
  page.clearConsoleErrors();
  await openApp(page, server.url(''));
}
/** Home's console stayed clean (checked before leaving Home, and at the end of a test that stays there). */
function clean(page, when) {
  const errors = page.consoleErrors().map((e) => e.text);
  page.clearConsoleErrors();
  assert.deepEqual(errors, [], `console errors on Home (${when})`);
}
/** Notes' Quick note sheet (a dialog of that name) is open. */
const quickSheet = () => location.pathname === '/notes/' && !!document.querySelector('[role="dialog"][aria-label="Quick note"]');

/** The open quick-actions menu: its name, its items' names, and which of them has focus. */
const menuState = (page) =>
  page.evaluate((sel) => {
    const m = document.querySelector(sel);
    return m
      ? {
          label: m.querySelector('[role="menu"]')?.getAttribute('aria-label'),
          items: [...m.querySelectorAll('[role="menuitem"]')].map((b) => b.querySelector('.grow').textContent.trim()),
          focused: document.activeElement?.closest(sel) ? document.activeElement.querySelector('.grow')?.textContent.trim() : null,
        }
      : null;
  }, MENU);

const where = (page) => page.evaluate(() => ({ path: location.pathname, hash: location.hash }));
const status = (page, detail) => page.evaluate((d) => window.dispatchEvent(new CustomEvent('ecosys:ai', { detail: d })), detail);
const setSettings = (page, patch) => page.evaluate((p) => import('/shared/store.js').then((m) => m.settings.set(p)), patch);
const touch = (page, type, x, y) => page.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
const centre = (page, sel) =>
  page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);

/** Wait for the launcher's one-time entrance to end, so nothing moves under a click or a screenshot. */
const still = (page) => page.waitFor(() => document.getAnimations().every((a) => a.playState !== 'running'), { timeout: 5000, message: 'the entrance to end' });

describe('qa home: what the launcher keeps', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });

  test("Notes' quick actions: a right-click opens Quick note and Today's note, Escape returns to Notes, a pick opens it", async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-home-keeps-actions-mouse', async () => {
      await openHome(page, server);
      await still(page);
      await page.click(NOTES, { button: 'right' });
      await page.waitFor(MENU, { timeout: 4000 });
      assert.deepEqual(await menuState(page), { label: 'Notes quick actions', items: ['Quick note', "Today's note"], focused: 'Quick note' });
      assert.deepEqual(await where(page), { path: '/', hash: '' }, 'the right-click does not open Notes');
      assert.ok(await page.evaluate((s) => document.querySelector(s).classList.contains('actions-open'), NOTES), 'the icon stays picked up while its actions are open');

      await page.press('Escape');
      await page.waitFor((s) => !document.querySelector(s), { timeout: 3000, args: [MENU], message: 'the menu to close' });
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.app), 'notes', 'focus is back on Notes');
      assert.equal(await page.evaluate((s) => document.querySelector(s).classList.contains('actions-open'), NOTES), false);

      // Only Notes has quick actions: Tasks keeps the browser's own menu (its link's "Open in new tab").
      const tasksPrevented = await page.evaluate(() => !document.querySelector('.launch-app[data-app="tasks"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })));
      assert.equal(tasksPrevented, false, 'a right-click on Tasks is left to the browser');
      assert.equal(await page.exists(MENU), false);

      await page.click(NOTES, { button: 'right' });
      await page.waitFor(MENU, { timeout: 4000 });
      clean(page, 'quick actions by mouse');
      await page.clickText('menuitem', "Today's note");
      const today = await browserToday(page);
      await page.waitFor((d) => location.pathname === '/notes/' && (location.hash === '#/today' || location.hash.startsWith(`#/day/${d}`)), { timeout: 10000, args: [today], message: "Notes to open on today's note" });
    });
  });

  test('keyboard: Shift+F10 on Notes opens its quick actions, Enter on Quick note opens the capture sheet', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-home-keeps-actions-keys', async () => {
      await openHome(page, server);
      await page.evaluate((s) => document.querySelector(s).focus(), NOTES);
      await page.press('Shift+F10');
      await page.waitFor(MENU, { timeout: 4000, message: 'Shift+F10 to open the quick actions' });
      assert.equal((await menuState(page)).focused, 'Quick note', 'focus moves to the first action');
      await page.press('ArrowDown');
      assert.equal((await menuState(page)).focused, "Today's note");
      await page.press('ArrowUp');
      clean(page, 'quick actions by keyboard');
      await page.press('Enter');
      await page.waitFor(quickSheet, { timeout: 10000, message: "Notes' Quick note sheet" });
    });
  });

  test('touch: a long press on Notes opens its quick actions and stays on Home; a tap still opens Notes', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-home-keeps-actions-touch', async () => {
      await page.setViewport(390, 844, true);
      await openHome(page, server);
      await still(page);
      const p = await centre(page, `${NOTES} .launch-icon`);
      await touch(page, 'touchStart', p.x, p.y);
      // Held past the 500 ms long press: the actions open while the finger is still down.
      await page.waitFor(MENU, { timeout: 4000, message: 'a long press to open the quick actions' });
      await sleep(250);
      await touch(page, 'touchEnd');
      await settle(page, 600);
      assert.deepEqual(await where(page), { path: '/', hash: '' }, 'lifting the finger after a long press does not open Notes');
      assert.deepEqual((await menuState(page)).items, ['Quick note', "Today's note"]);

      // A tap outside closes them, and then a short tap on Notes opens it, as before.
      await touch(page, 'touchStart', 30, 160);
      await touch(page, 'touchEnd');
      await page.waitFor((s) => !document.querySelector(s), { timeout: 3000, args: [MENU], message: 'a tap outside to close the actions' });
      clean(page, 'quick actions by touch');
      await touch(page, 'touchStart', p.x, p.y);
      await sleep(60);
      await touch(page, 'touchEnd');
      await page.waitFor(() => location.pathname === '/notes/', { timeout: 10000, message: 'a tap to open Notes' });
    });
    await page.setViewport(1440, 900, false);
  });

  test('N opens a quick note, and does nothing while single-key shortcuts are off', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-home-keeps-n', async () => {
      await openHome(page, server);
      await page.evaluate(() => document.activeElement?.blur());
      clean(page, 'before N');
      await page.press('n');
      await page.waitFor(quickSheet, { timeout: 10000, message: "N to open Notes' Quick note sheet" });

      await openHome(page, server);
      await setSettings(page, { shellSingleKeys: false });
      try {
        await page.evaluate(() => document.activeElement?.blur());
        await page.press('n');
        await settle(page, 700);
        assert.deepEqual(await where(page), { path: '/', hash: '' }, 'single-key shortcuts are off (Settings › Keyboard)');
        // The way to the quick actions from a keyboard is not a single key, so it still works.
        await page.evaluate((s) => document.querySelector(s).focus(), NOTES);
        await page.press('Shift+F10');
        await page.waitFor(MENU, { timeout: 4000 });
        assert.equal(await page.evaluate((s) => !!document.querySelector(`${s} .hint .keys`), MENU), false, 'the menu shows no N while N does nothing');
        await page.press('Escape');
      } finally {
        await setSettings(page, { shellSingleKeys: true });
      }
      clean(page, 'N with single keys off');
    });
  });

  test("the palette still has Today's note and Quick note on Home", async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-home-keeps-palette', async () => {
      await openHome(page, server);
      const rows = async (q) => {
        await page.evaluate(() => document.activeElement?.blur());
        await page.press('Control+k');
        await page.waitFor(() => document.activeElement?.matches('.palette input'), { timeout: 4000, message: 'the palette to open' });
        await page.type(q);
        await page.waitFor(() => document.querySelector('.palette-list [data-r].hl, .palette-empty'), { timeout: 4000 });
        const out = await page.evaluate(() => [...document.querySelectorAll('.palette-list [data-r]')].map((b) => b.querySelector('.grow').textContent.replace(/\s+/g, ' ').trim()));
        await page.press('Escape');
        await page.waitFor(() => !document.querySelector('.palette'), { timeout: 3000 });
        return out;
      };
      assert.ok((await rows("today's note")).includes("Today's note"), 'Ctrl+K “today’s note”');
      assert.ok((await rows('quick note')).includes('Quick note'), 'Ctrl+K “quick note”');
      clean(page, 'palette');
    });
  });

  test('the header: Search opens the palette, Appearance lists the four themes, Settings opens', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-home-keeps-header', async () => {
      await openHome(page, server);
      await page.clickText('button', 'Search');
      await page.waitFor(() => document.activeElement?.matches('.palette input'), { timeout: 4000, message: 'Search to open the palette' });
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.palette'), { timeout: 3000 });

      await page.clickText('button', 'Appearance');
      await page.waitFor('.appearance-menu [role="menuitemradio"]', { timeout: 4000 });
      const themes = await page.evaluate(() => [...document.querySelectorAll('.appearance-menu [role="menuitemradio"]')].map((b) => b.querySelector('.grow').textContent.trim()));
      assert.deepEqual(themes, ['Automatic', 'Light', 'Dim', 'Lights out']);
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.appearance-menu'), { timeout: 3000 });

      await page.clickText('button', 'Settings');
      await page.waitFor('.modal.settings', { timeout: 4000, message: 'Settings to open' });
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.modal.settings'), { timeout: 3000 });
      clean(page, 'header');
    });
  });

  test('the date and the greeting move on past midnight', async () => {
    const { page, server } = ctx;
    await openHome(page, server);
    const shown = () => page.evaluate(() => ({ datetime: document.querySelector('[data-date]').getAttribute('datetime'), hello: document.querySelector('[data-greeting]').textContent }));
    assert.equal((await shown()).datetime, await browserToday(page));
    // Half a minute past the next midnight, then back to the tab (the same redraw the 30 s tick does).
    const tomorrow = await page.evaluate(() => {
      const Real = Date;
      const at = new Real();
      at.setDate(at.getDate() + 1);
      at.setHours(0, 0, 30, 0);
      const offset = at.getTime() - Real.now();
      window.__qaRealDate = Real;
      window.Date = class extends Real {
        constructor(...a) {
          super(...(a.length ? a : [Real.now() + offset]));
        }
        static now() {
          return Real.now() + offset;
        }
      };
      document.dispatchEvent(new Event('visibilitychange'));
      return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    });
    try {
      assert.deepEqual(await shown(), { datetime: tomorrow, hello: 'Hello, night owl' });
    } finally {
      await page.evaluate(() => {
        window.Date = window.__qaRealDate;
      });
    }
    clean(page, 'midnight');
  });

  test('AI: read-only access shows the lock before "AI" and is said in every state, never in write mode', async () => {
    const { page, server } = ctx;
    const claude = { id: 'c1', kind: 'claude', label: 'Claude Desktop' };
    await withScreenshot(page, 'qa-home-keeps-ai-read-only', async () => {
      await openHome(page, server);
      await page.waitFor(() => document.querySelector('[data-ai-status]')?.textContent.trim(), { timeout: 8000, message: 'the AI status' });
      const steps = [
        [{ mode: 'read', clients: [] }, 'Connect', 'AI assistants, Connect Claude, ChatGPT or Grok, read only', true],
        [{ mode: 'read', clients: [{ ...claude, connected: false }] }, 'Ready', 'AI assistants, Ready for Claude, read only', true],
        [{ mode: 'read', clients: [{ ...claude, connected: true }] }, 'Claude', 'AI assistants, Claude is connected, read only', true],
        [{ mode: 'write', clients: [{ ...claude, connected: true }] }, 'Claude', 'AI assistants, Claude is connected', false],
        [{ mode: 'off', clients: [{ ...claude, connected: false }] }, 'Off', 'AI assistants, Off: AI access is turned off', false],
        [{ mode: 'write', clients: [] }, 'Connect', 'AI assistants, Connect Claude, ChatGPT or Grok', false],
      ];
      for (const [st, text, name, lock] of steps) {
        await status(page, { type: 'status', ...st });
        await page.waitFor((t, n) => document.querySelector('[data-ai-status] .launch-cap-text')?.textContent === t && document.querySelector('.launch-app[data-app="ai"]').getAttribute('aria-label') === n, { timeout: 4000, args: [text, name], message: `“${name}”` });
        const s = await page.evaluate(() => {
          const f = document.querySelector('.launch-app[data-app="ai"] [data-ai-flag]');
          return { lock: !f.hidden && f.getBoundingClientRect().width > 0, glyph: !!f.querySelector('svg[aria-hidden="true"]'), name: document.querySelector('.launch-app[data-app="ai"] .launch-name').textContent };
        });
        assert.equal(s.lock, lock, `${st.mode}, "${text}": the lock is ${lock ? 'shown' : 'hidden'}`);
        assert.ok(s.glyph, 'the lock is decoration (the name says it)');
        assert.equal(s.name, 'AI', 'the visible name stays "AI"');
      }
      clean(page, 'AI read only');
    });
  });

  test('names, captions, date and greeting keep 4.5:1 on the backdrop in Light, Dim and Lights out', async () => {
    const { page, server } = ctx;
    const all = [];
    for (const theme of ['light', 'dim', 'dark']) {
      for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
        await page.setViewport(w, h, mobile);
        await openHome(page, server);
        await setSettings(page, { theme });
        await page.waitFor((t) => document.documentElement.dataset.theme === t, { timeout: 4000, args: [theme] });
        await still(page);
        for (const st of [{ mode: 'write', clients: [] }, { mode: 'write', clients: [{ id: 'c3', kind: 'grok', label: 'Grok CLI', connected: false }] }]) {
          await status(page, { type: 'status', ...st });
          await page.waitFor((t) => document.querySelector('[data-ai-status] .launch-cap-text')?.textContent === t, { timeout: 4000, args: [st.clients.length ? 'Ready' : 'Connect'] });
          await settle(page, 350); // the caption fades in
          const items = await page.evaluate(() => {
            const rgb = (css) => {
              const k = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
              k.fillStyle = '#000';
              k.fillStyle = css;
              k.fillRect(0, 0, 1, 1);
              return [...k.getImageData(0, 0, 1, 1).data.slice(0, 3)];
            };
            const els = [['date', document.querySelector('[data-date]')], ['greeting', document.querySelector('[data-greeting]')], ...[...document.querySelectorAll('.launch-app')].map((a) => [`${a.dataset.app} name`, a.querySelector('.launch-name')]), ['AI caption', document.querySelector('[data-ai-status] .launch-cap-text')]];
            return els.map(([what, el]) => {
              const range = document.createRange();
              range.selectNodeContents(el);
              const r = range.getBoundingClientRect();
              return { what, rgb: rgb(getComputedStyle(el).color), box: { x: r.left, y: r.top, w: r.width, h: r.height } };
            });
          });
          // The backdrop under the words: the same page with the words (and the caption's dot and glyph) hidden.
          await page.evaluate(() => {
            const s = document.createElement('style');
            s.id = 'qa-hide-words';
            s.textContent = '.home-date, .home-greeting, .launch-name, .launch-cap { color: transparent !important; } .launch-flag, .launch-dot, .launch-cap svg { visibility: hidden !important; }';
            document.head.append(s);
          });
          await settle(page, 120);
          const { data } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
          await page.evaluate(() => document.getElementById('qa-hide-words')?.remove());
          const measured = await page.evaluate(
            async (png, list) => {
              const img = new Image();
              img.src = `data:image/png;base64,${png}`;
              await img.decode();
              const c = document.createElement('canvas');
              c.width = img.naturalWidth;
              c.height = img.naturalHeight;
              const g = c.getContext('2d', { willReadFrequently: true });
              g.drawImage(img, 0, 0);
              const k = img.naturalWidth / innerWidth;
              const lum = (p) => {
                const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
                return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
              };
              const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
              return list.map((it) => {
                const d = g.getImageData(Math.round(it.box.x * k), Math.round(it.box.y * k), Math.max(1, Math.round(it.box.w * k)), Math.max(1, Math.round(it.box.h * k))).data;
                let min = Infinity;
                for (let i = 0; i < d.length; i += 4) min = Math.min(min, ratio(it.rgb, [d[i], d[i + 1], d[i + 2]]));
                return { what: it.what, ratio: Math.round(min * 100) / 100 };
              });
            },
            data,
            items,
          );
          for (const m of measured) all.push({ ...m, where: `${theme} ${w}px${st.clients.length ? ' (Ready)' : ''}` });
        }
        clean(page, `contrast, ${theme} ${w}px`);
      }
    }
    await page.setViewport(1440, 900, false);
    await setSettings(page, { theme: 'light' });
    const low = all.filter((m) => m.ratio < 4.5);
    assert.deepEqual(low, [], `below 4.5:1: ${low.map((m) => `${m.where} ${m.what} ${m.ratio}`).join('; ')}`);
  });

  test('the pairing link opens Home paired, with the secret out of the address bar', async (t) => {
    const { browser, server } = ctx;
    const file = join(server.dataDir, 'pair.json');
    if (!existsSync(file)) return t.skip('this server does not pair browsers yet (no pair.json in its data folder)');
    const { secret } = JSON.parse(readFileSync(file, 'utf8'));
    // A browser that never saw the link (the harness pairs its tabs unless told not to).
    const fresh = await browser.newPage({ isolated: true, pair: false });
    try {
      await fresh.goto(server.url(`#pair=${secret}`));
      await waitForSync(fresh);
      const s = await fresh.evaluate(() => ({ href: location.href, hash: location.hash, kept: localStorage.getItem('ecosys:v1:pair'), apps: document.querySelectorAll('.launch-app').length }));
      assert.equal(s.hash, '', 'the secret is taken out of the address bar');
      assert.ok(!s.href.includes(secret));
      assert.equal(s.kept, secret, 'this browser is paired');
      assert.equal(s.apps, 4, 'Home shows the apps');
      assert.deepEqual(fresh.consoleErrors().map((e) => e.text), [], 'console errors on the paired Home');
    } finally {
      await fresh.close();
    }
  });
});
