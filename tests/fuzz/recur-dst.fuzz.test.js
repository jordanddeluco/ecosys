// Occurrence math across DST transitions: shared/dates.js, shared/recur.js and the relative dates of
// shared/nlp.js, checked against a TZ-independent day-arithmetic oracle, each zone in its own child
// process (TZ must be set before the process starts). Zones: America/New_York and Europe/London
// (required), plus America/Sao_Paulo (DST used to start at midnight, so local midnight did not
// exist), Australia/Lord_Howe (30-minute DST shift) and UTC (no DST).
//
//   FUZZ_ZONES=Europe/London,Asia/Tokyo node --test tests/fuzz/recur-dst.fuzz.test.js
import { test } from 'node:test';
import { SEED, reproduce } from './lib/harness.js';
import { runChildProps, reportChild } from './lib/child.js';

const ZONES = (process.env.FUZZ_ZONES || 'America/New_York,Europe/London,America/Sao_Paulo,Australia/Lord_Howe,UTC').split(',').map((s) => s.trim()).filter(Boolean);
console.log(`# recur-dst fuzz: seed ${SEED}, zones ${ZONES.join(', ')} (reproduce: ${reproduce()})`);

for (const tz of ZONES) {
  test(`recurrence and date math in TZ=${tz}`, async (t) => {
    const report = await runChildProps(new URL('./lib/recur-props.js', import.meta.url), { env: { TZ: tz } });
    await reportChild(t, report, `TZ=${tz}`);
  });
}
