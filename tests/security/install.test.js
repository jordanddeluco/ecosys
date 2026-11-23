// The one-click Claude Desktop installer (POST /api/ai/install/claude-desktop, server/install.mjs).
// It runs in a real `node server.mjs` child process whose HOME / USERPROFILE / APPDATA /
// LOCALAPPDATA / XDG_CONFIG_HOME point into a temp folder, so the real Claude Desktop config is
// never touched. Checks: it cannot be triggered cross-site (or through a tunnel, a proxy, DNS
// rebinding, a form post or another method), and when it does run it changes only the Claude config
// files (plus a backup each), keeps every other key, never writes the key, never runs a shell, and
// never removes or leaves behind other files.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync, chmodSync, unlinkSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { claudeDesktopConfigPaths } from '../../server/install.mjs';
import { createScope, spawnServer, request, api, snapshotTree, diffTrees, ensureDir, leaked, BRIDGE, sleep } from './_harness.js';

const WIN = process.platform === 'win32';
const ROUTE = '/api/ai/install/claude-desktop';
const OWN_BACKUP = /^claude_desktop_config\.json\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.bak$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function homeEnv(home) {
  return {
    USERPROFILE: home,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
  };
}

describe('Claude Desktop installer', () => {
  const scope = createScope('install');
  let home;
  let env;
  let primary;
  let msix = null;
  let decoy = null;
  let emptyPkgDir = null;
  let child;
  let L;
  const same = () => ({ origin: L, 'sec-fetch-site': 'same-origin' });
  const clientIds = async () => (await api(child, 'GET', '/api/ai')).json.clients.map((c) => c.id).sort();

  before(async () => {
    home = scope.tempDir('home');
    env = homeEnv(home);
    primary = claudeDesktopConfigPaths({ env, home })[0];
    ensureDir(dirname(primary));
    writeFileSync(primary, '﻿' + JSON.stringify({ preferences: { keep: true }, mcpServers: { other: { command: 'other-tool', args: ['--x'] } }, globalShortcut: 'Ctrl+Space' }, null, 2));
    if (WIN) {
      const pk = join(env.LOCALAPPDATA, 'Packages');
      msix = join(pk, 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
      ensureDir(dirname(msix));
      writeFileSync(msix, JSON.stringify({ mcpServers: {} }));
      decoy = join(pk, 'NotClaude_x', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
      ensureDir(dirname(decoy));
      writeFileSync(decoy, JSON.stringify({ decoy: true }));
      emptyPkgDir = ensureDir(join(pk, 'Claude_nocfg', 'LocalCache', 'Roaming', 'Claude'));
    }
    child = await spawnServer(scope, { env: { ...env, ECOSYS_ALLOWED_HOSTS: 'abc.trycloudflare.com' } });
    L = `http://127.0.0.1:${child.port}`;
  });
  after(() => scope.cleanup());

  test('cross-site, form, rebinding, tunnel and proxied attempts never run the installer', async () => {
    const P = child.port;
    const before = snapshotTree(home);
    const ids = await clientIds();
    // The Origin, Fetch Metadata, Host and relay attempts carry the real pairing secret: those checks hold on their own.
    const K = child.secret;
    const attacks = [
      ['no X-Ecosys header', {}],
      ['X-Ecosys: 1 (not paired)', { 'x-ecosys': '1' }],
      ['HTML form post', { 'content-type': 'application/x-www-form-urlencoded' }, 'clientId=x&access=write'],
      ['text/plain post from another site', { 'content-type': 'text/plain', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, '{}'],
      ['foreign Origin', { 'x-ecosys': K, origin: 'https://evil.example' }],
      ['Origin null', { 'x-ecosys': K, origin: 'null' }],
      ['Origin of another local port', { 'x-ecosys': K, origin: `http://localhost:${P + 1}` }],
      ['Sec-Fetch-Site: cross-site', { 'x-ecosys': K, 'sec-fetch-site': 'cross-site' }],
      ['Sec-Fetch-Site: same-site', { 'x-ecosys': K, 'sec-fetch-site': 'same-site' }],
      ['rebinding Host', { 'x-ecosys': K }, undefined, `evil.example:${P}`],
      ['tunnel Host', { 'x-ecosys': K }, undefined, 'abc.trycloudflare.com'],
      ['relayed (X-Forwarded-For)', { 'x-ecosys': K, 'x-forwarded-for': '203.0.113.9' }],
      ['relayed (Forwarded)', { 'x-ecosys': K, forwarded: 'for=203.0.113.9' }],
      ['relayed (CF-Connecting-IP)', { 'x-ecosys': K, 'cf-connecting-ip': '203.0.113.9' }],
    ];
    for (const [label, headers, body, host] of attacks) {
      const r = await request(P, { method: 'POST', path: ROUTE, headers, host, body: body ?? '{}' });
      assert.ok(r.status === 403 || r.status === 404, `${label} -> ${r.status} ${r.text.slice(0, 120)}`);
    }
    await sleep(100);
    assert.deepEqual(diffTrees(before, snapshotTree(home)), { added: [], removed: [], changed: [] }, 'no file changed in the home folder');
    assert.deepEqual(await clientIds(), ids, 'no connection was created');
  });

  test('other methods and look-alike paths cannot trigger it', async () => {
    const before = snapshotTree(home);
    const ids = await clientIds();
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const r = await api(child, method, ROUTE, method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? undefined : {}, same());
      assert.ok(r.status === 404 || r.status === 405, `${method} -> ${r.status}`);
    }
    for (const path of [`${ROUTE}/`, '/api/ai/install/Claude-Desktop', '/api/ai/install', '/api/ai/install/claude-desktop%2F', '/API/ai/install/claude-desktop']) {
      const r = await api(child, 'POST', path, {}, same());
      assert.ok(r.status === 404 || r.status === 405, `${path} -> ${r.status}`);
    }
    assert.deepEqual(diffTrees(before, snapshotTree(home)), { added: [], removed: [], changed: [] });
    assert.deepEqual(await clientIds(), ids);
  });

  test('a same-origin install changes only the Claude config files, adds one backup each, keeps other keys', async () => {
    const before = snapshotTree(home);
    const original = readFileSync(primary);
    const r = await api(child, 'POST', ROUTE, {}, same());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    const targets = [primary, msix].filter(Boolean);
    for (const p of [r.json.path, ...r.json.paths, ...r.json.backups]) assert.ok(p.startsWith(home), `wrote outside the temp home: ${p}`);
    const d = diffTrees(before, snapshotTree(home));
    const rel = (p) => relative(home, p);
    assert.deepEqual(d.changed, targets.map(rel).sort(), 'only the Claude config files changed');
    assert.deepEqual(d.removed, [], 'nothing was deleted');
    assert.equal(d.added.length, targets.length, `added: ${d.added.join(', ')}`);
    for (const p of targets) assert.ok(d.added.some((a) => new RegExp(`^${escapeRe(rel(dirname(p)))}[\\\\/]${escapeRe(basename(p))}\\.[0-9TZ-]+\\.bak$`).test(a)), `a backup next to ${rel(p)}`);
    const bak = r.json.backups.find((b) => dirname(b) === dirname(primary));
    assert.deepEqual(readFileSync(bak), original, 'the backup is the previous file, byte for byte');
    if (decoy) assert.deepEqual(JSON.parse(readFileSync(decoy, 'utf8')), { decoy: true }, 'other packages are not touched');
    if (emptyPkgDir) assert.deepEqual(readdirSync(emptyPkgDir), [], 'no config is created where Claude has none');
    assert.deepEqual([...snapshotTree(child.cwd).keys()], [], 'nothing was written to the working folder');

    const cfg = JSON.parse(readFileSync(primary, 'utf8'));
    assert.deepEqual(cfg.preferences, { keep: true });
    assert.deepEqual(cfg.mcpServers.other, { command: 'other-tool', args: ['--x'] });
    assert.equal(cfg.globalShortcut, 'Ctrl+Space');
    const entry = cfg.mcpServers.ecosys;
    assert.equal(entry.command, process.execPath, 'runs node directly');
    assert.ok(!/(^|[\\/])(cmd|powershell|pwsh|sh|bash|wscript|cscript|mshta)(\.exe)?$/i.test(entry.command), 'never a shell');
    assert.ok(Array.isArray(entry.args) && entry.args.every((a) => typeof a === 'string'), 'an argv array, not a command line');
    assert.equal(entry.args[0], BRIDGE, 'the first argument is the bridge script');
    assert.equal(entry.args[entry.args.indexOf('--client') + 1], r.json.clientId, 'names the connection by id');
    assert.equal(entry.args[entry.args.indexOf('--data') + 1], child.dataDir, 'points at this server\'s data folder');
    assert.ok(!entry.args.some((a) => /^-(e|p|-eval|-print|r|-require|-import)$/.test(a)), 'no node flags that run inline code');
    const key = r.json.client.token;
    for (const p of targets) assert.deepEqual(leaked(readFileSync(p, 'utf8'), [key]), [], `the key was written into ${rel(p)}`);
  });

  test('repeat installs keep one entry and one connection, and prune only the installer\'s own backups', async () => {
    const dir = dirname(primary);
    const userFiles = {
      'claude_desktop_config.json.2020-01-01.bak': 'my own dated backup',
      'claude_desktop_config.json.my-backup.bak': 'another of mine',
      'claude_desktop_config.json.orig': 'not a .bak',
      'notes.bak': 'unrelated',
    };
    for (const [n, c] of Object.entries(userFiles)) writeFileSync(join(dir, n), c);
    const ids = await clientIds();
    let last;
    for (let i = 0; i < 6; i++) {
      last = await api(child, 'POST', ROUTE, {}, same());
      assert.equal(last.status, 200, last.text);
      await sleep(5); // distinct millisecond stamps
    }
    assert.deepEqual(await clientIds(), ids, 'the Claude Desktop connection is reused');
    const cfg = JSON.parse(readFileSync(primary, 'utf8'));
    assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['ecosys', 'other']);
    const ours = readdirSync(dir).filter((n) => OWN_BACKUP.test(n));
    assert.ok(ours.length >= 1 && ours.length <= 5, `${ours.length} installer backups kept`);
    const lost = Object.entries(userFiles).filter(([n, c]) => !existsSync(join(dir, n)) || readFileSync(join(dir, n), 'utf8') !== c).map(([n]) => n);
    assert.deepEqual(lost, [], 'files the installer did not create were deleted or changed');
  });

  test('a config Windows will not let it replace (read-only) gets a clear error and leaves no temp file behind', { skip: WIN ? false : 'only Windows refuses to rename over a read-only file' }, async () => {
    const dir = dirname(primary);
    const content = readFileSync(primary);
    const tmpBefore = readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    chmodSync(primary, 0o444);
    let r;
    try {
      r = await api(child, 'POST', ROUTE, {}, same());
    } finally {
      chmodSync(primary, 0o666);
    }
    const stray = readdirSync(dir).filter((n) => n.endsWith('.tmp') && !tmpBefore.includes(n));
    assert.deepEqual(readFileSync(primary), content, 'the config is unchanged');
    const outcome = { refused: r.status >= 400, ok: r.json?.ok ?? null, error: r.json?.error ?? null, strayTempFiles: stray };
    for (const n of stray) {
      try {
        unlinkSync(join(dir, n));
      } catch {}
    }
    assert.ok(outcome.refused, `status ${r.status}`);
    assert.deepEqual(
      { ok: outcome.ok, genericError: outcome.error === 'Server error', strayTempFiles: outcome.strayTempFiles },
      { ok: false, genericError: false, strayTempFiles: [] },
      `status ${r.status}, body ${r.text.slice(0, 200)}`,
    );
  });

  test('without a Claude Desktop folder it says so and creates nothing', async () => {
    const bare = scope.tempDir('home-empty');
    const other = await spawnServer(scope, { env: homeEnv(bare) });
    const before = snapshotTree(bare);
    const r = await api(other, 'POST', ROUTE, {}, { origin: `http://127.0.0.1:${other.port}` });
    assert.equal(r.status, 404, r.text);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /does not seem to be installed/);
    assert.deepEqual(diffTrees(before, snapshotTree(bare)), { added: [], removed: [], changed: [] }, 'no folders or files were created');
    assert.deepEqual([...snapshotTree(other.cwd).keys()], []);
  });
});
