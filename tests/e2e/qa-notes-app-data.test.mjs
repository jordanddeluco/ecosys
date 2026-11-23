// notes-app fixes, data safety (headless Chrome tabs and profiles against an isolated server):
//   idle          with this browser's storage full, an open Notes tab sends nothing to ecosys while you
//                 aren't typing (no save retry writes a note again)
//   housekeeping  the AI-review expiry and the 30-day purge wait for the first sync: a note recovered and
//                 a line added in another browser survive Notes opening while ecosys is briefly unreachable
//   linked items  catch up at start with task renames and completions made while Notes was closed
//   second tab    a change that also moves a linked task (a Restore) is not undone by another Notes tab
//   same line     typing in one line in two tabs keeps both tabs' text
//   deep link     a link to a note this browser doesn't have yet opens that note once it arrives
//   quick note    Add to Today writes a line of its own; New note right after it makes a note of its own
//   event chips   follow their event when it moves (a single event, and one occurrence of a series)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp as openAppHash, waitForApp, waitForSync, waitForSyncIdle, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Load the page afresh (going to a URL that differs only in its hash would keep the page as it is). */
async function openApp(page, url, opts) {
  await page.goto('about:blank');
  return openAppHash(page, url, opts);
}

const DAY = 86400000;
const textOf = (b) => (b?.c || []).map((r) => r[0]).join('');
const textsOf = (n) => (n?.blocks || []).map(textOf);
const addDaysYmd = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
/** Put the caret at the end of the open note's last block (as a click at the end of its last line does). */
const caretToEnd = (page) =>
  page.evaluate(() => {
    const ed = document.querySelector('.ne-doc');
    ed.focus();
    const tx = [...ed.querySelectorAll('.ne-b')].pop().querySelector('.ne-tx');
    const r = document.createRange();
    r.selectNodeContents(tx);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
/**
 * Run fn(store, core, model, arg) in the page, with the store, the notes core and the model at hand. One
 * expression sent as is (the page's CSP refuses eval inside it; DevTools' own evaluation is not eval).
 */
const inPage = (page, fn, arg) =>
  page.evaluate(`(async () => {
    const store = await import('/shared/store.js');
    const core = await import('/notes/core/notes.js');
    const model = await import('/shared/model.js');
    return (${String(fn)})(store, core, model, ${JSON.stringify(arg ?? null)});
  })()`);

describe('qa notes-app: data safety', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  const extra = [];
  async function newPage({ isolated = false } = {}) {
    const p = await ctx.browser.newPage({ isolated });
    await p.setViewport(1440, 900, false);
    extra.push(p);
    return p;
  }
  async function closeExtra() {
    while (extra.length) await extra.pop().close().catch(() => {});
  }

  test('an idle Notes tab with storage full sends nothing to ecosys (no save retry rewrites the open note)', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-notes-app-idle', async () => {
      await openApp(page, server.url('notes/#/all'));
      await waitForSyncIdle(page);
      // Fill this browser's storage to the last character, so the next save of the notes fails.
      await page.evaluate(() => {
        window.__qaSaveErrors = 0;
        // The store says so either way: an error, or (sync online) that only the offline copy is partial.
        addEventListener('ecosys:save-error', () => window.__qaSaveErrors++);
        addEventListener('ecosys:offline-cache', () => window.__qaSaveErrors++);
        let size = 1 << 22;
        let i = 0;
        while (size >= 1) {
          try {
            localStorage.setItem(`qa-fill-${i}`, 'x'.repeat(size));
            i++;
          } catch {
            size >>= 1;
          }
        }
      });
      try {
        await caretToEnd(page);
        await page.type(` and some more text that no longer fits in this browser's storage ${'z'.repeat(200)}`);
        await page.waitFor(() => window.__qaSaveErrors > 0, { timeout: 8000, message: 'the save to this browser to fail' });
        // What the store reports when it can't count on ecosys having the edit (sync offline, or not in yet):
        // the app checks again now and then whether the notes were saved after all.
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('ecosys:save-error', { detail: new Error('QuotaExceededError') })));
        await waitForSyncIdle(page);
        await sleep(1500);
        const rev0 = (await server.state()).rev;
        await sleep(12000); // two and a half of the old 5-second save retries
        const rev1 = (await server.state()).rev;
        assert.equal(rev1, rev0, 'nothing was written while the tab sat idle');
        assert.equal(await page.evaluate(() => !!document.querySelector('.n-banner-err')), false, 'ecosys has every edit: no "Not saved" banner');
      } finally {
        await page.evaluate(() => {
          for (const k of Object.keys(localStorage)) if (k.startsWith('qa-fill-')) localStorage.removeItem(k);
        });
      }
    });
  });

  test('housekeeping waits for the first sync: what another browser recovered and wrote survives Notes opening offline', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('tasks/'));
    const ids = await inPage(
      page,
      ({ db }, _c, _m, DAY) => {
        const t = Date.now();
        const trashed = db.insert('notes', { v: 1, rev: 2, trashedAt: t - 31 * DAY, trashedFrom: null, blocks: [{ id: 'b1', t: 'h1', c: [['Passport numbers']] }, { id: 'b2', t: 'p', c: [['keep this']] }] });
        const at = t - 8 * DAY;
        const reviewed = db.insert('notes', { v: 1, rev: 3, editedBy: 'mcp:claude', editedAt: at, aiPrev: { at, by: 'mcp:claude', rev: 2, blocks: [{ id: 'c1', t: 'h1', c: [['Trip budget']] }] }, blocks: [{ id: 'c1', t: 'h1', c: [['Trip budget']] }, { id: 'c2', t: 'p', c: [['Flights 420']] }] });
        return { trashed: trashed.id, reviewed: reviewed.id };
      },
      DAY,
    );
    await waitForSyncIdle(page);
    await page.goto('about:blank');
    const b = await newPage({ isolated: true }); // another browser: recover the note, add a line to the other
    try {
      await openApp(b, server.url('tasks/'));
      await inPage(
        b,
        ({ db }, _c, _m, x) => {
          const n = db.get('notes', x.trashed);
          db.update('notes', x.trashed, { trashedAt: null, trashedFrom: null, rev: n.rev + 1 });
          const m = db.get('notes', x.reviewed);
          db.update('notes', x.reviewed, { blocks: [...m.blocks, { id: 'c3', t: 'p', c: [['Hotel 610']] }], rev: m.rev + 1, editedAt: Date.now(), editedBy: 'user' });
        },
        ids,
      );
      await waitForSyncIdle(b);
    } finally {
      await closeExtra();
    }
    // This browser opens Notes while ecosys can't be reached for a few seconds.
    await page.send('Network.enable');
    await page.send('Network.setBlockedURLs', { urls: ['*/api/*'] });
    try {
      await page.goto(server.url('notes/'));
      await page.waitFor(() => !!window.ecosysSync, { timeout: 15000 });
      await sleep(3000);
      // Nothing ran on this browser's old copy meanwhile: the note is still here (deleted 31 days ago
      // as far as this copy knows) and the AI edit still waits for review.
      const local = await inPage(page, ({ db }, _c, _m, x) => ({ trashed: !!db.get('notes', x.trashed), aiPrev: !!db.get('notes', x.reviewed)?.aiPrev }), ids);
      assert.deepEqual(local, { trashed: true, aiPrev: true }, 'no purge or AI-review expiry before the first sync');
    } finally {
      await page.send('Network.setBlockedURLs', { urls: [] });
    }
    await waitForSync(page, 30000);
    await sleep(2500);
    await waitForSyncIdle(page);
    const notes = (await server.state()).data.notes;
    const recovered = notes.find((n) => n.id === ids.trashed);
    assert.ok(recovered && !recovered.trashedAt, 'the note recovered in the other browser is still there');
    assert.ok(textsOf(notes.find((n) => n.id === ids.reviewed)).includes('Hotel 610'), "the other browser's new line is still in the note");
  });

  test('linked checklist items catch up at start with what their tasks did while Notes was closed', async () => {
    const { page, server } = ctx;
    const t = tag();
    await openApp(page, server.url('notes/#/all'));
    const { noteId, taskId } = await inPage(
      page,
      ({ db }, core, model, title) => {
        const task = model.createTask({ title });
        const n = core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`Linked ${title}`]] }, { id: 'k', t: 'check', ck: false, task: task.id, c: [[title]] }] });
        return { noteId: n.id, taskId: task.id };
      },
      `Call the bank ${t}`,
    );
    await waitForSyncIdle(page);
    // Renamed and completed in Tasks, in this browser, while no Notes tab is open: when Notes opens, its
    // copy of the tasks is already the new one (no change arrives to set the items off).
    await openApp(page, server.url('tasks/'));
    await inPage(page, ({ db }, _c, _m, x) => db.update('tasks', x.id, { title: x.title, done: true, completedAt: Date.now() }), { id: taskId, title: `Call the bank today ${t}` });
    await waitForSyncIdle(page);
    await page.goto('about:blank');
    await openApp(page, server.url('notes/#/all'));
    const n = await server.waitForState((s) => {
      const x = s.data.notes.find((y) => y.id === noteId);
      const b = x?.blocks.find((y) => y.task === taskId);
      return b && textOf(b) === `Call the bank today ${t}` && b.ck === true ? x : null;
    }, 10000, 'the item renamed and checked');
    assert.ok(n);
  });

  test('a Restore in another tab (its task change arriving before its note) is not undone from this tab’s old copy', async () => {
    const { page, server } = ctx;
    const t = tag();
    await openApp(page, server.url('notes/#/all'));
    const { noteId, taskId } = await inPage(
      page,
      ({ db }, core, model, x) => {
        const task = model.createTask({ title: `Item ${x}` });
        model.toggleTask(task.id); // done
        const n = core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`Restore ${x}`]] }, { id: 'k', t: 'check', ck: true, task: task.id, c: [[`Item ${x}`]] }, { id: 'p', t: 'p', c: [[`second version ${x}`]] }] });
        return { noteId: n.id, taskId: task.id };
      },
      t,
    );
    await waitForSyncIdle(page);
    const before = (await server.state()).data.notes.find((n) => n.id === noteId);
    // Another tab of this browser restores the earlier version (item unchecked, its task reopened). This
    // tab hears it as two storage events, the tasks first, then the notes: exactly what it gets then.
    await inPage(
      page,
      ({ db }, _c, _m, x) => {
        const now = Date.now();
        const tasks = db.all('tasks').map((y) => (y.id === x.taskId ? { ...y, done: false, completedAt: null, updatedAt: now } : y));
        const notes = db.all('notes').map((n) => (n.id === x.noteId ? { ...n, rev: n.rev + 1, updatedAt: now, editedAt: now, blocks: [{ id: 'h', t: 'h1', c: [[`Restore ${x.t}`]] }, { id: 'k', t: 'check', ck: false, task: x.taskId, c: [[`Item ${x.t}`]] }, { id: 'p', t: 'p', c: [[`first version ${x.t}`]] }] } : n));
        const fire = (name, list) => {
          const v = JSON.stringify(list);
          localStorage.setItem(`ecosys:v1:${name}`, v);
          window.dispatchEvent(new StorageEvent('storage', { key: `ecosys:v1:${name}`, newValue: v, storageArea: localStorage }));
        };
        fire('tasks', tasks);
        return new Promise((r) =>
          setTimeout(() => {
            fire('notes', notes);
            r();
          }, 60),
        );
      },
      { noteId, taskId, t },
    );
    await sleep(1500);
    await waitForSyncIdle(page);
    const after = (await server.state()).data.notes.find((n) => n.id === noteId);
    assert.equal(after.rev, before.rev, `this tab wrote nothing over the note from its old copy: ${JSON.stringify(textsOf(after))}`);
    const local = await inPage(page, ({ db }, _c, _m, id) => db.get('notes', id).blocks.map((b) => (b.c || []).map((r) => r[0]).join('')), noteId);
    assert.deepEqual(local.slice(1), [`Item ${t}`, `first version ${t}`], 'this tab has the restored version');
  });

  test('typing in the same line in two tabs keeps both tabs’ text', async () => {
    const { page, server } = ctx;
    const t = tag();
    await openApp(page, server.url('notes/#/all'));
    const noteId = await inPage(page, (_s, core, _m, x) => core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`Two tabs ${x}`]] }, { id: 'l', t: 'p', c: [['shared line']] }] }).id, t);
    await waitForSyncIdle(page);
    const other = await newPage();
    try {
      await openApp(page, server.url(`notes/#/all/n/${noteId}`));
      await openApp(other, server.url(`notes/#/all/n/${noteId}`));
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
      for (let i = 0; i < 5; i++) {
        await page.type(`x${i}`);
        await sleep(60);
        await other.type(`y${i}`);
        await sleep(60);
      }
      await sleep(3500);
      const line = textsOf((await server.state()).data.notes.find((n) => n.id === noteId)).find((s) => s.includes('shared line'));
      for (let i = 0; i < 5; i++) {
        assert.ok(line.includes(`x${i}`), `the first tab's x${i} is kept: "${line}"`);
        assert.ok(line.includes(`y${i}`), `the second tab's y${i} is kept: "${line}"`);
      }
    } finally {
      await closeExtra();
    }
  });

  test('a link to a note this browser does not have yet opens that note (not the first one)', async () => {
    const { page, server } = ctx;
    const t = tag();
    await openApp(page, server.url('notes/#/all'));
    await page.goto('about:blank');
    const id = `qa${tag(10)}`;
    const now = Date.now();
    const r = await server.api('api/ops', { method: 'POST', body: { client: 'qa-ai', ops: [{ op: 'put', c: 'notes', item: { id, v: 1, rev: 1, createdAt: now, updatedAt: now, editedAt: now, blocks: [{ id: 'b1', t: 'h1', c: [[`Deep ${t}`]] }, { id: 'b2', t: 'p', c: [['made elsewhere']] }] } }] } });
    assert.equal(r.status, 200);
    await page.goto(server.url(`notes/#/n/${id}`));
    await waitForApp(page);
    await waitForSync(page);
    await page.waitFor((x) => document.querySelector('.ne-doc .ne-b')?.textContent === x, { timeout: 8000, args: [`Deep ${t}`], message: 'the linked note to open' });
    assert.ok((await page.evaluate(() => location.hash)).includes(id), 'the address still names the note');
  });

  test('Quick Note: Add to Today writes a line of its own; New note right after it makes a note of its own', async () => {
    const { page, server } = ctx;
    const t = tag();
    await openApp(page, server.url('notes/#/all'));
    const today = await browserToday(page);
    await inPage(
      page,
      (_s, core, _m, x) => {
        const n = core.dailyNote(x.today, { create: true });
        core.saveBlocks(n.id, [...n.blocks.filter((b) => (b.c || []).length || b.t !== 'p'), { id: 'last', t: 'p', c: [[`Last line ${x.t}`]] }]);
      },
      { today, t },
    );
    await waitForSyncIdle(page);
    const quick = async (label) => {
      await openApp(page, server.url('notes/#/quick'));
      await page.waitFor(() => document.querySelector('.n-quick .ne-doc'), { timeout: 8000, message: 'Quick Note' });
      await page.click((l) => [...document.querySelectorAll('.n-quick [data-qmode]')].find((b) => b.textContent.trim() === l), { args: [label] });
      await sleep(400);
    };
    await quick('Add to Today');
    await page.type(`Quick ${t}`);
    await sleep(600);
    await page.clickText('button', 'Done', { exact: true });
    const n = await server.waitForState((s) => s.data.notes.find((x) => x.day === today && textsOf(x).includes(`Quick ${t}`)), 10000, "the quick text as a line of today's note");
    assert.ok(textsOf(n).includes(`Last line ${t}`), `the last line stays as it was: ${JSON.stringify(textsOf(n).slice(-3))}`);
    await quick('New note');
    await page.type(`Own note ${t}`);
    await sleep(800);
    await page.clickText('button', 'Done', { exact: true });
    const own = await server.waitForState((s) => s.data.notes.find((x) => textsOf(x).some((y) => y.includes(`Own note ${t}`))), 10000, 'the new quick note');
    assert.equal(own.day, null, 'a note of its own, not the day note');
    assert.equal(own.title, `Own note ${t}`);
  });

  test('event chips follow their event: a moved event, and an occurrence moved on its own', async () => {
    const { page, server } = ctx;
    const t = tag();
    await openApp(page, server.url('notes/#/all'));
    const today = await browserToday(page);
    const d1 = addDaysYmd(today, 1);
    const d3 = addDaysYmd(today, 3);
    const { noteId } = await inPage(
      page,
      ({ db }, core, model, x) => {
        const cal = db.all('calendars')[0];
        const one = db.insert('events', { title: `Chip ev ${x.t}`, start: `${x.d1}T15:00`, end: `${x.d1}T16:00`, calendarId: cal.id, allDay: false });
        const series = db.insert('events', { title: `Weekly ${x.t}`, start: `${x.d1}T09:00`, end: `${x.d1}T09:30`, calendarId: cal.id, allDay: false, repeat: { freq: 'week', interval: 1, days: [new Date(`${x.d1}T12:00`).getDay()] } });
        const chip = (e, d) => [e.title, '', { ref: `event:${e.id}@${d}`, atom: 1 }];
        const n = core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`Chips ${x.t}`]] }, { id: 'a', t: 'p', c: [chip(one, x.d1)] }, { id: 'b', t: 'p', c: [chip(series, x.d1)] }] });
        // Both move: the event two days later; the series' occurrence on d1 alone, to the day after.
        db.update('events', one.id, { start: `${x.d3}T15:00`, end: `${x.d3}T16:00` });
        model.detachOccurrence(series.id, x.d1, { start: `${x.d2}T11:00`, end: `${x.d2}T11:30` });
        return { noteId: n.id };
      },
      { t, d1, d3, d2: addDaysYmd(today, 2) },
    );
    await openApp(page, server.url(`notes/#/all/n/${noteId}`));
    await page.waitFor(() => document.querySelectorAll('.ne-doc .ne-chip-event').length === 2, { timeout: 8000, message: 'the two event chips' });
    const { chips, want3, want2, old } = await page.evaluate((a, b, c) => {
      const f = (d) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      return { chips: [...document.querySelectorAll('.ne-doc .ne-chip-event')].map((x) => x.textContent), want3: f(b), want2: f(c), old: f(a) };
    }, d1, d3, addDaysYmd(today, 2));
    assert.ok(chips[0].includes(want3) && !chips[0].includes(old), `the event's chip shows its new day (${want3}): "${chips[0]}"`);
    assert.ok(chips[1].includes(want2) && !chips[1].includes(old), `the occurrence's chip shows the day it moved to (${want2}): "${chips[1]}"`);
    await settle(page, 100);
    assert.deepEqual(page.consoleErrors(), []);
  });
});
