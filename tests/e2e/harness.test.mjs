// Self-tests for the e2e harness: the isolated server launcher (server.mjs) and the CDP client
// (cdp.mjs) against a tiny fixture page, so failures in the app tests can be trusted.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, acquireChromeLock } from './cdp.mjs';
import { startServer, freePort, LIVE_PORT } from './server.mjs';
import { artifactPath } from './helpers.mjs';

// ------------------------------------------------------------------ the isolated ecosys server

describe('e2e harness: isolated server', () => {
  test('server harness: random port, temp ECOSYS_DATA_DIR, clean stop', async () => {
    const server = await startServer();
    try {
      assert.notEqual(server.port, LIVE_PORT, 'never the live dev server port');
      assert.ok(resolve(server.dataDir).startsWith(resolve(tmpdir())), `data dir ${server.dataDir} is in the temp folder`);
      assert.ok(!resolve(server.dataDir).startsWith(resolve('.ecosys')), 'data dir is not the real .ecosys');
      const info = JSON.parse(readFileSync(join(server.dataDir, 'server.json'), 'utf8'));
      assert.equal(info.port, server.port, 'server.json in the temp dir names our port');

      const hello = await server.api('api/hello');
      assert.equal(hello.status, 200);
      assert.equal(hello.json.app, 'ecosys');

      // A write lands in the temp data directory.
      const now = Date.now();
      const task = { id: 'e2eharness000001', title: 'E2E harness probe', notes: '', listId: null, tags: [], priority: 0, date: null, time: null, duration: null, deadline: null, repeat: null, checklist: [], done: false, completedAt: null, order: 1, createdAt: now, updatedAt: now };
      const imp = await server.api('api/import', { method: 'POST', body: { data: { tasks: [task] }, settings: {} } });
      assert.equal(imp.status, 200, imp.text);
      const state = await server.state();
      assert.ok(state.data.tasks.some((t) => t.id === task.id), 'the server has the task');
      const onDisk = readFileSync(join(server.dataDir, 'data.json'), 'utf8');
      assert.ok(onDisk.includes('E2E harness probe'), 'data.json in the temp dir has it');
    } finally {
      await server.stop();
    }
    assert.equal(existsSync(server.dataDir), false, 'the temp data dir is deleted');
    assert.equal(server.running, false, 'the server process exited');
    const r = await fetch(server.url('api/hello'), { headers: { 'X-Ecosys': '1' }, signal: AbortSignal.timeout(2000) }).then(
      () => 'answered',
      () => 'refused',
    );
    assert.equal(r, 'refused', 'nothing listens on the port any more');
  });
});

