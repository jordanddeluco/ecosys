// QA regressions for the shell (shared/shell.js, shared/minical.js) at 1440x900:
//   palette    a query that names a command lists it first ("connect ai", "claude", "export",
//              "keyboard shortcuts"), also over the app's own content in Tasks and Notes, while an app's
//              own command it names comes first ("today" in Tasks); "dark" is Lights out; the result
//              count is announced
//   placement  a date picker that fits neither above nor below its row opens beside it; an event
//              card in Day view opens under a wide event, not over it; the time list starts on whole rows
//   focus      Tab past a card's last control closes it and goes on from its anchor, Shift+Tab returns
//              to the anchor, focus leaving closes it, a card with a form keeps Tab inside, and a time
//              typed in a time list is kept on Tab
//   a11y       menu items are named by their labels (shortcuts as aria-keyshortcuts), type-ahead finds
//              "Add to Today", multi-select menus are menuitemcheckbox, a destructive confirm is
//              described by its warning, the toast and announcement regions exist from the start, a
//              date picker announces the month it moves to, single-key shortcuts can be turned off, and
//              then menus, the palette and tooltips show only the shortcuts that still work; a
//              pointer-opened tooltip stays up while the pointer is on it (WCAG 1.4.13)
//   more       redo (Ctrl+Shift+Z, Ctrl+Y) keeps edits made since the undo; the date picker can set a
//              time; the custom repeat picker; Settings shows live AI status; Connect AI explains a
//              failed load while ecosys runs; losing ecosys shows a status until it is back (or Hide)
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot, tag, browserToday, waitForSyncIdle } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

/** Run code in the page with the shell (s), the store (store) and the model (model) in scope. */
const inPage = (page, body, ...args) =>
  page.evaluate(
    new Function(
      '...args',
      `return (async () => { const s = await import('/shared/shell.js'); const store = await import('/shared/store.js'); const model = await import('/shared/model.js'); ${body} })();`,
    ),
    ...args,
  );

async function palette(page, q) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.press('Control+k');
  await page.waitFor(() => document.activeElement?.matches('.palette input'), { timeout: 4000, message: 'the palette to open' });
  await page.type(q);
  await page.waitFor(() => document.querySelector('.palette-list [data-r].hl, .palette-empty'), 3000);
  // Each row's label (and sub line): not its lead glyph (the Today icon's date) or its keycaps.
  return page.evaluate(() => [...document.querySelectorAll('.palette-list [data-r]')].map((b) => (b.querySelector('.grow') || b).innerText.replace(/\s+/g, ' ').trim()));
}
async function closePalette(page) {
  await page.press('Escape');
  await page.waitFor(() => !document.querySelector('.palette'), 3000);
}

/** Accessible name, role and description of the elements matching a selector (CDP Accessibility). */
async function ax(page, selector) {
  await page.send('Accessibility.enable');
  const { root } = await page.send('DOM.getDocument', { depth: 0 });
  const { nodeIds } = await page.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
  const out = [];
  for (const nodeId of nodeIds) {
    const { nodes } = await page.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    out.push({ role: nodes[0]?.role?.value, name: nodes[0]?.name?.value ?? '', description: nodes[0]?.description?.value ?? '' });
  }
  return out;
}

const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
const rect = (page, sel) => page.evaluate((s) => {
  const r = document.querySelector(s)?.getBoundingClientRect();
  return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null;
}, sel);

