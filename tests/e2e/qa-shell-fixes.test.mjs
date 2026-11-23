// QA regressions for shared/shell.js in the browser:
//   backup       Export backup writes compact JSON that Import backup takes back, past the old 5 MB bound
//                (3,000 short notes were a 5.9 MB backup it refused), and the confirm names folders
//   palette      with a large library the results are drawn once typing pauses, and Enter still runs the
//                result for what was typed; a modal paints before the page behind is made inert, and is
//                inert right after, stacked modals and menus included
//   quick note   Ctrl+Alt+N (and the palette's Quick note) tell Notes where they came from (?back=)
//   settings     Notes' rows use Notes' own labels ("AI assistants can"), the Connect AI link opens Connect AI,
//                and working hours keep their end after their start
//   date picker  the month button is named "Go to today", and pressing the month buttons with the keyboard
//                keeps the focus on them
//   switcher     the five apps in one row, AI opening Connect AI
// Run with: node --test tests/e2e/qa-shell-fixes.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useE2E, openApp, settle, tag, waitForSyncIdle, withScreenshot } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;
/** Put records on the server as another client would (500 at a time). */
async function putAll(server, c, items) {
  for (let i = 0; i < items.length; i += 500) {
    const r = await server.api('api/ops', { method: 'POST', body: { client: 'qa-shell-seed', ops: items.slice(i, i + 500).map((item) => ({ op: 'put', c, item })) } });
    assert.equal(r.status, 200, `seeding ${c}: ${r.text.slice(0, 200)}`);
  }
}
/** Open Settings with its key. */
async function openSettings(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.press(',');
  await page.waitFor('.modal.settings', 5000);
}

