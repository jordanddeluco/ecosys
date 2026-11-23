// QA (data, second pass), in Schedule's Create card, whose title field has no length limit:
//  - A long paste with "at <place>" was saved with the end of the paste in its title ("Offsite …
//    quarter, agenda notes …"): the place stopped at the parser's 2000-character limit and the rest
//    went to the title. The place now takes the rest; the title is what came before the place.
//  - The last word read before the limit was taken as the end of the input ("… evening news" was
//    18:00), and a pasted run of dashes or commas froze the card for seconds per keystroke.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, browserToday, withScreenshot, tag } from './helpers.mjs';

async function openCreate(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.press('c');
  await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Title', 4000);
}

/** Paste `text` into the focused title field; resolves to how long the input event and the next keystroke took (ms). */
function paste(page, text) {
  return page.evaluate((text) => {
    const el = document.activeElement;
    let t0 = performance.now();
    el.value = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    void document.body.offsetHeight;
    const pasteMs = performance.now() - t0;
    t0 = performance.now();
    el.value += 'x';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
    void document.body.offsetHeight;
    return { pasteMs, keyMs: performance.now() - t0 };
  }, text);
}

async function closeCreate(page) {
  await page.press('Escape');
  await settle(page, 200);
  if (await page.evaluate(() => !!document.querySelector('[data-where]'))) {
    await page.press('Escape'); // a "discard?" step, if the card asks
    await settle(page, 200);
  }
}

describe('qa data: the end of a long paste in the Create card', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let today;

  before(async () => {
    await openApp(ctx.page, ctx.server.url('schedule/'));
    today = await browserToday(ctx.page);
  });

  test('a pasted paragraph after "at" is the place: the event keeps its title', async () => {
    const page = ctx.page;
    await withScreenshot(page, 'qa-data-quickadd-cut-place', async () => {
      const t = tag();
      await openCreate(page);
      const text = `Offsite ${t} tomorrow 9am-5pm at Lakeside Lodge ${'agenda notes and goals for the quarter, '.repeat(2500)}`;
      await page.evaluate((text) => {
        const el = document.activeElement;
        el.value = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      }, text);
      await settle(page, 200);
      const card = await page.evaluate(() => {
        const marks = [...document.querySelectorAll('.qc-mirror mark')];
        return { where: document.querySelector('[data-where] .qc-val')?.textContent || '', lastMark: marks.at(-1)?.textContent || '' };
      });
      assert.ok(card.where.startsWith('Lakeside Lodge agenda notes') && card.where.endsWith('goals for the quarter'), `the place line: ${card.where.slice(0, 40)}…${card.where.slice(-30)}`);
      assert.ok(card.lastMark.startsWith('at Lakeside Lodge') && card.lastMark.endsWith('for the quarter,'), 'the whole place is highlighted in the title field, to the end of the paste');
      await page.clickText('button', /^Save$/);
      const ev = await ctx.server.waitForState((s) => s.data.events.find((e) => e.title.startsWith(`Offsite ${t}`)), 10000, 'the pasted event on the server');
      const [y, m, d] = today.split('-').map(Number);
      const tom = new Date(y, m - 1, d + 1, 12);
      const tomorrow = `${tom.getFullYear()}-${String(tom.getMonth() + 1).padStart(2, '0')}-${String(tom.getDate()).padStart(2, '0')}`;
      assert.equal(ev.title, `Offsite ${t}`);
      assert.deepEqual([ev.start, ev.end], [`${tomorrow}T09:00`, `${tomorrow}T17:00`]);
      assert.ok(ev.location.startsWith('Lakeside Lodge agenda notes and goals') && ev.location.length <= 500, `${ev.location.length} characters: ${ev.location.slice(0, 40)}`);
    });
  });

  test('the last word read is not the end of the paste, and runs of dashes or commas are read in a moment', async () => {
    const page = ctx.page;
    await openCreate(page);
    await paste(page, `${'e '.repeat(996)}${'evening news was long and dull '.repeat(10)}`);
    await settle(page, 100);
    const marks = await page.evaluate(() => [...document.querySelectorAll('.qc-mirror mark')].map((m) => m.textContent));
    assert.deepEqual(marks, [], '"evening" in "evening news" is not a time');
    await closeCreate(page);
    // these took 1.7 to 6.6 s on paste and again on the next keystroke
    for (const text of [`Notes ${'-'.repeat(100000)} end`, `Lunch ${', '.repeat(50000)}end`]) {
      await openCreate(page);
      const { pasteMs, keyMs } = await paste(page, text);
      assert.ok(pasteMs < 1500 && keyMs < 1500, `${JSON.stringify(text.slice(0, 10))}…: paste ${pasteMs.toFixed(0)} ms, next keystroke ${keyMs.toFixed(0)} ms`);
      await closeCreate(page);
    }
  });
});
