// QA (pairing): shared/boot.js, the classic script every page runs first.
//  - It takes "#pair=<secret>" out of the address bar before any app router reads the hash, keeps the
//    secret under ecosys:v1:pair and keeps the route after it; shared/pair.js, which does the same
//    when boot.js didn't, gives the very same result for every link.
//  - A page framed by another site (possible only on a static copy such as GitHub Pages, where no
//    frame-ancestors header protects it) hides itself and tries to take the whole window.
//  - The saved theme still applies before first paint.
// boot.js runs in a vm with a stand-in window; pair.js is imported with stand-in globals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const BOOT = readFileSync(new URL('../shared/boot.js', import.meta.url), 'utf8');
const KEY = 'ecosys:v1:pair';
const SECRET = 'Xy3_-q9ZkLmN0pQrStUvWxYz012345678_abcdEFGHi'; // the shape randomToken() makes: 43 base64url characters
assert.equal(SECRET.length, 43);

/** A stand-in browser for one page load at `href`. */
function browser(href, { storage = 'ok', stored = {}, top = 'self', settings = null } = {}) {
  const url = new URL(href);
  const items = new Map(Object.entries(stored));
  if (settings) items.set('ecosys:v1:settings', JSON.stringify(settings));
  const replaced = [];
  const localStorage = {
    getItem(k) {
      if (storage === 'blocked') throw new Error('SecurityError: storage is blocked');
      return items.has(k) ? items.get(k) : null;
    },
    setItem(k, v) {
      if (storage !== 'ok') throw new Error(storage === 'full' ? 'QuotaExceededError' : 'SecurityError');
      items.set(k, String(v));
    },
    removeItem(k) {
      items.delete(k);
    },
  };
  const location = {
    get hash() {
      return url.hash;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get href() {
      return url.href;
    },
    get origin() {
      return url.origin;
    },
  };
  const history = {
    state: { kept: true },
    replaceState(state, _title, to) {
      replaced.push({ state, to });
      const next = new URL(to, url);
      url.hash = next.hash;
      url.search = next.search;
      url.pathname = next.pathname;
    },
  };
  const attrs = {};
  const style = {};
  const document = { documentElement: { style, setAttribute: (k, v) => (attrs[k] = String(v)) } };
  const window = { location, history, localStorage, matchMedia: () => ({ matches: false }) };
  window.self = window;
  let navigatedTop = null;
  if (top === 'self') window.top = window;
  else if (top === 'same-origin') window.top = { location: { origin: url.origin } };
  else {
    // Another site's page: reading its location throws; setting its href may or may not be allowed.
    window.top = {
      location: {
        get origin() {
          throw new Error('SecurityError: Blocked a frame from accessing a cross-origin frame');
        },
        set href(v) {
          if (top === 'cross-origin-blocked') throw new Error('SecurityError: not allowed to navigate the top frame');
          navigatedTop = v;
        },
      },
    };
  }
  return {
    window,
    document,
    run() {
      vm.runInNewContext(BOOT, { window, document });
      return { url: url.href, stored: items.get(KEY) ?? null, replaced, attrs, style, navigatedTop };
    },
  };
}

// Links and what is left of them. The route after the secret is kept; anything that isn't a pairing
// link (too short, a character outside base64url, the name inside another word) is left alone.
const CASES = [
  ['http://127.0.0.1:4300/#pair=' + SECRET, 'http://127.0.0.1:4300/', SECRET],
  ['http://127.0.0.1:4300/tasks/#pair=' + SECRET + '&/today', 'http://127.0.0.1:4300/tasks/#/today', SECRET],
  ['http://127.0.0.1:4300/tasks/#pair=' + SECRET + '/today', 'http://127.0.0.1:4300/tasks/#/today', SECRET],
  ['http://127.0.0.1:4300/notes/#/n/abc123&pair=' + SECRET, 'http://127.0.0.1:4300/notes/#/n/abc123', SECRET],
  ['http://127.0.0.1:4300/schedule/?x=1#pair=' + SECRET + '&/week', 'http://127.0.0.1:4300/schedule/?x=1#/week', SECRET],
  ['http://localhost:5000/#pair=' + SECRET + '&&/today', 'http://localhost:5000/#/today', SECRET],
  ['http://127.0.0.1:4300/#pair=tooShort', 'http://127.0.0.1:4300/#pair=tooShort', null],
  ['http://127.0.0.1:4300/#pair=' + SECRET.slice(0, 30) + '%' + SECRET.slice(30), 'http://127.0.0.1:4300/#pair=' + SECRET.slice(0, 30) + '%' + SECRET.slice(30), null],
  ['http://127.0.0.1:4300/#/list/repair=' + SECRET, 'http://127.0.0.1:4300/#/list/repair=' + SECRET, null],
  ['http://127.0.0.1:4300/tasks/#/today', 'http://127.0.0.1:4300/tasks/#/today', null],
  ['http://127.0.0.1:4300/', 'http://127.0.0.1:4300/', null],
];

test('boot.js takes the pairing secret out of the address bar, keeps it, and keeps the route after it', () => {
  for (const [href, after, secret] of CASES) {
    const out = browser(href).run();
    assert.equal(out.url, after, href);
    assert.equal(out.stored, secret, `${href}: stored`);
    assert.equal(out.replaced.length, secret ? 1 : 0, `${href}: the address bar is rewritten only for a pairing link`);
    if (secret) {
      assert.deepEqual(out.replaced[0].state, { kept: true }, 'the history state is kept');
      assert.ok(!out.url.includes(secret), 'the secret is gone from the URL');
    }
  }
});

test('boot.js and shared/pair.js handle every link the same way', async () => {
  let n = 0;
  for (const [href] of CASES) {
    const b = browser(href);
    const viaBoot = b.run();
    // pair.js on its own (boot.js didn't run): stand-in globals, a fresh module instance per case.
    const p = browser(href);
    const saved = { location: globalThis.location, history: globalThis.history, localStorage: globalThis.localStorage };
    Object.assign(globalThis, { location: p.window.location, history: p.window.history, localStorage: p.window.localStorage });
    try {
      await import(`../shared/pair.js?case=${n++}`);
      assert.equal(p.window.location.href, viaBoot.url, `${href}: the same URL`);
      assert.equal(p.window.localStorage.getItem(KEY), viaBoot.stored, `${href}: the same secret`);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete globalThis[k];
        else globalThis[k] = v;
      }
    }
  }
});

