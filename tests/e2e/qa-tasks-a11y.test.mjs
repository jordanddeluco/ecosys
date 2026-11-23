// QA regression (tasks): keyboard and screen-reader details, and colours in Light, Dim and Lights out.
//   reorder   Alt+Down / Alt+Up move the selected task and say where it went ("Moved to position 2 of 3")
//   pane      a task opened from search (Ctrl+K) or a #/task link while keyboard focus sits on another row
//             opens that task's details: focus given back to the old row after the rebuild doesn't select it
//             (moving to a row yourself still does, and open details follow it)
//   colours   the unset Important star 3:1+ and the set one 3:1+; the + fills under their glyph (Add task,
//             Upcoming's per-day Add task, Suggestions) 3:1+; past events keep their text 4.5:1+ (no opacity);
//             the details pane's text fields show a 2px ring 3:1+ on their card, drawn where the card doesn't
//             clip it (the note fills its card)
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot, tag } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const go = async (page, hash) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await settle(page, 300);
};
const addTask = (page, fields) =>
  page.evaluate(async (f) => {
    const { createTask } = await import('/shared/model.js');
    const { todayYmd } = await import('/shared/dates.js');
    return createTask({ ...f, date: f.today ? todayYmd() : null }).id;
  }, fields);
const paneTitle = (page) => page.evaluate(() => (document.querySelector('#inspector').hidden ? null : document.querySelector('#inspector textarea[data-f="title"]')?.value ?? null));
/** Keyboard focus (:focus-visible) on a row's circle: focus it, then Shift+Tab and Tab back as a person would. */
const keyboardFocusRow = async (page, id) => {
  await page.evaluate((id) => document.querySelector(`.task[data-id="${id}"] [data-check]`).focus(), id);
  await page.press('Shift+Tab');
  await page.press('Tab');
  const ok = await page.evaluate((id) => document.activeElement?.closest('.task')?.dataset.id === id && document.activeElement.matches(':focus-visible'), id);
  assert.ok(ok, 'keyboard focus is on the row');
};
const mouseTo = (page, x, y) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const center = (page, sel) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);
/** In the page: contrast of two CSS colours (any syntax, read back through a canvas pixel). */
const CONTRAST = `(() => {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d', { willReadFrequently: true });
  const rgb = (s) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = s; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); };
  const lum = (x) => { const [r, gg, b] = x.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * gg + 0.0722 * b; };
  return (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return +((x + 0.05) / (y + 0.05)).toFixed(2); };
})()`;
const contrast = (page, a, b) => page.evaluate((src, a, b) => (0, eval)(src)(a, b), CONTRAST, a, b);

