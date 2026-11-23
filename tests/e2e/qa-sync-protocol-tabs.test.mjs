// QA regression (sync protocol), in a real Chrome: the tabs of one browser.
//   - a page load downloads the server's state once (the event stream opens first, so no reload follows)
//   - with localStorage full, an assistant's change to a note reaches a Notes tab that does not hold
//     the event stream (the tab holding it sends it over a BroadcastChannel)
//   - when ecosys stops, a tab that does not hold the stream shows it is offline too
// One isolated server and one Chrome (two tabs of one profile).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, waitForSyncIdle, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('qa sync protocol: tabs of one browser', () => {
  const ctx = useE2E({ width: 1280, height: 800 });
  let other = null;

  /** An assistant's MCP tool call (a read & write connection made for it). */
  let token = null;
  async function mcp(name, args) {
    token ??= (await ctx.server.api('api/ai/clients', { method: 'POST', body: { kind: 'claude', access: 'write' } })).json.client.token;
    const res = await fetch(ctx.server.url('mcp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const r = (await res.json()).result;
    assert.ok(r && !r.isError, `${name} failed: ${r?.content?.[0]?.text}`);
    return r.structuredContent;
  }

  test('a page load downloads the state once', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-sync-protocol-state-once', async () => {
      await openApp(page, server.url('tasks/'));
      await waitForSyncIdle(page);
      await openApp(page, server.url('schedule/')); // a second load: this browser has synced before
      await waitForSyncIdle(page);
      await sleep(800);
      const states = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/api\/state(\?|$)/.test(e.name)).length);
      assert.equal(states, 1, 'one GET /api/state');
    });
  });

  test('with localStorage full, an assistant’s note edit reaches the Notes tab that does not hold the stream', async () => {
    const { page, server, browser } = ctx;
    await withScreenshot(page, 'qa-sync-protocol-notes-full', async () => {
      await openApp(page, server.url('notes/'));
      other = await browser.newPage(); // the same profile: a second tab
      await other.setViewport(1280, 800, false);
      await openApp(other, server.url('notes/'));
      const T = `Trip plan ${tag()}`;
      const id = (await mcp('notes_create', { markdown: `# ${T}\n\nFirst line.` })).id;
      const has = (p, text) => p.evaluate(async ({ i, t }) => JSON.stringify((await import('/shared/store.js')).db.get('notes', i)?.blocks || []).includes(t), { i: id, t: text });
      for (const p of [page, other]) await p.waitFor(async (i) => !!(await import('/shared/store.js')).db.get('notes', i), { args: [id], timeout: 8000 });
      await page.evaluate(() => {
        let chunk = 'x'.repeat(512 * 1024);
        for (let n = 0; chunk.length >= 1; ) {
          try {
            localStorage.setItem(`qa-filler:${n}`, chunk);
            n++;
          } catch {
            chunk = chunk.slice(0, chunk.length >> 1);
          }
        }
      });
      try {
        await mcp('notes_append', { id, markdown: 'AILINE from the assistant' });
        const follower = (await page.evaluate(() => window.ecosysSync.leader)) ? other : page;
        await follower.waitFor(async (i) => JSON.stringify((await import('/shared/store.js')).db.get('notes', i)?.blocks || []).includes('AILINE'), { args: [id], timeout: 10000, message: 'the edit to reach the tab without the stream' });
        assert.ok(await has(page, 'AILINE') && (await has(other, 'AILINE')), 'both tabs have it');
      } finally {
        await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('qa-filler:')).forEach((k) => localStorage.removeItem(k)));
      }
    });
  });

  test('when ecosys stops, the tab that does not hold the stream shows it is offline too', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-sync-protocol-offline', async () => {
      assert.ok(other, 'two tabs are open');
      const follower = (await page.evaluate(() => window.ecosysSync.leader)) ? other : page;
      assert.equal(await follower.evaluate(() => window.ecosysSync.leader), false);
      await server.stop();
      await follower.waitFor(() => window.ecosysSync?.status === 'offline', { timeout: 20000, message: 'the tab without the stream to say it is offline' });
      await other.close().catch(() => {});
    });
  });
});
