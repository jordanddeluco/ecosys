// QA for what Home keeps now that it is an app launcher (the completeness review's list), with no browser (the flows are
// in tests/e2e/qa-home-keeps.test.mjs):
//   - index.html: the CSP meta, boot.js first (it takes the pairing link's secret out of the address bar before any app
//     code runs), no inline script, the iOS home-screen icon, and every file the page loads exists
//   - the root manifest: id and scope, the four shortcuts into the apps, Lights out black, icons that exist
//   - home.js: the shell starts first; N honours the single-key setting; the date and greeting tick and roll over;
//     Notes' quick actions (Quick note, Today's note) replace the jot box, opened by a long press, a right-click or
//     the context-menu key; the AI caption says read only in every state, and why AI is unavailable when ecosys
//     turned this browser away (not paired)
//   - home.css: a long press is not a text selection or iOS's link preview; Reduce motion keeps a picked-up icon still
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.ECOSYS_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const code = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** home.js's AI caption (NOT_PAIRED … aiCaption), evaluated on its own: it needs nothing from the page. */
function captionApi() {
  const js = read('home.js');
  const start = js.indexOf('const NOT_PAIRED');
  const end = js.indexOf('let aiShown');
  assert.ok(start > 0 && end > start, 'home.js keeps its AI caption (NOT_PAIRED … aiCaption) ahead of renderAI');
  return new Function(`${js.slice(start, end)}\nreturn { aiCaption };`)();
}

/** home.js's QUICK_ACTIONS, evaluated with stand-ins for what the actions call. */
function quickActions() {
  const js = read('home.js');
  const m = /const QUICK_ACTIONS = \{[\s\S]*?\n\};/.exec(js);
  assert.ok(m, 'home.js has QUICK_ACTIONS');
  const calls = [];
  const location = {
    set href(v) {
      calls.push(['href', v]);
    },
  };
  const actions = new Function('quickNote', 'BASE', 'location', `${m[0]}\nreturn QUICK_ACTIONS;`)(() => calls.push(['quickNote']), '/base/', location);
  return { actions, calls };
}

test('index.html: CSP meta, boot.js before any app code, no inline script, the iOS icon, every file it loads exists', () => {
  const html = read('index.html');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || '';
  assert.match(csp, /(^|;)\s*script-src 'self'\s*(;|$)/, "scripts only from ecosys itself (no 'unsafe-inline')");
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc="/, 'every script is a file (CSP script-src self)');
    assert.equal(body.trim(), '', 'no inline script');
  }
  assert.deepEqual(scripts.map(([, attrs]) => /src="([^"]+)"/.exec(attrs)[1]), ['shared/boot.js', 'home.js'], 'boot.js, then the launcher');
  assert.doesNotMatch(scripts[0][1], /type="module"|defer|async/, 'boot.js is a classic script: it runs before first paint and before any module reads the address');
  assert.match(scripts[1][1], /type="module"/);
  assert.match(html, /<link rel="apple-touch-icon" href="shared\/icons\/ecosys-180\.png" \/>/, "iOS's home-screen icon (iOS ignores SVG icons)");
  assert.match(html, /<link rel="icon" href="shared\/icons\/ecosys\.svg" type="image\/svg\+xml" \/>/);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest" \/>/);
  // Everything the page loads is there, the 180px PNG iOS takes for the home screen too (rendered from the maskable logo).
  const loads = [...html.matchAll(/<(?:link rel="(?:stylesheet|modulepreload|icon|apple-touch-icon|manifest)"|script)[^>]*?\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(loads.includes('shared/icons/ecosys-180.png') && loads.includes('home.js'));
  for (const href of loads) assert.ok(existsSync(join(ROOT, href)), `${href} exists`);
});

test('the root manifest: id and scope, the four shortcuts into the apps, Lights out black, icons that exist', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.id, './');
  assert.equal(m.scope, './');
  assert.equal(m.start_url, './');
  assert.equal(m.display, 'standalone');
  assert.equal(m.background_color, '#000000');
  assert.equal(m.theme_color, '#000000');
  assert.deepEqual(
    m.shortcuts.map((s) => [s.name, s.url]),
    [["Today's tasks", 'tasks/#/today'], ['Schedule', 'schedule/'], ['Notes', 'notes/'], ['Quick note', 'notes/#/quick']],
  );
  for (const s of m.shortcuts) for (const i of s.icons) assert.ok(existsSync(join(ROOT, i.src)), `${s.name}: ${i.src} exists`);
  assert.doesNotMatch(m.description, /at a glance/i, 'Home lists the apps; it no longer previews the day');
  assert.deepEqual(m.icons.map((i) => i.purpose), ['any', 'maskable']);
  for (const i of m.icons) assert.ok(existsSync(join(ROOT, i.src)), `${i.src} exists`);
});