describe('qa tasks: announcements, the details pane and colours', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let page;
  const k = tag();

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('tasks/'));
  });

  test('Alt+Down / Alt+Up move the task and say where it went', async () => {
    await withScreenshot(page, 'qa-tasks-a11y-reorder', async () => {
      const list = await page.evaluate(async (k) => (await import('/shared/model.js')).createList({ name: `Moves ${k}` }).id, k);
      const ids = [];
      for (const n of ['One', 'Two', 'Three']) ids.push(await page.evaluate(async ([title, listId]) => (await import('/shared/model.js')).createTask({ title, listId }).id, [`${n} ${k}`, list]));
      await go(page, `#/list/${list}`);
      await keyboardFocusRow(page, ids[0]);
      const order = () => page.evaluate(() => [...document.querySelectorAll('.task-list .task[data-id]')].map((r) => r.dataset.id));
      const said = () => page.evaluate(() => document.querySelector('[data-announcer]')?.textContent || '');
      await page.press('Alt+ArrowDown');
      await page.waitFor(() => document.querySelector('[data-announcer]')?.textContent === 'Moved to position 2 of 3', { timeout: 3000, message: 'the move to be announced' });
      assert.deepEqual(await order(), [ids[1], ids[0], ids[2]]);
      assert.equal(await page.evaluate(() => document.activeElement?.closest('.task')?.dataset.id), ids[0], 'focus stays on the moved task');
      await page.press('Alt+ArrowDown');
      await page.waitFor(() => document.querySelector('[data-announcer]')?.textContent === 'Moved to position 3 of 3', { timeout: 3000, message: 'the second move to be announced' });
      await page.press('Alt+ArrowUp');
      await page.waitFor(() => document.querySelector('[data-announcer]')?.textContent === 'Moved to position 2 of 3', { timeout: 3000, message: 'the move up to be announced' });
      assert.deepEqual(await order(), [ids[1], ids[0], ids[2]]);
      assert.match(await said(), /^Moved to position \d of 3$/);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('a task opened from search or a link keeps its details while focus sat on another row', async () => {
    await withScreenshot(page, 'qa-tasks-a11y-pane', async () => {
      const a = await addTask(page, { title: `Alpha ${k}`, today: true });
      const b = await addTask(page, { title: `Bravo ${k}`, today: true });
      const c = await addTask(page, { title: `Charlie ${k}`, today: true });
      await go(page, '#/today');
      await keyboardFocusRow(page, a);
      await page.press('Control+k');
      await page.waitFor(() => document.activeElement?.matches('input'), { timeout: 3000, message: 'the search field' });
      await page.type(`Bravo ${k}`);
      await sleep(250);
      await page.press('Enter');
      await page.waitFor((t) => document.querySelector('#inspector textarea[data-f="title"]')?.value === t, { timeout: 3000, args: [`Bravo ${k}`], message: "Bravo's details" });
      await sleep(300); // past the rebuild that gives focus back to Alpha's row
      assert.equal(await paneTitle(page), `Bravo ${k}`, 'search opened Bravo, not the focused Alpha');
      await page.press('Escape');
      await sleep(200);
      await keyboardFocusRow(page, a);
      await go(page, `#/task/${c}`);
      await sleep(300);
      assert.equal(await paneTitle(page), `Charlie ${k}`, 'a #/task link opens its own task');
      await page.press('Escape');
      await sleep(200);
      // Moving to another row yourself still selects it, and the open details follow it.
      await keyboardFocusRow(page, b);
      await page.press('Enter');
      await page.waitFor((t) => document.querySelector('#inspector textarea[data-f="title"]')?.value === t, { timeout: 3000, args: [`Bravo ${k}`], message: "Enter to open Bravo's details" });
      await keyboardFocusRow(page, c);
      await page.waitFor((t) => document.querySelector('#inspector textarea[data-f="title"]')?.value === t, { timeout: 3000, args: [`Charlie ${k}`], message: 'the details to follow the row focus moved to' });
      await page.press('Escape');
      await sleep(200);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('colours: stars, + fills, past events and the details pane rings, in Light, Dim and Lights out', async () => {
    await withScreenshot(page, 'qa-tasks-a11y-colours', async () => {
      const ids = await page.evaluate(async (k) => {
        const { createTask, createEvent } = await import('/shared/model.js');
        const { todayYmd } = await import('/shared/dates.js');
        const t = todayYmd();
        createEvent({ title: `Early ${k}`, date: t, time: '00:00', duration: 1 });
        return {
          off: createTask({ title: `Plain ${k}`, date: t }).id,
          on: createTask({ title: `Starred ${k}`, date: t, priority: 3 }).id,
          later: createTask({ title: `Later ${k}`, date: null }).id,
          pane: createTask({ title: `Pane ${k}`, date: t, notes: 'A note', checklist: [{ id: `s${k}`, title: 'A step', done: false }] }).id,
        };
      }, k);
      for (const theme of ['light', 'dim', 'dark']) {
        await page.evaluate(async (theme) => (await import('/shared/store.js')).settings.set({ theme, accent: 'iris', showEventsInToday: true }), theme);
        await go(page, '#/today');
        // What the rows sit on: the first opaque background up from the list.
        const bg = await page.evaluate(() => {
          for (let el = document.querySelector('#view-body'); el; el = el.parentElement) {
            const c = getComputedStyle(el).backgroundColor;
            if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
          }
          return getComputedStyle(document.documentElement).backgroundColor;
        });
        // Stars: unset (shown on hover) and set.
        const star = await page.evaluate((ids) => ['off', 'on'].map((x) => getComputedStyle(document.querySelector(`.task[data-id="${ids[x]}"] .star`)).color), ids);
        assert.ok((await contrast(page, star[0], bg)) >= 3, `${theme}: the unset star is 3:1+ (${star[0]} on ${bg})`);
        assert.ok((await contrast(page, star[1], bg)) >= 3, `${theme}: the set star is 3:1+ (${star[1]} on ${bg})`);
        // Past events: full opacity, text 4.5:1+ (made past by hand if the test runs in the first minute of the day).
        const past = await page.evaluate((k) => {
          const row = [...document.querySelectorAll('.event-row')].find((r) => r.textContent.includes(`Early ${k}`));
          row.classList.add('past');
          return { opacity: getComputedStyle(row).opacity, colors: ['.when', '.what'].map((s) => getComputedStyle(row.querySelector(s)).color) };
        }, k);
        assert.equal(past.opacity, '1', `${theme}: a past event isn't dimmed by opacity`);
        for (const c of past.colors) assert.ok((await contrast(page, c, bg)) >= 4.5, `${theme}: past event text is 4.5:1+ (${c} on ${bg})`);
        // The + fills under their glyph, hovered: Add task, then Suggestions' add.
        const p = await center(page, '#composer-slot .add-row');
        await mouseTo(page, p.x, p.y);
        await sleep(250);
        const plus = await page.evaluate(() => {
          const cs = getComputedStyle(document.querySelector('#composer-slot .add-row .plus'));
          return [cs.color, cs.backgroundColor];
        });
        assert.ok((await contrast(page, plus[0], plus[1])) >= 3, `${theme}: Add task's + on its fill (${plus.join(' on ')})`);
        await mouseTo(page, 5, 890);
        await page.click('[data-suggestions]');
        await page.waitFor('.sugg-row .add', 3000);
        const s = await center(page, '.sugg-row .add');
        await mouseTo(page, s.x, s.y);
        await sleep(250);
        const add = await page.evaluate(() => {
          const cs = getComputedStyle(document.querySelector('.sugg-row .add:hover'));
          return [cs.color, cs.backgroundColor];
        });
        assert.ok((await contrast(page, add[0], add[1])) >= 3, `${theme}: Suggestions' + on its fill (${add.join(' on ')})`);
        await page.press('Escape');
        await mouseTo(page, 5, 890);
        // Upcoming's per-day Add task.
        await go(page, '#/upcoming');
        const u = await center(page, '.add-row.inline');
        await mouseTo(page, u.x, u.y);
        await sleep(250);
        const inline = await page.evaluate(() => {
          const cs = getComputedStyle(document.querySelector('.add-row.inline:hover .plus'));
          return [cs.color, cs.backgroundColor];
        });
        assert.ok((await contrast(page, inline[0], inline[1])) >= 3, `${theme}: Upcoming's + on its fill (${inline.join(' on ')})`);
        await mouseTo(page, 5, 890);
        // The details pane's text fields: a ring 3:1+ on the card, inside the card's clip.
        await go(page, `#/task/${ids.pane}`);
        for (const sel of ['textarea[data-f="title"]', '[data-step-title]', '[data-tag-new]', 'textarea[data-f="notes"]']) {
          const r = await page.evaluate((sel) => {
            const el = document.querySelector(`#inspector ${sel}`);
            el.focus();
            const cs = getComputedStyle(el);
            const card = el.closest('.dp-card');
            const e = el.getBoundingClientRect();
            const b = card.getBoundingClientRect();
            const o = parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth);
            return {
              style: cs.outlineStyle,
              width: cs.outlineWidth,
              color: cs.outlineColor,
              card: getComputedStyle(card).backgroundColor,
              inside: e.left - o >= b.left - 0.5 && e.right + o <= b.right + 0.5 && e.top - o >= b.top - 0.5 && e.bottom + o <= b.bottom + 0.5,
            };
          }, sel);
          assert.deepEqual([r.style, r.width], ['solid', '2px'], `${theme}: ${sel} shows a focus ring`);
          assert.ok(r.inside, `${theme}: ${sel}'s ring isn't clipped by its card`);
          assert.ok((await contrast(page, r.color, r.card)) >= 3, `${theme}: ${sel}'s ring is 3:1+ (${r.color} on ${r.card})`);
        }
        await page.evaluate(() => document.activeElement?.blur());
        await page.press('Escape');
        await sleep(150);
      }
      await page.evaluate(async () => (await import('/shared/store.js')).settings.set({ theme: 'light' }));
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
