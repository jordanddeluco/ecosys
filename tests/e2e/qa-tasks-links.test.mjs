// QA regression (tasks): what connects a task to the rest, at 1440x900.
//   mentioned  the details pane lists "Mentioned in N notes": the notes with a [[task]] chip (or a checklist
//              line linked to it), each opening at that line; a note in Recently Deleted drops out, and the
//              note the task was sent from shows as "From note" only
//   labels     a label can be renamed or deleted everywhere, as Notes' tags: from its right-click menu in the
//              sidebar and from its page's More menu; done tasks too; one Undo takes it back
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot, tag } from './helpers.mjs';

const go = async (page, hash) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await settle(page, 300);
};
const lastToast = (page) => page.evaluate(() => [...document.querySelectorAll('.toast .toast-msg')].map((x) => x.innerText).at(-1));
const tasksWith = (page, g) => page.evaluate(async (g) => (await import('/shared/store.js')).db.all('tasks').filter((t) => t.tags.includes(g)).map((t) => t.title).sort(), g);
const mentions = (page) =>
  page.evaluate(() => ({
    head: document.querySelector('#inspector .dp-mentions-head')?.innerText.trim() || null,
    rows: [...document.querySelectorAll('#inspector .dp-mentions a')].map((a) => ({ href: a.getAttribute('href'), text: a.innerText.replace(/\s+/g, ' ').trim() })),
    from: document.querySelector('#inspector a.dp-link:not([data-ment]), #inspector .dp-link.is-missing')?.innerText.replace(/\s+/g, ' ').trim() || null,
  }));

