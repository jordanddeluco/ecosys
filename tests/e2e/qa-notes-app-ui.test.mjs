// notes-app fixes, what you see (headless Chrome against an isolated server):
//   several notes selected   the open note's toolbar and folder crumb go (they would edit a note not on screen)
//   menus                    the row, folder or tag a context menu acts on is marked while it is open;
//                            folders have Move to…, Move up and Move down
//   Select mode              only picked rows are tinted, not the open one
//   rows                     no folder line repeating the folder you are in; groups as row descriptions;
//                            empty checklist items aren't counted; a meeting note's row shows its time
//   meeting notes            the event card doesn't repeat the title
//   empty states             version history with no versions; two tags with "All" and no note with both
//   search                   "New note “…”" leaves out operators and excluded words
//   palette                  one entry for today's note
//   shortcuts                Ctrl+Shift+X order outside macOS
//   phones                   the list bar is ⋯ only (Done while selecting); a tap beside revealed swipe
//                            actions only puts them away, and only the revealed side's actions are drawn
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp as openAppHash, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Load the page afresh (going to a URL that differs only in its hash would keep the page as it is). */
async function openApp(page, url, opts) {
  await page.goto('about:blank');
  return openAppHash(page, url, opts);
}
const inPage = (page, fn, arg) =>
  page.evaluate(`(async () => {
    const store = await import('/shared/store.js');
    const core = await import('/notes/core/notes.js');
    const model = await import('/shared/model.js');
    return (${String(fn)})(store, core, model, ${JSON.stringify(arg ?? null)});
  })()`);
async function rightClick(page, fn, arg) {
  const p = await page.evaluate(fn, arg);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', buttons: 2, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', buttons: 0, clickCount: 1 });
  await sleep(300);
}

