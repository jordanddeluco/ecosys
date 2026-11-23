// QA regression (design system, shared/ui.css), the pickers in a real browser. On a phone, the time sheet opened from
// the date sheet's Time row brings a scrim that covers and dims the date sheet beneath it in Light, Dim and Lights out:
// a tap on that sheet's visible top (its Tomorrow row) closes the pickers and leaves the task's date alone, and a time
// picked in the top sheet still saves. On a desktop the date picker shows all of itself, a six-week month with Time and
// No date included, and in a short window it stays on screen and scrolls. In a menu hint a punctuation key keeps its
// keycap only as the whole shortcut: inside a chord (Notes' Focus mode, Ctrl + Shift + \) it is plain text.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THEMES = ['light', 'dim', 'dark'];

async function setLook(page, theme, accent = 'iris') {
  await page.evaluate(async (theme, accent) => (await import('/shared/store.js')).settings.set({ theme, accent }), theme, accent);
  await page.waitFor((theme, accent) => document.documentElement.dataset.theme === theme && document.documentElement.dataset.accent === accent, { args: [theme, accent], timeout: 5000 });
  await settle(page, 150);
}

/** A touch tap at a point (it lands wherever hit-testing puts it, as a finger's does). */
async function tapAt(page, x, y) {
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await sleep(40);
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
/** A touch tap on the middle of the first visible element matching `sel`. */
async function tap(page, sel) {
  const p = await page.evaluate((sel) => {
    const e = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length);
    if (!e) return null;
    e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);
  assert.ok(p, `${sel} is on screen`);
  await tapAt(page, p.x, p.y);
}
/** Let the page's animations (a sheet sliding up) finish. */
const still = (page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})))).catch(() => {});

/** A task due today, opened in its details (a sheet on a phone, the side pane on a desktop). Returns its id. */
async function openTask(page, server, fields) {
  await openApp(page, server.url(`tasks/?fresh=${Date.now()}#/today`));
  const id = await page.evaluate(async (fields) => {
    const { createTask } = await import('/shared/model.js');
    const { todayYmd } = await import('/shared/dates.js');
    return createTask({ date: todayYmd(), ...fields }).id;
  }, fields);
  await page.evaluate((id) => (location.hash = `#/task/${id}`), id);
  await page.waitFor(() => !!document.querySelector('#inspector [data-dp="date"]')?.offsetParent, { timeout: 5000, message: "the task's details" });
  await settle(page, 400);
  return id;
}
const taskField = (page, id, key) => page.evaluate(async (id, key) => (await import('/shared/store.js')).db.get('tasks', id)?.[key] ?? null, id, key);

