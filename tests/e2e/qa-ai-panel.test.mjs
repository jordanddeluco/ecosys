// QA wave 1, Connect AI (shared/ai.js, shared/ai.css): regressions for what the testers found.
//
//   status route   Home's card, the toolbar chip and the connect animation poll the key-free
//                  GET /api/ai/status; only the Connect AI sheet asks GET /api/ai (it needs the keys)
//   Home card      with nothing set up, its Connect button sits right under its message
//   typing         the connect animation still waits while someone types (the tracker now listens as
//                  keys bubble up to the window)
//   Off            with AI access Off every assistant reads "Paused", never a green "Connected"; on a
//                  phone the setup step's wrapped "AI access is off" line keeps its lock on line one
//   one height     the sheet keeps one height and content width on every page and tab (desktop, phone),
//                  with even sides: the scrollbar's room is kept on both edges
//   focus          after the connect animation focus returns to the control it came from, even when
//                  the sheet re-rendered it meanwhile; the animation's scrim is a plain tint; the
//                  "Waiting for … to connect" spinner sits on its line
//   Activity       human dates and curly quotes (toasts, Home, the feed), repeated look-ups on one
//                  row with a count, your own undo never shown as the assistant's latest action, and
//                  an undone change still reads Undone after a reload
//   setup text     keycaps keep the paragraph's line spacing; the xAI snippet fits its block
//   offline        when ecosys stops, the open sheet says so (focus on its heading, hero and steps
//                  apart) and reloads by itself when ecosys is back
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { useE2E, openApp, settle, withScreenshot, served, formatErrors } from './helpers.mjs';
import { ROOT } from './server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One MCP request with a connection key, the way a real client sends it (HTTP, legacy handshake). */
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
async function connectClient(server, token, name, version) {
  await mcp(server, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version } });
  await mcp(server, token, 'notifications/initialized');
  await mcp(server, token, 'tools/list');
}
async function tool(server, token, name, args = {}) {
  const out = await mcp(server, token, 'tools/call', { name, arguments: args });
  assert.ok(!out?.error && !out?.result?.isError, `${name} failed: ${JSON.stringify(out).slice(0, 300)}`);
  return out;
}
async function createClient(server, body) {
  const r = await server.api('api/ai/clients', { method: 'POST', body });
  assert.equal(r.status, 200, r.text);
  return r.json.client;
}
async function setMode(server, mode) {
  const r = await server.api('api/ai/mode', { method: 'POST', body: { mode } });
  assert.equal(r.status, 200, r.text);
}

const openPanel = (page, kind = null) => page.evaluate((kind) => import('/shared/ai.js').then((m) => m.openAIPanel(kind ? { kind } : {})), kind);
async function closePanel(page) {
  await page.press('Escape');
  await page.waitFor(() => !document.querySelector('.modal.ai-panel'), { timeout: 4000, message: 'the Connect AI sheet to close' });
}
const pickTab = (page, name) => page.evaluate((name) => [...document.querySelectorAll('.ai-panel .ai-tabs [role=tab]')].find((b) => b.textContent.trim() === name).click(), name);
/** Mark a connection as already celebrated in this browser, so its connect animation stays out of the way. */
const alreadyAnnounced = (page, id) =>
  page.evaluate((id) => {
    const m = JSON.parse(localStorage.getItem('ecosys:ai:announced') || '{}');
    m[id] = Date.now();
    localStorage.setItem('ecosys:ai:announced', JSON.stringify(m));
  }, id);
const aiRequests = (page) => page.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => p.startsWith('/api/ai')));
/**
 * A setup step's status line (lock, spinner or tick, then its message), run in the page: how many lines
 * the message takes, and the middles of the icon and of the message's first line.
 */
function statusLine(text) {
  const p = [...document.querySelectorAll('.ai-panel .ai-wait, .ai-panel .ai-ok')].find((x) => x.textContent.includes(text));
  if (!p) return null;
  const mid = (r) => r.top + r.height / 2;
  const range = document.createRange();
  range.selectNodeContents(p.lastElementChild);
  const lines = [...range.getClientRects()];
  return { lines: new Set(lines.map((r) => Math.round(r.top))).size, icon: mid(p.firstElementChild.getBoundingClientRect()), firstLine: mid(lines[0]) };
}

