// QA (ai), with no browser: what shared/ai.js and shared/ai.css promise in their source (the flows are in
// tests/e2e/qa-ai-pairing.test.mjs and tests/e2e/qa-ai-status.test.mjs).
//   - every /api request goes through one fetch that sends shared/pair.js apiHeaders(), and nothing invents its own
//     X-Ecosys header (lead decision 1); a 403 pairing_required forgets the refused secret (markRejected)
//   - Home's AI card is gone with the launcher (renderAITile and its .ai-tile/.ai-pill rules); renderAIChip() stays
//     exported: it is the AI status button initAI() puts in the apps' sidebar head
//   - the error lines use the alert glyph (the icon audit); info stays for callouts
//   - changing a connection's access says web connectors may need a refresh (server request)
//   - no emoji or pictographs anywhere (the owner's request: every glyph custom and drawn)
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.ECOSYS_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
/** Source without its comments (line and block), so only code is checked. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const js = read('shared/ai.js');
const css = read('shared/ai.css');

test('every /api request sends shared/pair.js apiHeaders(); none invents its own X-Ecosys header', () => {
  assert.match(js, /^import \{[^}]*\bapiHeaders\b[^}]*\bmarkRejected\b[^}]*\} from '\.\/pair\.js';$/m, 'ai.js takes apiHeaders and markRejected from ./pair.js');
  const src = code(js);
  const fetches = src.match(/\bfetch\(/g) || [];
  assert.equal(fetches.length, 1, 'one fetch, in call(): every request goes through it');
  const call = src.slice(src.indexOf('async function call('), src.indexOf('\n}\n', src.indexOf('async function call(')));
  assert.match(call, /const auth = apiHeaders\(\);/, 'call() asks pair.js for the header, per request (a secret stored since is used)');
  assert.match(call, /headers: body === undefined \? \{ \.\.\.auth \} : \{ \.\.\.auth, 'Content-Type': 'application\/json' \}/, 'and sends it with every request');
  assert.match(call, /res\.status === 403 && data\?\.error === 'pairing_required'[\s\S]*?markRejected\(auth\['X-Ecosys'\]\)/, 'a refused pairing forgets the secret that was sent');
  assert.doesNotMatch(src, /['"]?X-Ecosys['"]?\s*:\s*['"]1['"]/i, 'no hard-coded legacy header');
  assert.doesNotMatch(src, /\bnew EventSource\(/, 'no EventSource (it cannot send the header)');
});

test('Home’s AI card is gone; the AI status button (renderAIChip) stays', () => {
  assert.doesNotMatch(js, /\brenderAITile\b/, 'renderAITile() has no caller since Home became a launcher');
  assert.doesNotMatch(js, /\bneedsChrome\b/, 'nor its helper');
  assert.match(js, /^export function renderAIChip\(el\) \{$/m, 'renderAIChip(el) keeps its export');
  assert.match(js, /if \(app && app !== 'home'\) mountAppStatus\(\);/, 'initAI() mounts it in the apps (Home’s AI icon has its own caption)');
  const rules = code(css);
  assert.doesNotMatch(rules, /\.ai-tile|\.ai-pill/, 'ai.css keeps no Home card rules');
  assert.match(rules, /\.ai-chip\.on \.i circle \{ fill: var\(--success\); stroke: var\(--success\); \}/, 'connected: the glyph’s docked circle is lit');
  assert.doesNotMatch(rules, /\.ai-(?:chip|side)[^{]*\{[^}]*animation/, 'the button never animates (a status, not an alert)');
});

test('error lines use the alert glyph; info stays for callouts', () => {
  const errs = [...js.matchAll(/class="ai-err">\$\{icon\('([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(errs.length >= 2, `found the error lines (${errs.length})`);
  assert.deepEqual([...new Set(errs)], ['alert'], 'every .ai-err line draws alert');
  assert.ok(/class="ai-callout">\$\{icon\('info'/.test(js), 'callouts keep info');
});

test('changing access says web connectors may need a refresh', () => {
  const fn = js.slice(js.indexOf('async function setAccess('), js.indexOf('async function rotate('));
  assert.match(fn, /Web connectors \(claude\.ai, ChatGPT, Grok\) may need a refresh to see it\./);
  assert.match(fn, /duration: 4200/);
});

test('no emoji or pictographs in ai.js or ai.css', () => {
  for (const [name, src] of [['shared/ai.js', js], ['shared/ai.css', css]]) {
    const found = src.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu);
    assert.equal(found, null, `${name} draws every glyph (found ${found?.join(' ')})`);
  }
});