describe('qa notes-app: desk', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });

  test('several notes selected: no toolbar or crumb for the open note, and its tools do nothing', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-notes-app-multi', async () => {
      await openApp(page, server.url('notes/#/all'));
      const ids = await page.evaluate(() => [...document.querySelectorAll('#list .nrow[data-id]')].slice(0, 3).map((r) => r.dataset.id));
      for (const id of ids.slice(1)) await page.click((x) => document.getElementById(`row-${x}`), { args: [id], modifiers: ['Control'] });
      await sleep(300);
      const st = await page.evaluate(() => ({
        stack: !!document.querySelector('.n-multi'),
        tools: document.querySelectorAll('#notetop [data-exec], #notetop [data-aa], #notetop [data-insert], #notetop [data-share], #notetop .nt-crumb').length,
        noNote: document.querySelector('#shell').classList.contains('no-note'),
      }));
      assert.deepEqual(st, { stack: true, tools: 0, noNote: true }, 'the stack shows, the note tools are gone');
      const before = await inPage(page, ({ db }, _c, _m, id) => JSON.stringify(db.get('notes', id).blocks), ids[0]);
      // Mod+F (find in note) and I (info) don't act on the hidden note either.
      await page.press('Control+f');
      await page.press('i');
      await sleep(300);
      assert.equal(await page.evaluate(() => document.querySelector('#findbar').hidden), true, 'no find bar');
      assert.equal(await page.evaluate(() => document.querySelector('#info').hidden), true, 'no info panel');
      assert.equal(await inPage(page, ({ db }, _c, _m, id) => JSON.stringify(db.get('notes', id).blocks), ids[0]), before, 'the open note is unchanged');
      await page.press('Escape');
      await sleep(300);
      assert.ok(await page.evaluate(() => !!document.querySelector('#notetop [data-exec]')), 'its tools are back with one note');
    });
  });

  test('context menus mark what they act on; folders can be moved from their menu', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/all'));
    const id = await page.evaluate(() => [...document.querySelectorAll('#list .nrow[data-id]')].find((r) => !r.classList.contains('open')).dataset.id);
    await rightClick(page, (x) => {
      const b = document.getElementById(`row-${x}`).getBoundingClientRect();
      return { x: b.x + 60, y: b.y + 20 };
    }, id);
    assert.ok(await page.evaluate((x) => document.getElementById(`row-${x}`).classList.contains('n-ctx'), id), 'the right-clicked row is marked');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#list .n-ctx').length), 1, 'only that row');
    await page.press('Escape');
    await sleep(200);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.n-ctx').length), 0, 'the mark goes with the menu');
    await rightClick(page, () => {
      const b = [...document.querySelectorAll('#nav a.n-folder')].pop().getBoundingClientRect();
      return { x: b.x + 40, y: b.y + 10 };
    });
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('#nav a.n-folder')].pop().classList.contains('n-ctx')), 'the folder is marked');
    const items = await page.evaluate(() => [...document.querySelectorAll('[role=menu] [role^=menuitem]')].map((b) => b.textContent.trim()));
    assert.ok(items.some((x) => x.startsWith('Move to')), `Move to… is in the folder menu: ${items}`);
    assert.ok(items.some((x) => x.startsWith('Move up')), 'Move up (the last folder can only go up)');
    await page.clickText('menuitem', /^Move to/);
    await sleep(300);
    const picks = await page.evaluate(() => [...document.querySelectorAll('[role=menu] [role^=menuitem]')].map((b) => b.textContent.trim()));
    assert.ok(picks.includes('Top level'), `the picker offers the top level: ${picks}`);
    await page.press('Escape');
  });

  test('Select mode tints only picked rows; group headings describe their rows; empty checklist items are not counted', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/all'));
    const noteId = await inPage(page, (_s, core) => core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [['Counting']] }, { id: 'a', t: 'check', ck: true, c: [['done thing']] }, { id: 'b', t: 'check', ck: false, c: [] }] }).id);
    await sleep(400);
    const ring = await page.evaluate((x) => document.querySelector(`#row-${x} .n-ring`)?.getAttribute('aria-label'), noteId);
    assert.equal(ring, '1 of 1 checked', 'the empty item is not counted');
    const desc = await page.evaluate(() => [...document.querySelectorAll('#list .nrow[data-id]')].map((r) => document.getElementById(r.getAttribute('aria-describedby') || '-')?.textContent.trim()));
    assert.ok(desc.every(Boolean), `every row names its group: ${desc}`);
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('#list .ngroup')].every((g) => g.getAttribute('aria-hidden') === 'true')), 'the headings themselves are out of the accessibility tree');
    await page.click('[data-select-mode]');
    await sleep(300);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#list .nrow.open').length), 0, 'the open note is not tinted while selecting');
    await page.click('[data-select-mode]');
  });

  test('inside a folder, rows name only a subfolder; a meeting note: no repeated title in its card, its time in its row', async () => {
    const { page, server } = ctx;
    const t = tag();
    await openApp(page, server.url('notes/#/all'));
    const today = await browserToday(page);
    const ids = await inPage(
      page,
      ({ db }, core, _m, x) => {
        const top = core.createFolder({ name: `Top ${x.t}` });
        const sub = core.createFolder({ name: `Sub ${x.t}`, parentId: top.id });
        const a = core.createNote({ folderId: top.id, blocks: [{ id: 'h', t: 'h1', c: [[`In top ${x.t}`]] }] });
        const b = core.createNote({ folderId: sub.id, blocks: [{ id: 'h', t: 'h1', c: [[`In sub ${x.t}`]] }] });
        const cal = db.all('calendars')[0];
        const ev = db.insert('events', { title: `Standup ${x.t}`, start: `${x.today}T09:30`, end: `${x.today}T09:45`, calendarId: cal.id, allDay: false, location: 'Zoom' });
        const m = core.meetingNote(ev.id, x.today, { create: true, title: `Standup ${x.t}` });
        return { top: top.id, a: a.id, b: b.id, m: m.id };
      },
      { t, today },
    );
    await openApp(page, server.url(`notes/#/folder/${ids.top}`));
    const lines = await page.evaluate((x) => [x.a, x.b].map((id) => document.querySelector(`#row-${id} .nrow-folder`)?.textContent.trim() || ''), ids);
    assert.deepEqual(lines, ['', `Sub ${t}`], 'no repeat of the folder you are in; the subfolder is named');
    await openApp(page, server.url(`notes/#/all/n/${ids.m}`));
    const card = await page.evaluate(() => ({ text: document.querySelector('.n-evhead')?.innerText || '', label: document.querySelector('.n-evhead')?.getAttribute('aria-label') }));
    assert.ok(!card.text.includes(`Standup ${t}`), `the card doesn't repeat the title: "${card.text}"`);
    assert.match(card.text, /Zoom/);
    assert.match(card.label, new RegExp(`Standup ${t}`), 'its name still says which event');
    const prev = await page.evaluate((x) => document.querySelector(`#row-${x} .nrow-prev`)?.textContent, ids.m);
    assert.match(prev, /9:30/, `the row shows when the meeting is: "${prev}"`);
    assert.doesNotMatch(prev, /^Notes$/, 'not the template heading');
  });

  test('empty states: version history with nothing kept; two tags with All and no note with both', async () => {
    const { page, server } = ctx;
    const t = tag();
    await openApp(page, server.url('notes/#/all'));
    const id = await inPage(page, (_s, core, _m, x) => core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`No history ${x}`]] }] }).id, t);
    await openApp(page, server.url(`notes/#/all/n/${id}`));
    await page.click(() => [...document.querySelectorAll('[data-note-menu]')].find((b) => b.offsetParent));
    await page.clickText('menuitem', /Version history/);
    await page.waitFor('[role=dialog]', 5000);
    const dlg = await page.evaluate(() => {
      const d = [...document.querySelectorAll('[role=dialog]')].pop();
      return { text: d.innerText, listbox: !!d.querySelector('[role=listbox]'), buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean) };
    });
    assert.match(dlg.text, /No earlier versions yet/);
    assert.equal(dlg.listbox, false, 'no empty list of versions');
    assert.ok(!dlg.buttons.some((b) => /Restore|Copy as Markdown/.test(b)), `no actions that can't be used: ${dlg.buttons}`);
    await page.press('Escape');
    await inPage(page, (_s, core, _m, x) => {
      core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [['A']] }, { id: 'p', t: 'p', c: [[`#alpha${x}`]] }] });
      core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [['B']] }, { id: 'p', t: 'p', c: [[`#beta${x}`]] }] });
    }, t);
    await openApp(page, server.url(`notes/#/tag/alpha${t}+beta${t}`));
    const empty = await page.evaluate(() => document.querySelector('#list .n-empty')?.innerText || '');
    assert.match(empty, /No note has all of these tags/);
    await page.clickText('button', /any of them/i);
    await sleep(400);
    assert.match(await page.evaluate(() => location.hash), /mode=any/);
  });

  test('search: New note “…” leaves out operators and excluded words; the palette has one entry for today', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/all'));
    await page.press('/');
    await page.type('QA -"Links zqx" tag:travel in:Work Plum');
    await sleep(500);
    assert.match(await page.evaluate(() => document.querySelector('[data-create-from-search]')?.textContent || ''), /New note “QA Plum”/);
    await page.press('Escape');
    await page.press('Control+k');
    await page.waitFor('.palette input, [role=dialog] input', 5000);
    await page.type('today');
    await sleep(400);
    const rows = await page.evaluate(() => [...document.querySelectorAll('.palette-list [role=option]')].map((o) => o.textContent.replace(/\s+/g, ' ').trim()));
    assert.equal(rows.filter((r) => /Today's note/.test(r)).length, 1, `"Today's note" is there: ${rows}`);
    assert.equal(rows.filter((r) => /Note for /.test(r)).length, 0, `and no second entry for the same day: ${rows}`);
    await page.press('Escape');
  });

  test('shortcut hints read Ctrl+Shift+X outside macOS (Apple order on a Mac)', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/all'));
    await page.evaluate(() => document.activeElement?.blur());
    await page.press('?');
    await page.waitFor('[role=dialog] .shortcuts', 5000);
    const row = await page.evaluate(() => [...document.querySelectorAll('.shortcut')].find((r) => r.textContent.startsWith('Strikethrough')).querySelector('.keys').textContent.replace(/\s+/g, ''));
    const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
    if (mac) assert.match(row, /Shift.*Command/i);
    else assert.match(row, /^Ctrl\+Shift\+X/, `Ctrl comes first: ${row}`);
    await page.press('Escape');
  });

  test('the folder dialog saves a folder that keeps its name beside a twin of the same name (one hidden from AI)', async () => {
    const { page, server } = ctx;
    const t = tag();
    await openApp(page, server.url('notes/#/all'));
    await inPage(
      page,
      ({ db }, _c, _m, x) => {
        db.insert('folders', { id: `fhid${x}`, name: `Therapy ${x}`, parentId: null, color: 'blue', order: 90, aiHidden: true });
        db.insert('folders', { id: `ftwin${x}`, name: `Therapy ${x}`, parentId: null, color: 'green', order: 91 });
      },
      t,
    );
    await sleep(400);
    for (const id of [`ftwin${t}`, `fhid${t}`]) {
      await rightClick(page, (x) => {
        const b = document.querySelector(`#nav a[data-folder="${x}"]`).getBoundingClientRect();
        return { x: b.x + 40, y: b.y + 10 };
      }, id);
      await page.clickText('menuitem', /^Rename/);
      await page.waitFor('[role=dialog] [data-color="teal"]', 5000);
      await page.click('[role=dialog] [data-color="teal"]');
      await page.clickText('button', 'Save', { exact: true });
      await sleep(400);
      const st = await page.evaluate(() => ({ open: !!document.querySelector('[role=dialog] [data-color]'), err: [...document.querySelectorAll('.n-err')].some((e) => !e.hidden && e.textContent.trim()) }));
      assert.deepEqual(st, { open: false, err: false }, `${id}: saved without "A folder with this name is already here"`);
      await server.waitForState((s) => s.data.folders.find((f) => f.id === id)?.color === 'teal', 10000, `${id} teal on the server`);
    }
  });

  test('New note is the suite’s create button', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/all'));
    const btn = await page.evaluate(() => {
      const b = document.querySelector('#sidebar [data-new-note]');
      return { cls: b.className, wrap: b.parentElement.className, text: b.textContent.trim() };
    });
    assert.deepEqual(btn, { cls: 'create-btn', wrap: 'create-wrap', text: 'New note' });
    await settle(page, 100);
    assert.deepEqual(page.consoleErrors(), []);
  });
});

