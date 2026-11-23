// QA (ai): the AI status inside the apps (finding "Tasks, Schedule and Notes show no AI status"), and two smaller
// Connect AI items. initAI() puts renderAIChip() in the sidebar's head of Tasks, Schedule and Notes, beside the
// app switcher:
//   hidden    nothing set up: no button, and the head's Tab order is unchanged (brand menu, then the switcher)
//   ready     a connection set up: the AI glyph appears live, named "AI assistants, Ready for Claude"
//   on        an assistant connected: the glyph's docked circle is lit in the success colour, "… Claude is connected"
//   read/off  AI access read only says so; Off shows the struck-through glyph, "AI access is off"
//   quiet     ten minutes after a connection's last request it reads as not connected, with no reload (the server
//             sends nothing when a connection goes quiet)
//   opens     pressing it opens Connect AI, and Escape gives focus back to it
//   apps      Schedule and Notes have it too; on a phone it is in the drawer's head
//   toast     changing a connection's access says web connectors may need a refresh (server's request)
//   alert     the tunnel address error line uses the alert glyph, not the info one (icon audit)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useE2E, openApp, settle, withScreenshot, served, formatErrors } from './helpers.mjs';

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
/** Open `path` as a paired browser: the secret is stored first, as opening the pairing link does. */
async function openPaired(page, server, path) {
  const s = pairSecret(server);
  if (s) {
    await page.goto(server.url('shared/icons/ai.svg'));
    await page.evaluate((s) => localStorage.setItem('ecosys:v1:pair', s), s);
  }
  return openApp(page, server.url(path));
}
const consoleErrors = (page) => page.consoleErrors().filter((e) => !/favicon\.ico/.test(`${e.text} ${e.url || ''}`));

