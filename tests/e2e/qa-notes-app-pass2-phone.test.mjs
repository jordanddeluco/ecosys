// notes-app, second pass, phone (390 wide, touch input from CDP touch events, against an isolated server):
//   swipe actions   while a row's actions show, a tap anywhere outside the list only puts them away (as on
//                   iOS): ⋯ opens no menu and the search field takes no focus; the next tap acts as usual
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp as openAppHash, withScreenshot } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function openApp(page, url, opts) {
  await page.goto('about:blank');
  return openAppHash(page, url, opts);
}

describe('qa notes-app: second pass, phone', () => {
  const ctx = useE2E({ width: 390, height: 844, mobile: true, scheme: 'light' });

  const tap = async (page, p) => {
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
  };
  /** The centre of the first visible element matching `sel` that a tap there would reach. */
  const centre = (page, sel) =>
    page.evaluate((s) => {
      const el = [...document.querySelectorAll(s)].find((x) => {
        const r = x.getBoundingClientRect();
        return r.width && r.height && r.x >= 0 && r.x < innerWidth && r.y >= 0 && r.y < innerHeight;
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const p = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      return { ...p, hit: document.elementFromPoint(p.x, p.y)?.closest(s) === el };
    }, sel);
  const swipeLeft = async (page, id) => {
    const r = await page.evaluate((x) => {
      const b = document.getElementById(`row-${x}`).getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }, id);
    const y = r.y + r.h / 2;
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x + r.w - 30, y }] });
    for (let x = r.x + r.w - 30; x >= r.x + r.w - 190; x -= 16) {
      await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await sleep(16);
    }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    return page.evaluate((x) => document.getElementById(`row-${x}`)._open || 0, id);
  };
  const state = (page, id) =>
    page.evaluate((x) => ({ menu: !!document.querySelector('[role=menu]'), open: document.getElementById(`row-${x}`)?._open || 0, focus: document.activeElement?.id || document.activeElement?.tagName, hash: location.hash }), id);

  test('with swipe actions showing, a tap on ⋯ or the search field only puts them away; the next tap acts', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-notes-app-swipe-outside', async () => {
      for (const sel of ['#listhead [data-list-menu]', '#q']) {
        await openApp(page, server.url('notes/#/all'), { settleMs: 400 });
        const id = await page.evaluate(() => document.querySelectorAll('#list .nrow[data-id]')[1].dataset.id);
        const shown = await swipeLeft(page, id);
        assert.ok(shown < 0, `the row's actions show (${shown})`);
        const p = await centre(page, sel);
        assert.ok(p?.hit, `${sel} can be tapped`);
        await tap(page, p);
        const s1 = await state(page, id);
        assert.equal(s1.open, 0, `${sel}: the tap put the actions away`);
        assert.equal(s1.menu, false, `${sel}: and opened no menu`);
        assert.notEqual(s1.focus, 'q', `${sel}: and gave the search field no focus`);
        assert.equal(s1.hash, '#/all', `${sel}: and went nowhere`);
        await tap(page, p);
        const s2 = await state(page, id);
        if (sel === '#q') assert.equal(s2.focus, 'q', 'the next tap on the search field focuses it');
        else assert.equal(s2.menu, true, 'the next tap on ⋯ opens its menu');
        await page.press('Escape');
        await sleep(200);
      }
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
