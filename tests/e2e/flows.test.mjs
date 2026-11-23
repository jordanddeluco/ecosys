// User flows through the real UI, against an isolated server, at 1440x900 (light):
//   tasks      add a task with natural language in the composer, see it, complete it
//   schedule   open Create, type an event, save it, see it
//   notes      create a note and type into it (skipped while the notes app is not built)
//   cross-app  a task added in tasks shows in schedule after a reload, and in a fresh browser
//              profile (so it came through the server, not this browser's storage)
//   AI         GET /api/ai answers; the Connect AI panel opens from the app menu
// Elements are found by role, accessible name and visible text, not by class names; results are
// checked in the UI and in the server's data.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, waitForApp, waitForSync, waitForSyncIdle, settle, browserToday, withScreenshot, missingFiles, formatMissing, served, tag } from './helpers.mjs';

let ctx; // set inside the suite below (its hooks belong to the suite)
const flowErrors = []; // console errors seen during each flow, checked at the end
const flowDialogs = []; // native alert / confirm / prompt dialogs (the apps should only use their own)

async function flow(name, fn) {
  const { page } = ctx;
  page.clearConsoleErrors();
  const d0 = page.dialogs.length;
  try {
    await withScreenshot(page, `flow-${name}`, fn);
  } finally {
    for (const e of page.consoleErrors()) flowErrors.push({ ...e, flow: name });
    for (const d of page.dialogs.slice(d0)) flowDialogs.push({ ...d, flow: name });
  }
}

/** Click a role/selector + name if it shows up within `timeout`; false when it does not. */
async function tryClickText(page, role, text, timeout = 2000) {
  try {
    await page.clickText(role, text, { timeout });
    return true;
  } catch (err) {
    if (/timed out/.test(err.message)) return false;
    throw err;
  }
}

