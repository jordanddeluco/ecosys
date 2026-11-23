// QA regression (tasks): the quick-add composer, with real typing.
//   #/@ list    while the completions are open, what they would cut through (description, chips, buttons)
//               is hidden; Enter takes the highlighted name ("#Wo" → "#Work ")
//   Esc         puts the composer away and focus goes back to "Add task" (the day's one in Upcoming)
//   label page  the label the page adds shows as a chip and can be taken off before adding
//   phone       a long name wraps onto more lines (never scrolls sideways); Esc gives focus to the + button
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot, tag } from './helpers.mjs';

const go = async (page, hash) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await settle(page, 300);
};
const openComposer = async (page) => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.press('q');
  await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', { timeout: 3000, message: 'the composer to open' });
};

describe('qa tasks: quick-add composer', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });
  let page;
  const k = tag();

  before(async () => {
    page = ctx.page;
    await openApp(page, ctx.server.url('tasks/'));
    await page.evaluate(async (k) => {
      const { createTask, createList } = await import('/shared/model.js');
      createList({ name: 'Workshop' });
      if (!(await import('/shared/store.js')).db.all('lists').some((l) => l.name === 'Work')) createList({ name: 'Work' });
      createTask({ title: `Labelled ${k}`, tags: [`lbl${k}`] });
    }, k);
    await go(page, '#/today');
  });

  test('#/@ completions hide what they would cut through; Enter completes the word', async () => {
    await withScreenshot(page, 'qa-tasks-composer-hash', async () => {
      await openComposer(page);
      await page.type('Ping the team #Wo');
      await page.waitFor(() => document.querySelector('.qa-field [aria-expanded="true"]'), { timeout: 3000, message: 'the #list completions' });
      const hidden = await page.evaluate(() => ['.cb-notes', '.cb-chips', '.cb-foot'].map((s) => getComputedStyle(document.querySelector(`.composer-box ${s}`)).visibility));
      assert.deepEqual(hidden, ['hidden', 'hidden', 'hidden']);
      await page.press('Enter');
      await page.waitFor(() => document.querySelector('.qa-field textarea').value === 'Ping the team #Work ', { timeout: 3000, message: '"#Wo" completed to "#Work "' });
      const shown = await page.evaluate(() => ['.cb-notes', '.cb-chips', '.cb-foot'].map((s) => getComputedStyle(document.querySelector(`.composer-box ${s}`)).visibility));
      assert.deepEqual(shown, ['visible', 'visible', 'visible']);
    });
  });

  test('Esc puts the composer away and focus goes back to "Add task"', async () => {
    await withScreenshot(page, 'qa-tasks-composer-esc', async () => {
      await page.press('Escape');
      await page.waitFor(() => document.querySelector('.composer-box').hidden, 3000);
      const f = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.innerText?.trim() }));
      assert.deepEqual(f, { tag: 'BUTTON', text: 'Add task' });
      // Upcoming: a day's composer gives focus back to that day's "Add task".
      await go(page, '#/upcoming');
      const day = await page.evaluate(() => document.querySelectorAll('[data-add-on]')[2].dataset.addOn);
      await page.click((d) => document.querySelector(`[data-add-on="${d}"]`), { args: [day] });
      await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', 3000);
      await page.press('Escape');
      await page.waitFor((d) => document.activeElement?.dataset.addOn === d, { timeout: 3000, args: [day], message: "focus on the day's Add task" });
      // Every day of Upcoming shows its "Add task" (no invisible rows leaving gaps).
      const op = await page.evaluate(() => [...document.querySelectorAll('.add-row.inline')].map((b) => getComputedStyle(b).opacity));
      assert.ok(op.length >= 7 && op.every((o) => o === '1'), `every day's Add task is visible (${op.join(',')})`);
    });
  });

  test("a label's page shows its label as a chip, which can be taken off", async () => {
    await withScreenshot(page, 'qa-tasks-composer-label', async () => {
      await go(page, `#/tag/lbl${k}`);
      await openComposer(page);
      const title = `From label page ${k}`;
      await page.type(title);
      const chips = await page.evaluate(() => [...document.querySelectorAll('.cb-chips > *')].map((c) => c.innerText.trim()));
      assert.ok(chips.includes(`lbl${k}`), `the label shows (${chips.join(', ')})`);
      await page.click(`[data-cc-untag="lbl${k}"]`);
      await page.waitFor((k) => !document.querySelector(`[data-cc-untag="lbl${k}"]`), { timeout: 3000, args: [k] });
      await page.press('Enter');
      const t = await page.waitFor(async (title) => (await import('/shared/store.js')).db.all('tasks').find((x) => x.title === title) || null, { timeout: 3000, args: [title], message: 'the task to be added' });
      assert.ok(t, 'added');
      const tags = await page.evaluate(async (title) => (await import('/shared/store.js')).db.all('tasks').find((x) => x.title === title)?.tags, title);
      assert.deepEqual(tags, [], 'added without the label that was taken off');
      await page.press('Escape');
    });
  });

  test('phone: a long name wraps (never scrolls sideways); Esc gives focus to the + button', async () => {
    await withScreenshot(page, 'qa-tasks-composer-phone', async () => {
      await page.setViewport(390, 844, true);
      await go(page, '#/today');
      await page.click('.fab');
      await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Task name', 3000);
      await page.type('Call mom tomorrow 6pm for 20m p1 and bring the photo album from the attic');
      await settle(page, 200);
      const r = await page.evaluate(() => {
        const ta = document.querySelector('.qa-field textarea');
        const mirror = document.querySelector('.qa-mirror');
        return { tag: ta.tagName, h: Math.round(ta.getBoundingClientRect().height), mh: Math.round(mirror.getBoundingClientRect().height), scrollTop: ta.scrollTop, scrollLeft: ta.scrollLeft, fits: ta.scrollHeight <= ta.clientHeight + 1 };
      });
      assert.equal(r.tag, 'TEXTAREA');
      assert.ok(r.h >= 52, `the name wraps onto more lines (${r.h}px tall)`);
      assert.equal(r.h, r.mh, 'the field is as tall as its highlight mirror');
      assert.deepEqual([r.scrollTop, r.scrollLeft, r.fits], [0, 0, true], 'nothing scrolled out of sight');
      await page.press('Escape');
      await page.waitFor(() => document.activeElement?.matches('.fab'), { timeout: 3000, message: 'focus on the + button' });
      await page.setViewport(1440, 900, false);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