describe('qa shell (desktop): palette, placement, focus, a11y, redo', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let today;

  before(async () => {
    await openApp(ctx.page, ctx.server.url(''));
    today = await browserToday(ctx.page);
  });

  test('Ctrl+K lists the command a query names before content that mentions it', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-palette', async () => {
      await openApp(page, server.url(''));
      for (const [q, first] of [
        ['connect ai', /^Connect AI/],
        ['claude', /^Connect AI/],
        ['export', /^Export backup/],
        ['keyboard shortcuts', /^Keyboard shortcuts/],
        ['light', /^Appearance: Light\b/],
      ]) {
        const rows = await palette(page, q);
        assert.match(rows[0] || '', first, `"${q}" lists ${first} first (got ${JSON.stringify(rows.slice(0, 3))})`);
        // The number of results is said once typing pauses.
        await page.waitFor(() => /^\d+ results?$|^No results$/.test(document.querySelector('[data-pal-count]')?.textContent || ''), { timeout: 3000, message: 'the result count in the status region' });
        await closePalette(page);
      }
      const dark = await palette(page, 'dark');
      assert.deepEqual(dark.filter((r) => r.startsWith('Appearance')), ['Appearance: Lights out'], `"dark" finds only Lights out among the themes (got ${JSON.stringify(dark)})`);
      await page.press('Enter');
      await page.waitFor(() => document.documentElement.dataset.theme === 'dark', { timeout: 3000, message: '"dark" + Enter to apply Lights out' });
      await inPage(page, "store.settings.set({ theme: 'system' });");
      await page.waitFor(() => document.documentElement.dataset.theme === 'light', 3000);
      // In Schedule (its own commands first) the named built-in still beats notes and tasks.
      await openApp(page, server.url('schedule/'));
      const ks = await palette(page, 'keyboard shortcuts');
      assert.match(ks[0], /^Keyboard shortcuts/, JSON.stringify(ks));
      await closePalette(page);
      // …and the app's own command that the query names comes before a shared one ("Today's note").
      assert.match((await palette(page, 'today'))[0], /^Go to today/);
      await closePalette(page);
    });
  });

  test('Ctrl+K in Tasks and Notes: a named command beats the app’s own content, and Enter runs it', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-palette-apps', async () => {
      const enter = async (q, first, done, message) => {
        const rows = await palette(page, q);
        assert.match(rows[0] || '', first, `"${q}" lists ${first} first (got ${JSON.stringify(rows.slice(0, 3))})`);
        await page.press('Enter');
        await page.waitFor(done, { timeout: 8000, message });
      };
      // Tasks: the sample task "Learn the keyboard shortcuts — press ?" mentions the words; the command is named by them.
      await openApp(page, server.url('tasks/#/inbox'));
      await enter('keyboard shortcuts', /^Keyboard shortcuts/, () => !!document.querySelector('.modal .shortcuts'), 'Enter to open the Keyboard shortcuts sheet');
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.modal'), 3000);
      await enter('today', /^Today\b/, () => location.hash === '#/today', 'Enter on "today" to go to Today (not Today’s note)');
      // Notes: "Search notes for “…”" and "New note “…”" echo any query; they never come before the command.
      await openApp(page, server.url('notes/'));
      await enter('connect ai', /^Connect AI…/, () => !!document.querySelector('.modal.ai-panel'), 'Enter to open Connect AI');
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.modal'), 3000);
      await enter('dark', /^Appearance: Lights out/, () => document.documentElement.dataset.theme === 'dark', '"dark" + Enter to apply Lights out');
      await inPage(page, "store.settings.set({ theme: 'system' });");
      await page.waitFor(() => document.documentElement.dataset.theme === 'light', 3000);
    });
  });

  test('a date picker that fits neither above nor below its row never covers the row’s date button', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-row-date', async () => {
      await openApp(page, server.url('tasks/#/today'));
      // The row whose date button sits nearest the middle of the screen has the least room above and below.
      const id = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.task[data-id]')].filter((r) => r.querySelector('[data-row-date]'));
        const mid = innerHeight / 2;
        rows.sort((a, b) => Math.abs(a.getBoundingClientRect().top - mid) - Math.abs(b.getBoundingClientRect().top - mid));
        return rows[0]?.dataset.id;
      });
      assert.ok(id, 'a task row with a date button');
      const sel = `.task[data-id="${id}"]`;
      await page.evaluate((s) => document.querySelector(`${s} [data-row-date]`).click(), sel);
      await page.waitFor('.dp-pop', 3000);
      await settle(page, 300);
      const btn = await rect(page, `${sel} [data-row-date]`);
      const pop = await rect(page, '.dp-pop');
      assert.ok(!overlap(btn, pop), `the picker (${JSON.stringify(pop)}) leaves the date button (${JSON.stringify(btn)}) in view`);
      const roomBelow = 900 - 8 - 6 - btn.bottom;
      const roomAbove = btn.top - 6 - 8;
      if (pop.height > roomBelow && pop.height > roomAbove) {
        assert.ok(pop.right <= btn.left || pop.left >= btn.right, 'with no room above or below, it sits beside the button');
      }
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.dp-pop'), 3000);
    });
  });

  test('an event card in Day view opens under a wide event instead of over it', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-day-card', async () => {
      await openApp(page, server.url('schedule/'));
      const day = addDaysYmd(today, 1);
      const title = `QA wide ${tag()}`;
      const id = await inPage(page, `return store.db.insert('events', { title: args[0], calendarId: store.db.all('calendars')[0]?.id, allDay: false, start: args[1] + 'T09:00', end: args[1] + 'T09:15' }).id;`, title, day);
      await page.evaluate((h) => (location.hash = h), `#/day/${day}/event/${id}`);
      await page.waitFor('.ev-pop', { timeout: 6000, message: "the event's card" });
      await settle(page, 300);
      const block = await rect(page, `.ev[data-ev^="${id}@"]`);
      const card = await rect(page, '.ev-pop');
      assert.ok(block && card, 'the event and its card are on screen');
      assert.ok(block.width > card.width, 'the event spans the day (wider than the card)');
      assert.ok(!overlap(block, card), `the card (${JSON.stringify(card)}) does not cover the event (${JSON.stringify(block)})`);
      await page.press('Escape');
      await inPage(page, 'store.db.remove("events", args[0]);', id);
    });
  });

  test('the time list opens on whole rows, with the chosen time in view', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('tasks/#/today'));
    for (const value of ['10:00', '18:45', '12:00', '', '00:15']) {
      const r = await inPage(
        page,
        `const b = document.createElement('button');
        b.textContent = 'time'; b.style.cssText = 'position:fixed;left:600px;top:200px';
        document.body.append(b);
        const h = s.openTimePicker(b, { value: args[0], allowClear: true });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const list = h.el.querySelector('.tp-list');
        const top = list.getBoundingClientRect().top;
        const rows = [...list.querySelectorAll('.tp-row')];
        const first = rows.find((x) => x.getBoundingClientRect().bottom > top + 1);
        const sel = list.querySelector('.tp-row.sel')?.getBoundingClientRect();
        const out = { cut: Math.round(top - first.getBoundingClientRect().top), selIn: sel ? sel.top >= top - 1 && sel.bottom <= list.getBoundingClientRect().bottom + 1 : true };
        h.close(); b.remove();
        return out;`,
        value,
      );
      assert.equal(r.cut, 0, `value ${value || '(none)'}: the top row is whole`);
      assert.ok(r.selIn, `value ${value}: the chosen time is in view`);
    }
  });

  test('Tab past a card’s last control closes it and moves on; Shift+Tab returns to its anchor', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-card-tab', async () => {
      await openApp(page, server.url('schedule/'));
      // The event block that opens the card, and what Tab reaches after it on the page.
      const plan = await page.evaluate(() => {
        const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const tabbable = [...document.querySelectorAll(FOCUSABLE)].filter((n) => n.tabIndex >= 0 && n.offsetParent !== null && !n.closest('[inert]'));
        const ev = tabbable.find((n) => n.matches('.ev[data-ev]'));
        ev.id ||= 'qa-anchor';
        const next = tabbable[tabbable.indexOf(ev) + 1];
        next.id ||= 'qa-next';
        return { anchor: ev.id, next: next.id };
      });
      await page.evaluate((id) => document.getElementById(id).focus(), plan.anchor);
      await page.press('Enter');
      await page.waitFor('.ev-pop', 3000);
      await sleep(150);
      let open = true;
      for (let i = 0; i < 12 && open; i++) {
        await page.press('Tab');
        await sleep(60);
        open = await page.evaluate(() => !!document.querySelector('.ev-pop'));
        if (open) assert.ok(await page.evaluate(() => !!document.activeElement?.closest('.ev-pop')), 'focus stays in the card while it is open');
      }
      assert.equal(open, false, 'Tab past the last control closes the card');
      assert.equal(await page.evaluate(() => document.activeElement?.id), plan.next, 'focus goes on to what follows the event on the page');

      await page.evaluate((id) => document.getElementById(id).focus(), plan.anchor);
      await page.press('Enter');
      await page.waitFor('.ev-pop', 3000);
      await sleep(150);
      await page.press('Shift+Tab');
      await sleep(80);
      assert.equal(await page.evaluate(() => !!document.querySelector('.ev-pop')), false, 'Shift+Tab from the card closes it');
      assert.equal(await page.evaluate(() => document.activeElement?.id), plan.anchor, 'and focus is back on the event');

      // Focus that moves anywhere else closes the card, and stays where it went.
      await page.press('Enter');
      await page.waitFor('.ev-pop', 3000);
      await sleep(150);
      await page.evaluate(() => document.querySelector('[data-create]').focus());
      await sleep(80);
      assert.equal(await page.evaluate(() => !!document.querySelector('.ev-pop')), false, 'focus leaving closes the card');
      assert.ok(await page.evaluate(() => document.activeElement?.matches('[data-create]')), 'focus stays where it moved');

      // The app switcher: Tab past the last app closes it.
      await page.click('[data-app-switcher]');
      await page.waitFor('.switcher', 3000);
      for (let i = 0; i < 6 && (await page.evaluate(() => !!document.querySelector('.switcher'))); i++) await page.press('Tab');
      assert.equal(await page.evaluate(() => !!document.querySelector('.switcher')), false, 'Tab walks out of the switcher and closes it');
      assert.ok(await page.evaluate(() => document.activeElement && document.activeElement !== document.body), 'focus is on a control, not lost');
    });
  });

  test('a card with a form keeps Tab inside; a time typed in a time list is kept on Tab', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-form-tab', async () => {
      await openApp(page, server.url('schedule/'));
      await inPage(
        page,
        `const b = document.createElement('button');
        b.id = 'qa-form-anchor'; b.textContent = 'anchor'; b.style.cssText = 'position:fixed;left:600px;top:300px';
        document.body.append(b); b.focus();
        s.openPopover(b, '<form><input class="input" aria-label="One" data-autofocus><button type="submit">Save</button></form>', { className: 'qa-form-pop', label: 'Form card' });`,
      );
      await sleep(100);
      for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.press(key);
        await sleep(40);
        assert.ok(await page.evaluate(() => !!document.activeElement?.closest('.qa-form-pop')), `${key}: focus stays in the form card`);
      }
      await page.press('Escape');
      await page.evaluate(() => document.getElementById('qa-form-anchor')?.remove());

      // Create → the date and time fields → type a start time and Tab: it is kept, and focus moves on.
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('c');
      await page.waitFor('[data-when-edit]', 4000);
      await page.evaluate(() => document.querySelector('[data-when-edit]').click());
      await page.waitFor('[name="qcStart"]', 3000);
      await page.evaluate(() => document.querySelector('[name="qcStart"]').click());
      await page.waitFor(() => document.activeElement?.matches('.tp-pop input'), { timeout: 3000, message: 'the time list, focus in its field' });
      await page.press('Control+a');
      await page.type('3:15pm');
      await page.press('Tab');
      await page.waitFor(() => !document.querySelector('.tp-pop'), 3000);
      assert.equal(await page.evaluate(() => document.querySelector('[name="qcStart"]').value), '15:15', 'Tab keeps the typed time');
      assert.ok(await page.evaluate(() => !!document.activeElement?.closest('.qc-modal, .qc-pop') && !document.activeElement.matches('[name="qcStart"]')), 'focus moved on to the next field');
      await page.press('Escape');
      await page.press('Escape');
    });
  });

  test('menu items are named by their labels; type-ahead finds "Add to Today"; multi-select items are checkboxes', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-menu-names', async () => {
      await openApp(page, server.url('tasks/#/inbox'));
      const title = `QA menu ${tag()}`;
      const id = await inPage(page, 'return store.db.insert("tasks", { title: args[0] }).id;', title);
      await page.waitFor((id) => !!document.querySelector(`.task[data-id="${id}"] .task-title`), { args: [id], timeout: 4000 });
      await page.click((id) => document.querySelector(`.task[data-id="${id}"] .task-title`), { args: [id], button: 'right' });
      await page.waitFor('[role="menu"] .menu-item', 3000);
      const items = await ax(page, '[role="menu"] .menu-item');
      const labels = await page.evaluate(() => [...document.querySelectorAll('[role="menu"] .menu-item .grow')].map((s) => s.textContent.trim()));
      assert.deepEqual(items.map((x) => x.name), labels, 'each item is named by its label alone (no keycaps, no glyph digits)');
      const keysOf = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[role="menu"] .menu-item')].map((b) => [b.querySelector('.grow').textContent.trim(), b.getAttribute('aria-keyshortcuts')])));
      assert.equal(keysOf['Open details'], 'Enter');
      assert.equal(keysOf.Delete, 'Backspace');
      await page.press('a');
      await sleep(60);
      assert.equal(await page.evaluate(() => document.activeElement?.querySelector('.grow')?.textContent.trim()), 'Add to Today', 'typing "a" reaches Add to Today');
      await page.press('Escape');
      await inPage(page, 'store.db.remove("tasks", args[0]);', id);

      await inPage(
        page,
        `const b = document.createElement('button'); b.id = 'qa-multi'; b.textContent = 'lists'; b.style.cssText = 'position:fixed;left:600px;top:300px';
        document.body.append(b);
        s.openMenu(b, [{ heading: 'Show tasks from' }, { label: 'Inbox', checked: true, multi: true }, { label: 'Work', checked: false, multi: true }, { label: 'Day', checked: true }], { label: 'Task lists' });`,
      );
      const roles = await page.evaluate(() => [...document.querySelectorAll('[role="menu"] .menu-item')].map((b) => `${b.getAttribute('role')}:${b.getAttribute('aria-checked')}`));
      assert.deepEqual(roles, ['menuitemcheckbox:true', 'menuitemcheckbox:false', 'menuitemradio:true']);
      await page.press('Escape');
      await page.evaluate(() => document.getElementById('qa-multi')?.remove());
    });
  });

  test('a destructive confirmation is described by its warning; live regions exist from the start', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-alert', async () => {
      await openApp(page, server.url('tasks/#/today'));
      assert.ok(await page.evaluate(() => !!document.querySelector('body > .toasts[role="status"][aria-live="polite"]')), 'the toast region is there before any toast');
      assert.ok(await page.evaluate(() => !!document.querySelector('body > [data-announcer][role="status"]')), 'the announcement region is there');
      const count = () => inPage(page, 'return store.db.all("tasks").length + store.db.all("events").length;');
      const before = await count();
      assert.ok(before > 0);
      await page.evaluate(() => document.activeElement?.blur());
      await page.press(',');
      await page.waitFor('.modal.settings', 3000);
      await page.evaluate(() => document.querySelector('[data-action="erase"]').click());
      await page.waitFor('.modal.choice', 3000);
      await sleep(150);
      const [dialog] = await ax(page, '.modal.choice');
      assert.equal(dialog.role, 'alertdialog');
      assert.equal(dialog.name, 'Erase everything?');
      assert.match(dialog.description, /^Every task, list, event, calendar and note .* is deleted/, 'the warning is the description');
      assert.ok(await page.evaluate(() => document.activeElement?.textContent.trim() === 'Cancel'), 'focus starts on Cancel');
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.modal.choice'), 3000);
      await page.press('Escape');
      assert.equal(await count(), before, 'Cancel erased nothing');
    });
  });

  test('the date picker announces the month it moves to; days in another year say the year', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('tasks/#/today'));
    const r = await inPage(
      page,
      `const b = document.createElement('button'); b.textContent = 'date'; b.style.cssText = 'position:fixed;left:600px;top:100px';
      document.body.append(b);
      const h = s.openDatePicker(b, { value: null });
      const live = h.el.querySelector('[data-dp-live]');
      const heading = () => h.el.querySelector('.mc-head strong');
      const out = { liveRole: live?.getAttribute('role'), headingLive: heading()?.hasAttribute('aria-live') };
      for (let i = 0; i < 14 && !/${new Date().getFullYear() + 1}/.test(heading().textContent); i++) {
        h.el.querySelector('[data-mc="next"]').click();
      }
      await new Promise((r) => setTimeout(r, 200));
      out.said = live.textContent;
      out.heading = heading().textContent;
      out.label = h.el.querySelector('.mc-day:not(.out)')?.getAttribute('aria-label');
      h.close(); b.remove();
      return out;`,
    );
    assert.equal(r.liveRole, 'status');
    assert.equal(r.headingLive, false, 'the redrawn heading is not the live region');
    assert.equal(r.said, r.heading, 'the month moved to is announced');
    assert.match(r.label, new RegExp(String(new Date().getFullYear() + 1)), `a day next year says the year (${r.label})`);
  });

  test('single-key shortcuts can be turned off in Settings; Ctrl shortcuts keep working', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-single-keys', async () => {
      await openApp(page, server.url('tasks/#/today'));
      await page.evaluate(() => document.activeElement?.blur());
      await page.press(',');
      await page.waitFor('.modal.settings', 3000);
      await page.clickText('switch', 'Single-key shortcuts');
      await page.waitFor(() => document.querySelector('[name="shellSingleKeys"]')?.getAttribute('aria-checked') === 'false', 3000);
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.modal.settings'), 3000);
      await server.waitForState((st) => st.settings?.shellSingleKeys === false, 8000, 'the setting saved on the server');
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('?');
      await sleep(250);
      assert.equal(await page.evaluate(() => !!document.querySelector('.modal .shortcuts')), false, '? does nothing while single-key shortcuts are off');
      await page.press(',');
      await sleep(250);
      assert.equal(await page.evaluate(() => !!document.querySelector('.modal.settings')), false, ', does nothing either');
      await page.press('Control+k');
      await page.waitFor('.palette', { timeout: 3000, message: 'Ctrl+K still opens the palette' });
      await page.press('Escape');
      await inPage(page, 'store.settings.set({ shellSingleKeys: true });');
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('?');
      await page.waitFor('.modal .shortcuts', { timeout: 3000, message: '? opens the shortcuts again once they are on' });
      assert.match(await page.evaluate(() => document.querySelector('.modal .shortcuts').innerText), /Redo/, 'the sheet lists Redo');
      await page.press('Escape');
    });
  });

  test('with single-key shortcuts off, menus, the palette and tooltips show only shortcuts that work', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-keys-off', async () => {
      await openApp(page, server.url('tasks/#/inbox'));
      const title = `QA keys ${tag()}`;
      const id = await inPage(page, 'return store.db.insert("tasks", { title: args[0] }).id;', title);
      await page.waitFor((id) => !!document.querySelector(`.task[data-id="${id}"] .task-title`), { args: [id], timeout: 4000 });
      // Each menu item's label → its aria-keyshortcuts, and "+caps" when it shows keycaps.
      const menuKeys = () =>
        page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[role="menu"] .menu-item')].map((b) => [b.querySelector('.grow').textContent.trim(), `${b.getAttribute('aria-keyshortcuts') || ''}${b.querySelector('.hint kbd') ? '+caps' : ''}`])));
      const rowMenu = async () => {
        await page.click((id) => document.querySelector(`.task[data-id="${id}"] .task-title`), { args: [id], button: 'right' });
        await page.waitFor('[role="menu"] .menu-item', 3000);
        const r = await menuKeys();
        await page.press('Escape');
        await page.waitFor(() => !document.querySelector('[role="menu"]'), 3000);
        return r;
      };
      // How many keycaps the tooltip of a button with this key spec shows (opened by Tab focus).
      const tipKeys = (spec) =>
        inPage(
          page,
          `const b = document.createElement('button'); b.textContent = 'tip';
          b.dataset.tip = 'Tip'; b.dataset.keys = args[0]; b.style.cssText = 'position:fixed;left:600px;top:300px';
          document.body.append(b);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
          b.focus();
          await new Promise((r) => setTimeout(r, 600));
          const t = document.querySelector('.tooltip.on');
          const out = t ? t.querySelectorAll('kbd').length : -1;
          b.remove();
          return out;`,
          spec,
        );
      const on = await rowMenu();
      assert.equal(on.Complete, 'E+caps', 'with single keys on, Complete shows E');
      assert.equal(on['Priority…'], '+caps', 'and Priority shows 1 to 4');
      assert.equal(await tipKeys('n'), 1, 'a tooltip shows its one-key shortcut');

      await inPage(page, 'store.settings.set({ shellSingleKeys: false });');
      const off = await rowMenu();
      assert.equal(off['Open details'], 'Enter+caps', 'Enter still opens the details, and says so');
      assert.equal(off.Delete, 'Backspace+caps');
      for (const label of ['Complete', 'Mark as important', 'Add to Today', 'Pick a date…', 'Priority…', 'Move to list…', 'Duplicate']) {
        assert.equal(off[label], '', `${label}: no keycaps and no aria-keyshortcuts for a key that does nothing`);
      }
      await page.click('[data-app-menu]');
      await page.waitFor('[role="menu"] .menu-item', 3000);
      const app = await menuKeys();
      await page.press('Escape');
      assert.equal(app.Settings, '', 'the app menu no longer offers ,');
      assert.equal(app['Keyboard shortcuts'], '', 'nor ?');
      assert.equal(app.Search, `${await page.evaluate(() => (/Mac/.test(navigator.platform) ? 'Meta' : 'Control'))}+K+caps`, 'Ctrl+K stays');
      assert.equal(await tipKeys('n'), 0, 'a tooltip leaves out a one-key shortcut');
      assert.equal(await tipKeys('mod K'), 2, 'and keeps Ctrl+K');
      // The palette's Settings row (",") has no keycap; a spec's other alternatives stay.
      await palette(page, 'settings');
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.palette-list [data-r]')].find((b) => b.querySelector('.grow').textContent.trim() === 'Settings')?.querySelector('.hint kbd') ?? null), null, 'the Settings row shows no ","');
      await closePalette(page);
      assert.deepEqual(
        await inPage(page, "return ['j / down', 'shift ?', 'comma', 'space', 'mod K', 'alt up', 'esc', 'enter', 'shift enter', '1 / 2'].map((k) => s.liveKeys(k));"),
        ['down', '', '', '', 'mod K', 'alt up', 'esc', 'enter', 'shift enter', ''],
      );
      // The shortcuts sheet still lists every shortcut, and says the one-key ones are off.
      await inPage(page, 's.openShortcuts();');
      await page.waitFor('.modal .shortcuts', 3000);
      assert.match(await page.evaluate(() => document.querySelector('[data-keys-off]')?.textContent || ''), /^Single-key shortcuts, like E or \?, are off/);
      await page.press('Escape');
      await inPage(page, 'store.settings.set({ shellSingleKeys: true });');
      assert.equal(await inPage(page, "return s.liveKeys('j / down');"), 'j / down', 'all of it once they are on again');
      await inPage(page, 's.openShortcuts();');
      await page.waitFor('.modal .shortcuts', 3000);
      assert.equal(await page.evaluate(() => !!document.querySelector('[data-keys-off]')), false, 'no note while they are on');
      await page.press('Escape');
      await inPage(page, 'store.db.remove("tasks", args[0]);', id);
    });
  });

  test('a pointer-opened tooltip stays up while the pointer is on it; a click over it reaches what it covers', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-tooltip-hover', async () => {
      await openApp(page, server.url('tasks/#/inbox'));
      const mouseTo = (x, y) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      const glide = async (a, b, steps = 6) => {
        for (let i = 1; i <= steps; i++) await mouseTo(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
      };
      const shown = () => page.evaluate(() => !!document.querySelector('.tooltip.on'));
      // A trigger, and under where its tooltip opens (above it) a button with a tooltip of its own.
      await inPage(
        page,
        `const t = document.createElement('button'); t.id = 'qa-trigger'; t.textContent = 'trigger'; t.dataset.tip = 'A tooltip to read at leisure';
        t.style.cssText = 'position:fixed;left:600px;top:400px;width:80px;height:32px;z-index:5';
        const u = document.createElement('button'); u.id = 'qa-under'; u.textContent = 'under'; u.dataset.tip = 'Under';
        u.style.cssText = 'position:fixed;left:560px;top:360px;width:160px;height:30px;z-index:5';
        window.__qaUnder = 0; u.addEventListener('click', () => window.__qaUnder++);
        document.body.append(t, u);`,
      );
      const trigger = { x: 640, y: 416 };
      await mouseTo(200, 700);
      await sleep(400);
      await mouseTo(trigger.x, trigger.y);
      await page.waitFor(() => document.querySelector('.tooltip.on')?.textContent === 'A tooltip to read at leisure', { timeout: 3000, message: "the trigger's tooltip" });
      const tip = await page.evaluate(() => {
        const r = document.querySelector('.tooltip.on').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };
      });
      assert.ok(tip.bottom <= 400 && tip.top < 390 && tip.bottom > 360, `the tooltip opens above the trigger, over the other button (${JSON.stringify(tip)})`);
      await glide(trigger, tip);
      await sleep(300);
      assert.ok(await shown(), 'the tooltip stays up with the pointer on it (WCAG 1.4.13)');
      assert.equal(await page.evaluate(() => document.querySelector('.tooltip.on').textContent), 'A tooltip to read at leisure', 'the covered button does not take over while the pointer is on the tooltip');
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tip.x, y: tip.y, button: 'left', buttons: 1, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tip.x, y: tip.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(100);
      assert.equal(await page.evaluate(() => window.__qaUnder), 1, 'a click over the tooltip reaches the button it covers');
      // Again, then off both the trigger and its tooltip: it goes.
      await mouseTo(200, 700);
      await sleep(400);
      await mouseTo(trigger.x, trigger.y);
      await page.waitFor('.tooltip.on', 3000);
      await glide(trigger, tip);
      await sleep(150);
      await glide(tip, { x: 900, y: tip.y });
      await page.waitFor(() => !document.querySelector('.tooltip.on'), { timeout: 2000, message: 'the tooltip to go once the pointer is off it and its trigger' });
      await page.evaluate(() => ['qa-trigger', 'qa-under'].forEach((i) => document.getElementById(i)?.remove()));
      await mouseTo(200, 700);
    });
  });

  test('Settings shows the live AI status, and the Notes AI option reads "Read & write"', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('tasks/#/today'));
    await page.evaluate(() => document.activeElement?.blur());
    await page.press(',');
    await page.waitFor('.modal.settings', 3000);
    const value = await page.waitFor(() => document.querySelector('[data-ai-value]')?.textContent || null, { timeout: 8000, message: 'the AI row to show a status' });
    assert.ok(['Not set up', 'Not connected', 'Off', 'Unavailable'].includes(value) || / connected$/.test(value), `AI row: ${value}`);
    assert.equal(await page.evaluate(() => document.querySelector('[name="notesAi"]').getAttribute('aria-label')), 'AI access to notes: Read & write');
    await page.press('Escape');
  });

  test('redo re-applies an undone change and keeps an edit made in between', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-shell-redo', async () => {
      await openApp(page, server.url('tasks/#/inbox'));
      const title = `QA redo ${tag()}`;
      const id = await inPage(page, 'return store.db.insert("tasks", { title: args[0] }).id;', title);
      const done = () => inPage(page, 'return !!store.db.get("tasks", args[0])?.done;', id);
      await page.waitFor((id) => !!document.querySelector(`.task[data-id="${id}"] [data-check]`), { args: [id], timeout: 4000 });
      await page.click((id) => document.querySelector(`.task[data-id="${id}"] [data-check]`), { args: [id] });
      for (let i = 0; i < 40 && !(await done()); i++) await sleep(100); // Tasks saves once its check animation ends
      assert.equal(await done(), true, 'completed');
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+z');
      for (let i = 0; i < 20 && (await done()); i++) await sleep(50);
      assert.equal(await done(), false, 'undone');
      await inPage(page, 'store.db.update("tasks", args[0], { title: args[1] });', id, `${title} renamed`);
      await page.press('Control+Shift+z');
      for (let i = 0; i < 20 && !(await done()); i++) await sleep(50);
      assert.equal(await done(), true, 'Ctrl+Shift+Z redoes it');
      assert.equal(await inPage(page, 'return store.db.get("tasks", args[0]).title;', id), `${title} renamed`, 'the rename made after the undo stays');
      await page.press('Control+z');
      for (let i = 0; i < 20 && (await done()); i++) await sleep(50);
      await page.press('Control+y');
      for (let i = 0; i < 20 && !(await done()); i++) await sleep(50);
      assert.equal(await done(), true, 'Ctrl+Y redoes too');
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('.toast-msg')].some((m) => m.textContent.startsWith('Redid '))), 'a "Redid …" toast');
      await waitForSyncIdle(page);
      const t = (await server.state()).data.tasks.find((x) => x.id === id);
      assert.equal(t.done, true);
      assert.equal(t.title, `${title} renamed`);
      // A new change ends the redo chain.
      await page.press('Control+z');
      for (let i = 0; i < 20 && (await done()); i++) await sleep(50);
      await inPage(page, 's.undoable("QA change", () => {});');
      await page.press('Control+y');
      await sleep(200);
      assert.equal(await done(), false, 'nothing to redo after a new change');
      await inPage(page, 'store.db.remove("tasks", args[0]);', id);
    });
  });

  test('the date picker can set a time, and the custom repeat picker builds rules', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('tasks/#/today'));
    await inPage(
      page,
      `const b = document.createElement('button'); b.id = 'qa-dp'; b.textContent = 'date'; b.style.cssText = 'position:fixed;left:600px;top:100px';
      document.body.append(b);
      window.__qaPicks = [];
      b.addEventListener('click', () => s.openDatePicker(b, { value: args[0], withTime: true, time: '09:30', onPick: (p) => window.__qaPicks.push({ date: p.date, time: p.time }) }));`,
      addDaysYmd(today, 3),
    );
    await page.click('#qa-dp');
    await page.waitFor('.dp-pop [data-dp="time"]', 3000);
    assert.match(await page.evaluate(() => document.querySelector('.dp-pop [data-dp="time"]').innerText), /Time\s+9:30am/);
    assert.equal(await page.evaluate(() => document.querySelector('.dp-pop [data-dp="today"] .today-glyph[aria-hidden="true"] b')?.textContent), String(+today.slice(8)), 'Today shows the dated calendar glyph');
    await page.evaluate(() => document.querySelector('.dp-pop [data-dp="time"]').click());
    await page.waitFor('.tp-pop', 3000);
    await page.evaluate(() => [...document.querySelectorAll('.tp-pop .tp-row')].find((r) => r.dataset.t === '15:00').click());
    await page.waitFor(() => !document.querySelector('.dp-pop, .tp-pop'), 3000);
    await page.click('#qa-dp');
    await page.waitFor('.dp-pop', 3000);
    await page.evaluate(() => document.querySelector('.dp-pop [data-dp="clear"]').click());
    assert.deepEqual(await page.evaluate(() => window.__qaPicks), [
      { date: addDaysYmd(today, 3), time: '15:00' },
      { date: null, time: null },
    ]);
    await page.evaluate(() => document.getElementById('qa-dp')?.remove());

    await inPage(
      page,
      `const b = document.createElement('button'); b.id = 'qa-rp'; b.textContent = 'repeat'; b.style.cssText = 'position:fixed;left:600px;top:100px';
      document.body.append(b);
      window.__qaRules = [];
      b.addEventListener('click', () => s.openRepeatPicker(b, { value: { freq: 'week', interval: 1, days: [1] }, date: '2026-11-26', onPick: (r) => window.__qaRules.push(r) }));`,
    );
    await page.click('#qa-rp');
    await page.waitFor(() => document.activeElement?.matches('.rp-pop input'), 3000);
    await page.press('Control+a');
    await page.type('2');
    await page.evaluate(() => document.querySelector('.rp-pop [data-rp-day="4"]').click());
    assert.equal(await page.evaluate(() => document.querySelector('.rp-pop [data-rp-sum]').textContent), 'Every 2 weeks on Mon, Thu');
    await page.press('Enter');
    await page.click('#qa-rp');
    await page.waitFor('.rp-pop', 3000);
    await page.evaluate(() => document.querySelector('.rp-pop [data-rp-unit="month"]').click());
    await page.evaluate(() => document.querySelector('.rp-pop [type="submit"]').click());
    assert.deepEqual(await page.evaluate(() => window.__qaRules), [
      { freq: 'week', interval: 2, days: [1, 4] },
      { freq: 'month', interval: 1, monthDay: 26 },
    ]);
    await page.evaluate(() => document.getElementById('qa-rp')?.remove());
    assert.deepEqual(page.consoleErrors(), []);
  });

  test('Connect AI says to reload when its module fails while ecosys runs', async () => {
    const page = await ctx.browser.newPage({ isolated: true });
    try {
      await page.setViewport(1440, 900, false);
      await page.send('Network.enable');
      await page.send('Network.setBlockedURLs', { urls: ['*/shared/ai.js*'] });
      await openApp(page, ctx.server.url('tasks/#/today'));
      await page.click('[data-app-menu]');
      await page.clickText('menuitem', 'Connect AI…');
      const msg = await page.waitFor(() => [...document.querySelectorAll('.toast .toast-msg')].map((m) => m.textContent).find((t) => /AI connections/.test(t)) || null, { timeout: 5000, message: 'a toast about AI connections' });
      assert.equal(msg, 'Couldn’t load AI connections. Reload the page to try again.');
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('.toast button')].some((b) => b.textContent === 'Reload')), 'with a Reload button');
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('losing ecosys shows a status that stays until it is back, unless it is hidden', async () => {
    const page = await ctx.browser.newPage({ isolated: true });
    try {
      await page.setViewport(1440, 900, false);
      await openApp(page, ctx.server.url('schedule/'));
      await page.send('Network.enable');
      await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await inPage(page, 'store.db.insert("tasks", { title: "QA offline change" });');
      await page.waitFor(() => window.ecosysSync?.status === 'offline', { timeout: 30000, message: 'sync to go offline' });
      const sticky = await page.waitFor(() => document.querySelector('.toast.sticky .toast-msg')?.textContent || null, { timeout: 12000, message: 'the offline status' });
      assert.equal(sticky, 'Offline. Your changes will sync when ecosys is back.');
      await inPage(page, 's.toast("One"); s.toast("Two"); s.toast("Three");');
      assert.ok(await page.evaluate(() => !!document.querySelector('.toast.sticky')), 'other toasts come and go; the status stays');
      // It covers part of the page for the whole outage, so it can be put away.
      await page.evaluate(() => [...document.querySelectorAll('.toast.sticky button')].find((b) => b.textContent === 'Hide').click());
      await page.waitFor(() => !document.querySelector('.toast.sticky:not(.leaving)'), { timeout: 3000, message: 'Hide to put the status away' });
      await sleep(4500);
      assert.equal(await page.evaluate(() => !!document.querySelector('.toast.sticky')), false, 'and it stays away while ecosys is still gone');
      await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await page.waitFor(() => window.ecosysSync?.online === true, { timeout: 60000, message: 'sync to come back' });
      await page.waitFor(() => !document.querySelector('.toast.sticky:not(.leaving)') && [...document.querySelectorAll('.toast-msg')].some((m) => m.textContent === 'Back online'), { timeout: 5000, message: '"Back online", though the status was hidden' });
    } finally {
      await page.close().catch(() => {});
    }
  });
});
