// QA flows for sync and data, with two browser profiles (two isolated browser contexts of one headless
// Chrome) against one isolated server that can be stopped and started again on the same port and data
// folder:
//   live        a task added in one profile shows in the other without a reload, and back
//   offline     edits made while a profile is offline reach the server and the other profile on reconnect
//   stale       a change queued while offline must not overwrite a newer change made meanwhile: each
//               profile changed a different field, and both changes are kept, in both profiles
//   restart     the server stops mid-session: edits made meanwhile are kept and sent once it is back
//   settings    theme, accent, 24-hour clock and week start reach every open app and the other profile
//   backup      Export backup, Erase everything, Import backup gives back exactly what was there
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { freePort, removeTempDir, readPairSecret, ROOT } from './server.mjs';
import { openApp, waitForSyncIdle, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'server-child.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

/**
 * An isolated ecosys server (random port, temp data folder) that can be stopped and started again on
 * the same port and folder, which startServer() in server.mjs does not offer.
 */
function restartableServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ecosys-e2e-data-'));
  let port = null;
  let child = null;
  let output = '';
  const base = () => `http://127.0.0.1:${port}/`;
  const alive = () => !!child && child.exitCode === null && child.signalCode === null;
  const hello = async () => {
    try {
      const r = await fetch(`${base()}api/hello`, { headers: { 'X-Ecosys': '1' }, signal: AbortSignal.timeout(1500) });
      return r.status === 200;
    } catch {
      return false;
    }
  };
  const srv = {
    dataDir,
    get port() {
      return port;
    },
    url: (p = '') => base() + String(p).replace(/^\/+/, ''),
    output: () => output,
    async start() {
      if (alive()) return;
      port ??= await freePort();
      const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', ECOSYS_DATA_DIR: dataDir, ECOSYS_E2E_PARENT: String(process.pid) };
      for (const k of ['ECOSYS_ALLOWED_HOSTS', 'ECOSYS_CLIENT', 'NODE_TEST_CONTEXT']) delete env[k];
      output = '';
      child = spawn(process.execPath, [CHILD], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      child.stdout.on('data', (d) => (output = (output + d).slice(-20000)));
      child.stderr.on('data', (d) => (output = (output + d).slice(-20000)));
      const until = Date.now() + 20000;
      while (!(await hello())) {
        if (!alive()) throw new Error(`e2e: the server exited while starting:\n${output}`);
        if (Date.now() > until) throw new Error(`e2e: the server did not answer on port ${port}:\n${output}`);
        await sleep(100);
      }
    },
    async stop() {
      if (!alive()) return;
      const c = child;
      const gone = new Promise((r) => c.once('exit', r));
      try {
        c.disconnect(); // server-child.mjs shuts the server down when the channel closes
      } catch {}
      if (!(await Promise.race([gone.then(() => true), sleep(6000).then(() => false)]))) {
        try {
          c.kill();
        } catch {}
        await Promise.race([gone, sleep(3000)]);
      }
    },
    async api(path, { method = 'GET', body } = {}) {
      // As a paired browser: the secret the server keeps in its data folder (server-child.mjs gives every e2e server the same one).
      const res = await fetch(srv.url(path), { method, headers: { 'X-Ecosys': readPairSecret(dataDir), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    async state() {
      const r = await srv.api('api/state');
      if (r.status !== 200) throw new Error(`GET /api/state answered ${r.status}`);
      return r.json;
    },
    async waitForState(pred, ms = 10000, what = 'the server state to match') {
      const until = Date.now() + ms;
      for (;;) {
        try {
          const v = pred(await srv.state());
          if (v) return v;
        } catch {}
        if (Date.now() > until) throw new Error(`e2e: timed out after ${ms} ms waiting for ${what}`);
        await sleep(150);
      }
    },
    async dispose() {
      await srv.stop();
      removeTempDir(dataDir);
    },
  };
  return srv;
}

/** Press a single-key shortcut with nothing focused. */
async function shortcut(page, key) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.press(key);
}

/** Tasks: add one task through the composer of the current view. */
async function addTask(page, text) {
  if (!(await page.exists('textbox', 'Task name'))) await page.clickText('button', /^add task$/i);
  await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', 3000);
  await page.type(text);
  await page.press('Enter');
  await page.press('Escape');
}

/** Schedule: create an event with the Create card. */
async function addEvent(page, text) {
  await shortcut(page, 'c');
  await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Title', 4000);
  await page.type(text);
  await page.clickText('button', /^Save$/);
}

const setOffline = (page, offline) =>
  page.send('Network.enable').then(() => page.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }));

describe('qa flows: two profiles, offline, server restart, settings, backup', () => {
  const ctx = { server: null, browser: null, p1: null, p2: null, today: null, tomorrow: null };

  before(async () => {
    ctx.browser = await launch();
    ctx.server = restartableServer();
    await ctx.server.start();
    ctx.p1 = await ctx.browser.newPage(); // profile 1: Tasks
    ctx.p2 = await ctx.browser.newPage({ isolated: true }); // profile 2: Schedule
    for (const p of [ctx.p1, ctx.p2]) {
      await p.setViewport(1440, 900, false);
      await p.emulateColorScheme('light');
    }
    await openApp(ctx.p1, ctx.server.url('tasks/#/inbox'));
    await openApp(ctx.p2, ctx.server.url('schedule/'));
    ctx.today = await browserToday(ctx.p1);
    ctx.tomorrow = addDaysYmd(ctx.today, 1);
    await ctx.p2.evaluate((d) => (location.hash = `#/day/${d}`), ctx.tomorrow);
  });
  after(async () => {
    await ctx.browser?.close().catch(() => {});
    await ctx.server?.dispose().catch(() => {});
  });

  test('a task added in one profile shows in the other without a reload, and back', async () => {
    const { p1, p2, server, tomorrow } = ctx;
    await withScreenshot(p2, 'qa-sync-live', async () => {
      const title = `QA two profiles ${tag()}`;
      await p1.bringToFront();
      await addTask(p1, `${title} tomorrow 1pm`);
      const t = await server.waitForState((s) => s.data.tasks.find((x) => x.title === title), 10000, 'the task on the server');
      await p2.waitFor(`.ev[data-task="${t.id}"]`, { timeout: 10000, message: 'the task to reach the other profile live' });
      await p2.bringToFront();
      await p2.click((id) => document.querySelector(`.ev[data-task="${id}"] [role=checkbox]`), { args: [t.id] });
      await server.waitForState((s) => s.data.tasks.find((x) => x.id === t.id && x.done), 8000, 'the task to be done on the server');
      await p1.waitFor((id) => !document.querySelector(`.task[data-id="${id}"]:not(.is-done)`), { timeout: 10000, args: [t.id], message: 'the first profile to see it done' });
    });
  });

  test('edits made offline reach the server and the other profile after reconnecting', async () => {
    const { p1, p2, server } = ctx;
    await withScreenshot(p2, 'qa-sync-offline', async () => {
      const evTitle = `QA offline event ${tag()}`;
      const taskTitle = `QA online task ${tag()}`;
      await setOffline(p2, true);
      try {
        await p2.bringToFront();
        await addEvent(p2, `${evTitle} tomorrow 4pm`);
        await p2.waitFor(() => window.ecosysSync?.online === false, { timeout: 8000, message: 'the offline profile to know it is offline' });
        await p1.bringToFront();
        await addTask(p1, taskTitle);
        await server.waitForState((s) => s.data.tasks.some((x) => x.title === taskTitle), 10000, 'the online task on the server');
        await sleep(500);
        assert.ok(!(await server.state()).data.events.some((x) => x.title === evTitle), 'the offline event has not reached the server yet');
      } finally {
        await setOffline(p2, false);
      }
      const ev = await server.waitForState((s) => s.data.events.find((x) => x.title === evTitle), 20000, 'the offline event to reach the server after reconnecting');
      assert.equal(ev.start, `${ctx.tomorrow}T16:00`);
      await waitForSyncIdle(p2, 20000);
      await p2.waitFor((t) => JSON.parse(localStorage.getItem('ecosys:v1:tasks') || '[]').some((x) => x.title === t), { timeout: 10000, args: [taskTitle], message: "the reconnected profile to receive the other profile's task" });
      await p1.evaluate(() => (location.hash = '#/upcoming'));
      await p1.waitForText(evTitle, 10000);
    });
  });

  // Regression test for the wave-1 finding 'Reconnect pushes stale offline edits over newer changes (last
  // arrival wins, not last write)'. A queued edit says which fields it changed, and the server merges just
  // those into a copy that changed meanwhile (server/store.mjs applyOps, shared/sync.js).
  test('a change queued offline does not overwrite a newer change made meanwhile', async () => {
    const { p1, p2, server } = ctx;
    await withScreenshot(p1, 'qa-sync-stale', async () => {
      const title = `QA conflict ${tag()}`;
      const renamed = `${title} renamed later`;
      await p1.bringToFront();
      await p1.evaluate(() => (location.hash = '#/inbox'));
      await settle(p1, 200);
      await addTask(p1, `${title} tomorrow 2pm`);
      const t = await server.waitForState((s) => s.data.tasks.find((x) => x.title === title), 10000, 'the task on the server');
      await p2.waitFor(`.ev[data-task="${t.id}"]`, { timeout: 10000 });

      // Profile 2, offline, completes it (first)...
      await setOffline(p2, true);
      try {
        await p2.bringToFront();
        await p2.click((id) => document.querySelector(`.ev[data-task="${id}"] [role=checkbox]`), { args: [t.id] });
        await p2.waitFor((id) => JSON.parse(localStorage.getItem('ecosys:v1:tasks') || '[]').find((x) => x.id === id)?.done === true, { timeout: 8000, args: [t.id] });
        await sleep(300);
        // ...then profile 1 renames it (later, online).
        await p1.bringToFront();
        await p1.evaluate((id) => (location.hash = `#/task/${id}`), t.id);
        await p1.waitFor('#inspector [aria-label="Task name"]', 5000);
        await p1.click('#inspector [aria-label="Task name"]');
        await p1.press('Control+a');
        await p1.type(renamed);
        await p1.press('Tab');
        await server.waitForState((s) => s.data.tasks.find((x) => x.id === t.id)?.title === renamed, 8000, 'the rename on the server');
        await p1.press('Escape');
      } finally {
        await setOffline(p2, false);
      }
      await waitForSyncIdle(p2, 20000);
      await sleep(800);
      const now = (await server.state()).data.tasks.find((x) => x.id === t.id);
      assert.equal(now.title, renamed, 'the newer rename survives the older offline edit');
      assert.equal(now.done, true, 'the offline completion is kept too: it changed another field, so it is merged, not dropped');
      // Both profiles end up with the merged copy.
      const merged = (id, want) => {
        const x = JSON.parse(localStorage.getItem('ecosys:v1:tasks') || '[]').find((y) => y.id === id);
        return x?.title === want && x.done === true;
      };
      await p2.waitFor(merged, { timeout: 10000, args: [t.id, renamed], message: 'the offline profile to take the rename' });
      await p1.waitFor(merged, { timeout: 10000, args: [t.id, renamed], message: 'the online profile to take the offline completion' });
    });
  });

  test('the server stops mid-session: edits made meanwhile are sent once it is back', async () => {
    const { p1, p2, server } = ctx;
    await withScreenshot(p1, 'qa-sync-restart', async () => {
      const title = `QA while down ${tag()}`;
      await p1.bringToFront();
      await p1.evaluate(() => (location.hash = '#/inbox'));
      await settle(p1, 200);
      await server.stop();
      await p1.waitFor(() => window.ecosysSync?.online === false, { timeout: 15000, message: 'the page to notice the server is gone' });
      await addTask(p1, `${title} tomorrow 9am`);
      await p1.waitFor((t) => document.body.innerText.includes(t), { timeout: 5000, args: [title], message: 'the task to show while the server is down' });
      await sleep(1000);
      await server.start(); // same port, same data folder
      const t = await server.waitForState((s) => s.data.tasks.find((x) => x.title === title), 30000, 'the task made while the server was down to reach it');
      assert.equal(t.date, ctx.tomorrow);
      await p2.waitFor(`.ev[data-task="${t.id}"]`, { timeout: 30000, message: 'the other profile to get it once both are reconnected' });
      await waitForSyncIdle(p1, 20000);
    });
  });

  test('settings reach every open app and the other profile: theme, accent, 24-hour clock, week start', async () => {
    const { browser, p1, p2, server } = ctx;
    const home = await browser.newPage(); // profile 1
    try {
      await home.setViewport(1440, 900, false);
      await home.emulateColorScheme('light');
      await openApp(home, server.url(''));
      await p2.evaluate((d) => (location.hash = `#/week/${d}`), ctx.tomorrow);
      await withScreenshot(p1, 'qa-sync-settings', async () => {
        await p1.bringToFront();
        await shortcut(p1, ',');
        await p1.waitFor('.modal.settings', 4000);
        await p1.clickText('radio', 'Dim');
        await p1.clickText('radio', 'Pink');
        await p1.click(() => [...document.querySelectorAll('[data-set="timeFormat"]')].find((b) => b.dataset.val === '24h'));
        await p1.click(() => [...document.querySelectorAll('[data-set="weekStart"]')].find((b) => b.dataset.val === '1'));
        await p1.press('Escape');
        await server.waitForState((s) => s.settings.theme === 'dim' && s.settings.accent === 'pink' && s.settings.timeFormat === '24h' && s.settings.weekStart === 1, 8000, 'the settings on the server');
        const look = () => ({ theme: document.documentElement.dataset.theme, accent: document.documentElement.dataset.accent });
        for (const [name, p] of [['home (same profile)', home], ['schedule (other profile)', p2]]) {
          await p.waitFor((want) => document.documentElement.dataset.theme === want, { timeout: 10000, args: ['dim'], message: `${name} to switch to Dim` });
          assert.deepEqual(await p.evaluate(look), { theme: 'dim', accent: 'pink' }, name);
        }
        // The other profile's week now starts on Monday and its hours read 13:00, not 1 PM.
        await p2.waitFor(() => new Date(`${document.querySelector('.grid-body .col')?.dataset.date}T12:00`).getDay() === 1, { timeout: 8000, message: 'the week to start on Monday' });
        await p2.waitFor(() => /\b13:00\b/.test(document.querySelector('#view')?.innerText || ''), { timeout: 8000, message: 'the hours to use the 24-hour clock' });
      });
    } finally {
      await ctx.server.api('api/ops', { method: 'POST', body: { client: 'qa-reset', baseRev: 0, ops: [{ op: 'settings', patch: { theme: 'system', accent: 'iris', timeFormat: 'auto', weekStart: 0 } }] } });
      await home.close();
    }
  });

  test('Export backup, Erase everything, Import backup gives back exactly what was there', async () => {
    const { browser, p1, p2, server } = ctx;
    const dl = mkdtempSync(join(tmpdir(), 'ecosys-e2e-dl-'));
    try {
      await withScreenshot(p1, 'qa-sync-backup', async () => {
        await waitForSyncIdle(p1);
        await waitForSyncIdle(p2);
        const before = await server.state();
        await browser.conn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
        await p1.bringToFront();
        await shortcut(p1, ',');
        await p1.waitFor('.modal.settings', 4000);
        await p1.clickText('button', /Export backup/);
        let file = null;
        for (let i = 0; i < 50 && !file; i++) {
          await sleep(200);
          file = readdirSync(dl).find((f) => /^ecosys-backup-.*\.json$/.test(f));
        }
        assert.ok(file, 'the backup file was downloaded');
        const backup = JSON.parse(readFileSync(join(dl, file), 'utf8'));
        assert.equal(backup.app, 'ecosys');
        assert.equal(backup.tasks.length, before.data.tasks.length, 'the backup has every task');

        // Erase everything.
        await p1.clickText('button', /Erase everything/);
        await p1.waitFor(() => [...document.querySelectorAll('[role=alertdialog], [role=dialog]')].some((d) => /Erase everything\?/.test(d.innerText)), 4000);
        await p1.click(() => [...document.querySelectorAll('[role=alertdialog] button, [role=dialog] button')].filter((b) => b.innerText.trim() === 'Erase everything').pop());
        await server.waitForState((s) => s.data.tasks.length === 0 && s.data.events.length === 0, 10000, 'the server to be emptied');
        await p2.waitFor(() => !document.querySelector('.ev[data-ev], .ev[data-task]'), { timeout: 10000, message: 'the other profile to be emptied' });

        // Import the file.
        await shortcut(p1, ',');
        await p1.waitFor('.modal.settings', 4000);
        await p1.send('Page.setInterceptFileChooserDialog', { enabled: true });
        try {
          const chooser = p1.waitForEvent('Page.fileChooserOpened', { timeout: 5000 });
          await p1.clickText('button', /Import backup/);
          const { backendNodeId } = await chooser;
          await p1.send('DOM.setFileInputFiles', { files: [join(dl, file)], backendNodeId });
        } finally {
          await p1.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
        }
        await p1.waitFor(() => [...document.querySelectorAll('[role=alertdialog], [role=dialog]')].some((d) => /Import this backup\?/.test(d.innerText)), 5000);
        await p1.click(() => [...document.querySelectorAll('[role=alertdialog] button, [role=dialog] button')].filter((b) => b.innerText.trim() === 'Import').pop());
        const after = await server.waitForState((s) => (s.data.tasks.length === before.data.tasks.length ? s : null), 10000, 'the import to reach the server');

        const diffs = [];
        for (const c of Object.keys(before.data)) {
          const now = new Map(after.data[c].map((x) => [x.id, JSON.stringify(x)]));
          for (const x of before.data[c]) if (now.get(x.id) !== JSON.stringify(x)) diffs.push(`${c}:${x.id}`);
          if (after.data[c].length !== before.data[c].length) diffs.push(`${c}: ${before.data[c].length} → ${after.data[c].length}`);
        }
        assert.deepEqual(diffs, [], 'every record is back as it was');
        assert.deepEqual(after.settings, before.settings, 'the settings are back as they were');
        await p2.waitFor('.ev[data-ev], .ev[data-task]', { timeout: 10000, message: 'the other profile to show the imported data' });
      });
    } finally {
      rmSync(dl, { recursive: true, force: true });
    }
  });

  test('no console errors other than the expected connection failures', () => {
    const benign = (e) => /ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to fetch|NetworkError|net::ERR_FAILED/i.test(`${e.text} ${e.url || ''}`);
    const errors = [ctx.p1, ctx.p2].flatMap((p) => p.consoleErrors().filter((e) => !benign(e)));
    assert.deepEqual(errors.map((e) => `[${e.source}] ${e.text}`), []);
  });
});
