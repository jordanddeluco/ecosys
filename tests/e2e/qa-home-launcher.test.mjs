// QA for Home as an app launcher (index.html, home.js, home.css), against an isolated server. Replaces
// qa-home-tiles.test.mjs and qa-home-cross.test.mjs, whose tiles are gone:
//   apps        Tasks, Schedule and Notes are links to their start pages, AI is a button that opens Connect AI; every
//               icon is the app's logo (no text in it); the header has no app switcher (the page is the switcher)
//   AI caption  Connect (with the plug), one assistant, "Claude +1" for two (never cut off on a phone), Ready, Off;
//               the button's accessible name starts with the visible words; Home never asks api/ai (the keys)
//   keyboard    Tab reaches brand, Search, Appearance, Settings, then the apps; arrows move between them; Enter on AI
//               opens Connect AI (with the AI logo in its header) and Escape brings focus back
//   themes      nothing animates forever in Light, Dim or Lights out; Lights out is black; no glow on the greeting
//   phones      four across at 390 and 320 with no sideways scroll; at 620 the four stay one group
//   motion      Reduce motion: no entrance and nothing running
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot } from './helpers.mjs';

const capOf = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('[data-ai-status]');
    const t = c.querySelector('.launch-cap-text');
    return { text: t?.textContent ?? '', tone: c.dataset.tone || '', dot: !!c.querySelector('.launch-dot'), plug: !!c.querySelector('svg'), clipped: !!t && t.scrollWidth > t.clientWidth + 0.5 };
  });
const aiName = (page) => page.evaluate(() => document.querySelector('.launch-app[data-app="ai"]').getAttribute('aria-label'));
const status = (page, detail) => page.evaluate((d) => window.dispatchEvent(new CustomEvent('ecosys:ai', { detail: d })), detail);
const CLIENT = { claude: { id: 'c1', kind: 'claude', label: 'Claude Desktop' }, chatgpt: { id: 'c2', kind: 'chatgpt', label: 'ChatGPT' }, grok: { id: 'c3', kind: 'grok', label: 'Grok CLI' } };

