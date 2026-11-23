// QA flows for Notes and its connections, with real mouse and keyboard input in one headless Chrome
// against an isolated server (an AI assistant's edits go through the real MCP endpoint):
//   send to tasks  a checklist item sent to Tasks, completed in a Tasks tab, is checked in Notes;
//                  unchecking it in Notes reopens the task
//   meeting notes  "Meeting notes" on a Schedule event card: template, link to the occurrence,
//                  "Open meeting notes" afterwards, and the link follows the event when it moves
//   search         #tag, in:"Folder", is:pinned, has:todo, "phrase", -word and -"phrase"
//   todo (open bugs, pinned with their finding titles):
//                  a note link opened before this browser has the note; Quick note "Add to Today";
//                  event chips after the event moves; End in a task-linked checklist item; "/" right
//                  after inserting an event chip; Restore with a second Notes tab open; the same line
//                  typed in two tabs; Quick note "New note" after "Add to Today"; Quick note (Ctrl+Alt+N)
//                  from Tasks
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, waitForApp, waitForSync, waitForSyncIdle, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 'YYYY-MM-DD' plus n days (local noon, so a DST change never moves the date). */
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
const textOf = (b) => (b?.c || []).map((r) => r[0]).join('');
const textsOf = (n) => (n?.blocks || []).map(textOf);

/** Type one character at a time (each an input event, as a keyboard does), so autoformat and pickers run. */
async function typeChars(page, s, ms = 25) {
  for (const ch of s) {
    if (ch === '\n') await page.press('Enter');
    else await page.type(ch);
    await sleep(ms);
  }
}

/** Put the caret at the end of the note's last block (as a click at the end of the last line does). */
function caretToEnd(page) {
  return page.evaluate(() => {
    const ed = document.querySelector('.ne-doc');
    ed.focus();
    const tx = [...ed.querySelectorAll('.ne-b')].pop().querySelector('.ne-tx');
    const r = document.createRange();
    r.selectNodeContents(tx);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
}

/** The editor's suggestion list (slash menu, link picker, @date, #tag) is open. */
const pickerOpen = (page) => page.evaluate(() => !!document.querySelector('.ne-doc')?.getAttribute('aria-controls'));

/** A plain left click at viewport coordinates (with optional modifier bits: 2 = Ctrl). */
async function clickAt(page, { x, y }, modifiers = 0) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers });
}

/** Open a note row in the list by its title. */
const openRow = (page, title) => page.click((t) => [...document.querySelectorAll('.nrow')].find((r) => r.textContent.includes(t)), { args: [title] });