test('home.js: the shell starts first, N honours the single-key setting, the date and greeting tick and roll over', () => {
  const js = code(read('home.js'));
  const afterImports = js.slice(js.lastIndexOf("from './shared/shell.js';") + "from './shared/shell.js';".length).trim();
  assert.match(afterImports, /^initShell\(\{ app: 'home' \}\);/, 'initShell first: sample data, sync and its first-sync import, pairing, the global keys');
  const n = /document\.addEventListener\('keydown', \(e\) => \{([\s\S]*?)\n\}\);/.exec(js)?.[1] || '';
  assert.match(n, /e\.key === 'n' \|\| e\.key === 'N'/, 'N is Quick note');
  for (const guard of ['isTyping(e)', 'hasOpenLayer()', 'singleKeyOff(e)', 'e.metaKey', 'e.ctrlKey', 'e.altKey']) assert.ok(n.includes(guard), `N stays quiet: ${guard}`);
  assert.match(n, /quickNote\(\)/);
  assert.match(js, /setInterval\(renderHero, 30000\)/, 'the greeting and the date tick every 30 s, so they roll over at midnight');
  assert.match(js, /visibilitychange[\s\S]{0,120}renderHero\(\)/, 'and redraw on a return to the tab');
  assert.match(js, /'pageshow'[\s\S]{0,80}persisted\) renderHero\(\)/, 'and when Back brings Home from the browser cache');
  const hero = /function renderHero\(\) \{([\s\S]*?)\n\}/.exec(js)?.[1] || '';
  assert.match(hero, /new Date\(\)/, 'each redraw reads the clock');
  assert.match(js, /registerShortcuts\(/, 'the shortcuts sheet lists Home’s keys');
});

test("Notes' quick actions replace the jot box: Quick note and Today's note, by long press, right-click or the menu key", () => {
  const { actions, calls } = quickActions();
  assert.deepEqual(Object.keys(actions), ['notes'], 'only Notes has quick actions');
  assert.deepEqual(actions.notes.map((a) => [a.label, a.icon, a.keys ?? null]), [['Quick note', 'quick-note', 'n'], ["Today's note", 'today', null]]);
  for (const a of actions.notes) a.run();
  assert.deepEqual(calls, [['quickNote'], ['href', '/base/notes/#/today']], "Quick note is the shell's (it comes back here), Today's note opens today's note through BASE");
  const js = code(read('home.js'));
  assert.match(js, /QUICK_ACTIONS\[app\.id\] \? ' data-actions' : ''/, 'the icons that have them are marked (CSS: no link preview on a long press)');
  assert.match(js, /addEventListener\('contextmenu'/, 'a right-click, the context-menu key or Shift+F10');
  assert.match(js, /const LONG_PRESS = 500;/, 'a long press is half a second, as on iOS and Android');
  assert.match(js, /e\.pointerType === 'mouse'/, 'a mouse has its right button: no long press');
  assert.match(js, /addEventListener\(\s*'click',[\s\S]{0,200}eatClickUntil[\s\S]{0,200}stopImmediatePropagation\(\);[\s\S]{0,20}\},\s*true,?\s*\)/, 'the click that ends a long press does not open Notes');
  assert.match(js, /typeof shell\.openQuickNote === 'function' \? shell\.openQuickNote\(\) : \(location\.href = `\$\{BASE\}notes\/#\/quick`\)/, 'N and Quick note use the shell’s Quick note');
  assert.match(js, /`<a \$\{attrs\} href="\$\{esc\(app\.href\)\}">\$\{inner\}<\/a>`/, 'Notes stays a plain link (no aria-haspopup): activating it opens Notes');
});

