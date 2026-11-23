// Smoke: every ecosys page (/, /tasks/, /schedule/, /notes/) loads cleanly in light and dark at
// 1440x900 and 390x844: HTTP 200, the app starts and syncs with the server, the theme follows
// the system colour scheme, and there are zero console errors (console.error, uncaught exceptions,
// failed loads, CSP violations). At phone size the page must not scroll sideways.
// /notes/ is skipped while the notes app's own files are not all there yet.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, PAGES, VIEWPORTS, SCHEMES, openApp, formatErrors, withScreenshot, missingFiles, formatMissing } from './helpers.mjs';

describe('smoke: every page, light and dark, desktop and phone', () => {
  const ctx = useE2E();
  const loaded = new Set();
  const missingCache = new Map();
  const missingFor = (path) => {
    if (!missingCache.has(path)) missingCache.set(path, missingFiles(ctx.server, path).catch(() => []));
    return missingCache.get(path);
  };

  for (const vp of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      for (const p of PAGES) {
        const name = `/${p.path} ${scheme} ${vp.width}x${vp.height}`;

        test(`${name} loads with zero console errors`, async (t) => {
          const { page, server } = ctx;
          if (p.optional) {
            const own = (await missingFor(p.path)).filter((m) => m.path.startsWith(`/${p.path}`));
            if (own.length) return t.skip(`the ${p.id} app is not built yet; missing ${formatMissing(own)}`);
          }
          await page.setViewport(vp.width, vp.height, vp.mobile);
          await page.emulateColorScheme(scheme);
          page.clearConsoleErrors();
          try {
            await withScreenshot(page, `smoke-${p.id}-${scheme}-${vp.id}`, async () => {
              const { status } = await openApp(page, server.url(p.path), { settleMs: 800 });
              assert.equal(status, 200, `GET /${p.path} status`);
              loaded.add(name);
              const theme = await page.evaluate(() => document.documentElement.dataset.theme);
              assert.equal(theme, scheme, `data-theme follows prefers-color-scheme: ${scheme}`);
              const errors = page.consoleErrors();
              assert.equal(errors.length, 0, `${errors.length} console error(s) on /${p.path} (${scheme}, ${vp.width}x${vp.height}):\n${formatErrors(errors)}`);
            });
          } catch (err) {
            const missing = await missingFor(p.path);
            if (missing.length) err.message += `\n  files this page references that the server does not have: ${formatMissing(missing)}`;
            throw err;
          }
        });

        if (vp.mobile) {
          test(`${name} does not scroll sideways`, async (t) => {
            if (!loaded.has(name)) return t.skip('the page did not load');
            const r = await ctx.page.evaluate(() => {
              const x0 = scrollX;
              scrollTo(400, scrollY);
              const moved = scrollX;
              scrollTo(x0, scrollY);
              const wide = [...document.querySelectorAll('body *')]
                .filter((el) => {
                  const b = el.getBoundingClientRect();
                  return b.width > 0 && b.right > innerWidth + 1 && getComputedStyle(el).position !== 'fixed';
                })
                .slice(0, 3)
                .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`);
              return { moved, width: document.documentElement.scrollWidth, innerWidth, wide };
            });
            assert.equal(r.moved, 0, `the page scrolls ${r.moved}px sideways at ${r.innerWidth}px (content ${r.width}px wide; e.g. ${r.wide.join(', ') || 'n/a'})`);
          });
        }
      }
    }
  }
});