describe('qa notes-app: phone', () => {
  const ctx = useE2E({ width: 390, height: 844, mobile: true, scheme: 'light' });

  test('the list bar is ⋯ only, with Done while selecting', async () => {
    const { page, server } = ctx;
    await openApp(page, server.url('notes/#/all'));
    const bar = () => page.evaluate(() => [...document.querySelectorAll('#listhead .n-lh-bar button')].filter((b) => b.offsetParent).map((b) => b.getAttribute('aria-label') || b.textContent.trim()));
    assert.deepEqual((await bar()).filter((x) => !/folders/i.test(x)), ['More']);
    await page.click('[data-list-menu]');
    await page.clickText('menuitem', 'Select notes');
    await sleep(300);
    assert.deepEqual((await bar()).filter((x) => !/folders/i.test(x)), ['Done', 'More']);
    await page.click('[data-select-mode]');
  });

  test('swipe: only the revealed side is drawn, and a tap on another row only puts the actions away', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-notes-app-swipe', async () => {
      await openApp(page, server.url('notes/#/all'));
      const ids = await page.evaluate(() => [...document.querySelectorAll('#list .nrow[data-id]')].slice(0, 2).map((r) => r.dataset.id));
      // A left swipe on the first row (touch pointer events, as a finger makes them).
      const st = await page.evaluate(async (id) => {
        const row = document.getElementById(`row-${id}`);
        const r = row.getBoundingClientRect();
        const y = r.y + r.height / 2;
        const fire = (type, x) => row.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        fire('pointerdown', r.right - 20);
        for (let x = r.right - 20; x > r.right - 140; x -= 10) fire('pointermove', x);
        const drawn = [...row.querySelectorAll('.n-swipebg button')].map((b) => b.dataset.swipeAct);
        fire('pointerup', r.right - 140);
        await new Promise((res) => setTimeout(res, 350));
        return { drawn, open: !!row._open };
      }, ids[0]);
      assert.deepEqual(st.drawn, ['move', 'delete'], 'only the left side’s actions (no Pin under the row)');
      assert.ok(st.open, 'the actions stay revealed');
      const before = await page.evaluate(() => location.hash);
      // A tap on the second row: down and up on it, then its click.
      await page.evaluate((id) => {
        const row = document.getElementById(`row-${id}`);
        const r = row.getBoundingClientRect();
        const opt = { pointerType: 'touch', pointerId: 8, isPrimary: true, clientX: r.x + 50, clientY: r.y + 20, bubbles: true, cancelable: true };
        row.dispatchEvent(new PointerEvent('pointerdown', opt));
        row.dispatchEvent(new PointerEvent('pointerup', opt));
        row.dispatchEvent(new MouseEvent('click', { clientX: opt.clientX, clientY: opt.clientY, bubbles: true, cancelable: true }));
      }, ids[1]);
      await sleep(500);
      assert.equal(await page.evaluate(() => location.hash), before, 'no note opened');
      assert.equal(await page.evaluate((id) => !!document.getElementById(`row-${id}`)._open, ids[0]), false, 'the actions were put away');
    });
  });
});
