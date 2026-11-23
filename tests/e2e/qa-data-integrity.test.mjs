// QA data safety, end to end: headless Chrome profiles and tabs against isolated ecosys servers that are
// stopped, restarted and given a new data folder on the same port (so the browsers keep their copies).
// Every test here pins a way data is lost or brought back against the user's will; they are `todo` until
// fixed (a todo test that fails does not fail the run):
//   reset       the server comes back with an empty data folder while a tab is open, or a new profile
//               reaches the new folder first: the browser that held the data replaces it with nothing / samples;
//               a program holding data.json open for a moment makes the server start empty and overwrite it
//   concurrent  an assistant's change lands while the user's edit of the same task / note is on its way:
//               the user's whole record is re-applied and pushed over it
//   offline     changes made while ecosys is not running vanish when the tab is closed and ecosys is
//               opened again (for 2 minutes when small; for good when the outbox is over 256 KB)
//   undo        Ctrl+Z in another tab of the same browser after Erase everything brings a deleted task back
//   quota       with localStorage full, the other tabs of the browser stop getting remote changes and
//               their next edit reverts them
//   housekeep   Notes started before its first sync purges / expires on its stale copy and syncs that:
//               a note recovered elsewhere is deleted for good, newer text from elsewhere is overwritten
//   backup      a backup made with Export backup is refused by Import backup once it is over 5 MB
// Each test starts its own server (random port, temp data folder) and removes it afterwards.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { freePort, removeTempDir, readPairSecret, ROOT } from './server.mjs';
import { tag } from './helpers.mjs';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'server-child.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;

