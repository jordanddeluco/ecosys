// QA regressions read from shared/shell.js's source (the browser side is in tests/e2e/qa-shell-fixes.test.mjs):
//   - backups: Export writes compact JSON, and Import's size bound is at least the largest file Export can write
//     (it refused its own 5.5 MB backups at 5 MB); a refusal says how large the file is and what the bound is;
//     the import confirm names folders too
//   - Settings > Notes uses Notes' own labels ("AI assistants can: Read & edit / Read / Off", "Sort checked items:
//     Automatically / Manually"), never "AI access", which is Connect AI's switch for everything, and links to it
//   - Settings > Schedule has working hours, read as the server's 09:00-17:00 while unset
//   - the app switcher takes its five columns from ui.css (no inline grid)
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SHELL = read('shared/shell.js');
/** The body of a top-level function in shell.js (up to the first line that is just "}"). */
function fnBody(name) {
  const at = SHELL.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(at >= 0, `shell.js has ${name}()`);
  return SHELL.slice(at, SHELL.indexOf('\n}\n', at));
}
const constValue = (name) => {
  const m = new RegExp(`\\nconst ${name} = ([^;]+);`).exec(SHELL);
  assert.ok(m, `shell.js defines ${name}`);
  assert.match(m[1], /^[\d\s*()+\-^.]+$/, `${name} is plain arithmetic`);
  return Function(`"use strict"; return (${m[1]});`)();
};

test('Export backup writes compact JSON (indenting made a backup about 80% larger)', () => {
  const body = fnBody('downloadBackup');
  assert.match(body, /JSON\.stringify\(store\.exportData\(\)\)/, 'no indentation argument');
  assert.doesNotMatch(body, /JSON\.stringify\([^)]*\),\s*null,\s*\d/);
});

test('Import backup accepts any file Export can write: its bound is the largest string a tab holds, in UTF-8', () => {
  const max = constValue('MAX_BACKUP_BYTES');
  // Export writes one string: at most 2^29 − 24 UTF-16 units in Chrome, each at most 3 bytes of UTF-8.
  assert.ok(max >= 3 * (2 ** 29 - 24), `MAX_BACKUP_BYTES ${max} covers every backup Export can write`);
  assert.ok(max > 64 * 1024 * 1024, 'far above any library the apps can hold (the old bound was 5 MB)');
  // The same string written compact: a library that was 5.5 MB indented is about 3 MB.
  const lib = { app: 'ecosys', version: 2, notes: Array.from({ length: 3000 }, (_, i) => ({ id: `n${i}`, blocks: [{ id: 'b1', t: 'h1', c: [[`Journal ${i}`]] }, { id: 'b2', t: 'p', c: [['Worked in the garden and read a chapter. '.repeat(20)]] }] })) };
  const pretty = Buffer.byteLength(JSON.stringify(lib, null, 2));
  const compact = Buffer.byteLength(JSON.stringify(lib));
  assert.ok(compact < pretty * 0.85, `compact ${compact} vs indented ${pretty}`);
});

test('Import says how large a refused file is, and the bound; a read failure is not called "not a backup"', () => {
  const body = fnBody('importBackupFile');
  assert.match(body, /file\.size > MAX_BACKUP_BYTES\) return toast\(`This backup is \$\{mbText\(file\.size\)\}, more than ecosys can import \(\$\{mbText\(MAX_BACKUP_BYTES\)\}\)\.`/);
  assert.doesNotMatch(body, /too large to be an ecosys backup/, 'the old message blamed the file');
  assert.match(body, /Couldn’t read that file\. Try choosing it again\./);
  assert.match(body, /couldn’t be read and \$\{dropped === 1 \? 'was' : 'were'\} left out/, 'skipped records are counted');
});

test('the import confirm lists every collection it replaces, folders included', () => {
  const body = fnBody('importBackupFile');
  assert.match(body, /const kinds = COLLECTIONS\.filter\(\(k\) => Array\.isArray\(src\[k\]\)\);/);
  assert.match(SHELL, /import \{[^}]*\bCOLLECTIONS\b[^}]*\} from '\.\/sanitize\.js';/);
  assert.match(read('shared/sanitize.js'), /export const COLLECTIONS = \['tasks', 'lists', 'events', 'calendars', 'notes', 'folders'\];/);
});

test('Erase everything, Start over and Import say a safety copy is kept, when ecosys holds the data', () => {
  const body = fnBody('openSettings');
  assert.match(body, /\$\{shared \? safetyCopy\('what is erased'\) : ''\}/);
  assert.match(body, /\$\{shared \? safetyCopy\('what is replaced'\) : ''\}/);
  assert.match(fnBody('importBackupFile'), /safetyCopy\('what it replaces'\)/);
  assert.match(SHELL, /const safetyCopy = \(what\) => ` A safety copy of \$\{what\} is kept on this computer, in the backups folder of the ecosys data folder\.`;/);
  assert.match(read('server/store.mjs'), /this\.backupDir = join\(dir, 'backups'\)/, 'where the server keeps them');
});

test('Settings > Notes uses Notes’ own labels, and links to Connect AI for everything else', () => {
  const body = fnBody('openSettings');
  const notes = read('notes/app.js');
  assert.match(body, /row\('Sort checked items', seg\('notesCheckedSort', \[\['auto', 'Automatically'\], \['manual', 'Manually'\]\], 'Sort checked items'\)\)/);
  assert.match(body, /row\('AI assistants can', seg\('notesAi', \[\['edit', 'Read & edit'\], \['read', 'Read'\], \['off', 'Off'\]\], 'AI access to notes'\)\)/);
  // The same words as Notes' settings sheet.
  assert.match(notes, /row\('Sort checked items', seg\('notesCheckedSort', \[\['auto', 'Automatically'\], \['manual', 'Manually'\]\]/);
  assert.match(notes, /row\('AI assistants can', seg\('notesAi', \[\['edit', 'Read & edit'\], \['read', 'Read'\], \['off', 'Off'\]\]/);
  assert.doesNotMatch(body, /row\('AI access'/, '"AI access" is Connect AI’s switch for everything');
  assert.doesNotMatch(body, /Move checked items to the bottom/);
  assert.match(body, /<button type="button" data-action="ai"[^>]*>Connect AI<\/button> allows everywhere/, 'a way to the switch for everything');
});

test('Settings > Schedule has working hours, read as the server’s 09:00–17:00 while unset', () => {
  const body = fnBody('openSettings');
  assert.match(body, /timeField\(\{ name: 'scheduleWorkStart'/);
  assert.match(body, /timeField\(\{ name: 'scheduleWorkEnd', value: settingOf\(s, 'scheduleWorkEnd'\), base: settingOf\(s, 'scheduleWorkStart'\)/);
  assert.match(body, /AI assistants plan tasks and look for free time within your working hours\./);
  assert.match(SHELL, /scheduleWorkStart: '09:00', scheduleWorkEnd: '17:00'/);
  const core = read('server/core.mjs');
  assert.match(core, /let workStart = setStart \|\| '09:00';/);
  assert.match(core, /let workEnd = setEnd \|\| '17:00';/);
});

test('the app switcher takes its five columns from ui.css', () => {
  const body = fnBody('openSwitcher');
  assert.doesNotMatch(body, /grid-template-columns|minWidth/, 'no inline grid');
  assert.match(read('shared/ui.css'), /\.switcher-grid \{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
});

test('Home’s blurb in APPS says what Home is now: the apps', () => {
  assert.match(SHELL, /\{ id: 'home', name: 'Home', url: BASE, blurb: 'All your apps' \}/);
});
