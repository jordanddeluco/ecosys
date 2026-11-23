// notes-app, second pass: this browser's storage is full while ecosys can't be reached (headless Chrome,
// an isolated server of its own so the library is small):
//   "Not saved: storage is full" goes as soon as the notes are saved again: right after Empty Recently
//   Deleted made room (the banner's own button), not at the next timed check (5 s doubling to 5 min).
//   A library over the store's 512 KB mark is saved again at once too where the store can be asked to
//   (saveAgain); until then it waits for the store's own pause, and the test says so (skipped).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp as openAppHash, waitForApp, waitForSyncIdle, withScreenshot, tag } from './helpers.mjs';

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
/** Every /api request of the page fails (no connection): ecosys can't be reached. Returns a function that stops it. */
async function cutApi(page) {
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  const off = page.conn.on((msg) => {
    if (msg.sessionId === page.sessionId && msg.method === 'Fetch.requestPaused') page.send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'ConnectionRefused' }).catch(() => {});
  });
  return async () => {
    off();
    await page.send('Fetch.disable').catch(() => {});
  };
}

describe('qa notes-app: second pass, storage full', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });

  /**
   * A big note in Recently Deleted (`trashKb`), another note open, ecosys unreachable, storage full to the
   * last character, then a few words typed: the "Not saved" banner. Returns a function that undoes it.
   */
  async function fillUp(page, { trashKb, extraKb = 0 }) {
    const { server } = ctx;
    const t = tag();
    await openApp(page, server.url('notes/#/all'));
    const ids = await inPage(
      page,
      (_s, core, _m, a) => {
        const para = (i) => ({ id: `p${i}`, t: 'p', c: [['x'.repeat(1000)]] });
        const big = core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`Old drafts ${a.t}`]] }, ...Array.from({ length: a.trashKb }, (_, i) => para(i))] });
        core.trashNote(big.id);
        for (let k = 0; k < Math.ceil(a.extraKb / 100); k++) core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`Library ${k} ${a.t}`]] }, ...Array.from({ length: 100 }, (_, i) => para(i))] });
        const keep = core.createNote({ blocks: [{ id: 'h', t: 'h1', c: [[`Keep ${a.t}`]] }, { id: 'p', t: 'p', c: [['keep this']] }] });
        return { big: big.id, keep: keep.id };
      },
      { t, trashKb, extraKb },
    );
    await waitForSyncIdle(page, 30000);
    const uncut = await cutApi(page);
    await page.goto('about:blank');
    await page.goto(server.url(`notes/#/all/n/${ids.keep}`));
    await waitForApp(page);
    await page.waitFor(() => window.ecosysSync?.status === 'offline', { timeout: 15000, message: 'sync to go offline' });
    await page.waitFor((x) => document.querySelector('.ne-doc .ne-b')?.textContent === x, { timeout: 8000, args: [`Keep ${t}`], message: 'the note to open' });
    await page.evaluate(() => {
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
    await page.evaluate(() => {
      const ed = document.querySelector('.ne-doc');
      ed.focus();
      const tx = [...ed.querySelectorAll('.ne-b')].pop().querySelector('.ne-tx');
      const r = document.createRange();
      r.selectNodeContents(tx);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await page.type(' and more text that does not fit');
    await page.waitFor(() => document.querySelector('.n-banner-err'), { timeout: 10000, message: 'the "Not saved" banner' });
    return async () => {
      await uncut();
      await page
        .evaluate(() => {
          for (const k of Object.keys(localStorage)) if (k.startsWith('qa-fill-')) localStorage.removeItem(k);
        })
        .catch(() => {});
    };
  }
  /** The banner's Empty Recently Deleted, confirmed. */
  async function emptyFromBanner(page) {
    await page.click(() => document.querySelector('.n-banner-err [data-empty-trash]'));
    const confirm = () => [...document.querySelectorAll('[role=dialog] button, [role=alertdialog] button')].find((b) => /Delete All/.test(b.textContent));
    await page.waitFor(confirm, { timeout: 5000, message: 'the Delete All confirmation' });
    await page.click(confirm);
  }

  test('with ecosys unreachable, "Not saved: storage is full" goes as soon as Empty Recently Deleted made room', async () => {
    const page = await ctx.browser.newPage({ isolated: true });
    await page.setViewport(1440, 900, false);
    let undo = null;
    try {
      await withScreenshot(page, 'qa-notes-app-storage', async () => {
        undo = await fillUp(page, { trashKb: 150 });
        await emptyFromBanner(page);
        await page.waitFor(() => !document.querySelector('.n-banner-err'), { timeout: 2500, message: 'the banner to go as soon as the notes are saved (not at the next timed check)' });
        const saved = await page.evaluate(async () => (await import('/shared/store.js')).cacheSaved('notes'));
        assert.equal(saved, true, 'the notes are in this browser’s storage');
        assert.ok(await page.evaluate(() => [...document.querySelectorAll('.toast')].some((x) => /Saved/.test(x.textContent))), 'and it says so');
      });
    } finally {
      await undo?.();
      await page.close().catch(() => {});
    }
  });

  test('a library over 512 KB is saved again at once too, where the store can be asked to (saveAgain)', async (t) => {
    const page = await ctx.browser.newPage({ isolated: true });
    await page.setViewport(1440, 900, false);
    let undo = null;
    try {
      await openApp(page, ctx.server.url('notes/#/all'));
      if (!(await page.evaluate(async () => typeof (await import('/shared/store.js')).saveAgain === 'function'))) {
        return t.skip("shared/store.js has no saveAgain yet: after a big write failed it waits 30 s, and the next edit saves");
      }
      await withScreenshot(page, 'qa-notes-app-storage-big', async () => {
        undo = await fillUp(page, { trashKb: 300, extraKb: 600 });
        await emptyFromBanner(page);
        await page.waitFor(() => !document.querySelector('.n-banner-err'), { timeout: 2500, message: 'the banner to go once the store saved the notes again' });
        assert.equal(await page.evaluate(async () => (await import('/shared/store.js')).cacheSaved('notes')), true);
      });
    } finally {
      await undo?.();
      await page.close().catch(() => {});
    }
  });
});