/** An isolated server that can be stopped and started again on the same port, with the same or a new data folder. */
function makeServer() {
  const dirs = [mkdtempSync(join(tmpdir(), 'ecosys-e2e-data-'))];
  let port = null;
  let child = null;
  let output = '';
  const alive = () => !!child && child.exitCode === null && child.signalCode === null;
  const url = (p = '') => `http://127.0.0.1:${port}/${String(p).replace(/^\/+/, '')}`;
  const hello = async () => {
    try {
      const r = await fetch(url('api/hello'), { headers: { 'X-Ecosys': '1' }, signal: AbortSignal.timeout(1500) });
      return r.status === 200;
    } catch {
      return false;
    }
  };
  const srv = {
    url,
    get dataDir() {
      return dirs.at(-1);
    },
    /** The next start uses a new, empty data folder (as after a corrupt data.json, a deleted .ecosys, another ECOSYS_DATA_DIR). */
    newDataFolder() {
      dirs.push(mkdtempSync(join(tmpdir(), 'ecosys-e2e-data-')));
    },
    async start() {
      if (alive()) return;
      port ??= await freePort();
      const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', ECOSYS_DATA_DIR: srv.dataDir, ECOSYS_E2E_PARENT: String(process.pid) };
      for (const k of ['ECOSYS_ALLOWED_HOSTS', 'ECOSYS_CLIENT', 'NODE_TEST_CONTEXT', 'TZ']) delete env[k];
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
    async api(path, { method = 'GET', body, headers = {} } = {}) {
      const res = await fetch(url(path), {
        method,
        // As a paired browser: the secret the server keeps in its data folder (server-child.mjs gives every e2e server the same one).
        headers: { 'X-Ecosys': readPairSecret(srv.dataDir), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json, text };
    },
    async state() {
      const r = await srv.api('api/state');
      if (r.status !== 200) throw new Error(`GET /api/state answered ${r.status}`);
      return r.json;
    },
    async waitForState(pred, ms = 10000) {
      const until = Date.now() + ms;
      for (;;) {
        try {
          const v = pred(await srv.state());
          if (v) return v;
        } catch {}
        if (Date.now() > until) return null;
        await sleep(150);
      }
    },
    /** A read & write AI connection's key. */
    async aiToken() {
      const r = await srv.api('api/ai/clients', { method: 'POST', body: { kind: 'claude', access: 'write' } });
      return r.json.client.token;
    },
    /** Call an MCP tool as that assistant. */
    async mcp(token, name, args) {
      const res = await fetch(url('mcp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(15000),
      });
      const r = (await res.json()).result;
      assert.ok(r && !r.isError, `${name} failed: ${r?.content?.[0]?.text}`);
      return r.structuredContent;
    },
    async dispose() {
      await srv.stop();
      for (const d of dirs) removeTempDir(d);
    },
  };
  return srv;
}

/** Load an app page and wait until the shell runs and sync is online. */
async function open(page, url) {
  await page.goto(url);
  await page.waitFor(() => !!window.ecosysSync && document.readyState === 'complete', { timeout: 20000, message: 'the app to start' });
  await page.waitFor(() => window.ecosysSync?.online === true, { timeout: 20000, message: 'sync to come online' });
  await sleep(400);
}
const idle = (page, timeout = 15000) => page.waitFor(() => window.ecosysSync?.online === true && !window.ecosysSync.pending, { timeout, message: 'sync to finish sending' }).catch(() => {});
/** Titles of this tab's tasks and notes (from its store) that start with `prefix`. */
const localTitles = (page, prefix) =>
  page.evaluate(async (p) => {
    const { snapshot } = await import('/shared/store.js');
    const d = snapshot().data;
    return [...d.tasks.map((t) => t.title), ...d.notes.map((n) => n.title)].filter((t) => typeof t === 'string' && t.startsWith(p));
  }, prefix);
const serverTitles = async (srv, prefix) => {
  const d = (await srv.state()).data;
  return [...d.tasks.map((t) => t.title), ...d.notes.map((n) => n.title)].filter((t) => typeof t === 'string' && t.startsWith(prefix));
};
const addTasks = (page, prefix, n = 3) =>
  page.evaluate(
    async ({ prefix, n }) => {
      const { db } = await import('/shared/store.js');
      for (let i = 0; i < n; i++) db.insert('tasks', { title: `${prefix} ${i + 1}`, listId: null });
    },
    { prefix, n },
  );

describe('qa data integrity: resets, concurrent edits, offline, undo, quota, housekeeping, backups', () => {
  let browser = null;
  before(async () => {
    browser = await launch();
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  test(
    'reset: the server comes back with an empty data folder while a tab is open; the tab keeps its data and brings it there',
    { todo: 'resync() replaces the tab’s copy with the new folder’s empty, uninitialized state: every collection is emptied in the tab and its localStorage, and the reload then imports nothing' },
    async () => {
      const srv = makeServer();
      let p;
      try {
        await srv.start();
        p = await browser.newPage();
        await open(p, srv.url('tasks/'));
        const T = `Kept ${tag()}`;
        await addTasks(p, T);
        await idle(p);
        assert.equal((await serverTitles(srv, T)).length, 3);
        await srv.stop();
        srv.newDataFolder(); // data.json corrupt and moved aside, .ecosys deleted, another ECOSYS_DATA_DIR, a new copy of ecosys
        await srv.start();
        await p.waitFor(() => window.ecosysSync?.online === true, { timeout: 30000, message: 'the tab to reconnect' });
        await sleep(3000);
        assert.equal((await localTitles(p, T)).length, 3, 'the open tab still has its tasks');
        assert.ok(await srv.waitForState((s) => s.initialized && s.data.tasks.filter((t) => t.title.startsWith(T)).length === 3, 10000), 'and the new data folder gets them');
      } finally {
        await p?.close().catch(() => {});
        await srv.dispose();
      }
    },
  );

  test(
    'reset: a program that holds data.json open for a moment wipes neither the server nor the open tab',
    {
      todo: 'DataStore.load() handles a sharing violation (EBUSY) like invalid JSON: the server starts empty and uninitialized (the log says the file was moved aside, but the rename failed), the open tab resyncs to that and empties itself, and the next change saves the empty store over data.json',
      skip: process.platform !== 'win32' && 'needs a Windows sharing violation',
    },
    async () => {
      const srv = makeServer();
      let p;
      try {
        await srv.start();
        p = await browser.newPage();
        await open(p, srv.url('tasks/'));
        const T = `Held ${tag()}`;
        await addTasks(p, T);
        await idle(p);
        // A backup or sync client (or an editor) opens data.json without sharing and touches it.
        const file = join(srv.dataDir, 'data.json').replace(/'/g, "''");
        const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${file}','Open','ReadWrite','None'); $b=New-Object byte[] 1; [void]$f.Read($b,0,1); $f.Position=0; Start-Sleep -Milliseconds 200; $f.Write($b,0,1); $f.Flush(); Start-Sleep -Seconds 3; $f.Close()`], { stdio: 'ignore', windowsHide: true });
        await new Promise((r) => ps.once('exit', r));
        await sleep(2000);
        assert.equal((await localTitles(p, T)).length, 3, 'the open tab still has its tasks');
        await addTasks(p, `${T} later`, 1);
        await idle(p);
        await sleep(500);
        assert.equal((await serverTitles(srv, T)).length, 4, 'and the server keeps them with the new one');
      } finally {
        await p?.close().catch(() => {});
        await srv.dispose();
      }
    },
  );

  test(
    'reset: a new profile that reaches a new data folder first does not cost the older profile its data',
    { todo: 'A browser that synced before trusts any initialized server: after another profile imported its sample data into the new folder, firstLoad() replaces this browser’s copy with those samples and nothing of its own is sent (README: later browsers add what the folder doesn’t have)' },
    async () => {
      const srv = makeServer();
      const pages = [];
      try {
        await srv.start();
        const a = await browser.newPage();
        pages.push(a);
        await open(a, srv.url('tasks/'));
        const T = `Mine ${tag()}`;
        await addTasks(a, T);
        await idle(a);
        await a.close();
        await srv.stop();
        srv.newDataFolder();
        await srv.start();
        const b = await browser.newPage({ isolated: true }); // another profile or browser, opened first
        pages.push(b);
        await open(b, srv.url('schedule/'));
        await idle(b);
        const a2 = await browser.newPage(); // the first profile again
        pages.push(a2);
        await open(a2, srv.url('tasks/'));
        await idle(a2);
        await sleep(1000);
        assert.equal((await localTitles(a2, T)).length, 3, 'the first profile still has its tasks');
        assert.equal((await serverTitles(srv, T)).length, 3, 'and sent them to the new data folder');
      } finally {
        for (const p of pages) await p.close().catch(() => {});
        await srv.dispose();
      }
    },
  );

  test(
    'concurrent: an assistant completes a task while the user is typing in it; both changes are kept',
    { todo: 'The pending local edit (deferred save, then the push) is re-applied as the whole record over the remote op and pushed: complete_tasks reports success but the task stays open' },
    async () => {
      const srv = makeServer();
      let p;
      try {
        await srv.start();
        p = await browser.newPage();
        await open(p, srv.url('tasks/'));
        const token = await srv.aiToken();
        const id = (await srv.mcp(token, 'create_tasks', { tasks: [{ title: `Renew passport ${tag()}` }] })).created[0].task_id;
        await p.waitFor(async (i) => !!(await import('/shared/store.js')).db.get('tasks', i), { args: [id], timeout: 8000 });
        // Typing in the task's notes saves with { defer: true }; the assistant completes the task a moment later.
        await p.evaluate(async (i) => (await import('/shared/store.js')).db.update('tasks', i, { notes: 'photo booth on Main St' }, { defer: true }), id);
        await srv.mcp(token, 'complete_tasks', { task_ids: [id] });
        await sleep(2500);
        await idle(p);
        const t = (await srv.state()).data.tasks.find((x) => x.id === id);
        assert.equal(t.notes, 'photo booth on Main St', 'the user’s typing is saved');
        assert.equal(t.done, true, 'the assistant’s completion is kept');
      } finally {
        await p?.close().catch(() => {});
        await srv.dispose();
      }
    },
  );

  test(
    'concurrent: an assistant appends to a note while the user’s save of it is on its way; both texts are kept',
    { todo: 'The browser’s put (same rev as the assistant’s write) replaces the note on the server, and the editor skips the merge because note.rev equals its baseRev: notes_append reports success, the toast says Claude added to the note, the text is gone' },
    async () => {
      const srv = makeServer();
      let p;
      try {
        await srv.start();
        p = await browser.newPage();
        await p.setViewport(1280, 800, false);
        await open(p, srv.url('notes/'));
        const token = await srv.aiToken();
        const id = (await srv.mcp(token, 'notes_create', { markdown: '# Plan for Friday\n\nFirst line.' })).id;
        await p.waitFor(async (i) => !!(await import('/shared/store.js')).db.get('notes', i), { args: [id], timeout: 8000 });
        await p.evaluate((i) => (location.hash = `#/all/n/${i}`), id);
        await p.waitFor(() => !!document.querySelector('#editorhost [contenteditable="true"]'), { timeout: 8000 });
        await sleep(600);
        await p.evaluate(() => {
          const ed = document.querySelector('#editorhost [contenteditable="true"]');
          ed.focus();
          const r = document.createRange();
          r.selectNodeContents(ed);
          r.collapse(false);
          getSelection().removeAllRanges();
          getSelection().addRange(r);
          // The server is busy for a moment (another process holds the data lock): pushes take 1.5 s.
          const real = window.fetch;
          window.fetch = (u, o) => (String(u).includes('/api/ops') && o?.method === 'POST' ? sleep(1500).then(() => real(u, o)) : real(u, o));
          function sleep(ms) {
            return new Promise((res) => setTimeout(res, ms));
          }
        });
        await p.type(' USERTEXT', { keys: true });
        await sleep(600); // saved 400 ms after the last key; its push is on its way
        await srv.mcp(token, 'notes_append', { id, markdown: 'AILINE from the assistant' });
        await sleep(4000);
        await idle(p);
        const blocks = JSON.stringify((await srv.state()).data.notes.find((n) => n.id === id).blocks);
        assert.ok(blocks.includes('USERTEXT'), 'the user’s text is saved');
        assert.ok(blocks.includes('AILINE'), 'the assistant’s appended line is kept');
      } finally {
        await p?.close().catch(() => {});
        await srv.dispose();
      }
    },
  );

  test(
    'offline: tasks added while ecosys is not running are there when ecosys is opened again right away',
    { todo: 'A closed tab’s outbox is treated as another live tab’s for 2 minutes (ABANDONED_MS), so the next page does not send it and replaces its copy with the server’s: the tasks vanish until a reload more than 2 minutes later' },
    async () => {
      const srv = makeServer();
      let p;
      try {
        await srv.start();
        p = await browser.newPage();
        await open(p, srv.url('tasks/'));
        await idle(p);
        await srv.stop(); // the terminal running ecosys was closed, the computer restarted...
        const T = `Offline ${tag()}`;
        await addTasks(p, T);
        await sleep(1500);
        await p.close(); // ...and the tab too
        await srv.start();
        p = await browser.newPage();
        await open(p, srv.url('tasks/'));
        await idle(p);
        await sleep(1500);
        assert.equal((await localTitles(p, T)).length, 3, 'the tasks are in the reopened app');
        assert.equal((await serverTitles(srv, T)).length, 3, 'and on the server');
      } finally {
        await p?.close().catch(() => {});
        await srv.dispose();
      }
    },
  );

  test(
    'offline: long notes written while ecosys is not running survive closing the tab',
    { todo: 'An outbox over 256 KB is kept in sessionStorage only, which closing the tab discards; the next page replaces its copy with the server’s, so the notes are lost for good' },
    async () => {
      const srv = makeServer();
      let p;
      try {
        await srv.start();
        p = await browser.newPage();
        await open(p, srv.url('notes/'));
        await idle(p);
        await srv.stop();
        const T = `Minutes ${tag()}`;
        await p.evaluate(async (title) => {
          const { db } = await import('/shared/store.js');
          for (const k of [1, 2]) {
            const blocks = [{ id: 'h', t: 'h1', c: [[`${title} ${k}`]] }];
            for (let i = 0; i < 180; i++) blocks.push({ id: `p${i}`, t: 'p', c: [[`Item ${i}: decisions and follow-ups from the planning meeting. `.repeat(12)]] });
            db.insert('notes', { v: 1, rev: 1, blocks });
          }
        }, T);
        await sleep(1500);
        await p.close();
        await srv.start();
        p = await browser.newPage();
        await open(p, srv.url('notes/'));
        await idle(p);
        await sleep(1500);
        assert.equal((await localTitles(p, T)).length, 2, 'both notes are in the reopened app');
        assert.equal((await serverTitles(srv, T)).length, 2, 'and on the server');
      } finally {
        await p?.close().catch(() => {});
        await srv.dispose();
      }
    },
  );

  test(
    'undo: Ctrl+Z in another tab of the same browser after Erase everything does not bring a task back',
    { todo: 'Erase everything and Import backup clear the undo history only in the tab that ran them (ecosys:data-replaced is not raised in the other tabs of that browser): their Ctrl+Z puts deleted records back into the erased or imported data' },
    async () => {
      const srv = makeServer();
      const pages = [];
      try {
        await srv.start();
        const p1 = await browser.newPage();
        pages.push(p1);
        await open(p1, srv.url('tasks/#/inbox'));
        await idle(p1);
        const p2 = await browser.newPage(); // the same browser, another tab
        pages.push(p2);
        await open(p2, srv.url('schedule/'));
        await p1.bringToFront();
        await p1.evaluate(() => document.querySelector('[data-check]').focus());
        await p1.press('Delete'); // delete the selected task (Undo: Ctrl+Z)
        await sleep(600);
        await idle(p1);
        await p2.evaluate(async () => (await import('/shared/store.js')).resetData()); // Settings > Erase everything
        await idle(p2);
        assert.ok(await srv.waitForState((s) => s.data.tasks.length === 0), 'everything was erased');
        await p1.bringToFront();
        await p1.evaluate(() => document.activeElement?.blur());
        await p1.press('Control+z');
        await sleep(1000);
        await idle(p1);
        assert.deepEqual((await srv.state()).data.tasks.map((t) => t.title), [], 'nothing came back');
      } finally {
        for (const p of pages) await p.close().catch(() => {});
        await srv.dispose();
      }
    },
  );

  test(
    'quota: with localStorage full, the other tabs still get an assistant’s change and do not revert it',
    { todo: 'Remote changes reach the tabs that do not hold the event stream only through localStorage; when it is full they keep a stale copy (with no warning there) and their next edit of that task puts the old title back on the server' },
    async () => {
      const srv = makeServer();
      const pages = [];
      try {
        await srv.start();
        const a = await browser.newPage();
        pages.push(a);
        await open(a, srv.url('tasks/'));
        await idle(a);
        const b = await browser.newPage();
        pages.push(b);
        await open(b, srv.url('tasks/'));
        const token = await srv.aiToken();
        const id = (await srv.mcp(token, 'create_tasks', { tasks: [{ title: 'Renew car insurance' }] })).created[0].task_id;
        await sleep(1500);
        await a.evaluate(() => {
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
        await srv.mcp(token, 'update_tasks', { tasks: [{ task_id: id, title: 'Renew car insurance before Dec 3' }] });
        await sleep(2000);
        const other = (await a.evaluate(() => window.ecosysSync.leader)) ? b : a;
        const seen = await other.evaluate(async (i) => (await import('/shared/store.js')).db.get('tasks', i)?.title, id);
        await other.evaluate(async (i) => (await import('/shared/store.js')).db.update('tasks', i, { priority: 3 }), id); // the user stars it there
        await sleep(2000);
        const t = (await srv.state()).data.tasks.find((x) => x.id === id);
        await a.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('qa-filler:')).forEach((k) => localStorage.removeItem(k)));
        assert.equal(seen, 'Renew car insurance before Dec 3', 'the other tab got the assistant’s rename');
        assert.equal(t.title, 'Renew car insurance before Dec 3', 'starring it there did not put the old title back');
        assert.equal(t.priority, 3);
      } finally {
        for (const p of pages) await p.close().catch(() => {});
        await srv.dispose();
      }
    },
  );

  test(
    'housekeeping: Notes started before its first sync leaves alone what another browser changed',
    { todo: 'notes/app.js housekeeping() (purgeTrash 30 days, expireAiReviews 7 days) runs at requestIdleCallback on the stale local copy and syncs whole records / deletes: a note recovered in another browser is deleted for good and that browser’s newer text is overwritten (natural race with ~1,500 notes; here the API is unreachable for 3 s)' },
    async () => {
      const srv = makeServer();
      const pages = [];
      try {
        await srv.start();
        let a = await browser.newPage(); // browser A
        pages.push(a);
        await open(a, srv.url('tasks/'));
        const ids = await a.evaluate(async (DAY) => {
          const { db } = await import('/shared/store.js');
          const t = Date.now();
          const trashed = db.insert('notes', { v: 1, rev: 2, trashedAt: t - 31 * DAY, trashedFrom: null, blocks: [{ id: 'b1', t: 'h1', c: [['Passport numbers']] }, { id: 'b2', t: 'p', c: [['keep this']] }] });
          const at = t - 8 * DAY;
          const reviewed = db.insert('notes', { v: 1, rev: 3, editedBy: 'mcp:claude', editedAt: at, aiPrev: { at, by: 'mcp:claude', rev: 2, blocks: [{ id: 'c1', t: 'h1', c: [['Trip budget']] }] }, blocks: [{ id: 'c1', t: 'h1', c: [['Trip budget']] }, { id: 'c2', t: 'p', c: [['Flights 420']] }] });
          return { trashed: trashed.id, reviewed: reviewed.id };
        }, DAY);
        await idle(a);
        await a.close();
        const b = await browser.newPage({ isolated: true }); // browser B: Recover, and a new line in the other note
        pages.push(b);
        await open(b, srv.url('tasks/'));
        await b.evaluate(async (ids) => {
          const { db } = await import('/shared/store.js');
          const n = db.get('notes', ids.trashed);
          db.update('notes', ids.trashed, { trashedAt: null, trashedFrom: null, rev: n.rev + 1 });
          const m = db.get('notes', ids.reviewed);
          db.update('notes', ids.reviewed, { blocks: [...m.blocks, { id: 'c3', t: 'p', c: [['Hotel 610']] }], rev: m.rev + 1, editedAt: Date.now(), editedBy: 'user' });
        }, ids);
        await idle(b);
        await b.close();
        a = await browser.newPage(); // browser A opens Notes while ecosys is briefly unreachable
        pages.push(a);
        await a.send('Network.enable');
        await a.send('Network.setBlockedURLs', { urls: ['*/api/*'] });
        await a.goto(srv.url('notes/'));
        await a.waitFor(() => !!window.ecosysSync, { timeout: 15000 });
        await sleep(3000);
        await a.send('Network.setBlockedURLs', { urls: [] });
        await a.waitFor(() => window.ecosysSync?.online === true, { timeout: 30000, message: 'sync to come online' });
        await sleep(2500);
        await idle(a);
        const notes = (await srv.state()).data.notes;
        const recovered = notes.find((n) => n.id === ids.trashed);
        assert.ok(recovered && !recovered.trashedAt, 'the note recovered in browser B is still there');
        assert.ok(JSON.stringify(notes.find((n) => n.id === ids.reviewed)?.blocks).includes('Hotel 610'), 'browser B’s new line is still in the other note');
      } finally {
        for (const p of pages) await p.close().catch(() => {});
        await srv.dispose();
      }
    },
  );

  test(
    'backup: a backup made with Export backup can be imported again',
    { todo: 'Export backup writes pretty-printed JSON with no size check, Import backup refuses files over 5 MB ("That file is too large to be an ecosys backup."): 3,000 short journal notes give a backup of about 6 MB that cannot be restored' },
    async () => {
      const srv = makeServer();
      const dl = mkdtempSync(join(tmpdir(), 'ecosys-e2e-dl-'));
      let p;
      try {
        await srv.start();
        const t0 = Date.now() - DAY;
        const ops = [];
        for (let i = 0; i < 3000; i++) {
          ops.push({ op: 'put', c: 'notes', item: { id: `jn${String(i).padStart(6, '0')}`, v: 1, rev: 1, createdAt: t0, updatedAt: t0, blocks: [{ id: 'b1', t: 'h1', c: [[`Journal ${i}`]] }, { id: 'b2', t: 'p', c: [['Worked in the garden and read a chapter of my book. '.repeat(20)]] }, { id: 'b3', t: 'check', c: [['water the plants']] }] } });
        }
        await srv.api('api/import', { method: 'POST', body: { data: {}, settings: {} } });
        for (let i = 0; i < ops.length; i += 500) assert.equal((await srv.api('api/ops', { method: 'POST', body: { client: 'qa-seed', ops: ops.slice(i, i + 500) } })).status, 200);
        p = await browser.newPage();
        await p.setViewport(1280, 800, false);
        await open(p, srv.url('tasks/'));
        await idle(p);
        await browser.conn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
        await p.evaluate(() => document.activeElement?.blur());
        await p.press(',');
        await p.waitFor('.modal.settings', 5000);
        await p.clickText('button', /Export backup/);
        let file = null;
        for (let i = 0; i < 75 && !file; i++) {
          await sleep(200);
          file = readdirSync(dl).find((f) => /^ecosys-backup-.*\.json$/.test(f));
        }
        assert.ok(file, 'the backup was downloaded');
        await sleep(500);
        const mb = statSync(join(dl, file)).size / 1048576;
        await p.send('Page.setInterceptFileChooserDialog', { enabled: true });
        try {
          const chooser = p.waitForEvent('Page.fileChooserOpened', { timeout: 5000 });
          await p.clickText('button', /Import backup/);
          const { backendNodeId } = await chooser;
          await p.send('DOM.setFileInputFiles', { files: [join(dl, file)], backendNodeId });
        } finally {
          await p.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
        }
        const asked = await p
          .waitFor(() => [...document.querySelectorAll('[role=alertdialog], [role=dialog]')].some((d) => /Import this backup\?/.test(d.innerText)), { timeout: 5000 })
          .then(() => true, () => false);
        assert.ok(asked, `Import backup accepts the ${mb.toFixed(1)} MB file Export backup just made`);
      } finally {
        await p?.close().catch(() => {});
        await srv.dispose();
        rmSync(dl, { recursive: true, force: true });
      }
    },
  );
});
