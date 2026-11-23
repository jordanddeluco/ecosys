// QA security: the one-click Claude Desktop install promises to keep every other key of the user's
// claude_desktop_config.json. It parses the file with safeParse(), which drops keys named
// "__proto__", "constructor" and "prototype" at every depth, so an MCP server called "prototype" or
// an env var called "constructor" silently disappears from the user's config (a .bak is kept).
// Only fake config paths in a temp folder are used.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installClaudeDesktop } from '../../server/install.mjs';
import { createScope } from './_harness.js';

const T = { keys: 'The Claude Desktop installer silently deletes config keys named "prototype" or "constructor" (another MCP server, an env var)' };

describe('QA security: Claude Desktop config merge', () => {
  const scope = createScope('qa-install');
  after(() => scope.cleanup());

  test('every key of the existing config survives the install, whatever its name', { todo: T.keys }, () => {
    const dir = join(scope.tempDir('cfg'), 'Claude');
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, 'claude_desktop_config.json');
    const before = {
      mcpServers: {
        prototype: { command: 'node', args: ['C:/tools/prototype-server.js'] },
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { constructor: 'keep-me', GITHUB_TOKEN: 'x' } },
      },
      globalShortcut: 'Ctrl+Space',
    };
    writeFileSync(cfg, JSON.stringify(before, null, 2));
    installClaudeDesktop({ nodePath: process.execPath, bridgePath: 'C:/ecosys/mcp/stdio-bridge.mjs', clientId: 'abc123', paths: [cfg] });
    const after2 = JSON.parse(readFileSync(cfg, 'utf8'));
    assert.ok(after2.mcpServers.ecosys, 'ecosys was added (control)');
    assert.equal(after2.globalShortcut, 'Ctrl+Space', 'plain keys are kept (control)');
    assert.deepEqual(Object.keys(after2.mcpServers).sort(), ['ecosys', 'github', 'prototype']);
    assert.deepEqual(Object.keys(after2.mcpServers.github.env).sort(), ['GITHUB_TOKEN', 'constructor']);
  });
});