describe('qa tasks: notes that mention a task, and labels', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let page;
  const k = tag();

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('tasks/'));
  });

  test('the details list the notes that mention the task, each opening at its line', async () => {
    await withScreenshot(page, 'qa-tasks-links-mentioned', async () => {
      const ids = await page.evaluate(async (k) => {
        const { createTask } = await import('/shared/model.js');
        const core = await import('/notes/core/notes.js');
        const task = createTask({ title: `Book flights ${k}` });
        const chip = (t) => [t.title, '', { ref: `task:${t.id}`, atom: 1 }];
        const a = core.createNote({ blocks: [{ t: 'h1', c: [[`Trip plan ${k}`]] }, { t: 'p', c: [['First '], chip(task), [' then hotels']] }] });
        const b = core.createNote({ blocks: [{ t: 'h1', c: [[`Weekly review ${k}`]] }, { t: 'bullet', c: [['Follow up: '], chip(task)] }] });
        // The note a second task was sent from (Send to Tasks): "From note", not "Mentioned in".
        const sent = createTask({ title: `Sent over ${k}` });
        const src = core.createNote({ blocks: [{ t: 'h1', c: [[`Source ${k}`]] }, { t: 'check', c: [[sent.title]], task: sent.id }] });
        const { db } = await import('/shared/store.js');
        const blockOf = (n, i) => db.get('notes', n.id).blocks[i].id;
        db.update('tasks', sent.id, { source: { app: 'notes', noteId: src.id, blockId: blockOf(src, 1) } });
        return { task: task.id, a: a.id, aBlock: blockOf(a, 1), b: b.id, sent: sent.id };
      }, k);

      await go(page, `#/task/${ids.task}`);
      await page.waitFor(() => !!document.querySelector('#inspector .dp-mentions'), { timeout: 4000, message: 'the "Mentioned in" card' });
      let m = await mentions(page);
      assert.equal(m.head, 'Mentioned in 2 notes');
      assert.equal(m.rows.length, 2);
      const trip = m.rows.find((r) => r.text.startsWith(`Trip plan ${k}`));
      assert.ok(trip, `the trip note listed (${JSON.stringify(m.rows)})`);
      assert.equal(trip.href, `../notes/#/n/${ids.a}/b/${ids.aBlock}`, 'it opens at the line that mentions the task');
      assert.match(trip.text, new RegExp(`First Book flights ${k} then hotels`), 'with that line');

      // Deleting a note (Recently Deleted) takes it off the list, in the open pane.
      await page.evaluate(async (id) => (await import('/shared/store.js')).db.update('notes', id, { trashedAt: Date.now() }), ids.b);
      await page.waitFor(() => document.querySelector('#inspector .dp-mentions-head')?.innerText.trim() === 'Mentioned in 1 note', { timeout: 3000, message: 'one note left' });
      await page.evaluate(async (id) => (await import('/shared/store.js')).db.update('notes', id, { trashedAt: Date.now() }), ids.a);
      await page.waitFor(() => !document.querySelector('#inspector .dp-mentions'), { timeout: 3000, message: 'the card gone' });
      await page.press('Escape');

      // A task sent from a note: that note is its "From note", and isn't listed again.
      await go(page, `#/task/${ids.sent}`);
      await page.waitFor(() => !!document.querySelector('#inspector a.dp-link'), { timeout: 4000 });
      m = await mentions(page);
      assert.match(m.from || '', new RegExp(`From note Source ${k}`));
      assert.equal(m.head, null, 'no "Mentioned in" for its own source note');
      await page.press('Escape');
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('a label is renamed everywhere from the sidebar, done tasks too; Undo takes it back', async () => {
    await withScreenshot(page, 'qa-tasks-links-rename', async () => {
      const g = `lbl${k}`;
      const to = `renamed-${k}`;
      await page.evaluate(
        async (g, k) => {
          const { createTask, toggleTask } = await import('/shared/model.js');
          createTask({ title: `Open one ${k}`, tags: [g] });
          createTask({ title: `Open two ${k}`, tags: [g, 'other'] });
          toggleTask(createTask({ title: `Done one ${k}`, tags: [g] }).id);
        },
        g,
        k,
      );
      await go(page, '#/inbox');
      await page.click(`#nav a[data-nav="tag:${g}"]`, { button: 'right' });
      await page.waitFor('.menu [role="menu"]', 3000);
      const items = await page.evaluate(() => [...document.querySelectorAll('.menu .menu-item')].map((x) => x.innerText.trim()));
      assert.deepEqual(items, ['Rename label…', 'Delete label']);
      await page.clickText('menuitem', 'Rename label…');
      await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'New name', { timeout: 3000, message: 'the rename dialog' });
      assert.match(await page.evaluate(() => document.querySelector('.label-hint').innerText), /^Renames the label on 3 tasks\.$/);
      await page.press('Control+a');
      await page.type(`Renamed ${k}`); // stored as a label: lowercase, a dash for the space
      await page.press('Enter');
      await page.waitFor(() => !document.querySelector('.modal'), 3000);
      assert.deepEqual(await tasksWith(page, g), []);
      assert.deepEqual(await tasksWith(page, to), [`Done one ${k}`, `Open one ${k}`, `Open two ${k}`]);
      assert.equal(await lastToast(page), `Renamed ${g} to ${to}`);
      assert.ok(await page.evaluate((to) => !!document.querySelector(`#nav a[data-nav="tag:${to}"]`), to), 'the sidebar lists the new name');

      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+z');
      await page.waitFor(async (g) => (await import('/shared/store.js')).db.all('tasks').filter((t) => t.tags.includes(g)).length === 3, { timeout: 3000, args: [g], message: 'the old name back' });
      assert.deepEqual(await tasksWith(page, to), []);
      assert.deepEqual(await tasksWith(page, 'other'), [`Open two ${k}`], 'the other label untouched');
    });
  });

  test("a label is deleted from its page's More menu; its page closes; Undo puts it back", async () => {
    await withScreenshot(page, 'qa-tasks-links-delete', async () => {
      const g = `lbl${k}`;
      await go(page, `#/tag/${g}`);
      await page.click('#head-actions [data-view-menu]');
      await page.waitFor('.menu [role="menu"]', 3000);
      const items = await page.evaluate(() => [...document.querySelectorAll('.menu .menu-item')].map((x) => x.innerText.trim().split('\n')[0]));
      assert.ok(items.includes('Rename label…') && items.includes('Delete label'), items.join(', '));
      await page.clickText('menuitem', 'Delete label');
      await page.waitFor(() => location.hash === '#/inbox', { timeout: 3000, message: 'the label page left' });
      assert.deepEqual(await tasksWith(page, g), []);
      assert.equal(await lastToast(page), `Deleted the label ${g} from 3 tasks`);
      assert.ok(await page.evaluate((g) => !document.querySelector(`#nav a[data-nav="tag:${g}"]`), g), 'gone from the sidebar');
      await page.evaluate(() => document.activeElement?.blur());
      await page.press('Control+z');
      await page.waitFor(async (g) => (await import('/shared/store.js')).db.all('tasks').filter((t) => t.tags.includes(g)).length === 3, { timeout: 3000, args: [g], message: 'the label back on its tasks' });
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
