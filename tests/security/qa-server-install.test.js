// QA (server fix): the one-click Claude Desktop install keeps every other key of the user's config
// exactly: keys named "prototype", "constructor" or "__proto__" (another MCP server, an env var),
// numbers as written (a 20-digit id is not rounded), and a config that is a hard or symbolic link
// stays one (both names see the change). An "mcpServers" that is not an object is refused, untouched.
// Only fake config paths in temp folders are used.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, linkSync, symlinkSync, statSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { installClaudeDesktop, mergeConfig, bridgeEntry, InstallError } from '../../server/install.mjs';
import { createScope } from './_harness.js';

const entry = bridgeEntry({ nodePath: process.execPath, bridgePath: 'C:/ecosys/mcp/stdio-bridge.mjs', clientId: 'abc123' });

describe('QA server: Claude Desktop config merge keeps the user\'s config exactly', () => {
  const scope = createScope('qa-srv-install');
  after(() => scope.cleanup());
  const configDir = () => {
    const dir = join(scope.tempDir('cfg'), 'Claude');
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  test('keys named prototype, constructor and __proto__ survive, at every depth', () => {
    const cfg = join(configDir(), 'claude_desktop_config.json');
    writeFileSync(cfg, '{"mcpServers":{"prototype":{"command":"node","args":["p.js"]},"github":{"command":"npx","env":{"constructor":"keep-me","__proto__":"also","GITHUB_TOKEN":"x"}}},"__proto__":{"polluted":true},"globalShortcut":"Ctrl+Space"}');
    installClaudeDesktop({ ...{ nodePath: process.execPath, bridgePath: 'C:/ecosys/mcp/stdio-bridge.mjs', clientId: 'abc123' }, paths: [cfg] });
    const text = readFileSync(cfg, 'utf8');
    const after2 = JSON.parse(text);
    assert.deepEqual(Object.keys(after2.mcpServers).sort(), ['ecosys', 'github', 'prototype']);
    assert.deepEqual(Object.keys(after2.mcpServers.github.env).sort(), ['GITHUB_TOKEN', '__proto__', 'constructor'].sort());
    assert.match(text, /"__proto__": \{\s*"polluted": true\s*\}/, 'a top-level "__proto__" key is written back as a key');
    assert.equal({}.polluted, undefined, 'and nothing was polluted');
    assert.equal(after2.globalShortcut, 'Ctrl+Space');
  });

  test('numbers are written back exactly as they were', () => {
    const cfg = join(configDir(), 'claude_desktop_config.json');
    writeFileSync(cfg, '{"telemetryInstallId":12345678901234567890,"scale":1.0,"big":1e400,"mcpServers":{}}');
    mergeConfig(cfg, entry);
    const text = readFileSync(cfg, 'utf8');
    assert.match(text, /"telemetryInstallId": 12345678901234567890[,\n]/);
    assert.match(text, /"scale": 1\.0[,\n]/);
    assert.match(text, /"big": 1e400[,\n]/);
  });

  test('a hard-linked config is updated in place: both names see ecosys, the link stays', () => {
    const dir = configDir();
    const cfg = join(dir, 'claude_desktop_config.json');
    const other = join(scope.tempDir('dotfiles'), 'claude.json');
    writeFileSync(other, JSON.stringify({ mcpServers: { github: { command: 'npx' } } }));
    linkSync(other, cfg);
    assert.equal(statSync(cfg).nlink, 2, 'control: two links');
    mergeConfig(cfg, entry);
    assert.equal(statSync(cfg).nlink, 2, 'still one file with two names');
    assert.ok(JSON.parse(readFileSync(other, 'utf8')).mcpServers.ecosys, 'the other name sees the change');
    assert.ok(readdirSync(dir).some((n) => n.endsWith('.bak')), 'a backup was written first');
  });

  test('a config that is a symbolic link stays a link to the updated file', (t) => {
    const dir = configDir();
    const cfg = join(dir, 'claude_desktop_config.json');
    const real = join(scope.tempDir('dotfiles'), 'claude.json');
    writeFileSync(real, JSON.stringify({ mcpServers: {} }));
    try {
      symlinkSync(real, cfg, 'file');
    } catch (err) {
      return t.skip(`symbolic links are not allowed here (${err.code})`);
    }
    mergeConfig(cfg, entry);
    assert.ok(lstatSync(cfg).isSymbolicLink(), 'still a symbolic link');
    assert.ok(JSON.parse(readFileSync(real, 'utf8')).mcpServers.ecosys, 'the file it points to was updated');
  });

  test('an mcpServers that is not an object is refused and the file is left exactly as it was, without a backup', () => {
    const dir = configDir();
    const cfg = join(dir, 'claude_desktop_config.json');
    const before = '{"mcpServers":["not","an","object"],"x":1}';
    writeFileSync(cfg, before);
    assert.throws(() => mergeConfig(cfg, entry), (err) => err instanceof InstallError && err.status === 422 && /left untouched/.test(err.message));
    assert.equal(readFileSync(cfg, 'utf8'), before);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.bak')), []);
  });
});
