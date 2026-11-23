// QA regression (design system, shared/ui.css), the logo family's look in a real browser. The app switcher is one row
// of five, 336px wide, from ui.css alone (also once shell.js drops its inline grid), and fits a phone. Every app logo
// (sidebar, switcher, palette) has the logo's own corners, 15 of its 64 units; on Dim and Lights out it carries a faint
// rim (none on Light) while Home's launcher keeps the lit edge it draws itself. A hovered filled button moves away from
// its label in every theme and accent (Yellow lightens under its dark labels), and a native select's chevron is the
// theme's --text-3, focused too.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { useE2E, openApp, settle, withScreenshot } from './helpers.mjs';

const THEMES = ['light', 'dim', 'dark'];
const ACCENTS = ['iris', 'blue', 'violet', 'pink', 'orange', 'green', 'yellow'];
const LOGO = 15 / 64; // setFavicon() and shared/icons round the 64-unit tile with rx 15

async function setLook(page, theme, accent = 'iris') {
  await page.evaluate(async (theme, accent) => (await import('/shared/store.js')).settings.set({ theme, accent }), theme, accent);
  await page.waitFor((theme, accent) => document.documentElement.dataset.theme === theme && document.documentElement.dataset.accent === accent, { args: [theme, accent], timeout: 5000 });
  await settle(page, 150);
}

/** sRGB 0-255 from a computed colour: rgb()/rgba() or color(srgb …). */
function rgb(s) {
  let m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(s);
  if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255];
  throw new Error(`cannot read colour ${s}`);
}
const lum = (c) => {
  const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a, b) => {
  const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** Open the app switcher and measure it. With `bare`, first strip the inline grid and width shell.js used to write. */
async function measureSwitcher(page, { bare = false } = {}) {
  await page.evaluate(() => document.querySelector('[data-app-switcher]').click());
  await page.waitFor('.switcher .switcher-app', 3000);
  return page.evaluate(async (bare) => {
    const el = document.querySelector('.switcher');
    if (bare) {
      el.style.minWidth = '';
      el.querySelector('.switcher-grid').removeAttribute('style');
    }
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})));
    const r = el.getBoundingClientRect();
    const apps = [...el.querySelectorAll('.switcher-app')].map((a) => a.getBoundingClientRect());
    const out = { width: Math.round(r.width), left: r.left, right: r.right, vw: innerWidth, apps: apps.length, rows: new Set(apps.map((a) => Math.round(a.top))).size, narrowest: Math.min(...apps.map((a) => Math.round(a.width))) };
    document.querySelector('[data-app-switcher]').click(); // the menu button toggles it shut
    return out;
  }, bare);
}

/** Corner share and rim of every visible app logo in `scope` (selector), as { where, share, rim }. */
const logos = (page, scope) =>
  page.evaluate((scope) => {
    return [...document.querySelectorAll(`${scope} .app-icon`)]
      .filter((n) => n.getClientRects().length)
      .map((n) => {
        const size = n.getBoundingClientRect().width;
        const r = getComputedStyle(n).borderTopLeftRadius;
        const share = r.endsWith('%') ? parseFloat(r) / 100 : parseFloat(r) / size;
        const after = getComputedStyle(n, '::after');
        return { where: `${scope} ${Math.round(size)}px`, share, rim: after.content === 'none' ? 'none' : after.boxShadow };
      });
  }, scope);

