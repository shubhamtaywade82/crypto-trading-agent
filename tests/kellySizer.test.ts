import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/research/Bootstrap.js';
import { kellyBinary, kellyLogOptimal, estimateKelly, type KellySample } from '../src/risk/KellySizer.js';

test('kellyBinary computes the closed form f* = (bp - q) / b', () => {
  // Even payoff, 60% win: f* = (1*0.6 - 0.4)/1 = 0.20
  assert.ok(Math.abs(kellyBinary({ winRate: 0.6, payoffRatio: 1 }) - 0.2) < 1e-12);
  // 2:1 payoff, 40% win: f* = (2*0.4 - 0.6)/2 = 0.10
  assert.ok(Math.abs(kellyBinary({ winRate: 0.4, payoffRatio: 2 }) - 0.1) < 1e-12);
  // Negative edge clamps to zero — Kelly never bets on a losing game.
  assert.equal(kellyBinary({ winRate: 0.4, payoffRatio: 1 }), 0);
});

test('kellyLogOptimal matches the closed form on a binary payoff distribution', () => {
  // 60% +1R, 40% -1R: empirical optimum should sit at ~0.20.
  const netRs: number[] = [];
  for (let i = 0; i < 3000; i += 1) netRs.push(i % 10 < 6 ? 1 : -1);
  const result = kellyLogOptimal(netRs);
  assert.ok(Math.abs(result.fraction - 0.2) < 0.02, `got ${result.fraction}`);
  assert.ok(result.interior);
  // Expected log growth at f* = 0.2: 0.6*ln(1.2) + 0.4*ln(0.8) ≈ 0.0201
  assert.ok(Math.abs(result.expectedLogGrowth - 0.0201) < 0.002);
});

test('kellyLogOptimal returns zero for a negative-expectancy distribution', () => {
  const netRs = [1, -1, -1, 1, -1, -1, 1, -1, -1, -1]; // mean -0.2R
  const result = kellyLogOptimal(netRs);
  assert.equal(result.fraction, 0);
  assert.equal(result.interior, false);
});

test('kellyLogOptimal never recommends a fraction that is ruined by the worst observed trade', () => {
  // Contains a -10R outlier: any f >= 0.1 sends 1 + f*(-10) <= 0, so the grid can never choose it.
  const netRs = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -10];
  const result = kellyLogOptimal(netRs);
  assert.ok(result.fraction < 0.1, `fraction ${result.fraction} would have been ruined by the -10R trade`);
});

test('estimateKelly grades evidence and bootstraps the interval', () => {
  // Strong binary edge: 60% +1R / 40% -1R over 400 trades, 10 trades per day-cluster (mixed within cluster).
  const rand = mulberry32(99);
  const samples: KellySample[] = Array.from({ length: 400 }, (_, i) => ({
    netR: rand() < 0.6 ? 1 : -1,
    cluster: `day-${Math.floor(i / 10)}`,
  }));
  const est = estimateKelly(samples, { iterations: 400, seed: 5 });
  assert.equal(est.evidence, 'POSITIVE_EDGE');
  // For binary ±1R payoffs the log-optimal fraction is exactly 2p - 1 where p is the SAMPLE win rate.
  const expected = 2 * est.winRate - 1;
  assert.ok(Math.abs(est.kellyLogOptimal - expected) < 0.005, `log-optimal ${est.kellyLogOptimal} vs 2p-1 ${expected}`);
  assert.ok(est.ciLow > 0, `CI low ${est.ciLow} should be positive for a strong edge`);
  assert.ok(est.halfKelly > 0 && est.quarterKelly > 0);
  assert.ok(est.halfKelly < est.kellyLogOptimal && est.quarterKelly < est.halfKelly);
});

test('estimateKelly flags a negative-edge series as UNCERTAIN with zero-worthy recommendations', () => {
  const samples: KellySample[] = Array.from({ length: 200 }, (_, i) => ({
    netR: i % 10 < 4 ? 1 : -1, // 40% win rate at 1:1 — negative expectancy
    cluster: `day-${i % 20}`,
  }));
  const est = estimateKelly(samples, { iterations: 200, seed: 7 });
  assert.equal(est.evidence, 'UNCERTAIN');
  assert.ok(est.meanNetR < 0);
  assert.equal(est.kellyLogOptimal, 0);
  assert.ok(est.warnings.some((w) => /correct Kelly bet is zero/.test(w)));
});

test('estimateKelly reports INSUFFICIENT_DATA below 30 trades', () => {
  const samples: KellySample[] = Array.from({ length: 29 }, (_, i) => ({ netR: i % 2 === 0 ? 1 : -1 }));
  const est = estimateKelly(samples, { iterations: 100, seed: 3 });
  assert.equal(est.evidence, 'INSUFFICIENT_DATA');
  assert.ok(est.warnings.some((w) => /n=29/.test(w)));
});

test('estimateKelly is deterministic for a fixed seed', () => {
  const samples: KellySample[] = Array.from({ length: 150 }, (_, i) => ({
    netR: i % 3 === 0 ? 0.8 : -0.4,
    cluster: `day-${i % 15}`,
  }));
  const a = estimateKelly(samples, { iterations: 200, seed: 11 });
  const b = estimateKelly(samples, { iterations: 200, seed: 11 });
  assert.deepEqual(a, b);
});
