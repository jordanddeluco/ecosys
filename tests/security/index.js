// Entry point for `node --test tests/security/`. Node 24 treats a directory argument as a module
// path and loads this file, so it imports every suite; each suite is a describe() block with its
// own servers, temp folders and cleanup, and they run one after another in this process.
// Every *.test.js file in this folder is loaded (the original suites in their usual order first,
// then any others alphabetically), so a new suite needs no registration here. Files starting
// with "_" (helpers such as _harness.js) are never loaded as tests.
// The files also run on their own: `node --test tests/security/<name>.test.js`.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIRST = [
  'static-paths.test.js',
  'host-origin.test.js',
  'api-csrf.test.js',
  'mcp-auth.test.js',
  'token-leak.test.js',
  'headers-csp.test.js',
  'install.test.js',
  'bridge-fuzz.test.js',
];
const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((n) => n.endsWith('.test.js') && !n.startsWith('_'));
for (const f of [...FIRST.filter((n) => files.includes(n)), ...files.filter((n) => !FIRST.includes(n)).sort()]) {
  await import(pathToFileURL(join(here, f)).href);
}
