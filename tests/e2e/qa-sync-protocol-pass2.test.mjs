// QA regression (sync protocol, second pass), in a real Chrome against one isolated server:
//   - a new browser profile that cannot reach ecosys yet runs Erase everything: once it connects, the
//     folder keeps its data, the task typed there is added and no sample is pushed (the queued replace
//     used to erase the folder in ecosys and in every other browser)
//   - another browser erases everything: Ctrl+Z in a tab of this browser that does not hold the event
//     stream brings nothing back (only the tab holding the stream used to drop its undo history)
//   - a library bigger than this browser's localStorage: Tasks, Schedule and Notes load without
//     "Could not save" (ecosys:save-error) or Notes' "Not saved" banner, although every first state
//     load cannot save it all
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, waitForApp, waitForSyncIdle, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COUNT_SAVE_ERRORS = "window.__saveErrors = []; addEventListener('ecosys:save-error', () => window.__saveErrors.push(location.pathname));";

describe('qa sync protocol, second pass', () => {
  const ctx = useE2E({ width: 1280, height: 800 });
  const pages = [];
  const newPage = async (opts) => {
    const p = await ctx.browser.newPage(opts);
    pages.push(p);
    await p.setViewport(1280, 800, false);
    return p;
  };

  test('a new profile that cannot reach ecosys yet: its Erase everything leaves the folder’s data alone once it connects', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-sync-protocol-pass2-fresh', async () => {
      const T = tag();
      await openApp(page, server.url('tasks/'));
      await page.evaluate(async (t) => {
        const { db } = await import('/shared/store.js');
        db.insert('tasks', { title: `Real task one ${t}` });
        db.insert('tasks', { title: `Real task two ${t}` });
      }, T);
      await waitForSyncIdle(page);
      const fresh = await newPage({ isolated: true });
      await fresh.send('Network.enable');
      await fresh.send('Network.setBlockedURLs', { urls: ['*/api/*'] }); // the page loads; ecosys does not answer
      await fresh.goto(server.url('tasks/'));
      await waitForApp(fresh);
      await fresh.waitFor(() => window.ecosysSync?.status === 'offline', { timeout: 15000, message: 'the new profile to be offline' });
      const samples = await fresh.evaluate(async (t) => {
        const s = await import('/shared/store.js');
        const ids = [...(s.sampleIds() || [])];
        s.resetData(); // Settings > Erase everything, to clear the samples
        s.db.insert('tasks', { title: `Typed in the new profile ${t}` });
        return ids;
      }, T);
      assert.ok(samples.length > 0, 'the new profile had sample data');
      await fresh.send('Network.setBlockedURLs', { urls: [] });
      await waitForSyncIdle(fresh, 40000);
      const st = await server.state();
      const mine = st.data.tasks.map((t) => t.title).filter((t) => t.endsWith(T)).sort();
      assert.deepEqual(mine, [`Real task one ${T}`, `Real task two ${T}`, `Typed in the new profile ${T}`], 'the folder keeps its tasks and gets the typed one');
      const onServer = new Set(Object.entries(st.data).flatMap(([c, list]) => list.map((x) => `${c}:${x.id}`)));
      assert.deepEqual(samples.filter((k) => onServer.has(k)), [], 'no sample record was pushed');
      await fresh.close();
    });
  });

  test('another browser erases everything: Ctrl+Z in a tab that does not hold the event stream brings nothing back', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-sync-protocol-pass2-undo', async () => {
      await openApp(page, server.url('schedule/')); // this tab holds the stream
      const tasks = await newPage(); // the same browser, another tab
      await openApp(tasks, server.url('tasks/#/inbox'));
      assert.equal(await page.evaluate(() => window.ecosysSync.leader), true);
      assert.equal(await tasks.evaluate(() => window.ecosysSync.leader), false);
      await tasks.bringToFront();
      await tasks.evaluate(() => document.querySelector('[data-check]').focus());
      await tasks.press('Delete'); // delete the selected task (Undo: Ctrl+Z)
      await sleep(600);
      await waitForSyncIdle(tasks);
      const other = await newPage({ isolated: true }); // another browser
      await openApp(other, server.url('tasks/'));
      await other.evaluate(async () => (await import('/shared/store.js')).resetData());
      await waitForSyncIdle(other);
      await server.waitForState((s) => s.data.tasks.length === 0, 10000, 'everything to be erased');
      await tasks.waitFor(async () => (await import('/shared/store.js')).db.all('tasks').length === 0, { timeout: 10000, message: 'the erase to reach the tab' });
      await tasks.bringToFront();
      await tasks.evaluate(() => document.activeElement?.blur());
      await tasks.press('Control+z');
      await sleep(1200);
      await waitForSyncIdle(tasks);
      assert.deepEqual((await server.state()).data.tasks.map((t) => t.title), [], 'nothing came back');
      assert.deepEqual(await tasks.evaluate(async () => (await import('/shared/store.js')).db.all('tasks').length), 0);
      await other.close();
      await tasks.close();
    });
  });

  test('a library bigger than localStorage: Tasks, Schedule and Notes load without “Could not save” or “Not saved”', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-sync-protocol-pass2-biglib', async () => {
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT_SAVE_ERRORS });
      await openApp(page, server.url('tasks/'));
      // Fill this browser's localStorage, leaving about 40 KB.
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
        // The smallest pieces go first, so about 40 to 70 KB stays free.
        const keys = Object.keys(localStorage).filter((x) => x.startsWith('qa-filler:'));
        keys.sort((a, b) => localStorage.getItem(a).length - localStorage.getItem(b).length);
        let freed = 0;
        for (const k of keys) {
          if (freed > 40000) break;
          freed += localStorage.getItem(k).length;
          localStorage.removeItem(k);
        }
      });
      try {
        // Another browser writes a long note: this browser's offline copy can't hold it.
        const other = await newPage({ isolated: true });
        await openApp(other, server.url('notes/'));
        await other.evaluate(async () => {
          const { db } = await import('/shared/store.js');
          db.insert('notes', { v: 1, rev: 1, folderId: null, blocks: Array.from({ length: 30 }, (_, i) => ({ id: `qa${i}`, t: 'p', c: [[`Long paragraph ${i} `.repeat(200)]] })) });
        });
        await waitForSyncIdle(other);
        await other.close();
        await server.waitForState((s) => s.data.notes.some((n) => JSON.stringify(n.blocks).includes('Long paragraph 29')), 10000, 'the long note on the server');
        await sleep(800);
        for (const path of ['tasks/', 'schedule/', 'notes/']) {
          await openApp(page, server.url(path), { settleMs: 1500 });
          await waitForSyncIdle(page);
          const seen = await page.evaluate(() => ({
            saveErrors: window.__saveErrors.length,
            toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText),
            banner: !!document.querySelector('.n-banner-err'),
          }));
          assert.equal(seen.saveErrors, 0, `${path}: no ecosys:save-error`);
          assert.ok(!seen.toasts.some((t) => /Could not save/.test(t)), `${path}: no “Could not save” toast (${seen.toasts.join(' | ')})`);
          assert.equal(seen.banner, false, `${path}: no “Not saved” banner`);
        }
        assert.equal(await page.evaluate(async () => (await import('/shared/store.js')).cacheSaved('notes')), false, 'the notes really did not fit');
      } finally {
        await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('qa-filler:')).forEach((k) => localStorage.removeItem(k)));
      }
    });
  });

  test('teardown', async () => {
    for (const p of pages) await p.close().catch(() => {});
  });
});