describe('qa design system: logos and look', () => {
  const ctx = useE2E({ width: 1440, height: 900, scheme: 'light' });

  test('the app switcher is one row of five from ui.css alone, on a desktop and on a phone', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-switcher', async () => {
      await openApp(page, server.url('tasks/#/today'));
      const now = await measureSwitcher(page);
      await settle(page, 250);
      const bare = await measureSwitcher(page, { bare: true });
      for (const s of [now, bare]) {
        assert.deepEqual({ apps: s.apps, rows: s.rows, width: s.width }, { apps: 5, rows: 1, width: 336 }, `Home, Tasks, Schedule, Notes and AI in one 336px row (${JSON.stringify(s)})`);
        assert.ok(s.narrowest >= 60, `each app has room for its name (${s.narrowest}px)`);
      }
      await page.setViewport(390, 844, true);
      await openApp(page, server.url('tasks/#/today'));
      await page.evaluate(() => document.querySelector('.menu-toggle')?.click());
      await page.waitFor(() => !!document.querySelector('[data-app-switcher]')?.checkVisibility?.(), { timeout: 3000, message: "the drawer's switcher button" });
      await settle(page, 400);
      const phone = await measureSwitcher(page, { bare: true });
      assert.equal(phone.rows, 1, 'one row on a phone too');
      assert.ok(phone.left >= 8 && phone.right <= phone.vw - 8, `inside the screen (${Math.round(phone.left)}-${Math.round(phone.right)} of ${phone.vw})`);
      await page.setViewport(1440, 900, false);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test("every app logo has the logo's own corners; a faint rim on Dim and Lights out; Home keeps its own edge", async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-logo-corners', async () => {
      await openApp(page, server.url('tasks/#/today'));
      for (const theme of THEMES) {
        await setLook(page, theme);
        const seen = await logos(page, '.sidebar');
        await page.evaluate(() => document.querySelector('[data-app-switcher]').click());
        await page.waitFor('.switcher .app-icon', 3000);
        seen.push(...(await logos(page, '.switcher')));
        await page.press('Escape');
        await page.press('Control+k');
        await page.waitFor('.palette input', 3000);
        await page.type('connect ai');
        await page.waitFor('.palette .app-icon', { timeout: 3000, message: "the palette's Connect AI row with the AI logo" });
        seen.push(...(await logos(page, '.palette')));
        await page.press('Escape');
        await settle(page, 200);
        assert.ok(seen.length >= 7, `the sidebar's logo, five in the switcher and the palette's (${seen.length})`);
        for (const l of seen) {
          assert.ok(Math.abs(l.share - LOGO) < 0.01, `${theme}: ${l.where} has the logo's corners (${(l.share * 100).toFixed(1)}%, want ${(LOGO * 100).toFixed(1)}%)`);
          if (theme === 'light') assert.equal(l.rim, 'none', `${theme}: ${l.where} has no rim`);
          else assert.match(l.rim, /^rgba\(255, 255, 255, 0\.1\d\) 0px 0px 0px 1px inset$/, `${theme}: ${l.where} has a faint white rim (${l.rim})`);
        }
      }
      // Home draws its icons' edge itself (home.css): where it does, that edge wins over the shared rim.
      await openApp(page, server.url(''));
      for (const theme of ['dim', 'dark']) {
        await setLook(page, theme);
        const h = await page.evaluate(() => {
          const rules = [];
          const walk = (list) => {
            for (const r of list) {
              if (r.cssRules) walk(r.cssRules);
              if (r.selectorText && /::after\b/.test(r.selectorText) && r.style?.boxShadow && r.parentStyleSheet?.href?.includes('home.css')) rules.push(r.selectorText);
            }
          };
          for (const s of document.styleSheets) walk(s.cssRules);
          const icons = [...document.querySelectorAll('.launch-icon, .home-brand .app-icon')];
          return { own: icons.map((n) => rules.some((sel) => sel.split(',').some((one) => n.matches(one.trim().replace(/::after$/, ''))))), edges: icons.map((n) => getComputedStyle(n, '::after').boxShadow) };
        });
        assert.ok(h.edges.length >= 5, "Home's four launcher icons and its brand mark");
        h.edges.forEach((e, i) => {
          if (h.own[i]) assert.ok(e !== 'none' && !/^rgba\(255, 255, 255, 0\.14\) 0px 0px 0px 1px inset$/.test(e), `${theme}: Home's own edge wins over the shared rim (${e})`);
          else assert.match(e, /^rgba\(255, 255, 255, 0\.1\d\) 0px 0px 0px 1px inset$/, `${theme}: a Home icon without an edge of its own gets the shared rim (${e})`);
        });
      }
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test('a hovered filled button moves away from its label in every theme and accent', async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-hover-direction', async () => {
      await openApp(page, server.url('tasks/#/today'));
      const fails = [];
      for (const theme of THEMES) {
        for (const accent of ACCENTS) {
          await page.evaluate((theme, accent) => Object.assign(document.documentElement.dataset, { theme, accent }), theme, accent);
          const c = await page.evaluate(() => {
            const swatch = (bg) => {
              const d = document.createElement('div');
              d.style.cssText = `background: var(${bg}); color: var(--on-accent)`;
              document.body.append(d);
              const out = { bg: getComputedStyle(d).backgroundColor, fg: getComputedStyle(d).color };
              d.remove();
              return out;
            };
            return { rest: swatch('--accent-fill'), hover: swatch('--accent-hover') };
          });
          const rest = contrast(c.rest.bg, c.rest.fg);
          const hover = contrast(c.hover.bg, c.hover.fg);
          if (hover < rest - 0.01) fails.push(`${theme}/${accent}: ${rest.toFixed(2)}:1 at rest, ${hover.toFixed(2)}:1 hovered`);
          if (hover < 4.5) fails.push(`${theme}/${accent}: hovered label ${hover.toFixed(2)}:1`);
        }
      }
      assert.deepEqual(fails, [], `a hovered fill never moves toward its label:\n  ${fails.join('\n  ')}`);
      assert.deepEqual(page.consoleErrors(), []);
    });
  });

  test("a native select's chevron is the theme's --text-3, focused too", async () => {
    const { page, server } = ctx;
    await withScreenshot(page, 'qa-ds-select-chevron', async () => {
      await openApp(page, server.url('tasks/#/today'));
      for (const theme of THEMES) {
        await setLook(page, theme);
        const r = await page.evaluate(() => {
          const s = document.createElement('select');
          s.className = 'input';
          s.innerHTML = '<option>One</option>';
          document.body.append(s);
          const stroke = () => /stroke='%23([0-9a-f]{6})'/i.exec(getComputedStyle(s).backgroundImage)?.[1].toLowerCase() ?? null;
          const rest = stroke();
          s.focus();
          const out = { rest, isFocused: s.matches(':focus'), focused: stroke(), text3: getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim().toLowerCase().slice(1) };
          s.remove();
          return out;
        });
        assert.equal(r.rest, r.text3, `${theme}: the chevron is --text-3 (#${r.text3})`);
        assert.ok(r.isFocused, 'the select took focus');
        assert.equal(r.focused, r.text3, `${theme}: and stays when the select is focused (.input:focus's background shorthand would drop it)`);
      }
      assert.deepEqual(page.consoleErrors(), []);
    });
  });
});