describe('qa design system: pickers', () => {
  const ctx = useE2E({ width: 390, height: 844, mobile: true, scheme: 'light' });

  test('phone: the time sheet dims the date sheet under it, and a tap on that sheet picks nothing', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-stacked-sheets', async () => {
      const id = await openTask(page, server, { title: 'Stacked sheets' });
      const today = await page.evaluate(async () => (await import('/shared/dates.js')).todayYmd());
      for (const theme of THEMES) {
        await setLook(page, theme);
        await tap(page, '#inspector [data-dp="date"]');
        await page.waitFor('.menu.dp-pop.as-sheet [data-dp="time"]', { timeout: 3000, message: 'the date sheet with its Time row' });
        await still(page);
        await tap(page, '.menu.dp-pop [data-dp="time"]');
        await page.waitFor(() => document.querySelectorAll('.pop-scrim').length === 2 && !!document.querySelector('.menu.tp-pop.as-sheet'), { timeout: 3000, message: 'the time sheet over the date sheet, each with its scrim' });
        await still(page);
        const s = await page.evaluate(() => {
          const z = (e) => +getComputedStyle(e).zIndex;
          const [dateScrim, timeScrim] = document.querySelectorAll('.pop-scrim');
          const date = document.querySelector('.menu.dp-pop');
          const time = document.querySelector('.menu.tp-pop');
          const row = date.querySelector('[data-dp="tomorrow"]').getBoundingClientRect();
          const x = row.x + row.width / 2;
          const y = row.y + row.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { z: [z(dateScrim), z(date), z(timeScrim), z(time)], shows: row.bottom <= time.getBoundingClientRect().top, hit: String(hit?.className || hit?.tagName), x, y };
        });
        assert.ok(s.shows, `${theme}: the date sheet's Tomorrow row shows above the time sheet`);
        assert.ok(s.z[0] < s.z[1] && s.z[1] < s.z[2] && s.z[2] < s.z[3], `${theme}: scrim, date sheet, scrim, time sheet, bottom to top (z ${s.z.join(', ')})`);
        assert.match(s.hit, /\bpop-scrim\b/, `${theme}: the time sheet's scrim covers the date sheet's visible rows (hit: ${s.hit})`);
        await tapAt(page, s.x, s.y);
        await page.waitFor(() => !document.querySelector('.dp-pop, .tp-pop'), { timeout: 3000, message: 'a tap on the dimmed date sheet to close the pickers' });
        await page.waitFor(() => !document.querySelector('.pop-scrim'), { timeout: 3000, message: 'the scrims to go' });
        await sleep(250);
        assert.equal(await taskField(page, id, 'date'), today, `${theme}: the tap on Tomorrow's row picked nothing; the task is still due today`);
      }
      // A time picked in the top sheet still saves (and the date with it).
      await tap(page, '#inspector [data-dp="date"]');
      await page.waitFor('.menu.dp-pop.as-sheet [data-dp="time"]', 3000);
      await still(page);
      await tap(page, '.menu.dp-pop [data-dp="time"]');
      await page.waitFor('.menu.tp-pop [data-t="10:00"]', 3000);
      await still(page);
      await tap(page, '.menu.tp-pop [data-t="10:00"]');
      await page.waitFor(async (id) => (await import('/shared/store.js')).db.get('tasks', id)?.time === '10:00', { args: [id], timeout: 3000, message: 'the picked time (10am) to be saved' });
      assert.equal(await taskField(page, id, 'date'), today);
      await page.waitFor(() => !document.querySelector('.dp-pop, .tp-pop, .pop-scrim'), { timeout: 3000, message: 'both sheets and scrims to go' });
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('desktop: the date picker shows all of itself, and a short window keeps it on screen, scrolling', async () => {
    const { page, server } = ctx;
    await page.setViewport(1440, 900, false);
    await withScreenshot(page, 'qa-ds-date-picker-height', async () => {
      await openTask(page, server, { title: 'Tall date picker', time: '09:00' });
      await setLook(page, 'light');
      const measure = () =>
        page.evaluate(() => {
          const m = document.querySelector('.menu.dp-pop');
          const r = m.getBoundingClientRect();
          const last = [...m.querySelectorAll('.menu-item')].pop().getBoundingClientRect();
          return { month: m.querySelector('.mc-head strong')?.textContent, weeks: m.querySelectorAll('.mc-row').length, scrollH: m.scrollHeight, clientH: m.clientHeight, top: r.top, bottom: r.bottom, last: last.bottom, vh: innerHeight };
        });
      await page.click('#inspector [data-dp="date"]');
      await page.waitFor('.menu.dp-pop [data-dp="clear"]', { timeout: 3000, message: 'the date picker with Time and No date' });
      let m = await measure();
      assert.ok(m.scrollH <= m.clientH, `all of it shows: ${m.scrollH}px of picker in ${m.clientH}px (${m.month})`);
      assert.ok(m.last <= m.bottom, 'No date, the last row, is in view');
      // The tallest picker: a six-week month.
      for (let i = 0; i < 12 && m.weeks < 6; i++) {
        await page.click('.menu.dp-pop [data-mc="next"]');
        await settle(page, 120);
        m = await measure();
      }
      assert.equal(m.weeks, 6, 'found a six-week month');
      assert.ok(m.scrollH <= m.clientH && m.clientH > 520, `a six-week month shows whole, past a menu's 520px: ${m.scrollH}px in ${m.clientH}px (${m.month})`);
      assert.ok(m.top >= 8 && m.bottom <= m.vh - 8, `and on screen (${Math.round(m.top)}-${Math.round(m.bottom)} of ${m.vh})`);
      await page.press('Escape');
      await page.waitFor(() => !document.querySelector('.dp-pop'), 3000);
      // A window too short for it: on screen, scrolling inside.
      await page.setViewport(1280, 480, false);
      await settle(page, 300);
      await page.click('#inspector [data-dp="date"]');
      await page.waitFor('.menu.dp-pop', 3000);
      await settle(page, 250);
      m = await measure();
      assert.ok(m.top >= 8 && m.bottom <= m.vh - 8, `in a 480px window it stays on screen (${Math.round(m.top)}-${Math.round(m.bottom)})`);
      assert.ok(m.scrollH > m.clientH, `and scrolls inside (${m.scrollH}px in ${m.clientH}px)`);
      await page.press('Escape');
      await page.setViewport(1440, 900, false);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('desktop: a punctuation key has a keycap only as the whole shortcut, never inside a chord', async () => {
    const { page, server } = ctx;
    await page.setViewport(1440, 900, false);
    await withScreenshot(page, 'qa-ds-chord-keycaps', async () => {
      await openApp(page, server.url('tasks/#/today'));
      for (const theme of ['light', 'dark']) {
        await setLook(page, theme);
        const r = await page.evaluate(async () => {
          const s = await import('/shared/shell.js');
          const a = document.createElement('button');
          a.id = 'qa-chord-anchor';
          a.textContent = 'menu';
          a.style.cssText = 'position:fixed;left:400px;top:200px;z-index:50';
          document.body.append(a);
          const h = s.openMenu(a, [
            { label: 'Focus mode', keys: 'mod shift \\', onSelect() {} },
            { label: 'Settings', keys: 'comma', onSelect() {} },
            { label: 'Find in note', keys: 'mod F', onSelect() {} },
          ]);
          await Promise.all(h.el.getAnimations().map((x) => x.finished.catch(() => {}))); // past the pop-in's scale
          const row = (label) => [...h.el.querySelectorAll('.menu-item')].find((b) => b.querySelector('.grow')?.textContent === label);
          const look = (k) => {
            const cs = getComputedStyle(k);
            const b = k.getBoundingClientRect();
            return { text: k.textContent, punct: k.classList.contains('kbd-punct'), bg: cs.backgroundColor, color: cs.color, h: Math.round(b.height), w: Math.round(b.width) };
          };
          const out = { chord: [...row('Focus mode').querySelectorAll('.hint .kbd')].map(look), comma: look(row('Settings').querySelector('.hint .kbd')), find: [...row('Find in note').querySelectorAll('.hint .kbd')].map(look) };
          h.close();
          a.remove();
          return out;
        });
        const clear = /rgba\(0, 0, 0, 0\)|transparent/;
        const back = r.chord.at(-1);
        assert.equal(back.text, '\\', `${theme}: Focus mode ends in the backslash key`);
        assert.ok(back.punct, 'which keycap() marks as punctuation');
        assert.match(back.bg, clear, `${theme}: inside a chord it has no keycap fill (${back.bg})`);
        assert.ok(back.h < 18, `${theme}: nor a keycap's height (${back.h}px), like Ctrl and Shift beside it`);
        assert.equal(back.color, r.chord[0].color, `${theme}: in the hint's colour, as Ctrl is`);
        for (const k of r.find) assert.match(k.bg, clear, `${theme}: Ctrl+F stays plain text`);
        assert.ok(r.comma.punct && r.comma.h >= 18 && r.comma.w >= 18, `${theme}: a lone ',' keeps its cap (${JSON.stringify(r.comma)})`);
        assert.doesNotMatch(r.comma.bg, clear, `${theme}: with the keycap fill`);
      }
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