// ------------------------------------------------------------------ the CDP client

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>fixture</title>
<style>
  body { font: 16px/1.4 sans-serif; margin: 0; padding: 16px; }
  .gone { display: none; }
  #cover { position: fixed; inset: 0; background: rgba(0,0,0,.2); }
  #cover[hidden] { display: none; }
  #tall { height: 3000px; }
  @media (prefers-color-scheme: dark) { body { background: #000; color: #fff; } }
</style></head>
<body>
  <form id="f"><input id="name" aria-label="Task name"><button type="submit" id="save">Save</button></form>
  <button id="b1">Create</button> <button id="b2">Create calendar</button> <button class="gone" id="b3">Create</button>
  <button role="checkbox" aria-checked="false" aria-label="Complete: Buy milk" id="cb">o</button>
  <a href="#x" id="lnk">Open details</a>
  <div id="ed" contenteditable="true" aria-label="Editor"></div>
  <textarea id="ta" aria-label="Notes"></textarea>
  <div id="cover" hidden></div>
  <div id="tall"></div>
  <button id="bottom">Far below</button>
  <script src="/fixture.js"></script>
</body></html>`;

const FIXTURE_JS = `
window.__events = [];
const log = (e) => window.__events.push(e);
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); log('submit:' + document.getElementById('name').value); });
for (const b of document.querySelectorAll('button, a')) b.addEventListener('click', (e) => { if (b.tagName === 'A') e.preventDefault(); log('click:' + b.id + ':' + e.isTrusted); });
document.addEventListener('keydown', (e) => log('keydown:' + e.key + ':' + (e.ctrlKey ? 'C' : '') + (e.metaKey ? 'M' : '') + (e.shiftKey ? 'S' : '') + (e.altKey ? 'A' : '')));
document.getElementById('cb').addEventListener('click', (e) => e.currentTarget.setAttribute('aria-checked', String(e.currentTarget.getAttribute('aria-checked') !== 'true')));
`;

describe('e2e harness: CDP client', () => {
  let fixture;
  let base;
  let browser;
  let page;

  before(async () => {
    const port = await freePort();
    fixture = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/?')) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(FIXTURE_HTML);
      if (req.url === '/fixture.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(FIXTURE_JS);
      if (req.url === '/csp') {
        // The ecosys policy forbids inline scripts and handlers; a violation must count as a console error.
        return res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'" })
          .end('<!doctype html><title>csp</title><p>csp</p><script>window.inlineRan = true</script><img src="x" onerror="window.handlerRan = true">');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    });
    await new Promise((r) => fixture.listen(port, '127.0.0.1', r));
    base = `http://127.0.0.1:${port}/`;
    browser = await launch();
    page = await browser.newPage();
    await page.setViewport(1024, 700, false);
  });

  after(async () => {
    await browser?.close();
    await new Promise((r) => (fixture ? fixture.close(() => r()) : r()));
  });

  const events = () => page.evaluate(() => window.__events.splice(0));

  test('cdp: goto reports the HTTP status; evaluate takes functions, args and expressions', async () => {
    assert.equal((await page.goto(base)).status, 200);
    assert.equal(await page.title(), 'fixture');
    assert.equal(await page.evaluate((a, b) => a + b, 2, 3), 5);
    assert.equal(await page.evaluate('document.querySelectorAll("button").length'), 6);
    assert.deepEqual(await page.evaluate(async (x) => ({ x, ok: await Promise.resolve(true) }), 'y'), { x: 'y', ok: true });
    await assert.rejects(page.evaluate(() => {
      throw new Error('boom inside');
    }), /boom inside/);
    assert.equal((await page.goto(`${base}missing`)).status, 404);
    page.clearConsoleErrors();
  });

  test('cdp: waitFor selectors and predicates, with a useful timeout message', async () => {
    await page.goto(base);
    assert.match(await page.waitFor('#b1'), /button#b1 "Create"/);
    await page.evaluate(() => setTimeout(() => (window.later = 42), 150));
    assert.equal(await page.waitFor(() => window.later, 2000), 42);
    assert.equal(await page.waitFor('#b3', { state: 'hidden', timeout: 500 }), 'hidden');
    await assert.rejects(page.waitFor('#nope', 300), (err) => /timed out after 300 ms waiting for "#nope"/.test(err.message) && /url http:\/\/127\.0\.0\.1/.test(err.message));
    await page.waitForText('Open details', 1000);
  });

  test('cdp: click / clickText send trusted mouse clicks, prefer exact names and skip hidden or covered elements', async () => {
    await page.goto(base);
    await page.click('#b2');
    assert.deepEqual(await events(), ['click:b2:true']);
    await page.clickText('button', 'Create'); // exact match wins over "Create calendar"; the hidden #b3 is ignored
    assert.deepEqual(await events(), ['click:b1:true']);
    await page.clickText('button', /calendar$/i);
    assert.deepEqual(await events(), ['click:b2:true']);
    await page.clickText('checkbox', 'Buy milk'); // a <button role=checkbox> is a checkbox, matched by aria-label
    assert.equal(await page.evaluate(() => document.getElementById('cb').getAttribute('aria-checked')), 'true');
    assert.equal(await page.exists('button', 'Complete: Buy milk'), false, 'role=checkbox is not a button');
    await page.clickText('link', 'open details');
    assert.deepEqual((await events()).filter((e) => e.startsWith('click')), ['click:cb:true', 'click:lnk:true']);
    await page.click(() => document.getElementById('bottom')); // a function locator, scrolled into view
    assert.deepEqual(await events(), ['click:bottom:true']);
    // A covered element is not clicked: the click waits, then fails naming what covers it.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => (document.getElementById('cover').hidden = false));
    await assert.rejects(page.click('#b1', { timeout: 400 }), /covered by div#cover/);
    await page.evaluate(() => (document.getElementById('cover').hidden = true));
    assert.deepEqual(await events(), []);
  });

  test('cdp: type (insertText) and press (Enter, Tab, Backspace, arrows, Escape, modifier combos)', async () => {
    await page.goto(base);
    await page.click('#name');
    await page.type('Buy mlk');
    await page.press('ArrowLeft', { repeat: 2 });
    await page.type('i');
    await page.press('End');
    await page.press('Backspace');
    await page.type('k');
    assert.equal(await page.evaluate(() => document.getElementById('name').value), 'Buy milk');
    await events();
    await page.press('Enter');
    // Implicit submission: Enter "clicks" the form's default button, which submits it.
    assert.deepEqual(await events(), ['keydown:Enter:', 'click:save:true', 'submit:Buy milk'], 'Enter submits the form');
    await page.press('Control+a');
    await page.press('Backspace');
    assert.equal(await page.evaluate(() => document.getElementById('name').value), '', 'Control+A selects all');
    await page.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'save', 'Tab moves focus');
    await page.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'name', 'Shift+Tab moves back');
    await events();
    await page.press('Escape');
    await page.press('Meta+k');
    await page.press('Control+Enter');
    await page.press('Mod+Shift+P');
    await page.press('?');
    const mod = process.platform === 'darwin' ? 'M' : 'C';
    assert.deepEqual(
      (await events()).filter((e) => !/^keydown:(Control|Meta|Shift|Alt):/.test(e)),
      ['keydown:Escape:', 'keydown:k:M', 'keydown:Enter:C', `keydown:P:${mod}S`, 'keydown:?:S'],
    );
    // contenteditable: typed text and Enter make a new line
    await page.click('#ed');
    await page.type('First');
    await page.press('Enter');
    await page.type('Second');
    assert.match(await page.evaluate(() => document.getElementById('ed').innerText), /^First\nSecond$/);
    // per-key typing fires a keydown for each character
    await page.click('#ta');
    await events();
    await page.type('ab', { keys: true });
    assert.equal(await page.evaluate(() => document.getElementById('ta').value), 'ab');
    assert.deepEqual(await events(), ['keydown:a:', 'keydown:b:']);
  });

  test('cdp: consoleErrors collects console.error, uncaught exceptions, rejections and failed loads', async () => {
    await page.goto(base);
    page.clearConsoleErrors();
    await page.evaluate(() => {
      console.error('plain console error', 7);
      console.warn('just a warning');
      setTimeout(() => {
        throw new Error('uncaught boom');
      });
      Promise.reject(new Error('rejected boom'));
      const s = document.createElement('script');
      s.src = '/missing.js';
      document.head.append(s);
    });
    await page.waitFor(() => true, 50);
    const until = Date.now() + 3000;
    while (page.consoleErrors().length < 4 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    const errs = page.consoleErrors();
    const text = errs.map((e) => `${e.source}: ${e.text}`).join('\n');
    assert.ok(errs.some((e) => e.source === 'console.error' && e.text === 'plain console error 7'), text);
    assert.ok(errs.some((e) => e.source === 'exception' && /uncaught boom/.test(e.text)), text);
    assert.ok(errs.some((e) => e.source === 'exception' && /rejected boom/.test(e.text)), text);
    assert.ok(errs.some((e) => e.source === 'log.network' && /404/.test(e.text) && /missing\.js/.test(e.url || '')), text);
    assert.ok(!errs.some((e) => /just a warning/.test(e.text)), 'warnings are not errors');
    page.clearConsoleErrors();
    assert.deepEqual(page.consoleErrors(), []);
  });

  test('cdp: consoleErrors includes Content-Security-Policy violations; native dialogs are dismissed and recorded', async () => {
    page.clearConsoleErrors();
    await page.goto(`${base}csp`);
    const until = Date.now() + 3000;
    while (page.consoleErrors().filter((e) => /Content Security Policy/i.test(e.text)).length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    const csp = page.consoleErrors().filter((e) => /Content Security Policy/i.test(e.text));
    assert.ok(csp.length >= 2, `inline script and inline handler violations are reported:\n${page.consoleErrors().map((e) => `${e.source}: ${e.text}`).join('\n')}`);
    assert.deepEqual(await page.evaluate(() => [window.inlineRan ?? null, window.handlerRan ?? null]), [null, null], 'the policy really blocked them');
    page.clearConsoleErrors();

    await page.goto(base);
    const before = page.dialogs.length;
    assert.equal(await page.evaluate(() => confirm('Delete everything?')), false, 'confirm() is dismissed, so the page is never stuck');
    assert.deepEqual(page.dialogs.slice(before), [{ type: 'confirm', message: 'Delete everything?' }]);
  });

  test('cdp: setViewport, emulateColorScheme and screenshot', async () => {
    await page.setViewport(390, 844, true);
    await page.emulateColorScheme('dark');
    await page.goto(base);
    const m = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dark: matchMedia('(prefers-color-scheme: dark)').matches, coarse: matchMedia('(pointer: coarse)').matches, touch: navigator.maxTouchPoints, bg: getComputedStyle(document.body).backgroundColor }));
    assert.deepEqual(m, { w: 390, h: 844, dark: true, coarse: true, touch: 5, bg: 'rgb(0, 0, 0)' });
    const file = await page.screenshot(artifactPath('harness-phone-dark.png'));
    const png = readFileSync(file);
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.equal(png.readUInt32BE(16), 390, 'screenshot width');
    assert.equal(png.readUInt32BE(20), 844, 'screenshot height');
    assert.ok(statSync(file).size > 1000);

    await page.setViewport(1440, 900, false);
    await page.emulateColorScheme('light');
    await page.reload();
    const d = await page.evaluate(() => ({ w: innerWidth, dark: matchMedia('(prefers-color-scheme: dark)').matches, coarse: matchMedia('(pointer: coarse)').matches }));
    assert.deepEqual(d, { w: 1440, dark: false, coarse: false });
  });

  test('cdp: isolated pages get their own storage; normal pages share it', async () => {
    await page.goto(base);
    await page.evaluate(() => localStorage.setItem('e2e-probe', 'shared'));
    const same = await browser.newPage();
    const iso = await browser.newPage({ isolated: true });
    try {
      await same.goto(base);
      await iso.goto(base);
      assert.equal(await same.evaluate(() => localStorage.getItem('e2e-probe')), 'shared');
      assert.equal(await iso.evaluate(() => localStorage.getItem('e2e-probe')), null);
      // A page in the background keeps running timers and animation frames.
      const ticks = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(document.visibilityState), 10))));
      assert.equal(ticks, 'visible');
    } finally {
      await same.close();
      await iso.close();
    }
    await page.bringToFront();
  });

  test('cdp: only one e2e Chrome at a time (the lock is held while a browser is open)', async () => {
    await assert.rejects(acquireChromeLock({ timeout: 300 }), /waited 300 ms for another e2e Chrome/);
  });
});