/** An MCP tool call as a connected assistant ("Claude", read & write). Throws on a tool error. */
async function mcpCaller(server) {
  const r = await server.api('api/ai/clients', { method: 'POST', body: { kind: 'claude' } });
  const token = r.json?.client?.token;
  assert.ok(token, `a new AI connection with a key: ${r.status} ${r.text.slice(0, 200)}`);
  let id = 1;
  return async (name, args = {}) => {
    const res = await fetch(server.url('mcp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    if (j.error || j.result?.isError) throw new Error(`${name}: ${j.error?.message || j.result?.content?.[0]?.text || res.status}`.slice(0, 400));
    return j.result.structuredContent;
  };
}

describe('qa notes flows', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let mcp = null;
  let today = null;
  const tabs = [];
  /** A second tab in the same profile (shares this browser's storage, like a real second tab). */
  async function newTab() {
    const p = await ctx.browser.newPage();
    await p.setViewport(1440, 900, false);
    await p.emulateColorScheme('light');
    tabs.push(p);
    return p;
  }
  async function closeTabs() {
    while (tabs.length) await tabs.pop().close().catch(() => {});
    await ctx.page.bringToFront();
  }
  async function ready() {
    if (mcp) return;
    // The first load seeds the sample data; everything below makes its own data on top of it.
    await openApp(ctx.page, ctx.server.url('notes/'));
    await waitForSyncIdle(ctx.page);
    today = await browserToday(ctx.page);
    mcp = await mcpCaller(ctx.server);
  }

  test('checklist item → Send to Tasks → completed in Tasks is checked in Notes; unchecking it reopens the task', async () => {
    const { page, server } = ctx;
    await ready();
    const t = tag();
    const title = `QA send ${t}`;
    const item = `pack bags ${t}`;
    try {
      await withScreenshot(page, 'qa-notes-send-to-tasks', async () => {
        await openApp(page, server.url('notes/'));
        await page.clickText('button', 'New note');
        await page.waitFor(() => document.activeElement?.classList.contains('ne-doc'), { timeout: 5000, message: 'the editor to take focus' });
        await typeChars(page, title);
        await page.press('Enter');
        await typeChars(page, `[] ${item}`);
        const note = await server.waitForState((s) => s.data.notes.find((n) => n.title === title && n.blocks.some((b) => b.t === 'check' && textOf(b) === item)), 10000, 'the note and its checklist item');
        await page.click((it) => [...document.querySelectorAll('.ne-doc .ne-b[data-type=check]')].find((b) => b.textContent.includes(it))?.querySelector('.ne-ck'), { args: [item], button: 'right' });
        await page.clickText('menuitem', 'Send to Tasks', { exact: true });
        await page.clickText('button', 'Send', { exact: true });
        const task = await server.waitForState((s) => s.data.tasks.find((x) => x.title === item && x.source?.noteId === note.id), 10000, 'the task, with the note as its source');
        await server.waitForState((s) => s.data.notes.find((n) => n.id === note.id)?.blocks.some((b) => b.task === task.id), 10000, 'the checklist item linked to the task');

        const tasks = await newTab();
        await openApp(tasks, server.url('tasks/#/inbox'));
        await tasks.clickText('checkbox', item);
        await server.waitForState((s) => s.data.tasks.find((x) => x.id === task.id)?.done && s.data.notes.find((n) => n.id === note.id)?.blocks.find((b) => b.task === task.id)?.ck, 10000, 'the task done in Tasks and the item checked in the note');
        await page.waitFor((id) => document.querySelector(`.ne-doc .ne-b[data-task="${id}"]`)?.dataset.checked === 'true', { timeout: 8000, args: [task.id], message: 'the open note to show the item checked' });

        await page.bringToFront();
        await page.click((id) => document.querySelector(`.ne-doc .ne-b[data-task="${id}"] .ne-ck`), { args: [task.id] });
        await server.waitForState((s) => s.data.tasks.find((x) => x.id === task.id)?.done === false, 10000, 'unchecking the item in Notes to reopen the task');
        assert.deepEqual(page.consoleErrors(), []);
      });
    } finally {
      await closeTabs();
    }
  });

  test("Meeting notes from a Schedule event card: template, the occurrence link, \"Open meeting notes\", and the link follows a moved event", async () => {
    const { page, server } = ctx;
    await ready();
    const t = tag();
    const title = `QA meet ${t}`;
    const day = addDaysYmd(today, 1);
    await mcp('create_events', { events: [{ title, start: `${day}T10:00`, duration_minutes: 30, location: 'Room 4' }] });
    const ev = await server.waitForState((s) => s.data.events.find((e) => e.title === title), 10000, 'the event');
    await withScreenshot(page, 'qa-notes-meeting', async () => {
      await openApp(page, server.url(`schedule/#/day/${day}`));
      const block = `.ev[data-ev="${ev.id}@${day}"]`;
      await page.waitFor(block, { timeout: 8000, message: 'the event on the day view' });
      await page.click(block);
      await page.clickText('link', /^Meeting notes/);
      await page.waitFor(() => location.pathname.includes('/notes/'), { timeout: 10000, message: 'Notes to open' });
      await waitForApp(page);
      await waitForSync(page);
      await page.waitFor(() => document.querySelector('.n-evhead') && document.activeElement?.classList.contains('ne-doc'), { timeout: 8000, message: 'the meeting-note draft with its event header' });
      await typeChars(page, `notes of ${t}`);
      const n = await server.waitForState((s) => s.data.notes.find((x) => x.event?.id === ev.id), 10000, 'the meeting note');
      assert.deepEqual(n.event, { id: ev.id, date: day });
      assert.deepEqual(n.blocks.map((b) => b.t), ['h1', 'h3', 'p', 'h3', 'check']);
      assert.deepEqual(textsOf(n).slice(0, 4), [title, 'Notes', `notes of ${t}`, 'Action items']);
      await waitForSyncIdle(page);

      await openApp(page, server.url(`schedule/#/day/${day}`));
      await page.click(block);
      await page.waitFor(() => /Open meeting notes/.test(document.querySelector('a.ep-notes')?.textContent || ''), { timeout: 8000, message: 'the card to offer "Open meeting notes"' });

      // An assistant moves the event two days later: the meeting note goes with it.
      const later = addDaysYmd(day, 2);
      await mcp('update_event', { event_id: ev.id, date: later });
      await server.waitForState((s) => s.data.notes.find((x) => x.id === n.id)?.event?.date === later, 10000, "the meeting note's link to follow the event");
    });
  });

  test('search operators: #tag, in:"Folder", is:pinned, has:todo, "phrase", -word, -"phrase"', async () => {
    const { page, server } = ctx;
    await ready();
    const t = tag();
    const folder = `QA fold ${t}`;
    await mcp('notes_create', { markdown: `# Alpha ${t}\n\npasta sauce #qa${t}\n\n- [ ] buy basil`, folder, pinned: true });
    await mcp('notes_create', { markdown: `# Beta ${t}\n\npasta with red meat` });
    await mcp('notes_create', { markdown: `# Gamma ${t}\n\npasta sauce with red meat #qa${t}` });
    await server.waitForState((s) => s.data.notes.filter((n) => n.title.endsWith(` ${t}`)).length === 3, 10000, 'the three notes');
    await withScreenshot(page, 'qa-notes-search', async () => {
      await openApp(page, server.url('notes/'));
      await page.waitFor((x) => document.body.innerText.includes(`Gamma ${x}`), { timeout: 8000, args: [t], message: 'the new notes in the list' });
      const search = async (q) => {
        await page.evaluate(() => {
          const el = document.querySelector('input[type=search], input[aria-label*=Search i]');
          el.focus();
          el.select();
        });
        await page.press('Control+a');
        await page.type(q);
        await sleep(500);
        return page.evaluate((x) => [...document.querySelectorAll('.nrow')].map((r) => r.innerText.split('\n')[0].trim()).filter((s) => s.endsWith(` ${x}`)).map((s) => s.split(' ')[0]).sort(), t);
      };
      const cases = [
        [`#qa${t}`, ['Alpha', 'Gamma']],
        [`in:"${folder}"`, ['Alpha']],
        [`is:pinned ${t}`, ['Alpha']],
        [`has:todo ${t}`, ['Alpha']],
        [`"pasta sauce" ${t}`, ['Alpha', 'Gamma']],
        [`pasta -meat ${t}`, ['Alpha']],
        [`-"red meat" ${t}`, ['Alpha']],
        [`-#qa${t} ${t}`, ['Beta']],
      ];
      for (const [q, want] of cases) assert.deepEqual(await search(q), want, `search ${q}`);
    });
  });

  // ------------------------------------------------------------------ open bugs (todo)

  test(
    'a note link opened before this browser has the note opens that note (AI "Open:" link, Copy link on another device)',
    { todo: 'Deep links to a note this browser has not synced yet open the first note instead' },
    async () => {
      const { page, server } = ctx;
      await ready();
      const t = tag();
      await page.goto('about:blank');
      const made = await mcp('notes_create', { markdown: `# Deep ${t}\n\nmade by an assistant while Notes was closed` });
      await page.goto(made.url);
      await waitForApp(page);
      await waitForSync(page);
      await settle(page, 1500);
      const r = await page.evaluate(() => ({ hash: location.hash, title: document.querySelector('.ne-doc .ne-b')?.textContent }));
      assert.ok(r.hash.includes(made.id), `the URL still names the note: ${r.hash}`);
      assert.equal(r.title, `Deep ${t}`);
    },
  );

  test('Quick note "Add to Today" adds a new line to today\'s note', { todo: 'Quick note "Add to Today" glues the text onto the last line of today\'s note' }, async () => {
    const { page, server } = ctx;
    await ready();
    const t = tag();
    await mcp('notes_append', { day: 'today', markdown: `Last line ${t}` });
    await server.waitForState((s) => s.data.notes.some((n) => n.day === today && textsOf(n).at(-1) === `Last line ${t}`), 10000, "today's note to end with the new line");
    await openApp(page, server.url('notes/#/quick'));
    await page.waitFor(() => document.querySelector('[role=dialog][aria-label="Quick note"]'), { timeout: 8000, message: 'the Quick note sheet' });
    await page.clickText('button', 'Add to Today');
    await sleep(400);
    await typeChars(page, `Quick ${t}`);
    await page.clickText('button', 'Done', { exact: true });
    const n = await server.waitForState((s) => s.data.notes.find((x) => x.day === today && textsOf(x).some((s2) => s2.includes(`Quick ${t}`))), 10000, "the quick text in today's note");
    assert.ok(textsOf(n).includes(`Last line ${t}`), `the last line stays as it was: ${JSON.stringify(textsOf(n).slice(-3))}`);
    assert.ok(textsOf(n).includes(`Quick ${t}`), 'the quick text is a line of its own');
  });

  test('an event chip follows its event when the event moves to another day', { todo: 'Event chips keep the old date after the event moves' }, async () => {
    const { page, server } = ctx;
    await ready();
    const t = tag();
    const d1 = addDaysYmd(today, 1);
    const d3 = addDaysYmd(today, 3);
    const title = `Chip ev ${t}`;
    await mcp('create_events', { events: [{ title, start: `${d1}T15:00`, duration_minutes: 60 }] });
    const ev = await server.waitForState((s) => s.data.events.find((e) => e.title === title), 10000, 'the event');
    const made = await mcp('notes_create', { markdown: `# Chip note ${t}\n\nSee [${title}](ecosys://event/${ev.id}@${d1})` });
    await mcp('update_event', { event_id: ev.id, date: d3 });
    await server.waitForState((s) => s.data.events.find((e) => e.id === ev.id)?.start.startsWith(d3), 10000, 'the event on its new day');
    await openApp(page, server.url(`notes/#/all/n/${made.id}`));
    await page.waitFor(() => document.querySelector('.ne-doc .ne-chip-event'), { timeout: 8000, message: 'the event chip' });
    const { chip, want, old } = await page.evaluate(
      (a, b) => {
        const f = (d) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
        return { chip: document.querySelector('.ne-doc .ne-chip-event').textContent, want: f(b), old: f(a) };
      },
      d1,
      d3,
    );
    assert.ok(chip.includes(want) && !chip.includes(old), `the chip shows the event's new day (${want}), not the old one (${old}): "${chip}"`);
  });

  test('End in a checklist item linked to a task keeps the caret in that item', { todo: 'End after clicking right of a task-linked checklist item jumps to the end of the note' }, async () => {
    const { page, server } = ctx;
    await ready();
    const t = tag();
    const made = await mcp('notes_create', { markdown: `# End key ${t}\n\n- [ ] item ${t}\n\nlast line ${t}` });
    await mcp('notes_send_to_tasks', { id: made.id });
    await openApp(page, server.url(`notes/#/all/n/${made.id}`));
    await page.waitFor(() => document.querySelector('.ne-doc .ne-b[data-task] .ne-taskmeta'), { timeout: 8000, message: 'the linked item with its task label' });
    // Click in the empty part of the item's line, right of its text (the usual way to reach a line's end).
    const pos = await page.evaluate(() => {
      const r = document.querySelector('.ne-doc .ne-b[data-task] .ne-tx').getBoundingClientRect();
      return { x: r.right - 12, y: r.y + r.height / 2 };
    });
    await clickAt(page, pos);
    await sleep(200);
    await page.press('End');
    await page.type('Q');
    await sleep(300);
    const lines = await page.evaluate(() => [...document.querySelectorAll('.ne-doc .ne-tx')].map((e) => e.firstChild?.textContent || ''));
    assert.ok(lines.some((l) => l === `item ${t}Q`), `"Q" lands at the end of the item: ${JSON.stringify(lines)}`);
    assert.ok(!lines.some((l) => l === `last line ${t}Q`), 'not at the end of the note');
  });

  test('"/" opens the slash menu right after an event chip is inserted from the [[ picker', { todo: 'Pickers stop opening on a line just after an event chip is inserted' }, async () => {
    const { page, server } = ctx;
    await ready();
    const t = tag();
    const evTitle = `Picker ev ${t}`;
    await mcp('create_events', { events: [{ title: evTitle, start: `${addDaysYmd(today, 1)}T11:00`, duration_minutes: 30 }] });
    await server.waitForState((s) => s.data.events.some((e) => e.title === evTitle), 10000, 'the event');
    await openApp(page, server.url('notes/'));
    await page.clickText('button', 'New note');
    await page.waitFor(() => document.activeElement?.classList.contains('ne-doc'), { timeout: 5000, message: 'the editor to take focus' });
    await typeChars(page, `Agenda ${t}`);
    await server.waitForState((s) => s.data.notes.some((n) => n.title === `Agenda ${t}`), 10000, 'the note');
    // Control: on a line without a chip, "/" opens the slash menu.
    await caretToEnd(page);
    await page.press('Enter');
    await typeChars(page, 'plain line /', 30);
    await sleep(500);
    assert.ok(await pickerOpen(page), 'control: "/" opens the slash menu on a plain line');
    await page.press('Escape');
    await sleep(300);
    const results = [];
    // Pick the event, then keep typing after a short pause (as a person does): a date, then a slash command.
    for (const [pause, typed] of [[0, ' @tom'], [300, ' day @tom'], [300, ' /']]) {
      await caretToEnd(page);
      await page.press('Enter');
      const before = await page.evaluate(() => document.querySelectorAll('.ne-doc .ne-chip-event').length);
      await typeChars(page, `Item [[${evTitle}`, 30);
      await page.waitFor(
        (x) => {
          const id = document.querySelector('.ne-doc')?.getAttribute('aria-controls');
          return [...(document.getElementById(id)?.querySelectorAll('[role=option]') || [])].some((o) => o.textContent.includes(x));
        },
        { timeout: 8000, args: [evTitle], message: 'the event in the link picker' },
      );
      await sleep(300);
      await page.press('Enter'); // the highlighted row: the event (no note has that name)
      await page.waitFor((n) => document.querySelectorAll('.ne-doc .ne-chip-event').length > n, { timeout: 5000, args: [before], message: 'the event chip (Enter on the event row)' });
      await sleep(pause);
      await typeChars(page, typed, 30);
      await sleep(500);
      results.push(`${JSON.stringify(typed)} after ${pause} ms: ${(await pickerOpen(page)) ? 'opens' : 'does not open'}`);
      await page.press('Escape');
      await sleep(1500);
    }
    assert.ok(results.every((r) => r.endsWith(': opens')), `each picker opens on the chip's line:\n  ${results.join('\n  ')}`);
  });

  test('Restore in Version history keeps the restored version with a second Notes tab open', { todo: 'Restore is silently undone by a second open Notes tab when it changes a linked task' }, async () => {
    const { page, server } = ctx;
    await ready();
    const t = tag();
    const title = `Restore ${t}`;
    const item = `linked ${t}`;
    const spare = `Spare ${t}`; // another note to switch to (leaving a note keeps a version)
    await mcp('notes_create', { markdown: `# ${spare}` });
    try {
      await openApp(page, server.url('notes/'));
      await page.clickText('button', 'New note');
      await page.waitFor(() => document.activeElement?.classList.contains('ne-doc'), { timeout: 5000, message: 'the editor to take focus' });
      await typeChars(page, title);
      await page.press('Enter');
      await typeChars(page, `[] ${item}`);
      await page.press('Enter');
      await page.press('Enter');
      await typeChars(page, `first version ${t}`);
      const note = await server.waitForState((s) => s.data.notes.find((n) => n.title === title && textsOf(n).includes(`first version ${t}`)), 10000, 'the note');
      await page.click((it) => [...document.querySelectorAll('.ne-doc .ne-b[data-type=check]')].find((b) => b.textContent.includes(it))?.querySelector('.ne-ck'), { args: [item], button: 'right' });
      await page.clickText('menuitem', 'Send to Tasks', { exact: true });
      await page.clickText('button', 'Send', { exact: true });
      const task = await server.waitForState((s) => s.data.tasks.find((x) => x.title === item && x.source?.noteId === note.id), 10000, 'the linked task');
      await server.waitForState((s) => s.data.notes.find((n) => n.id === note.id)?.blocks.some((b) => b.task === task.id), 10000, 'the item linked');
      // Leaving the note keeps this version in history; then check the item and add a line, and leave again.
      await openRow(page, spare);
      await sleep(800);
      await openRow(page, title);
      await page.waitFor((x) => document.querySelector('.ne-doc .ne-b')?.textContent === x, { timeout: 5000, args: [title], message: 'the note open again' });
      await page.click((id) => document.querySelector(`.ne-doc .ne-b[data-task="${id}"] .ne-ck`), { args: [task.id] });
      await server.waitForState((s) => s.data.tasks.find((x) => x.id === task.id)?.done, 10000, 'the task done');
      await caretToEnd(page);
      await page.press('Enter');
      await typeChars(page, `second version ${t}`);
      await server.waitForState((s) => textsOf(s.data.notes.find((n) => n.id === note.id)).includes(`second version ${t}`), 10000, 'the second version saved');
      await openRow(page, spare);
      await sleep(800);
      await openRow(page, title);
      await sleep(800);

      const other = await newTab();
      await openApp(other, server.url('notes/#/all'));
      await page.bringToFront();
      await page.click(() => [...document.querySelectorAll('button[aria-label="More"]')].filter((b) => b.offsetParent).pop());
      await page.clickText('menuitem', /Version history/);
      await page.waitFor(() => [...document.querySelectorAll('[role=dialog] [role=option]')].length >= 2, { timeout: 8000, message: 'two versions in the history' });
      await page.click(() => [...document.querySelectorAll('[role=dialog] [role=option]')].pop()); // the oldest
      await page.clickText('button', 'Restore', { exact: true });
      await sleep(3000);
      const n = (await server.state()).data.notes.find((x) => x.id === note.id);
      assert.ok(!textsOf(n).includes(`second version ${t}`), `the restored version is what the note holds: ${JSON.stringify(textsOf(n))}`);
      assert.equal(n.blocks.find((b) => b.task === task.id)?.ck, false, 'the item is unchecked again, as in the restored version');
    } finally {
      await closeTabs();
    }
  });

  test('typing in the same line in two tabs keeps both edits', { todo: 'Typing in the same line in two tabs silently drops one tab\'s text' }, async () => {
    const { page, server } = ctx;
    await ready();
    const t = tag();
    const title = `Two tabs ${t}`;
    try {
      await openApp(page, server.url('notes/'));
      await page.clickText('button', 'New note');
      await page.waitFor(() => document.activeElement?.classList.contains('ne-doc'), { timeout: 5000, message: 'the editor to take focus' });
      await typeChars(page, title);
      await page.press('Enter');
      await typeChars(page, 'shared line');
      const note = await server.waitForState((s) => s.data.notes.find((n) => n.title === title && textsOf(n).includes('shared line')), 10000, 'the note');
      await waitForSyncIdle(page);
      const other = await newTab();
      await openApp(other, server.url(`notes/#/all/n/${note.id}`));
      const caretIn = (p, atStart) =>
        p.evaluate((s) => {
          const ed = document.querySelector('.ne-doc');
          ed.focus();
          const tx = [...ed.querySelectorAll('.ne-b')].find((b) => b.textContent.includes('shared line')).querySelector('.ne-tx');
          const r = document.createRange();
          r.selectNodeContents(tx);
          r.collapse(!!s);
          getSelection().removeAllRanges();
          getSelection().addRange(r);
        }, atStart);
      await page.bringToFront();
      await caretIn(page, false);
      await other.bringToFront();
      await caretIn(other, true);
      for (let i = 0; i < 6; i++) {
        await page.type(`x${i}`);
        await sleep(50);
        await other.type(`y${i}`);
        await sleep(50);
      }
      await sleep(3000);
      const line = textsOf((await server.state()).data.notes.find((n) => n.id === note.id)).find((s) => s.includes('shared line'));
      for (let i = 0; i < 6; i++) {
        assert.ok(line.includes(`x${i}`), `the first tab's x${i} is kept: "${line}"`);
        assert.ok(line.includes(`y${i}`), `the second tab's y${i} is kept: "${line}"`);
      }
    } finally {
      await closeTabs();
    }
  });

  /** Open the Quick note sheet and choose New note or Add to Today in it; the caret ends up in its editor. */
  async function quickMode(page, label) {
    const sheet = '[role=dialog][aria-label="Quick note"]';
    await page.waitFor((s) => document.querySelector(`${s} .ne-doc`), { timeout: 8000, args: [sheet], message: 'the Quick note sheet' });
    // The sheet's own toggle (the sidebar has a "New note" button too).
    await page.click((s, l) => [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent.trim() === l), { args: [sheet, label] });
    await sleep(300);
    if (!(await page.evaluate((s) => document.activeElement?.matches?.(`${s} .ne-doc`), sheet))) await page.click(`${sheet} .ne-doc`);
    await page.waitFor((s) => document.activeElement?.matches?.(`${s} .ne-doc`), { timeout: 5000, args: [sheet], message: 'the caret in the Quick note editor' });
  }

  test('Quick note "New note" makes a new note, also right after an "Add to Today"', { todo: 'Quick note "New note" keeps writing into today\'s note for 5 minutes after "Add to Today"' }, async () => {
    const { page, server } = ctx;
    await ready();
    const t = tag();
    await openApp(page, server.url('notes/#/quick'));
    await quickMode(page, 'Add to Today');
    await typeChars(page, ` for today ${t}`);
    await page.clickText('button', 'Done', { exact: true });
    await server.waitForState((s) => s.data.notes.some((n) => n.day === today && textsOf(n).some((x) => x.includes(`for today ${t}`))), 10000, "the text in today's note");
    await openApp(page, server.url('notes/#/quick'));
    await quickMode(page, 'New note');
    await typeChars(page, `QN ${t}`);
    await page.clickText('button', 'Done', { exact: true });
    const saved = await server.waitForState((s) => s.data.notes.find((n) => textsOf(n).some((x) => x.includes(`QN ${t}`))), 10000, 'the quick text saved');
    assert.equal(saved.title, `QN ${t}`, `"New note" makes a note of its own (the text went into "${saved.title}": ${JSON.stringify(textsOf(saved).slice(-2))})`);
  });

  test('Quick note (Ctrl+Alt+N) from Tasks leaves you in Tasks when you are done', { todo: 'Quick note from Tasks, Schedule or Home navigates away to Notes and never returns' }, async () => {
    const { page, server } = ctx;
    await ready();
    const t = tag();
    await openApp(page, server.url('tasks/#/today'));
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.press('Control+Alt+n');
    await quickMode(page, 'New note');
    await typeChars(page, `From Tasks ${t}`);
    await page.clickText('button', 'Done', { exact: true });
    await server.waitForState((s) => s.data.notes.some((n) => textsOf(n).some((x) => x.includes(`From Tasks ${t}`))), 10000, 'the quick text saved');
    await settle(page, 800);
    const path = await page.evaluate(() => location.pathname + location.hash);
    assert.match(path, /\/tasks\//, `back in Tasks after Done: ${path}`);
  });
});