describe('qa home: the app launcher', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });

  test('the apps: links to their start pages, AI opens Connect AI, every icon is a logo, no switcher', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-home-launcher-apps', async () => {
      await openApp(page, server.url(''));
      const s = await page.evaluate(() => ({
        list: !!document.querySelector('nav[aria-label="Apps"] > ul[role="list"]'),
        apps: [...document.querySelectorAll('.launch-app')].map((a) => [a.dataset.app, a.tagName, a.getAttribute('href'), a.hasAttribute('data-open-ai'), a.getAttribute('aria-haspopup')]),
        logos: [...document.querySelectorAll('.launch-icon')].map((i) => !!i.querySelector('svg[viewBox="0 0 64 64"] rect[width="64"]') && !i.querySelector('text')),
        switcher: !!document.querySelector('[data-app-switcher]'),
        greetingGlow: getComputedStyle(document.querySelector('.home-greeting')).textShadow,
      }));
      assert.ok(s.list, 'nav[aria-label=Apps] > ul[role=list]');
      assert.deepEqual(s.apps, [
        ['tasks', 'A', '/tasks/', false, null],
        ['schedule', 'A', '/schedule/', false, null],
        ['notes', 'A', '/notes/', false, null],
        ['ai', 'BUTTON', null, true, 'dialog'],
      ]);
      assert.deepEqual(s.logos, [true, true, true, true], 'each icon is a 64-grid logo with no text in it');
      assert.equal(s.switcher, false, 'Home is the switcher: no switcher button in its header');
      assert.equal(s.greetingGlow, 'none', 'the greeting is plain type');
    });
  });

  test('the AI caption: Connect, one, "Claude +1", Ready and Off, named by its visible words, never cut off', async () => {
    const { page, server } = ctx;
    for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true], [320, 640, true]]) {
      await withScreenshot(page, `qa-home-launcher-ai-${w}`, async () => {
        await page.setViewport(w, h, mobile);
        await openApp(page, server.url(''));
        await page.waitFor(() => document.querySelector('[data-ai-status]')?.textContent.trim(), { timeout: 8000, message: 'the AI status' });
        const steps = [
          [{ mode: 'write', clients: [] }, 'Connect', 'AI assistants, Connect Claude, ChatGPT or Grok'],
          [{ mode: 'write', clients: [{ ...CLIENT.claude, connected: true }] }, 'Claude', 'AI assistants, Claude is connected'],
          [{ mode: 'read', clients: [{ ...CLIENT.claude, connected: true }, { ...CLIENT.chatgpt, connected: true }] }, 'Claude +1', 'AI assistants, Claude and ChatGPT are connected, read only'],
          [{ mode: 'write', clients: [{ ...CLIENT.grok, connected: false }] }, 'Ready', 'AI assistants, Ready for Grok'],
          [{ mode: 'off', clients: [{ ...CLIENT.grok, connected: false }] }, 'Off', 'AI assistants, Off: AI access is turned off'],
        ];
        for (const [st, text, name] of steps) {
          await status(page, { type: 'status', ...st });
          await page.waitFor((t) => document.querySelector('[data-ai-status] .launch-cap-text')?.textContent === t, { timeout: 4000, args: [text], message: `the caption "${text}"` });
          const c = await capOf(page);
          assert.equal(c.clipped, false, `${w}px: "${text}" fits its cell`);
          assert.equal(c.dot, ['Claude', 'Claude +1'].includes(text), `${w}px: a green dot only while connected`);
          assert.equal(c.plug, text === 'Connect', `${w}px: the plug only before Connect`);
          assert.equal(await aiName(page), name);
        }
      });
    }
    await page.setViewport(1440, 900, false);
  });

  test('Home never asks GET /api/ai (the keys) for its caption', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url(''));
    await page.waitFor(() => document.querySelector('[data-ai-status]')?.textContent.trim(), { timeout: 8000, message: 'the AI status' });
    await settle(page, 1500);
    // The status may also arrive by the live event stream; whatever Home fetches, it is only the status route.
    const calls = await page.evaluate(() => [...new Set(performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => p.startsWith('/api/ai')))]);
    assert.deepEqual(calls.filter((p) => p !== '/api/ai/status'), [], `Home asked ${calls.join(', ')}`);
  });

  test('keyboard: Tab order, arrows, Enter on AI opens Connect AI and Escape brings focus back', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-home-launcher-keys', async () => {
      await openApp(page, server.url(''));
      await page.evaluate(() => document.activeElement?.blur());
      const order = [];
      for (let i = 0; i < 8; i++) {
        await page.press('Tab');
        order.push(await page.evaluate(() => document.activeElement?.dataset?.app || document.activeElement?.getAttribute('aria-label')));
      }
      assert.deepEqual(order, ['ecosys home', 'Search', 'Appearance', 'Settings', 'tasks', 'schedule', 'notes', 'ai']);
      await page.evaluate(() => document.querySelector('.launch-app[data-app="tasks"]').focus());
      const moves = [];
      for (const k of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'ArrowUp']) {
        await page.press(k);
        moves.push(await page.evaluate(() => document.activeElement?.dataset?.app));
      }
      assert.deepEqual(moves, ['schedule', 'notes', 'ai', 'tasks', 'ai', 'tasks', 'ai', 'notes'], 'one row: Down and Up move along it, and wrap');
      await page.evaluate(() => document.querySelector('.launch-app[data-app="ai"]').focus());
      await page.press('Enter');
      await page.waitFor('.modal.ai-panel .ai-head .ai-head-logo svg', { timeout: 8000 });
      await settle(page, 400);
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.modal.ai-panel') && document.activeElement?.dataset?.app === 'ai', { timeout: 5000, message: 'Connect AI to close and focus to return to AI' });
    });
  });

  test('themes: nothing animates forever, Lights out is black', async () => {
    const { page, server } = ctx;
    for (const theme of ['light', 'dim', 'dark']) {
      await openApp(page, server.url(''));
      await page.evaluate((t) => import('/shared/store.js').then((m) => m.settings.set({ theme: t })), theme);
      await settle(page, 1500);
      const s = await page.evaluate(() => ({
        forever: document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations === Infinity).length,
        bg: getComputedStyle(document.body).backgroundColor,
      }));
      assert.equal(s.forever, 0, `${theme}: no endless animation`);
      if (theme === 'dark') assert.equal(s.bg, 'rgb(0, 0, 0)', 'Lights out is black');
    }
    await page.evaluate(() => import('/shared/store.js').then((m) => m.settings.set({ theme: 'light' })));
  });

  test('phones keep four across with no sideways scroll; a narrow window keeps the four together', async () => {
    const { page, server } = ctx;
    for (const [w, h, mobile] of [[390, 844, true], [320, 640, true], [620, 900, false]]) {
      await page.setViewport(w, h, mobile);
      await openApp(page, server.url(''));
      // Layout boxes (offset*), not client rects: the one-time entrance moves the icons with transforms.
      const g = await page.evaluate(() => {
        const r = [...document.querySelectorAll('.launch-icon')].map((i) => {
          let x = 0;
          let y = 0;
          for (let n = i; n; n = n.offsetParent) {
            x += n.offsetLeft;
            y += n.offsetTop;
          }
          return { left: x, right: x + i.offsetWidth, top: y };
        });
        return { rows: new Set(r.map((b) => b.top)).size, gaps: r.slice(1).map((b, i) => b.left - r[i].right), wide: document.documentElement.scrollWidth - innerWidth };
      });
      assert.equal(g.rows, 1, `${w}px: one row of four`);
      assert.ok(g.wide <= 0, `${w}px: no sideways scroll`);
      assert.ok(Math.max(...g.gaps) <= 40, `${w}px: the icons stay one group (gaps ${g.gaps})`);
    }
    await page.setViewport(1440, 900, false);
  });

  test('Reduce motion: no entrance and nothing running', async () => {
    const { page, server } = ctx;
    await page.emulateMedia({ 'prefers-reduced-motion': 'reduce' });
    await openApp(page, server.url(''));
    const a = await page.evaluate(() => ({ entrance: getComputedStyle(document.querySelector('.launch-app')).animationName, running: document.getAnimations().length }));
    assert.deepEqual(a, { entrance: 'none', running: 0 });
    await page.emulateMedia({ 'prefers-reduced-motion': 'no-preference' });
  });

  test('no console errors on Home', async () => {
    const { page } = ctx;
    assert.deepEqual(page.consoleErrors().map((e) => e.text), []);
  });
});
