// QA (server fix): on Windows the data folder (AI keys, all data) is private to this user.
//  - A data folder ecosys creates gets no inherited permissions: full control for this user, SYSTEM
//    and Administrators only (what's inside inherits exactly that).
//  - An existing data folder (made by an older version, or by hand) is made private at every start,
//    files already in it included.
//  - When Everyone, Authenticated Users or Users can still open it (an entry set on the folder
//    itself), start-up logs one warning, and never fails.
// The ACL is read as SDDL (icacls /save), which names accounts the same in every language. Only
// fresh temp folders are used.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AIStore } from '../../server/ai-store.mjs';
import { createCore } from '../../server/core.mjs';
import { makeDirPrivate, broadAccess } from '../../server/util.mjs';
import { createScope, captureLog } from './_harness.js';

const WIN = process.platform === 'win32';
const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const silent = { error() {}, warn() {}, info() {}, log() {} };

/** The folder's ACL as SDDL ACEs: [{type, flags, sid}]. */
function aces(dir, scope) {
  const file = join(scope.tempDir('sddl'), 'acl.txt');
  execFileSync(join(sys, 'icacls.exe'), [dir, '/save', file], { windowsHide: true, stdio: 'ignore' });
  const sddl = readFileSync(file).toString('utf16le');
  return [...sddl.matchAll(/\((\w+);([^;()]*);[^;()]*;[^;()]*;[^;()]*;([^;()]+)\)/g)].map((m) => ({ type: m[1], flags: m[2], sid: m[3] }));
}
const userSid = () => /"(S-1-[0-9-]+)"/.exec(execFileSync(join(sys, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }))[1];
const BROAD = new Set(['WD', 'AU', 'BU', 'S-1-1-0', 'S-1-5-11', 'S-1-5-32-545']);

/** The ACL is private: nothing inherited, and only this user, SYSTEM and Administrators are let in. */
function assertPrivate(dir, scope, what) {
  const list = aces(dir, scope);
  assert.ok(list.length > 0, `${what}: the ACL could be read`);
  assert.deepEqual(list.filter((a) => a.flags.includes('ID')), [], `${what}: nothing is inherited from the parent folder`);
  const allowed = new Set(list.filter((a) => a.type === 'A').map((a) => a.sid));
  assert.deepEqual([...allowed].sort(), [userSid(), 'BA', 'SY'].sort(), `${what}: only this user, SYSTEM and Administrators`);
}

describe('QA server: a private data folder on Windows', { skip: !WIN && 'Windows ACLs only' }, () => {
  const scope = createScope('qa-acl');
  after(() => scope.cleanup());

  test('a data folder ecosys creates gets a private ACL, and the files in it inherit only that', () => {
    const dataDir = join(scope.tempDir('new'), '.ecosys');
    const ai = new AIStore({ dir: dataDir, log: silent });
    ai.createClient({ kind: 'claude' });
    assertPrivate(dataDir, scope, 'the new data folder');
    const fileAces = aces(join(dataDir, 'ai.json'), scope);
    assert.ok(fileAces.every((a) => !BROAD.has(a.sid)), `ai.json lets in no broad group: ${JSON.stringify(fileAces)}`);
  });

  test('an existing data folder is made private when ecosys starts, files already in it included', async () => {
    const dataDir = join(scope.tempDir('old'), '.ecosys');
    mkdirSync(dataDir, { recursive: true }); // like an older version: whatever the parent passes down
    writeFileSync(join(dataDir, 'ai.json'), '{}');
    assert.ok(aces(dataDir, scope).some((a) => a.flags.includes('ID')), 'control: the folder starts with inherited entries');
    const log = captureLog();
    const core = await createCore({ dataDir, log });
    core.close();
    assertPrivate(dataDir, scope, 'the data folder after start-up');
    assert.ok(aces(join(dataDir, 'ai.json'), scope).every((a) => !BROAD.has(a.sid) && (a.type !== 'A' || [userSid(), 'BA', 'SY'].includes(a.sid))), 'ai.json now inherits the private ACL');
    assert.deepEqual(log.entries.filter((e) => e.level === 'warn'), [], 'no warning when the folder could be made private');
  });

  test('Everyone still let in by an entry on the folder itself: one warning at start, and ecosys still starts', async () => {
    const dataDir = join(scope.tempDir('broad'), '.ecosys');
    mkdirSync(dataDir, { recursive: true });
    assert.equal(makeDirPrivate(dataDir).ok, true);
    execFileSync(join(sys, 'icacls.exe'), [dataDir, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true, stdio: 'ignore' });
    assert.deepEqual(broadAccess(dataDir), ['Everyone']);
    const log = captureLog();
    const core = await createCore({ dataDir, log });
    try {
      assert.ok(core.store, 'start-up went on');
      const warnings = log.entries.filter((e) => e.level === 'warn').map((e) => e.text);
      assert.equal(warnings.length, 1, warnings.join('\n'));
      assert.match(warnings[0], /Everyone can still open the data folder/);
    } finally {
      core.close();
    }
  });

  test('a folder whose ACL cannot be set gives an error result, never a throw', () => {
    const r = makeDirPrivate(join(scope.tempDir('gone'), 'does-not-exist'));
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.equal(broadAccess(join(scope.tempDir('gone2'), 'does-not-exist')), null);
  });
});
