// QA (server fix, second pass): the private data folder costs little at every start (Windows).
//  - A data folder that is private already (every start after the first) is only read: its ACL is not
//    set again, which would rewrite the ACL of every file inside (about a second for a few thousand
//    undo and backup files, on every server start and every stdio bridge launch).
//  - A folder that is not private (an entry for another account) is still made private, with a
//    warning when Everyone, Authenticated Users or Users can still open it.
// Each start is a fresh copy of server/util.mjs, as a new process would load it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const win = process.platform === 'win32';
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
let starts = 0;
/** server/util.mjs as a newly started process loads it (nothing cached from an earlier start). */
const freshUtil = () => import(`../../server/util.mjs?start=${++starts}`);
const icacls = (...args) => execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), args, { stdio: 'pipe', windowsHide: true });
const changeTime = (f) => statSync(f, { bigint: true }).ctimeNs;

test('an already private data folder is only read at start: the files inside keep their ACL untouched', { skip: !win && 'Windows only' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-acl-skip-'));
  dirs.push(dir);
  const warn = [];
  const log = { warn: (m) => warn.push(m) };
  assert.equal((await freshUtil()).secureDataDir(dir, log), true, 'first start: made private');
  mkdirSync(join(dir, 'changes'));
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, 'changes', `chg_${i}.json`), '{}');
  const file = join(dir, 'changes', 'chg_3.json');
  const before = changeTime(file);
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 2; i++) assert.equal((await freshUtil()).secureDataDir(dir, log), true, 'later start: private');
  assert.equal(changeTime(file), before, 'no ACL inside was rewritten (setting it again changes every file\'s change time)');
  assert.deepEqual(warn, []);
});

test('a data folder that let another group in is still made private again, and warned about when it stays open', { skip: !win && 'Windows only' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecosys-qa-acl-open-'));
  dirs.push(dir);
  const warn = [];
  const log = { warn: (m) => warn.push(m) };
  assert.equal((await freshUtil()).secureDataDir(dir, log), true);
  writeFileSync(join(dir, 'ai.json'), '{}');
  const file = join(dir, 'ai.json');
  // Not private any more: inheritance turned back on (the parent's entries flow in again).
  icacls(dir, '/inheritance:e');
  const before = changeTime(file);
  await new Promise((r) => setTimeout(r, 50));
  const util = await freshUtil();
  assert.equal(util.secureDataDir(dir, log), true, 'made private again');
  assert.notEqual(changeTime(file), before, 'its ACL was set again');
  assert.deepEqual(util.broadAccess(dir), []);
  // An explicit entry for Users on the folder itself is not ours to remove: warned about.
  icacls(dir, '/grant', '*S-1-5-32-545:(OI)(CI)RX');
  assert.equal((await freshUtil()).secureDataDir(dir, log), false);
  assert.match(warn.at(-1), /Users can still open the data folder/);
});
