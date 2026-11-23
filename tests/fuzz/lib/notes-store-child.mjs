// Child process for the notes integration checks. Reads canonical notes (JSON array) on stdin and
// prints, as one JSON line, what another process keeps of them:
//   node notes-store-child.mjs page     an app page that never loads the notes app (Tasks, Home…): only
//                                       shared/store.js is imported, as such a page does, with an
//                                       in-memory localStorage. The notes arrive as remote ops (sync)
//                                       and the results are what the store saved to localStorage.
//   node notes-store-child.mjs stage1   only shared/sanitize.js, on its own (its stage-1 notes schema;
//                                       no page validates with it alone since store.js registers the
//                                       notes data model) — kept for diagnostics
//   node notes-store-child.mjs server   a real server core (server/core.mjs createCore) on a fresh
//                                       temporary data directory, deleted afterwards; no port is opened
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv[2];
let input = '';
for await (const chunk of process.stdin) input += chunk;
const notes = JSON.parse(input);
const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
let out;
let dir = null;
try {
  if (mode === 'page') {
    const mem = new Map();
    const storage = {
      get length() {
        return mem.size;
      },
      key: (i) => [...mem.keys()][i] ?? null,
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => void mem.set(k, String(v)),
      removeItem: (k) => void mem.delete(k),
      clear: () => mem.clear(),
    };
    globalThis.window = new EventTarget();
    globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage });
    const store = await import('../../../shared/store.js');
    const S = await import('../../../shared/sanitize.js');
    console.warn = () => {}; // the store warns about records it could not validate; the parent reports them
    store.applyRemoteOps(notes.map((item) => ({ op: 'put', c: 'notes', item })));
    const saved = JSON.parse(storage.getItem('ecosys:v1:notes') || '[]');
    out = { ok: true, mode, fields: S.schemaFields('notes'), results: notes.map((n) => saved.find((x) => x.id === n.id) ?? null) };
  } else if (mode === 'stage1') {
    const S = await import('../../../shared/sanitize.js');
    out = { ok: true, mode, fields: S.schemaFields('notes'), results: notes.map((n) => S.validateItem('notes', n)) };
  } else if (mode === 'server') {
    dir = mkdtempSync(join(tmpdir(), 'ecosys-fuzz-'));
    const { createCore } = await import('../../../server/core.mjs');
    const core = await createCore({ dataDir: dir, log: silent });
    const S = await import('../../../shared/sanitize.js');
    out = { ok: true, mode, fields: S.schemaFields('notes'), results: notes.map((n) => core.validators.item('notes', n)) };
    await core.close?.();
  } else throw new Error(`unknown mode ${mode}`);
} catch (err) {
  out = { ok: false, mode, error: `${err?.name}: ${err?.message}` };
} finally {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