test('the AI caption: read only in every state, and why AI is unavailable when ecosys turned this browser away', () => {
  const { aiCaption } = captionApi();
  const claude = { kind: 'claude', label: 'Claude' };
  const grok = { kind: 'grok', label: 'Grok' };
  const st = (o) => ({ online: true, reason: '', mode: 'write', clients: [], connected: [], ...o });
  assert.equal(aiCaption(undefined), null, 'nothing while the status is unknown');
  assert.equal(aiCaption({ online: null, reason: 'unknown' }), null);
  assert.deepEqual(aiCaption(null), { text: 'Unavailable', tone: 'quiet', said: 'Unavailable: AI connections couldn’t load' });
  for (const reason of ['refused', 'unpaired']) {
    assert.deepEqual(aiCaption({ online: false, reason }), { text: 'Unavailable', tone: 'quiet', said: 'Unavailable: this browser isn’t connected to ecosys on this computer' }, reason);
  }
  assert.equal(aiCaption({ online: false, reason: 'static' }).said, 'Unavailable: AI assistants need the ecosys app running on your computer');
  assert.equal(aiCaption({ online: false, reason: 'lan' }).said, 'Unavailable: AI connections are managed on the computer that runs ecosys');
  assert.equal(aiCaption({ online: false, reason: 'unreachable' }).said, 'Unavailable: ecosys isn’t answering on this computer');
  assert.equal(aiCaption({ online: false, reason: 'no-server' }).said, 'Unavailable: ecosys isn’t answering on this computer');

  assert.deepEqual(aiCaption(st({ mode: 'read' })), { text: 'Connect', tone: 'connect', said: 'Connect Claude, ChatGPT or Grok, read only', readOnly: true });
  assert.deepEqual(aiCaption(st({ mode: 'read', clients: [grok] })), { text: 'Ready', tone: 'quiet', said: 'Ready for Grok, read only', readOnly: true });
  assert.deepEqual(aiCaption(st({ mode: 'read', clients: [claude, grok], connected: [claude, grok] })), { text: 'Grok +1', tone: 'on', said: 'Claude and Grok are connected, read only', readOnly: true });
  assert.deepEqual(aiCaption(st({ clients: [claude], connected: [claude] })), { text: 'Claude', tone: 'on', said: 'Claude is connected', readOnly: false });
  assert.deepEqual(aiCaption(st({})), { text: 'Connect', tone: 'connect', said: 'Connect Claude, ChatGPT or Grok', readOnly: false });
  assert.deepEqual(aiCaption(st({ mode: 'off', clients: [grok] })), { text: 'Off', tone: 'quiet', said: 'Off: AI access is turned off' }, 'Off says it all: no lock');

  const js = code(read('home.js'));
  assert.match(js, /el\.aiFlag\.hidden = !cap\?\.readOnly;/, 'the lock before "AI" follows read-only access');
  assert.match(js, /data-ai-flag hidden>\$\{icon\('lock'/, 'the lock is the glyph Connect AI uses for read only');
});

test('home.css: a long press is not a text selection or a link preview; Reduce motion keeps a picked-up icon still', () => {
  const css = strip(read('home.css'));
  const app = /\.launch-app \{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(app, /(^|;)\s*user-select:\s*none/, 'names are not selected by a long press');
  assert.match(app, /-webkit-user-select:\s*none/);
  assert.match(css, /\.launch-app\[data-actions\] \{\s*-webkit-touch-callout:\s*none;\s*\}/, 'no link preview where a long press opens quick actions');
  const reduce = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] || '';
  assert.match(reduce, /\.launch-app\.actions-open \.launch-icon[^{]*\{\s*transform:\s*none;/, 'Reduce motion: no lift while the actions are open');
  assert.match(css, /\[data-reduce-motion='true'\] \.launch-app\.actions-open \.launch-icon \{ transform: none; \}/, 'and with Reduce motion on in Settings');
  assert.match(css, /\.launch-flag \{[^}]*color:\s*var\(--text-2\)/, 'the read-only lock is quiet but visible');
  assert.doesNotMatch(css, /\binfinite\b/, 'nothing loops forever');
});
