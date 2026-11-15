import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/research/Bootstrap.js';
import { buildSamples, FIELDS, HORIZONS, SECONDS } from '../src/research/OfiAnalysis.js';

/** Two days where each second's OFI pushes the mid 5 seconds later: the forward move must line up with OFI, never with the past. */
function series(seed: number): Float64Array[] {
  const rand = mulberry32(seed);
  const ofi = Array.from({ length: 2 * SECONDS }, () => rand() - 0.5);
  let mid = 100;
  const days = [new Float64Array(SECONDS * FIELDS), new Float64Array(SECONDS * FIELDS)];
  for (let i = 0; i < 2 * SECONDS; i += 1) {
    mid *= 1 + 1e-5 * (i >= 5 ? ofi[i - 5]! : 0) + 1e-6 * (rand() - 0.5);
    const r = days[Math.floor(i / SECONDS)]!; const o = (i % SECONDS) * FIELDS;
    r[o] = mid; r[o + 1] = 1; r[o + 2] = ofi[i]!; r[o + 3] = 1; r[o + 4] = rand(); r[o + 5] = rand();
  }
  return days;
}

test('should align the forward move with OFI and keep features causal', () => {
  const s = buildSamples(series(4));
  const k = HORIZONS.indexOf(10);
  let agree = 0;
  for (let i = 0; i < s.n; i += 1) if (Math.sign(s.ofi[i]!) === Math.sign(s.fwd[k]![i]!)) agree += 1;
  assert.ok(agree / s.n > 0.6, `agreement ${agree / s.n}`);
  assert.ok(s.n > SECONDS, 'enough samples');
});