function assertNoConsoleErrors(page, ignore = null) {
  const errs = page.consoleErrors().filter((e) => !(ignore && ignore.test(e.text)));
  assert.equal(errs.length, 0, `console errors:\n${formatErrors(errs)}`);
}

describe('QA ai: Connect AI, the connect animation and Home’s AI icon', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  const state = {};
  let skip = '';

  test('status polling never receives connection keys; only the Connect AI sheet asks GET /api/ai', async (t) => {
    const { page, server } = ctx;
    if (!(await served(server, 'shared/ai.js'))) {
      skip = 'shared/ai.js is not served';
      return t.skip(skip);
    }
    await withScreenshot(page, 'qa-ai-status-route', async () => {
      await openApp(page, server.url(''));
      await page.waitFor(() => document.querySelector('[data-ai-status] .launch-cap-text'), { timeout: 10000, message: 'Home’s AI icon to show a status' });
      // Home's caption may get its first status from the live event stream; a refresh asks only the status route.
      await page.evaluate(() => import('/shared/ai.js').then((m) => m.aiStatus({ fresh: true })));
      const polled = await aiRequests(page);
      assert.ok(polled.includes('/api/ai/status'), `a status refresh asks GET /api/ai/status (saw: ${polled.join(', ') || 'nothing'})`);
      assert.ok(!polled.includes('/api/ai'), `nothing but the Connect AI sheet asks GET /api/ai, which holds the keys (saw: ${polled.join(', ')})`);

      // Nothing set up yet: the AI icon's caption offers Connect, after the plug, and its name says so.
      const cap = await page.evaluate(() => {
        const b = document.querySelector('.launch-app[data-app="ai"]');
        const c = b.querySelector('[data-ai-status]');
        return { text: c.textContent.trim(), tone: c.dataset.tone, plug: !!c.querySelector('svg'), name: b.getAttribute('aria-label') };
      });
      assert.deepEqual(cap, { text: 'Connect', tone: 'connect', plug: true, name: 'AI assistants, Connect Claude, ChatGPT or Grok' });

      await openPanel(page);
      await page.waitFor(() => document.querySelector('.modal.ai-panel .ai-row'), { timeout: 8000, message: 'the Connect AI sheet to load' });
      assert.ok((await aiRequests(page)).includes('/api/ai'), 'the sheet loads GET /api/ai (its setup steps need the keys)');
      await closePanel(page);
      assertNoConsoleErrors(page);
    });
  });

  test('the connect animation waits while someone is typing, and gives the field its focus back', async (t) => {
    if (skip) return t.skip(skip);
    const { page } = ctx;
    await withScreenshot(page, 'qa-ai-typing', async () => {
      await page.evaluate(() => {
        const i = document.createElement('input');
        i.id = 'qa-ai-typing';
        i.setAttribute('aria-label', 'QA typing field');
        i.style.cssText = 'position:fixed;left:8px;top:8px;z-index:5';
        document.body.append(i);
        i.focus();
      });
      await page.press('a'); // someone is typing…
      await page.evaluate(() => {
        window.__qaShown = null;
        import('/shared/ai.js').then((m) => m.playConnectAnimation({ kind: 'claude', label: 'Claude' }, { duration: 6000 }).then((v) => (window.__qaShown = v)));
      });
      for (let i = 0; i < 8; i++) {
        await sleep(250);
        await page.press('b');
        assert.equal(await page.evaluate(() => !!document.querySelector('.ai-cx')), false, 'the animation never covers a field someone is typing in');
      }
      // …and pauses: now it plays, and Escape hands the field its focus back.
      await page.waitFor(() => document.querySelector('.ai-cx .ai-cx-done'), { timeout: 6000, message: 'the animation once typing pauses' });
      await page.press('Escape');
      await page.waitFor(() => window.__qaShown === true, { timeout: 5000, message: 'the animation to finish' });
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'qa-ai-typing');
      await page.evaluate(() => document.getElementById('qa-ai-typing')?.remove());
      assertNoConsoleErrors(page);
    });
  });

  test('with AI access Off, assistants read Paused, never a green Connected', async (t) => {
    if (skip) return t.skip(skip);
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ai-paused', async () => {
      const c = await createClient(server, { kind: 'claude', access: 'write', label: 'Claude Code' });
      state.claude = c;
      await alreadyAnnounced(page, c.id);
      await connectClient(server, c.token, 'claude-code', '2.1.293');
      await setMode(server, 'off');

      await openPanel(page);
      await page.waitFor(() => document.querySelector('.ai-panel .ai-row[data-kind=claude] .ai-state')?.textContent.trim() === 'Paused', { timeout: 8000, message: 'the Claude row to read Paused' });
      assert.equal(await page.evaluate(() => document.querySelectorAll('.ai-panel .ai-dot.on').length), 0, 'no green dot while AI access is off');

      // Claude's page: the status line, the connection and the setup step all agree.
      await page.evaluate(() => document.querySelector('.ai-panel .ai-row[data-kind=claude]').click());
      await page.waitFor(() => document.querySelector('.ai-panel .ai-dline') && document.querySelector('.ai-panel .ai-tabs'), { timeout: 5000, message: 'Claude’s page' });
      await pickTab(page, 'Claude Code');
      await settle(page, 200);
      const d = await page.evaluate(() => ({
        line: document.querySelector('.ai-panel .ai-dline').textContent.replace(/\s+/g, ' ').trim(),
        meta: document.querySelector('.ai-panel .ai-conn-meta').textContent.replace(/\s+/g, ' ').trim(),
        green: document.querySelectorAll('.ai-panel .ai-dot.on, .ai-panel .ai-ok').length,
        waiting: [...document.querySelectorAll('.ai-panel .ai-wait')].map((x) => x.textContent.trim()),
      }));
      assert.match(d.line, /^Paused/, `status line: ${d.line}`);
      assert.match(d.meta, /^Paused/, `connection: ${d.meta}`);
      assert.equal(d.green, 0, 'nothing green says connected');
      assert.ok(d.waiting.some((w) => /AI access is off/.test(w)), `the setup step says why (${d.waiting.join(' | ')})`);

      // On a phone that line wraps: its lock stays beside the first words, not between the two lines.
      try {
        await page.setViewport(390, 844, true);
        await settle(page, 300);
        const lock = await page.evaluate(statusLine, 'AI access is off');
        assert.ok(lock.lines >= 2, `the line wraps at 390 (${lock.lines} line)`);
        const off = lock.icon - lock.firstLine;
        assert.ok(Math.abs(off) <= 1.5, `the lock sits on the first line (its middle is ${off.toFixed(1)}px from the line's)`);
      } finally {
        await page.setViewport(1440, 900, false);
      }

      // Access back on: the live state returns in the open sheet.
      await setMode(server, 'write');
      await page.waitFor(() => /^Connected/.test(document.querySelector('.ai-panel .ai-conn-meta')?.textContent.trim() || ''), { timeout: 8000, message: 'the connection to read Connected again' });
      await closePanel(page);
      assertNoConsoleErrors(page);
    });
  });

  test('the Connect AI sheet keeps one height, content width and even sides on every page and tab', async (t) => {
    if (skip) return t.skip(skip);
    const { page } = ctx;
    await withScreenshot(page, 'qa-ai-one-height', async () => {
      // Layout sizes and offsets, which the sheet's open and push animations don't scale or move: the
      // sheet's height, the page's width, and the room left and right of the page inside the sheet.
      const measure = () =>
        page.evaluate(() => {
          const m = document.querySelector('.modal.ai-panel');
          const p = m.querySelector('.ai-page');
          let l = 0;
          for (let e = p; e && e !== m; e = e.offsetParent) l += e.offsetLeft;
          return { h: m.offsetHeight, w: p.offsetWidth, l, r: m.clientWidth - l - p.offsetWidth };
        });
      // Connect AI's home is long; Grok (nothing set up) has short pages.
      const walk = async () => {
        await openPanel(page);
        await page.waitFor(() => document.querySelector('.modal.ai-panel .ai-row'), { timeout: 8000, message: 'the Connect AI sheet' });
        const seen = [['home', await measure()]];
        await page.evaluate(() => document.querySelector('.ai-panel .ai-row[data-kind=grok]').click());
        await page.waitFor(() => document.querySelector('.ai-panel .ai-tabs'), { timeout: 5000, message: 'Grok’s page' });
        for (const tab of ['Grok app', 'xAI API', 'Grok CLI']) {
          await pickTab(page, tab);
          await settle(page, 120);
          seen.push([tab, await measure()]);
        }
        await closePanel(page);
        return seen;
      };
      const same = (seen, key) => new Set(seen.map(([, m]) => m[key])).size === 1;
      // The scrollbar's room is kept on both edges, so a page sits centred whether it scrolls or not.
      const even = (seen) => seen.every(([, m]) => m.l === m.r);
      const desktop = await walk();
      const fmt = (seen) => seen.map(([p, m]) => `${p} ${m.h}px/${m.w}px (sides ${m.l}/${m.r})`).join(', ');
      assert.ok(same(desktop, 'h'), `one height at 1440: ${fmt(desktop)}`);
      assert.ok(same(desktop, 'w'), `one content width at 1440: ${fmt(desktop)}`);
      assert.ok(even(desktop), `even sides at 1440: ${fmt(desktop)}`);
      try {
        await page.setViewport(390, 844, true);
        const phone = await walk();
        assert.ok(same(phone, 'h'), `one height at 390: ${fmt(phone)}`);
        assert.ok(same(phone, 'w'), `one content width at 390: ${fmt(phone)}`);
        assert.ok(even(phone), `even sides at 390: ${fmt(phone)}`);
      } finally {
        await page.setViewport(1440, 900, false);
      }
      assertNoConsoleErrors(page);
    });
  });

  test('after the connect animation, focus returns to the control it came from', async (t) => {
    if (skip) return t.skip(skip);
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ai-focus-return', async () => {
      await openPanel(page, 'grok');
      await page.waitFor(() => document.querySelector('.ai-panel .ai-tabs'), { timeout: 8000, message: 'Grok’s page' });
      await pickTab(page, 'Grok CLI');
      await page.clickText('button', /Create a key for Grok CLI/);
      await page.waitFor(() => document.querySelector('.ai-panel [data-act="conn-menu"]'), { timeout: 8000, message: 'the new Grok CLI connection' });
      // Its last step waits for Grok CLI: the spinner sits on the line it goes with.
      await settle(page, 300);
      const spin = await page.evaluate(statusLine, 'Waiting for Grok CLI');
      assert.ok(spin, 'the setup step waits for Grok CLI to connect');
      assert.ok(Math.abs(spin.icon - spin.firstLine) <= 1.5, `the spinner sits on its line (its middle is ${(spin.icon - spin.firstLine).toFixed(1)}px from the line's)`);
      const label = await page.evaluate(() => {
        const b = document.querySelector('.ai-panel [data-act="conn-menu"]');
        b.focus();
        window.__qaMore = b;
        return b.getAttribute('aria-label');
      });
      const c = (await server.api('api/ai')).json.clients.find((x) => x.label === 'Grok CLI');
      assert.ok(c, 'the Grok CLI connection exists');
      await connectClient(server, c.token, 'grok-cli', '1.0.4');
      await page.waitFor(() => document.querySelector('.ai-cx .ai-cx-done'), { timeout: 8000, message: 'the connect animation' });
      const blur = await page.evaluate(() => getComputedStyle(document.querySelector('.ai-cx-scrim')).backdropFilter);
      assert.ok(!blur || blur === 'none', `the animation's scrim is a plain tint (backdrop-filter: ${blur})`);
      // The sheet updates underneath as the assistant connects: the focused button is replaced.
      await page.waitFor(() => !window.__qaMore.isConnected, { timeout: 8000, message: 'the sheet to re-render under the animation' });
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.ai-cx'), { timeout: 5000, message: 'the animation to close' });
      const f = await page.evaluate(() => {
        const a = document.activeElement;
        return { label: a?.getAttribute('aria-label') || a?.tagName, inSheet: !!a?.closest('.modal.ai-panel') };
      });
      assert.equal(f.inSheet, true, `focus stays in the sheet (it is on ${f.label})`);
      assert.equal(f.label, label, 'focus is back on the same control');
      await closePanel(page);
      assertNoConsoleErrors(page);
    });
  });

  test('Activity reads like the rest of ecosys, groups repeated look-ups, and keeps your undo yours', async (t) => {
    if (skip) return t.skip(skip);
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ai-activity', async () => {
      const { token } = state.claude;
      for (let i = 0; i < 3; i++) await tool(server, token, 'get_overview');
      // A change made while the sheet is closed shows a toast, worded for people.
      const d = new Date(Date.now() + 86400000);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await tool(server, token, 'create_events', { events: [{ title: 'QA lunch', start: `${day}T12:00`, end: `${day}T13:00` }] });
      const eventToast = await page.waitFor(() => [...document.querySelectorAll('.toast .toast-msg')].map((m) => m.textContent).find((x) => x.includes('QA lunch')), { timeout: 8000, message: 'a toast for the new event' });
      assert.ok(eventToast.startsWith('Claude added event “QA lunch” on '), `toast: ${eventToast}`);
      assert.doesNotMatch(eventToast, /\d{4}-\d{2}-\d{2}|\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}/, `the day reads like a date, not a machine date: ${eventToast}`);
      await sleep(1500); // a separate burst, so the next change gets its own toast
      await tool(server, token, 'create_tasks', { tasks: [{ title: 'Say "hi" to Sam' }] });
      const taskToast = await page.waitFor(() => [...document.querySelectorAll('.toast .toast-msg')].map((m) => m.textContent).find((x) => x.includes('Sam')), { timeout: 8000, message: 'a toast for the new task' });
      assert.equal(taskToast, 'Claude added task “Say "hi" to Sam”');

      // Undo it from the toast: the feed (below) shows the assistant's action struck through, never your undo.
      await page.evaluate(() => [...document.querySelectorAll('.toast')].find((x) => x.textContent.includes('Sam')).querySelector('button').click());


      // The feed: people's dates and quotes, and the three identical look-ups on one row.
      await openPanel(page);
      await page.waitFor(() => document.querySelector('.ai-panel .ai-feed .ai-undone'), { timeout: 8000, message: 'the feed to show the undone change' });
      const feed = await page.evaluate(() =>
        [...document.querySelectorAll('.ai-panel .ai-entry')].map((e) => ({ text: e.querySelector('.ai-entry-text').textContent, meta: e.querySelector('.ai-entry-meta').textContent.replace(/\s+/g, ' ') })),
      );
      const all = feed.map((x) => `${x.text} | ${x.meta}`).join('\n');
      assert.doesNotMatch(all, /\d{4}-\d{2}-\d{2}/, `no machine dates:\n${all}`);
      assert.doesNotMatch(all, /\\"/, `no escaped quotes:\n${all}`);
      assert.ok(feed.some((x) => x.text.startsWith('Added event “QA lunch” on ')), `the event reads naturally:\n${all}`);
      const looks = feed.filter((x) => x.text.startsWith('Looked at the agenda'));
      assert.equal(looks.length, 1, `repeated look-ups share one row:\n${all}`);
      assert.match(looks[0].meta, /3 times/, `with a count:\n${all}`);
      await closePanel(page);

      // After a reload the server says what was undone: Undone (not an Undo that would fail), and Redo on your undo.
      await openApp(page, server.url(''));
      await openPanel(page);
      await page.waitFor(() => document.querySelector('.ai-panel .ai-feed .ai-entry'), { timeout: 8000, message: 'the feed after a reload' });
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('.ai-panel .ai-entry')].map((e) => ({ text: e.querySelector('.ai-entry-text').textContent, action: (e.querySelector('.ai-undo, .ai-undone')?.textContent || '').trim() })),
      );
      const task = rows.find((r) => r.text.startsWith('Added task'));
      const yours = rows.find((r) => r.text.startsWith('Undid'));
      assert.equal(task?.action, 'Undone', JSON.stringify(rows));
      assert.equal(yours?.action, 'Redo', JSON.stringify(rows));
      await closePanel(page);
      assertNoConsoleErrors(page);
    });
  });

  test('setup text: keycaps keep the line spacing, and the xAI snippet fits its block', async (t) => {
    if (skip) return t.skip(skip);
    const { page } = ctx;
    await withScreenshot(page, 'qa-ai-setup-text', async () => {
      await openPanel(page, 'grok');
      await page.waitFor(() => document.querySelector('.ai-panel .ai-tabs'), { timeout: 8000, message: 'Grok’s page' });
      await pickTab(page, 'xAI API');
      await page.clickText('button', /Create a key for the xAI API/);
      await page.waitFor(() => document.querySelector('.ai-panel [data-fk="api-json"]'), { timeout: 8000, message: 'the xAI snippet' });
      const m = await page.evaluate(() => {
        const p = [...document.querySelectorAll('.ai-panel .ai-p')].find((x) => x.querySelector('.keys'));
        const lh = parseFloat(getComputedStyle(p).lineHeight);
        const pre = document.querySelector('.ai-panel [data-fk="api-json"]').closest('.ai-code').querySelector('pre');
        return { lines: p.getBoundingClientRect().height / lh, overflow: pre.scrollWidth - pre.clientWidth };
      });
      assert.ok(Math.abs(m.lines - Math.round(m.lines)) < 0.1, `a paragraph with keycaps is a whole number of lines tall (${m.lines.toFixed(2)})`);
      assert.ok(m.overflow <= 1, `the snippet fits its block (${m.overflow}px cut off)`);
      await closePanel(page);
      assertNoConsoleErrors(page);
    });
  });

  test('when ecosys stops, the open sheet says so, and reloads by itself once ecosys is back', async (t) => {
    if (skip) return t.skip(skip);
    const { page, server } = ctx;
    let again = null;
    try {
      await withScreenshot(page, 'qa-ai-offline', async () => {
        await openPanel(page);
        await page.waitFor(() => document.querySelector('.modal.ai-panel .ai-row'), { timeout: 8000, message: 'the Connect AI sheet' });
        await page.evaluate(() => document.querySelector('.ai-panel .ai-row[data-kind=claude]').focus());
        process.kill(server.pid); // ecosys stops (its window closed)
        await page.waitFor(() => /Can’t reach ecosys/.test(document.querySelector('.ai-panel .ai-hero-title')?.textContent || ''), {
          timeout: 20000,
          message: 'the sheet to say ecosys isn’t answering',
        });
        const s = await page.evaluate(() => {
          const hero = document.querySelector('.ai-panel .ai-hero').getBoundingClientRect();
          const steps = document.querySelector('.ai-panel .ai-hero ~ .group').getBoundingClientRect();
          return {
            gap: Math.round(steps.top - hero.bottom),
            rows: document.querySelectorAll('.ai-panel .ai-row').length,
            green: document.querySelectorAll('.ai-panel .ai-dot.on').length,
            focus: document.activeElement?.dataset?.fk || document.activeElement?.tagName,
          };
        });
        assert.equal(s.rows, 0, 'no stale assistant list');
        assert.equal(s.green, 0, 'nothing says connected');
        assert.ok(s.gap >= 12, `the hero and the steps don't touch (${s.gap}px apart)`);
        assert.equal(s.focus, 'hero-title', 'focus moves to the new page’s heading, not to Close');

        // ecosys starts again, same port and data: the sheet loads by itself.
        const env = { ...process.env, PORT: String(server.port), HOST: '127.0.0.1', ECOSYS_DATA_DIR: server.dataDir, ECOSYS_E2E_PARENT: String(process.pid) };
        for (const k of ['ECOSYS_ALLOWED_HOSTS', 'ECOSYS_CLIENT', 'NODE_TEST_CONTEXT']) delete env[k];
        again = spawn(process.execPath, [join(ROOT, 'tests', 'e2e', 'server-child.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
        await page.waitFor(() => document.querySelector('.modal.ai-panel .ai-row[data-kind=claude]'), { timeout: 30000, message: 'the sheet to reload once ecosys is back' });
        assert.equal(await page.evaluate(() => document.activeElement?.dataset?.fk), 'title', 'focus moves to the sheet’s title');
        await closePanel(page);
        // Lost connections while ecosys was down are expected; nothing else may fail.
        assertNoConsoleErrors(page, /net::ERR_|Failed to load resource/);
      });
    } finally {
      if (again && again.exitCode === null) {
        const exited = new Promise((r) => again.once('exit', r));
        try {
          again.disconnect(); // server-child.mjs shuts ecosys down cleanly
        } catch {}
        if (!(await Promise.race([exited.then(() => true), sleep(6000).then(() => false)]))) {
          again.kill();
          await Promise.race([exited, sleep(3000)]);
        }
      }
    }
  });
});