async function mcp(server, token, method, params = {}) {
  const notification = method.startsWith('notifications/');
  const res = await fetch(server.url('mcp'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notification ? {} : { id: Math.floor(Math.random() * 1e9) }) }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  assert.ok(res.status < 400, `MCP ${method} answered ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
async function setMode(server, mode) {
  const r = await api(server, 'api/ai/mode', { method: 'POST', body: { mode } });
  assert.equal(r.status, 200, r.text);
}

/** The status button as a person meets it (null when there is none to see). */
const button = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('.sidebar .side-head .ai-side');
    const b = host?.querySelector('.ai-chip');
    if (!host || host.hidden || !b || !b.offsetParent) return host ? { hidden: true } : null;
    const circle = b.querySelector('svg circle');
    const probe = document.createElement('span');
    probe.style.color = 'var(--success)';
    b.append(probe);
    const success = getComputedStyle(probe).color;
    probe.remove();
    return {
      hidden: false,
      label: b.getAttribute('aria-label'),
      tip: b.dataset.tip,
      haspopup: b.getAttribute('aria-haspopup'),
      lit: !!circle && getComputedStyle(circle).fill === success,
      struck: b.innerHTML.includes('M3.5 3.5 20.5 20.5'),
      next: host.nextElementSibling?.matches('[data-app-switcher]') || false,
    };
  });
const labelIs = (page, label, message) =>
  page.waitFor((label) => document.querySelector('.sidebar .side-head .ai-side:not([hidden]) .ai-chip')?.getAttribute('aria-label') === label, {
    timeout: 10000,
    args: [label],
    message: message || `the AI status button to read "${label}"`,
  });
const closePanel = async (page) => {
  await page.press('Escape');
  await page.waitFor(() => !document.querySelector('.modal.ai-panel'), { timeout: 5000, message: 'Connect AI to close' });
};
const openPanel = (page, kind) =>
  page.evaluate((kind) => {
    import('/shared/ai.js').then((m) => m.openAIPanel(kind ? { kind } : {}));
    return true;
  }, kind || null);

describe('QA ai: the AI status button in the apps’ sidebar head', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  const state = {};

  test('hidden until an assistant is set up; then live: ready, connected (lit), read only, off (struck through)', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ai-status-states', async () => {
      await openPaired(page, server, 'tasks/');
      await page.waitFor('.sidebar .side-head .ai-side', { state: 'attached', timeout: 10000, message: 'initAI() to mount the status button’s place' });
      assert.deepEqual(await button(page), { hidden: true }, 'nothing set up: no button to see');
      // The head's Tab order is unchanged while there is nothing to show: brand menu, then the switcher.
      await page.evaluate(() => document.querySelector('.sidebar .side-head [data-app-menu]').focus());
      await page.press('Tab');
      assert.ok(await page.evaluate(() => document.activeElement?.matches('[data-app-switcher]')), 'Tab goes from the brand menu straight to the app switcher');

      const r = await api(server, 'api/ai/clients', { method: 'POST', body: { kind: 'claude', access: 'write', label: 'Claude Code' } });
      assert.equal(r.status, 200, r.text);
      state.client = r.json.client;
      // Its connect animation would cover the page: mark it as already celebrated in this browser.
      await page.evaluate((id) => localStorage.setItem('ecosys:ai:announced', JSON.stringify({ [id]: Date.now() })), state.client.id);
      await labelIs(page, 'AI assistants, Ready for Claude', 'a new connection to show the button, live');
      let b = await button(page);
      assert.equal(b.tip, 'Ready for Claude');
      assert.equal(b.haspopup, 'dialog');
      assert.equal(b.next, true, 'it sits just before the app switcher');
      assert.equal(b.lit, false, 'not connected yet: the docked circle is not lit');
      assert.equal(b.struck, false);

      await mcp(server, state.client.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.3' } });
      await mcp(server, state.client.token, 'notifications/initialized');
      await mcp(server, state.client.token, 'tools/list');
      await labelIs(page, 'AI assistants, Claude is connected');
      b = await button(page);
      assert.equal(b.lit, true, 'connected: the docked circle (the assistant) is lit in the success colour');

      await setMode(server, 'read');
      await labelIs(page, 'AI assistants, Claude is connected, read only');
      await setMode(server, 'off');
      await labelIs(page, 'AI assistants, AI access is off');
      b = await button(page);
      assert.equal(b.struck, true, 'AI access off: the struck-through AI glyph');
      assert.equal(b.lit, false);
      await setMode(server, 'write');
      await labelIs(page, 'AI assistants, Claude is connected');
    });
  });

  test('a connection goes quiet ten minutes after its last request, without a reload', async (t) => {
    const { page } = ctx;
    if (!state.client) return t.skip('needs the connection from the first test');
    await withScreenshot(page, 'qa-ai-status-quiet', async () => {
      // What the server sends when a connection last asked 9 min 58.5 s ago (it says nothing when one goes quiet).
      await page.evaluate((c) => {
        window.dispatchEvent(
          new CustomEvent('ecosys:ai', {
            detail: { type: 'status', mode: 'write', clients: [{ id: c.id, kind: 'claude', label: 'Claude Code', access: 'write', connected: true, lastSeen: Date.now() - (10 * 60 * 1000 - 1500) }] },
          }),
        );
      }, state.client);
      await labelIs(page, 'AI assistants, Claude is connected');
      await labelIs(page, 'AI assistants, Ready for Claude', 'the connection to go quiet once ten minutes have passed');
      const st = await page.evaluate(() => import('/shared/ai.js').then((m) => m.aiStatus()));
      assert.equal(st.connected.length, 0, 'aiStatus() agrees: nothing connected');
    });
  });

  test('pressing it opens Connect AI; Escape gives focus back to it', async (t) => {
    const { page } = ctx;
    if (!state.client) return t.skip('needs the connection from the first test');
    await withScreenshot(page, 'qa-ai-status-opens', async () => {
      await page.click('.sidebar .side-head .ai-chip');
      await page.waitFor(() => document.querySelectorAll('.modal.ai-panel .ai-row').length === 4, { timeout: 8000, message: 'Connect AI to open' });
      await closePanel(page);
      await settle(page, 200);
      assert.ok(await page.evaluate(() => document.activeElement?.matches('.side-head .ai-chip')), 'focus is back on the status button');
    });
  });

  test('changing a connection’s access says web connectors may need a refresh', async (t) => {
    const { page } = ctx;
    if (!state.client) return t.skip('needs the connection from the first test');
    await withScreenshot(page, 'qa-ai-status-access-toast', async () => {
      await openPanel(page, 'claude');
      await page.waitFor('.modal.ai-panel .ai-conns', { timeout: 8000, message: 'Claude’s connections' });
      await page.evaluate(() => [...document.querySelectorAll('.ai-conns [data-act="access"]')].find((b) => b.dataset.val === 'read').click());
      await page.waitForText('Claude Code can now only read. Web connectors (claude.ai, ChatGPT, Grok) may need a refresh to see it.');
      const r = await api(ctx.server, 'api/ai/status');
      assert.equal(r.json.clients.find((c) => c.id === state.client.id)?.access, 'read', 'the server has it');
      await page.evaluate(() => [...document.querySelectorAll('.ai-conns [data-act="access"]')].find((b) => b.dataset.val === 'write').click());
      await page.waitForText('Claude Code can now read and make changes. Web connectors (claude.ai, ChatGPT, Grok) may need a refresh to see it.');
      await closePanel(page);
    });
  });

  test('changing AI access mentions web connectors only when one is set up', async (t) => {
    const { page, server } = ctx;
    if (!state.client) return t.skip('needs the connection from the first test');
    const mode = (val) => page.evaluate((val) => document.querySelector(`.modal.ai-panel .ai-access [data-val="${val}"]`).click(), val);
    const hint = () => page.evaluate(() => [...document.querySelectorAll('.toasts .toast-msg')].map((t) => t.textContent).filter((t) => t.includes('Web connectors')));
    await withScreenshot(page, 'qa-ai-status-mode-toast', async () => {
      await openPanel(page);
      await page.waitFor('.modal.ai-panel .ai-access', { timeout: 8000, message: 'Connect AI’s AI access' });
      await page.evaluate(() => document.querySelectorAll('.toasts .toast').forEach((t) => t.remove()));
      // Only Claude Code (it hears of changes itself): nothing to say.
      await mode('read');
      await page.waitFor(() => window.ecosysSync?.ai?.mode === 'read', { timeout: 5000, message: 'the server to take Read only' });
      await settle(page, 300);
      assert.deepEqual(await hint(), [], 'no web connector set up: no refresh hint');
      await mode('write');
      await page.waitFor(() => window.ecosysSync?.ai?.mode === 'write', { timeout: 5000, message: 'the server to take Read & write' });
      // A ChatGPT connection (a web connector) set up: the hint, for read and for write; none for Off.
      const r = await api(server, 'api/ai/clients', { method: 'POST', body: { kind: 'chatgpt', access: 'write', label: 'ChatGPT' } });
      assert.equal(r.status, 200, r.text);
      await page.waitFor(() => [...document.querySelectorAll('.modal.ai-panel .ai-row')].some((b) => /ChatGPT[\s\S]*Not connected yet/.test(b.textContent)), { timeout: 8000, message: 'the sheet to list the ChatGPT connection' });
      await mode('read');
      await page.waitForText('Assistants can now only read. Web connectors (claude.ai, ChatGPT, Grok) may need a refresh to see it.');
      await page.evaluate(() => document.querySelectorAll('.toasts .toast').forEach((t) => t.remove()));
      await mode('off');
      await page.waitFor(() => window.ecosysSync?.ai?.mode === 'off', { timeout: 5000, message: 'the server to take Off' });
      await settle(page, 300);
      assert.deepEqual(await hint(), [], 'turning access off needs no refresh: everything is refused');
      await mode('write');
      await page.waitForText('Assistants can now read and make changes. Web connectors (claude.ai, ChatGPT, Grok) may need a refresh to see it.');
      await closePanel(page);
    });
  });

  test('the tunnel address error line uses the alert glyph', async () => {
    const { page } = ctx;
    await withScreenshot(page, 'qa-ai-status-alert', async () => {
      await openPanel(page, 'chatgpt');
      await page.waitFor('.modal.ai-panel .ai-tunnel', { timeout: 8000, message: 'the tunnel address field' });
      await page.click('.modal.ai-panel .ai-tunnel');
      await page.type('not a tunnel');
      await page.waitFor('.modal.ai-panel .ai-err', { timeout: 5000, message: 'the error line under the field' });
      const svg = await page.evaluate(() => document.querySelector('.modal.ai-panel .ai-err svg').innerHTML);
      assert.match(svg, /M12 7\.2v5\.8M12 16\.6h\.01/, 'the alert glyph (the stroke above the dot)');
      assert.doesNotMatch(svg, /M12 11v5\.5M12 7\.6h\.01/, 'not the info glyph');
      // Leave no tunnel address behind for later tests.
      await page.evaluate(() => {
        const f = document.querySelector('.modal.ai-panel .ai-tunnel');
        f.value = '';
        f.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await closePanel(page);
    });
  });

  test('Schedule and Notes have it too; on a phone it is in the drawer’s head', async (t) => {
    const { page, server } = ctx;
    if (!state.client) return t.skip('needs the connection from the first test');
    await withScreenshot(page, 'qa-ai-status-apps', async () => {
      for (const path of ['schedule/', 'notes/']) {
        if (path === 'notes/' && !(await served(server, 'notes/app.js'))) continue;
        await openApp(page, server.url(path));
        await labelIs(page, 'AI assistants, Claude is connected', `the status button in ${path}`);
        assert.equal((await button(page)).next, true, `${path}: just before the app switcher`);
        // The head is tight: the button never costs the app's name a letter ("schedule" is the longest).
        const cut = await page.evaluate(() => {
          const label = document.querySelector('.sidebar .side-head .brand-btn .truncate');
          const host = document.querySelector('.sidebar .side-head .ai-side');
          const over = () => label.scrollWidth - label.clientWidth;
          const shown = over();
          host.style.display = 'none';
          const alone = over();
          host.style.display = '';
          return { shown, alone };
        });
        assert.equal(cut.shown, cut.alone, `${path}: the app's name is cut no more with the button than without it (${JSON.stringify(cut)})`);
      }
      await page.setViewport(390, 844, true);
      try {
        await openApp(page, server.url('tasks/'));
        await page.waitFor('.sidebar .side-head .ai-side:not([hidden])', { state: 'attached', timeout: 10000, message: 'the status button on a phone' });
        await page.click('.menu-toggle');
        // The drawer slides in: wait until the button has come to rest on screen.
        await page.waitFor(
          () => {
            const r = document.querySelector('.sidebar .side-head .ai-chip')?.getBoundingClientRect();
            return !!r && r.width > 0 && r.left >= 0 && r.right <= innerWidth && getComputedStyle(document.querySelector('.sidebar')).transform === 'none';
          },
          { timeout: 5000, message: 'the open drawer’s head to show the status button on screen' },
        );
      } finally {
        await page.setViewport(1440, 900, false);
      }
      const errs = consoleErrors(page);
      assert.equal(errs.length, 0, `no console errors:\n${formatErrors(errs)}`);
    });
  });
});
