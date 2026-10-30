import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrapMean, mulberry32 } from '../src/research/Bootstrap.js';

/**
 * Null simulations for the corrected bootstrap inference.
 *
 * A p-value is only a p-value if it is uniformly distributed under the null (or conservative). These tests
 * simulate data where the TRUE edge is zero and where it is positive, exactly as required before trusting
 * anything downstream (Holm correction, promotion gate) that consumes `pValue`.
 */

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

/** Standard normal draws from a seeded PRNG (Box-Muller). */
function normalRng(seed: number): () => number {
  const rand = mulberry32(seed);
  return () => {
    let u = rand();
    if (u < 1e-12) u = 1e-12;
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** Simulated ledger: `clusters` UTC days, `perCluster` trades per day, each trade N(mu, sigma). */
function simulateClusters(mu: number, sigma: number, clusters: number, perCluster: number, seed: number) {
  const z = normalRng(seed);
  const samples: { value: number; cluster: string }[] = [];
  for (let d = 0; d < clusters; d += 1) {
    const day = new Date(T0 + d * 86_400_000).toISOString().slice(0, 10);
    for (let k = 0; k < perCluster; k += 1) {
      samples.push({ value: mu + sigma * z(), cluster: day });
    }
  }
  return samples;
}

test('under a true zero edge, the null-centered bootstrap p-value is close to uniform (level check)', () => {
  const REPLICATIONS = 300;
  const ALPHA = 0.05;
  let rejections = 0;
  for (let i = 0; i < REPLICATIONS; i += 1) {
    const samples = simulateClusters(0, 1, 20, 8, 10_000 + i);
    const summary = bootstrapMean(samples, { iterations: 600, seed: 500 + i })!;
    if (summary.pValue < ALPHA) rejections += 1;
  }
  const rate = rejections / REPLICATIONS;
  // Expected 5%; binomial 3-sigma at p=0.05, n=300 is ~0.046, so 0.11 is a safe deterministic bound.
  assert.ok(rate < 0.11, `false-positive rate ${rate.toFixed(3)} should be near the 5% nominal level, not inflated`);
  assert.ok(rate > 0.005, `false-positive rate ${rate.toFixed(3)} should not be pathologically conservative`);
});

test('under a true zero edge, the sign-flip p-value is also near the nominal level', () => {
  const REPLICATIONS = 300;
  const ALPHA = 0.05;
  let rejections = 0;
  for (let i = 0; i < REPLICATIONS; i += 1) {
    const samples = simulateClusters(0, 1, 20, 8, 20_000 + i);
    const summary = bootstrapMean(samples, { iterations: 600, seed: 700 + i })!;
    if (summary.pValueSignFlip < ALPHA) rejections += 1;
  }
  const rate = rejections / REPLICATIONS;
  assert.ok(rate < 0.11, `sign-flip false-positive rate ${rate.toFixed(3)} should be near 5%, not inflated`);
});

test('a genuine edge produces small p-values: power check', () => {
  const REPLICATIONS = 200;
  // mu = 0.3R, sigma = 1R, n = 160: a t-stat of ~3.8 — the test should reject almost always.
  let rejections = 0;
  for (let i = 0; i < REPLICATIONS; i += 1) {
    const samples = simulateClusters(0.3, 1, 20, 8, 30_000 + i);
    const summary = bootstrapMean(samples, { iterations: 600, seed: 900 + i })!;
    if (summary.pValue < 0.05) rejections += 1;
  }
  const power = rejections / REPLICATIONS;
  assert.ok(power > 0.95, `power ${power.toFixed(3)} should be near 1 for a 0.3R edge over 1R noise at n=160`);
});

test('the old (uncentered) semantics would have reported a tiny p-value on a marginal edge; the corrected test does not', () => {
  // n = 40, mu = 0.08R, sigma = 1R: t ~ 0.51 — nowhere near significant. probPositive (a bootstrap summary of
  // the observed data) can still look optimistic; the null-centered p-value must stay large.
  const samples = simulateClusters(0.08, 1, 10, 4, 42);
  const summary = bootstrapMean(samples, { iterations: 4000, seed: 7 })!;
  assert.ok(summary.probPositive > summary.pValue, 'the data summary is always more optimistic than the null test');
  assert.ok(summary.pValue > 0.2, `p-value ${summary.pValue.toFixed(3)} must reflect that a t~0.5 edge is noise`);
});

test('p-values scale monotonically with the strength of the edge', () => {
  const pAt = (mu: number): number => {
    const samples = simulateClusters(mu, 1, 20, 8, 777);
    return bootstrapMean(samples, { iterations: 2000, seed: 21 })!.pValue;
  };
  const p0 = pAt(0);
  const pWeak = pAt(0.1);
  const pStrong = pAt(0.4);
  assert.ok(pStrong < pWeak, `stronger edge must yield smaller p (${pStrong.toFixed(3)} < ${pWeak.toFixed(3)})`);
  assert.ok(pWeak <= p0, `any edge must not increase p vs the null case (${pWeak.toFixed(3)} <= ${p0.toFixed(3)})`);
  assert.ok(p0 > 0.25, `a zero-mean sample must yield a large p-value, got ${p0.toFixed(3)}`);
});

test('skewed payoff distributions (many small losses, rare big wins) do not break the null test', () => {
  // 85% of trades lose -0.3R, 15% win +1.7R: mean = 0 exactly. A naive p-value construction collapses here;
  // the null-centered bootstrap must keep the false positive under control.
  const REPLICATIONS = 200;
  let rejections = 0;
  for (let i = 0; i < REPLICATIONS; i += 1) {
    const rand = mulberry32(50_000 + i);
    const samples: { value: number; cluster: string }[] = [];
    for (let d = 0; d < 20; d += 1) {
      const day = new Date(T0 + d * 86_400_000).toISOString().slice(0, 10);
      for (let k = 0; k < 10; k += 1) {
        samples.push({ value: rand() < 0.85 ? -0.3 : 1.7, cluster: day });
      }
    }
    const summary = bootstrapMean(samples, { iterations: 600, seed: 600 + i })!;
    if (summary.pValue < 0.05) rejections += 1;
  }
  const rate = rejections / REPLICATIONS;
  assert.ok(rate < 0.12, `skewed zero-mean data must not inflate false positives (rate ${rate.toFixed(3)})`);
});