describe('qa shell: backups, palette, quick note, settings, date picker, switcher', () => {
  const ctx = useE2E({ width: 1440, height: 900 });

  test('Export backup writes compact JSON that Import backup takes back, past the old 5 MB bound', async () => {
    const { page, server, browser } = ctx;
    const dl = mkdtempSync(join(tmpdir(), 'ecosys-e2e-dl-'));
    try {
      await withScreenshot(page, 'qa-shell-backup', async () => {
        const t0 = Date.now() - DAY;
        const notes = Array.from({ length: 3000 }, (_, i) => ({ id: `qn${String(i).padStart(6, '0')}`, v: 1, rev: 1, createdAt: t0, updatedAt: t0, blocks: [{ id: 'b1', t: 'h1', c: [[`Journal ${i}`]] }, { id: 'b2', t: 'p', c: [['Worked in the garden and read a chapter of my book. '.repeat(20)]] }, { id: 'b3', t: 'check', c: [['water the plants']] }] }));
        await putAll(server, 'notes', notes);
        await putAll(server, 'folders', [{ id: 'qf1', name: 'Journal', parentId: null, order: 0, createdAt: t0, updatedAt: t0 }]);
        await openApp(page, server.url('tasks/'));
        await browser.conn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
        await openSettings(page);
        await page.clickText('button', /Export backup/);
        let file = null;
        for (let i = 0; i < 100 && !file; i++) {
          await sleep(200);
          file = readdirSync(dl).find((f) => /^ecosys-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f));
        }
        assert.ok(file, 'the backup was downloaded');
        await sleep(500);
        const path = join(dl, file);
        const text = readFileSync(path, 'utf8');
        const data = JSON.parse(text);
        assert.equal(data.app, 'ecosys');
        assert.equal(data.notes.filter((n) => n.id.startsWith('qn')).length, 3000, 'every note is in it');
        assert.equal(text, JSON.stringify(data), 'compact JSON: no indentation');
        const mb = statSync(path).size / 1048576;
        assert.ok(Buffer.byteLength(JSON.stringify(data, null, 2)) > 5 * 1048576, 'indented, it would have been over the old 5 MB bound');
        // Import it again through Settings.
        await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
        try {
          const chooser = page.waitForEvent('Page.fileChooserOpened', { timeout: 5000 });
          await page.clickText('button', /Import backup/);
          const { backendNodeId } = await chooser;
          await page.send('DOM.setFileInputFiles', { files: [path], backendNodeId });
        } finally {
          await page.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
        }
        const msg = await page.waitFor(() => [...document.querySelectorAll('[role=alertdialog]')].find((d) => /Import this backup\?/.test(d.innerText))?.innerText || null, { timeout: 15000, message: `the import confirm for the ${mb.toFixed(1)} MB backup` });
        assert.match(msg, /\b30\d\d notes\b/, msg);
        assert.match(msg, /notes, folders and settings/, 'the confirm names folders among what it replaces');
        assert.match(msg, /A safety copy of what it replaces is kept on this computer/, 'and that ecosys keeps a safety copy');
        await page.clickText('button', 'Import', { exact: true });
        await page.waitFor(() => [...document.querySelectorAll('.toast-msg')].some((t) => /^Backup imported/.test(t.textContent)), { timeout: 30000, message: 'the "Backup imported" toast' });
        await waitForSyncIdle(page, 60000);
        const st = await server.state();
        assert.equal(st.data.notes.filter((n) => n.id.startsWith('qn')).length, 3000, 'the notes are all still there');
        assert.ok(st.data.folders.some((f) => f.id === 'qf1'), 'and the folder');
      });
    } finally {
      rmSync(dl, { recursive: true, force: true });
    }
  });

  test('with a large library Enter runs the palette result for what was typed, at once', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-palette-large', async () => {
      const t0 = Date.now() - DAY;
      const word = `Zq${tag()}`;
      const tasks = Array.from({ length: 2100 }, (_, i) => ({ id: `qt${String(i).padStart(6, '0')}`, title: `Bulk task ${i}`, notes: 'Read agenda pick training schedule contract invoice slides.', listId: 'inbox', createdAt: t0, updatedAt: t0 }));
      tasks[1777].title = `${word} quarterly`;
      await putAll(server, 'tasks', tasks);
      // Home: no app results of its own, so the shared task search answers.
      await openApp(page, server.url(''));
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+k');
      await page.waitFor('.palette input', 5000);
      await page.type(word.toLowerCase(), { keys: true });
      await page.press('Enter'); // at once: no pause for the drawn results to catch up
      await page.waitFor(() => /\/tasks\/#\/task\/qt001777$/.test(location.href), { timeout: 10000, message: 'Tasks opened on the task that was typed' });
    });
  });

  test('a modal paints before the page behind is made inert; stacked modals and menus stay usable', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('tasks/'));
    await openSettings(page);
    const behind = () => page.evaluate(() => [...document.body.children].filter((n) => n.inert).map((n) => n.className || n.tagName));
    await page.waitFor(() => [...document.body.children].some((n) => n.inert), { timeout: 2000, message: 'the page behind Settings to become inert' });
    const before = await behind();
    assert.ok(before.length && !before.some((c) => /modal|scrim/.test(c)), `the page, not Settings: ${before}`);
    // A confirm over Settings makes Settings inert too, never itself.
    await page.clickText('button', /Erase everything/);
    await page.waitFor(() => !!document.querySelector('[role=alertdialog]'), 5000);
    await page.waitFor(() => document.querySelector('.modal.settings')?.inert === true, { timeout: 2000, message: 'Settings to be inert under the confirm' });
    assert.equal(await page.evaluate(() => document.querySelector('[role=alertdialog]').closest('[inert]')), null, 'the confirm is usable');
    const eraseText = await page.evaluate(() => document.querySelector('[role=alertdialog]').innerText);
    assert.match(eraseText, /A safety copy of what is erased is kept on this computer/, 'synced with ecosys: the safety copy is mentioned');
    await page.clickText('button', 'Cancel', { exact: true });
    await page.waitFor(() => !document.querySelector('[role=alertdialog]') && document.querySelector('.modal.settings')?.inert === false, { timeout: 3000, message: 'Settings usable again' });
    assert.deepEqual(await behind(), before, 'the page stays inert behind Settings');
    // A menu opened from Settings at once is not made inert by Settings.
    await page.press('Escape');
    await page.waitFor(() => !document.querySelector('.modal.settings') && ![...document.body.children].some((n) => n.inert), { timeout: 3000, message: 'everything usable once Settings closed' });
    await page.evaluate(async () => {
      const { openSettings } = await import('/shared/shell.js');
      openSettings();
      document.querySelector('.modal.settings [data-select][name="defaultEventMinutes"]').click();
    });
    await sleep(300);
    const menu = await page.evaluate(() => {
      const m = document.querySelector('.select-pop');
      return m ? { inert: !!m.closest('[inert]'), page: [...document.body.children].some((n) => n.inert && n.id !== '') } : null;
    });
    assert.ok(menu, 'the menu opened');
    assert.equal(menu.inert, false, 'the menu over Settings is usable');
    await page.press('Escape');
    await page.press('Escape');
  });

  test('Quick note from Tasks (Ctrl+Alt+N and the palette) tells Notes where it came from', async () => {
    const { page, server } = ctx;
    for (const how of ['keys', 'palette']) {
      await openApp(page, server.url('tasks/#/today'));
      const from = await page.url();
      await page.evaluate(() => document.activeElement?.blur());
      const nav = page.waitForEvent('Page.frameRequestedNavigation', { timeout: 10000 });
      if (how === 'keys') await page.press('Control+Alt+n');
      else {
        await page.press('Control+k');
        await page.waitFor('.palette input', 5000);
        await page.type('quick note');
        await page.waitFor(() => [...document.querySelectorAll('.palette [role=option]')].some((o) => /^Quick note/.test(o.textContent.trim())), 5000);
        await page.clickText('option', /^Quick note/);
      }
      const { url } = await nav;
      const m = /\/notes\/#\/quick\?back=(.+)$/.exec(url);
      assert.ok(m, `${how}: Notes' Quick Note (${url})`);
      assert.equal(decodeURIComponent(m[1]), from, `${how}: with the address to come back to`);
      await page.waitFor(() => /\/notes\//.test(location.pathname) && !!document.querySelector('.n-quick'), { timeout: 15000, message: 'Notes shows its Quick Note sheet' });
      await page.press('Escape');
    }
  });

  test('Settings: Notes’ rows read as in Notes, Connect AI is a link away, working hours keep a range', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-settings', async () => {
      await openApp(page, server.url('tasks/'));
      await openSettings(page);
      const groups = await page.evaluate(() => [...document.querySelectorAll('.modal.settings [role=group]')].map((g) => [g.getAttribute('aria-label'), [...g.querySelectorAll('button')].map((b) => b.textContent.trim())]));
      const by = Object.fromEntries(groups);
      assert.deepEqual(by['AI access to notes'], ['Read & edit', 'Read', 'Off'], 'Notes’ own choices');
      assert.deepEqual(by['Sort checked items'], ['Automatically', 'Manually']);
      const rows = await page.evaluate(() => [...document.querySelectorAll('.modal.settings .item > .grow')].map((s) => s.textContent.trim()));
      assert.ok(rows.includes('AI assistants can') && rows.includes('Sort checked items') && rows.includes('Working hours'), rows.join(' | '));
      assert.ok(!rows.includes('AI access'), '"AI access" is Connect AI’s switch for everything');
      // Notes AI: Read.
      await page.click(() => document.querySelector('[aria-label="AI access to notes"] [data-val="read"]'));
      await server.waitForState((s) => s.settings.notesAi === 'read', 8000, 'notesAi read on the server');
      await page.click(() => document.querySelector('[aria-label="Sort checked items"] [data-val="manual"]'));
      await server.waitForState((s) => s.settings.notesCheckedSort === 'manual', 8000, 'notesCheckedSort manual on the server');
      // Working hours: 9am-5pm until set; a start after the end moves the end an hour on. The end's list
      // starts at the start (with how long the day is); ending when it starts moves the start an hour back.
      const label = (n) => page.evaluate((n) => document.querySelector(`[name="${n}"]`).getAttribute('aria-label'), n);
      assert.match(await label('scheduleWorkStart'), /^Working hours start: 9(:00)?\s?(am|AM)$|^Working hours start: 09:00$/);
      assert.match(await label('scheduleWorkEnd'), /^Working hours end: 5(:00)?\s?(pm|PM)$|^Working hours end: 17:00$/);
      await page.click(() => document.querySelector('[name="scheduleWorkStart"]'));
      await page.waitFor('.tp-pop input', 5000);
      await page.type('6pm');
      await page.press('Enter');
      await server.waitForState((s) => s.settings.scheduleWorkStart === '18:00' && s.settings.scheduleWorkEnd === '19:00', 8000, 'start 18:00 moved the end to 19:00');
      await page.click(() => document.querySelector('[name="scheduleWorkEnd"]'));
      await page.waitFor('.tp-pop input', 5000);
      const first = await page.evaluate(() => document.querySelector('.tp-pop .tp-row:not(.tp-clear)')?.textContent.replace(/\s+/g, ' ').trim());
      assert.match(first, /^(6(:00)?\s?(pm|PM)|18:00)\s*\(0 mins\)$/, `the end's list starts at the start: ${first}`);
      await page.type('6pm');
      await page.press('Enter');
      await server.waitForState((s) => s.settings.scheduleWorkEnd === '18:00' && s.settings.scheduleWorkStart === '17:00', 8000, 'end 18:00 (the start) moved the start to 17:00');
      assert.match(await label('scheduleWorkStart'), /5(:00)?\s?(pm|PM)|17:00/, 'the field shows the moved start');
      // The link to the switch for everything.
      await page.clickText('button', 'Connect AI', { exact: true });
      await page.waitFor(() => !document.querySelector('.modal.settings') && !!document.querySelector('.modal [class*="ai"], .ai-panel, .ai-sheet'), { timeout: 8000, message: 'Connect AI open instead of Settings' });
      await page.press('Escape');
      await server.api('api/ops', { method: 'POST', body: { client: 'qa-shell-reset', ops: [{ op: 'settings', patch: { notesAi: 'edit', notesCheckedSort: 'auto', scheduleWorkStart: '09:00', scheduleWorkEnd: '17:00' } }] } });
    });
  });

  test('date picker: "Go to today", and the month buttons keep the keyboard focus', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('tasks/'));
    await page.evaluate(async () => {
      const { openDatePicker } = await import('/shared/shell.js');
      const b = document.createElement('button');
      b.id = 'qa-dp-anchor';
      b.textContent = 'Date';
      b.style.cssText = 'position:fixed;left:300px;top:120px';
      document.body.append(b);
      b.focus();
      openDatePicker(b, { value: null });
    });
    await page.waitFor('.dp-pop [data-mc="next"]', 5000);
    const names = await page.evaluate(() => ({ today: document.querySelector('.dp-pop [data-mc="today"]').getAttribute('aria-label'), text: document.querySelector('.dp-pop [data-mc="today"]').textContent.trim(), dot: !!document.querySelector('.dp-pop [data-dp="today"] .today-glyph svg circle[r="2.2"]') }));
    assert.deepEqual(names, { today: 'Go to today', text: 'Today', dot: true });
    const month = () => page.evaluate(() => document.querySelector('.dp-pop .mc-head strong').textContent);
    const first = await month();
    for (const k of ['next', 'prev', 'today']) {
      await page.evaluate((k) => document.querySelector(`.dp-pop [data-mc="${k}"]`).focus(), k);
      await page.press('Enter');
      await sleep(120);
      const f = await page.evaluate(() => document.activeElement?.dataset?.mc || document.activeElement?.tagName);
      assert.equal(f, k, `after ${k}, the keyboard is still on it (not on <body>)`);
    }
    assert.equal(await month(), first, 'next, previous and today came back to this month');
    await page.press('Escape');
    await page.evaluate(() => document.getElementById('qa-dp-anchor')?.remove());
  });

  test('the switcher lists the five apps in one row, and AI opens Connect AI', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('schedule/'));
    await page.click('[data-app-switcher]');
    await page.waitFor('.switcher .switcher-app', 5000);
    const tiles = await page.evaluate(() => [...document.querySelectorAll('.switcher .switcher-app')].map((a) => ({ name: a.textContent.trim(), top: Math.round(a.getBoundingClientRect().top) })));
    assert.deepEqual(tiles.map((t) => t.name), ['Home', 'Tasks', 'Schedule', 'Notes', 'AI assistants']);
    assert.equal(new Set(tiles.map((t) => t.top)).size, 1, `one row: ${JSON.stringify(tiles)}`);
    assert.equal(await page.evaluate(() => document.querySelector('.switcher-grid').getAttribute('style')), null, 'from ui.css, no inline grid');
    await page.clickText('button', /AI/);
    await settle(page, 600);
    assert.ok(await page.evaluate(() => !document.querySelector('.switcher') && !!document.querySelector('.modal')), 'Connect AI opened in its place');
    await page.press('Escape');
    assert.deepEqual(page.consoleErrors(), []);
  });
});
