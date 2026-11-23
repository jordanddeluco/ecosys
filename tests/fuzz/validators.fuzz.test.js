// Property/fuzz tests for the shared/sanitize.js validators: validateItem (every collection),
// validateCollection, validateOp, validateOps, validateSnapshot, validateSettingsPatch.
//
// The same properties run twice:
//   - in this process with notes/core/schema.js registered (as in the notes app and Home), and
//   - in a child process with the stage-1 schemas only (shared/sanitize.js on its own, as the
//     server's loader imports it; every app page gets the notes schema too, from shared/store.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SEED, runs, forAll, shrinkString, shrinkValue, reproduce, show } from './lib/harness.js';
import { runChildProps, reportChild } from './lib/child.js';

const schemaUrl = new URL('../../notes/core/schema.js', import.meta.url);
let notesSchema = 'absent (notes/core/schema.js not found)';
if (existsSync(schemaUrl)) {
  try {
    await import(schemaUrl.href);
    notesSchema = 'registered';
  } catch (err) {
    notesSchema = `import failed: ${err?.message}`;
  }
}
const P = await import('./lib/validator-props.js');
const S = await import('../../shared/sanitize.js');

console.log(`# validators fuzz: seed ${SEED}, notes schema in this process: ${notesSchema} (reproduce: ${reproduce()})`);

const SHRINK = { string: shrinkString, value: shrinkValue };
const label = notesSchema === 'registered' ? 'notes schema registered' : 'stage-1 schema';

for (const p of P.properties) {
  test(`[${label}] ${p.name}`, (t) => {
    if (p.test) return p.test();
    const r = forAll(p.name, { runs: runs(p.runs), gen: p.gen, prop: p.prop, shrink: SHRINK[p.shrink], display: p.display });
    t.diagnostic(`seed=${SEED} cases=${r.runs} discarded=${r.discards}`);
  });
}

test(`[${label}] JSON.parse'd "__proto__" / "constructor" keys never reach outputs or prototypes`, () => {
  const raw = P.parsedPollution();
  assert.ok(Object.hasOwn(raw, '__proto__'), 'JSON.parse keeps __proto__ as an own key');
  for (const c of S.COLLECTIONS) {
    const out = S.validateItem(c, raw);
    if (out) {
      assert.ok(!Object.hasOwn(out, '__proto__') && !Object.hasOwn(out, 'constructor'), `${c}: forbidden key kept`);
      P.checkRecord(c, out);
    }
  }
  const op = S.validateOp(JSON.parse('{"op":"put","c":"tasks","item":{"id":"a1","__proto__":{"polluted":true}},"__proto__":{"op":"del"}}'));
  assert.equal(op?.op, 'put');
  const snap = S.validateSnapshot(JSON.parse('{"__proto__":{"tasks":[{"id":"p1"}]},"tasks":[{"id":"t1"}],"settings":{"__proto__":{"theme":"dark"},"constructor":{"prototype":{"x":1}}}}'));
  assert.deepEqual(snap.data.tasks.map((x) => x.id), ['t1']);
  assert.deepEqual(snap.settings, {});
  P.assertNoPollution();
});

test('[stage-1 schema, as the server loads shared/sanitize.js] validator properties in a child process', async (t) => {
  const report = await runChildProps(new URL('./lib/validator-props.js', import.meta.url));
  assert.equal(report.env?.notesSchema, false, `the child process unexpectedly has the notes schema: ${show(report.env)}`);
  await reportChild(t, report, 'stage-1 schema');
});

test('extendSchema / extendSettingsSchema with prototype names (isolated child process)', async (t) => {
  const report = await runChildProps(new URL('./lib/extend-schema-props.js', import.meta.url));
  await reportChild(t, report, 'isolated');
});
