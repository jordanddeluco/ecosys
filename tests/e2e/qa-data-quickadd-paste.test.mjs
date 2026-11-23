// QA (data, final pass), in the real apps:
//  - Pasting a wall of text into Schedule's Create card (its title field has no length limit) kept the
//    page frozen for seconds on every keystroke: the quick-add parser was quadratic on long runs of
//    tokens. It now reads about the first 2000 characters and keeps the rest in the title as typed.
//  - Working hours (settings scheduleWorkStart / scheduleWorkEnd, which the AI tools plan within) were
//    stored and synced whatever their value ('25:00', 'soon'). Now a page keeps only 'HH:MM', and so
//    does the server.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

async function shortcut(page, key) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.press(key);
}

/** Open Schedule's Create card and paste `text` into its title; resolves to how long the input event took (ms). */
async function pasteIntoCreate(page, text) {
  await shortcut(page, 'c');
  await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Title', 4000);
  return page.evaluate((text) => {
    const el = document.activeElement;
    const t0 = performance.now();
    el.value = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    return performance.now() - t0;
  }, text);
}

describe('qa data: long pastes in quick add, working hours settings', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let today;

  before(async () => {
    await openApp(ctx.page, ctx.server.url('schedule/'));
    today = await browserToday(ctx.page);
  });

  test('a long paste into the Create card is read in a moment, and the event is saved with its date', async () => {
    const page = ctx.page;
    await withScreenshot(page, 'qa-data-quickadd-paste', async () => {
      // 100,000 characters of a pasted list of days: this froze the card for about 3 s per keystroke
      const slowMs = await pasteIntoCreate(page, 'fri '.repeat(25000));
      assert.ok(slowMs < 1500, `the card took ${slowMs.toFixed(0)} ms to read 100,000 characters`);
      await page.press('Escape');
      await settle(page, 200);
      // a long paste that starts with a title and a date: the date is read, the text is kept
      const t = tag();
      const ms = await pasteIntoCreate(page, `Offsite ${t} tomorrow 9am-5pm ${'agenda notes '.repeat(4000)}`);
      assert.ok(ms < 1500, `the card took ${ms.toFixed(0)} ms`);
      await page.clickText('button', /^Save$/);
      const ev = await ctx.server.waitForState((s) => s.data.events.find((e) => e.title.startsWith(`Offsite ${t}`)), 10000, 'the pasted event on the server');
      const [y, m, d] = today.split('-').map(Number);
      const tom = new Date(y, m - 1, d + 1, 12);
      const tomorrow = `${tom.getFullYear()}-${String(tom.getMonth() + 1).padStart(2, '0')}-${String(tom.getDate()).padStart(2, '0')}`;
      assert.equal(ev.start, `${tomorrow}T09:00`);
      assert.equal(ev.end, `${tomorrow}T17:00`);
      assert.ok(ev.title.length <= 500 && ev.title.startsWith(`Offsite ${t} agenda notes agenda notes`), ev.title.slice(0, 60));
    });
  });

  test('working hours keep only a time of day, in the page and on the server', async () => {
    const page = ctx.page;
    const kept = await page.evaluate(async () => {
      const { settings } = await import('/shared/store.js');
      settings.set({ scheduleWorkStart: '07:00', scheduleWorkEnd: '25:00' });
      const s = settings.get();
      return { start: s.scheduleWorkStart ?? null, end: s.scheduleWorkEnd ?? null };
    });
    assert.deepEqual(kept, { start: '07:00', end: null }, 'the page keeps 07:00 and ignores 25:00');
    const st = await ctx.server.waitForState((s) => s.settings?.scheduleWorkStart === '07:00' && s, 10000, 'the working hours on the server');
    assert.ok(!Object.hasOwn(st.settings, 'scheduleWorkEnd'), `the server has no end (got ${st.settings.scheduleWorkEnd})`);
    await page.evaluate(async () => {
      const { settings } = await import('/shared/store.js');
      settings.set({ scheduleWorkEnd: '15:30' });
    });
    await ctx.server.waitForState((s) => s.settings?.scheduleWorkEnd === '15:30', 10000, 'the valid end on the server');
  });
});
