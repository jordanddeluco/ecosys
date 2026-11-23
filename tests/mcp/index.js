// Entry point for `node --test tests/mcp/`.
// Node 24 does not expand a directory given to --test: it runs the path as a module, which resolves
// to this file. Importing every suite here runs them one after another in a single process, so at
// most one isolated ecosys server (and one stdio bridge) is alive at a time.
// Every *.test.js file in this folder is loaded (the original four first, then the rest
// alphabetically), so a new suite needs no registration here. helpers.js is not a test file.
// Each file also runs on its own, e.g. `node --test tests/mcp/tools.test.js`, or all of them in
// parallel processes with `node --test "tests/mcp/*.test.js"`.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIRST = ['http-conformance.test.js', 'tools.test.js', 'stdio.test.js', 'notes-tools.test.js'];
const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((n) => n.endsWith('.test.js'));
for (const f of [...FIRST.filter((n) => files.includes(n)), ...files.filter((n) => !FIRST.includes(n)).sort()]) {
  await import(pathToFileURL(join(here, f)).href);
}