test('with storage blocked or full, the link still leaves the address bar (the secret is never left in it)', () => {
  for (const storage of ['full', 'blocked']) {
    const out = browser(`http://127.0.0.1:4300/tasks/#pair=${SECRET}&/today`, { storage }).run();
    assert.equal(out.url, 'http://127.0.0.1:4300/tasks/#/today', storage);
    assert.equal(out.attrs['data-theme'], 'light', `${storage}: the theme still applies`);
  }
});

test('a newer link replaces a stored secret (a new data folder has a new one)', () => {
  const out = browser(`http://127.0.0.1:4300/#pair=${SECRET}`, { stored: { [KEY]: 'Old_secret_from_another_folder_0123456789ab' } }).run();
  assert.equal(out.stored, SECRET);
});

test('framed by another site, the page hides itself and tries to take the whole window; otherwise it shows', () => {
  const href = 'https://user.github.io/ecosys/tasks/#/today';
  const cross = browser(href, { top: 'cross-origin' }).run();
  assert.equal(cross.style.visibility, 'hidden', 'hidden content cannot be clicked through');
  assert.equal(cross.navigatedTop, href, 'it asks to become the top page');
  const blocked = browser(href, { top: 'cross-origin-blocked' }).run();
  assert.equal(blocked.style.visibility, 'hidden', 'still hidden when the browser refuses that navigation');
  assert.equal(blocked.attrs['data-theme'], 'light', 'and the rest of boot.js still ran');
  for (const top of ['self', 'same-origin']) {
    const out = browser(href, { top }).run();
    assert.equal(out.style.visibility, undefined, `${top}: visible`);
    assert.equal(out.navigatedTop, null);
  }
});

test('the saved theme, accent and motion setting still apply before first paint', () => {
  const out = browser('http://127.0.0.1:4300/', { settings: { theme: 'dim', accent: 'green', reduceMotion: true } }).run();
  assert.deepEqual(out.attrs, { 'data-theme': 'dim', 'data-accent': 'green', 'data-reduce-motion': 'true' });
  const odd = browser('http://127.0.0.1:4300/', { settings: { theme: '<script>', accent: 1 } }).run();
  assert.deepEqual(odd.attrs, { 'data-theme': 'light', 'data-accent': 'iris', 'data-reduce-motion': 'false' });
});
