// Entry for `node --test tests/e2e/`. On Node 22+ a directory given to --test is loaded as a module
// (its index.js), not searched for test files, so this file pulls them all into one process. Each
// file keeps its hooks inside a describe() suite, so the suites run one after another: one server
// and one headless Chrome at a time, the leanest way to run the whole set.
// Every *.test.mjs file in this folder is loaded: the harness, smoke and flows suites first, then
// the rest alphabetically, so a new test file needs no registration here.
// (`node --test tests/e2e/*.test.mjs` runs the files as separate processes instead; the Chrome
// lock in cdp.mjs still keeps it to one browser at a time.)
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIRST = ['harness.test.mjs', 'smoke.test.mjs', 'flows.test.mjs'];
const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((n) => n.endsWith('.test.mjs'));
for (const f of [...FIRST.filter((n) => files.includes(n)), ...files.filter((n) => !FIRST.includes(n)).sort()]) {
  await import(pathToFileURL(join(here, f)).href);
}