/** Make sure a text field has focus: the focused element if editable, else click the textbox named `name`. */
async function focusTextbox(page, name, timeout = 3000) {
  try {
    await page.waitFor(() => {
      const a = document.activeElement;
      return !!a && (a.isContentEditable || a.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea'));
    }, 600);
  } catch {
    await page.clickText('textbox', name, { timeout });
  }
}

/** tasks: open the quick-add composer, type `text`, press Enter. */
async function addTask(page, text) {
  const open = await page.exists('textbox', /task name|add a task|new task/i);
  if (!open) await page.clickText('button', /^add (a )?task$/i);
  await focusTextbox(page, /task name|add a task|new task/i);
  await page.type(text);
  await page.press('Enter');
}

/** Click the checkbox that completes the task titled `title` (named after it, or the one in its row). */
function clickTaskCheckbox(page, title) {
  return page.click(
    (title) => {
      const boxes = [...document.querySelectorAll('[role=checkbox], input[type=checkbox]')];
      const name = (el) => `${el.getAttribute('aria-label') || ''} ${(el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')}`;
      const named = boxes.find((b) => name(b).includes(title) && b.checkVisibility?.() !== false);
      if (named) return named;
      const label = [...document.querySelectorAll('body *')].find((el) => el.textContent.trim() === title && el.checkVisibility?.() !== false && ![...el.children].some((c) => c.textContent.trim() === title));
      for (let n = label; n && n !== document.body; n = n.parentElement) {
        const box = n.querySelector('[role=checkbox], input[type=checkbox]');
        if (box) return box;
      }
      return null;
    },
    { args: [title] },
  );
}

/** True when no visible, unchecked checkbox belongs to the task titled `title`. */
const taskShownDone = (title) => {
  const checked = (b) => b.getAttribute('aria-checked') === 'true' || b.checked === true;
  const vis = (el) => el.checkVisibility?.() !== false && el.getClientRects().length > 0;
  const boxes = [...document.querySelectorAll('[role=checkbox], input[type=checkbox]')].filter(vis);
  const mine = boxes.filter((b) => (b.getAttribute('aria-label') || '').includes(title));
  if (mine.length) return mine.every(checked);
  const labels = [...document.querySelectorAll('body *')].filter((el) => vis(el) && el.textContent.trim() === title && ![...el.children].some((c) => c.textContent.trim() === title));
  return labels.every((l) => {
    for (let n = l; n && n !== document.body; n = n.parentElement) {
      const box = n.querySelector('[role=checkbox], input[type=checkbox]');
      if (box) return checked(box);
    }
    return true;
  });
};

describe('flows: tasks, schedule, notes, cross-app, AI', () => {
  ctx = useE2E({ width: 1440, height: 900, mobile: false, scheme: 'light' });

  // ------------------------------------------------------------------ tasks

  test('tasks: add a task with natural language in the composer, see it, complete it', async () => {
    const { page, server } = ctx;
    await flow('tasks', async () => {
      await openApp(page, server.url('tasks/'));
      const today = await browserToday(page);
      const title = `E2E oat milk ${tag()}`;
      await addTask(page, `${title} today 4pm p1`);

      // The parser took the date, time and priority out of the name.
      await page.waitForText(title, 8000);
      const saved = await server.waitForState((s) => s.data.tasks.find((t) => t.title === title), 10000, `the task "${title}" to reach the server`);
      assert.equal(saved.date, today, 'date from "today"');
      assert.equal(saved.time, '16:00', 'time from "4pm"');
      assert.equal(saved.priority, 3, 'p1 is the top priority (3)');
      assert.equal(saved.done, false);
      assert.ok(!(await page.hasText(`${title} today 4pm p1`)), 'the parsed words are not left in the title');

      await clickTaskCheckbox(page, title);
      await page.waitFor(taskShownDone, { timeout: 8000, args: [title], message: `"${title}" to show as done (checked, or moved out of the open list)` });
      const done = await server.waitForState((s) => s.data.tasks.find((t) => t.id === saved.id && t.done === true), 10000, `"${title}" to be done on the server`);
      assert.ok(done.completedAt, 'completedAt is set');
    });
  });

  // ------------------------------------------------------------------ schedule

  test('schedule: open Create, type an event and save it', async () => {
    const { page, server } = ctx;
    await flow('schedule', async () => {
      await openApp(page, server.url('schedule/'));
      const today = await browserToday(page);
      const title = `E2E standup ${tag()}`;
      await page.clickText('button', 'Create');
      // Google-style quick card (a dialog or popover), or an editor that takes focus.
      await page.waitFor(() => {
        const a = document.activeElement;
        const editing = !!a && (a.isContentEditable || a.matches('input, textarea'));
        return editing || [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open]')].some((d) => d.checkVisibility?.() !== false);
      }, { timeout: 5000, message: 'Create to open' });
      await focusTextbox(page, /title|add title|event/i);
      await page.type(`${title} 10am`);
      if (!(await tryClickText(page, '[role=dialog] button, dialog button', /^save$/i, 1500))) await page.press('Enter');

      await page.waitFor((t) => ![...document.querySelectorAll('[role=dialog] input, [role=dialog] textarea')].some((i) => i.value.includes(t) && i.checkVisibility?.() !== false), {
        timeout: 5000,
        args: [title],
        message: 'the Create dialog to close after saving',
      });
      await page.waitForText(title, 8000);
      const ev = await server.waitForState((s) => s.data.events.find((e) => e.title === title), 10000, `the event "${title}" to reach the server`);
      assert.equal(ev.allDay, false);
      assert.ok(String(ev.start).startsWith(`${today}T10:00`), `starts today at 10:00 (got ${ev.start})`);
      assert.ok(ev.end > ev.start, `ends after it starts (${ev.start} – ${ev.end})`);
      assert.ok(ev.calendarId, 'it is in a calendar');
    });
  });

  // ------------------------------------------------------------------ notes

  test('notes: create a note and type into it', async (t) => {
    const { page, server } = ctx;
    const missing = (await missingFiles(server, 'notes/')).filter((m) => m.path.startsWith('/notes/'));
    if (missing.length) return t.skip(`the notes app is not built yet; missing ${formatMissing(missing)}`);
    await flow('notes', async () => {
      await openApp(page, server.url('notes/'));
      const title = `E2E note ${tag()}`;
      const body = `first line ${tag()}`;
      if (await tryClickText(page, 'button', /^new note$/i, 3000)) t.diagnostic('created with the "New note" button');
      else if (await tryClickText(page, 'button', /new note|compose/i, 1000)) t.diagnostic('created with a compose / new-note button');
      else {
        t.diagnostic('no "New note" button found; used the N shortcut');
        await page.press('n');
      }
      try {
        await page.waitFor(() => document.activeElement?.isContentEditable, 4000);
      } catch {
        await page.click('[contenteditable="true"], [contenteditable=""]');
      }
      await page.type(title);
      await page.press('Enter');
      await page.type(body);

      const shown = await page.evaluate(() => (document.activeElement?.closest('[contenteditable]') || document.activeElement)?.innerText || '');
      assert.ok(shown.includes(title) && shown.includes(body), `the editor shows what was typed (got ${JSON.stringify(shown.slice(0, 200))})`);
      const note = await server.waitForState((s) => (s.data.notes || []).find((n) => n.title === title), 15000, `a note titled "${title}" to reach the server`);
      assert.ok(JSON.stringify(note).includes(body), 'the note keeps the second line');

      await page.reload();
      await waitForApp(page);
      await page.waitForText(title, 8000);
    });
  });

  // ------------------------------------------------------------------ cross-app

  test('cross-app: a task added in tasks shows in schedule after a reload, and in a fresh profile', async () => {
    const { page, server, browser } = ctx;
    await flow('cross-app', async () => {
      await openApp(page, server.url('tasks/'));
      const today = await browserToday(page);
      const title = `E2E sync ${tag()}`;
      await addTask(page, `${title} today 3pm`);
      const saved = await server.waitForState((s) => s.data.tasks.find((t) => t.title === title), 10000, `the task "${title}" to reach the server`);
      assert.equal(saved.date, today);
      assert.equal(saved.time, '15:00');

      await openApp(page, server.url('schedule/'));
      await page.reload();
      await waitForApp(page);
      await waitForSync(page);
      await page.waitForText(title, 10000);

      // A fresh profile has none of this browser's storage: the task can only come from the server.
      const before = (await server.state()).data.tasks.length;
      const fresh = await browser.newPage({ isolated: true });
      try {
        await fresh.setViewport(1440, 900, false);
        await fresh.emulateColorScheme('light');
        await withScreenshot(fresh, 'flow-cross-app-fresh-profile', async () => {
          const { status } = await openApp(fresh, server.url('schedule/'));
          assert.equal(status, 200);
          await fresh.waitForText(title, 10000);
          await waitForSyncIdle(fresh);
          await settle(fresh, 500);
        });
        const after = (await server.state()).data.tasks.length;
        assert.equal(after, before, `opening ecosys in a fresh profile must not add its untouched sample tasks to the server (${before} → ${after})`);
      } finally {
        for (const e of fresh.consoleErrors()) flowErrors.push({ ...e, flow: 'cross-app (fresh profile)' });
        for (const d of fresh.dialogs) flowDialogs.push({ ...d, flow: 'cross-app (fresh profile)' });
        await fresh.close();
        await page.bringToFront();
      }
    });
  });

  // ------------------------------------------------------------------ AI

  test('AI: GET /api/ai answers with the connection overview', async () => {
    const { page, server } = ctx;
    await flow('ai-api', async () => {
      const r = await server.api('api/ai');
      assert.equal(r.status, 200, r.text);
      const ai = r.json;
      assert.ok(['write', 'read', 'off'].includes(ai.mode), `mode ${ai.mode}`);
      assert.equal(ai.localUrl, `http://127.0.0.1:${server.port}/mcp`);
      assert.ok(Array.isArray(ai.clients), 'clients is a list');
      assert.ok(Array.isArray(ai.activity), 'activity is a list');
      assert.match(ai.bridgePath, /stdio-bridge\.mjs$/);
      assert.equal(typeof ai.nodePath, 'string');

      // Guarded like the rest of the browser API.
      assert.equal((await server.api('api/ai', { xEcosys: false })).status, 403, 'without X-Ecosys');
      assert.equal((await server.api('api/ai', { xEcosys: '1' })).status, 403, 'with the header from before pairing (not the secret)');
      assert.equal((await server.api('api/ai', { headers: { Origin: 'https://evil.example' } })).status, 403, 'from a foreign origin');

      // A new connection is listed with its key and secret path (in the temp data dir only).
      const made = await server.api('api/ai/clients', { method: 'POST', body: { kind: 'claude', access: 'read' } });
      assert.equal(made.status, 200, made.text);
      const id = made.json.client.id;
      try {
        const listed = (await server.api('api/ai')).json.clients.find((c) => c.id === id);
        assert.ok(listed, 'the new connection is listed');
        assert.equal(listed.kind, 'claude');
        assert.equal(listed.access, 'read');
        assert.match(listed.token, /^[A-Za-z0-9_-]{32,}$/);
        assert.equal(listed.secretPath, `/s/${listed.token}/mcp`);
      } finally {
        await server.api(`api/ai/clients/${id}`, { method: 'DELETE' });
      }

      // And from a page (a same-origin browser request passes the Origin / Sec-Fetch-Site checks),
      // with the pairing secret the page keeps, as every request of the apps sends it (shared/pair.js).
      await openApp(page, server.url('tasks/'));
      const fromPage = await page.evaluate(async () => {
        const res = await fetch('/api/ai', { headers: { 'X-Ecosys': localStorage.getItem('ecosys:v1:pair') } });
        return { status: res.status, mode: (await res.json()).mode };
      });
      assert.deepEqual(fromPage, { status: 200, mode: ai.mode });
    });
  });

  test('AI: the Connect AI panel opens from the app menu and closes with Escape', async (t) => {
    const { page, server } = ctx;
    if (!(await served(server, 'shared/ai.js'))) return t.skip('shared/ai.js is not built yet');
    await flow('ai-panel', async () => {
      await openApp(page, server.url('tasks/'));
      // The shell's AI status check fetches /api/ai once on start; let it land, then forget it, so
      // the request checked below is the panel's own.
      await page.waitFor(() => performance.getEntriesByType('resource').some((e) => /\/api\/ai(\?|$)/.test(e.name)), 1500).catch(() => {});
      await page.evaluate(() => performance.clearResourceTimings());

      // The brand / app menu ("tasks menu"), then "Connect AI…"; the command palette as a fallback.
      const menuButton = () =>
        [...document.querySelectorAll('button[aria-haspopup="menu"], button[aria-haspopup="true"]')].find((b) => /menu/i.test(b.getAttribute('aria-label') || b.textContent) && b.checkVisibility?.() !== false && b.getClientRects().length);
      let opened = false;
      if (await page.evaluate(`!!(${menuButton})()`)) {
        await page.click(menuButton);
        opened = await tryClickText(page, 'menuitem', /connect ai/i, 3000);
        if (!opened) await page.press('Escape');
      }
      t.diagnostic(opened ? 'opened from the app menu ("Connect AI…")' : 'not in the app menu; opened from the command palette');
      if (!opened) {
        await page.press('Mod+k');
        await focusTextbox(page, /search|command/i);
        await page.type('Connect AI');
        await settle(page, 300);
        await page.press('Enter');
      }

      // The panel: a visible dialog about AI that lists the three assistants. Tag it to watch it close.
      await page.waitFor(
        () => {
          const d = [...document.querySelectorAll('[role=dialog], dialog[open]')].find((x) => x.checkVisibility?.() !== false && /\bAI\b/.test(`${x.getAttribute('aria-label') || ''} ${x.innerText}`));
          const t = d?.innerText || '';
          if (!(/claude/i.test(t) && /chatgpt/i.test(t) && /grok/i.test(t))) return false;
          d.setAttribute('data-e2e-ai-panel', '');
          return true;
        },
        { timeout: 8000, message: 'the Connect AI panel to open and list Claude, ChatGPT and Grok' },
      );
      const fetched = await page.waitFor(() => performance.getEntriesByType('resource').find((e) => /\/api\/ai(\?|$)/.test(e.name) && e.responseStatus === 200)?.name, {
        timeout: 8000,
        message: 'the panel to load GET /api/ai (200)',
      });
      assert.match(fetched, /\/api\/ai/);

      await page.press('Escape');
      await page.waitFor(() => {
        const d = document.querySelector('[data-e2e-ai-panel]');
        return !d || d.checkVisibility?.() === false;
      }, { timeout: 4000, message: 'Escape to close the Connect AI panel' });
    });
  });

  // ------------------------------------------------------------------ console errors

  test('no console errors or native dialogs during the flows', () => {
    assert.equal(flowErrors.length, 0, `${flowErrors.length} console error(s):\n${flowErrors.map((e) => `  - (${e.flow}) [${e.source}] ${e.text}${e.url && !e.text.includes(e.url) ? ` (${e.url})` : ''}`).join('\n')}`);
    assert.equal(flowDialogs.length, 0, `native dialogs were opened (and dismissed by the harness):\n${flowDialogs.map((d) => `  - (${d.flow}) ${d.type}: ${d.message}`).join('\n')}`);
  });
});
