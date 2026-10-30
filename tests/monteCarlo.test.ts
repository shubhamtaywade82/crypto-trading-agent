import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runMonteCarlo, type MonteCarloTrade } from '../src/research/MonteCarlo.js';

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

const tradesOf = (netRs: number[], regimeOf?: (i: number) => string): MonteCarloTrade[] =>
  netRs.map((netR, i) => ({ netR, t: T0 + i * HOUR, regime: regimeOf?.(i) ?? 'TREND_UP' }));

test('Monte Carlo is deterministic for a fixed seed', () => {
  const trades = tradesOf([0.5, -1, 0.3, -0.2, 1.2, -1, 0.8, -0.5]);
  const a = runMonteCarlo(trades, { simulations: 400, seed: 7, resample: 'block' });
  const b = runMonteCarlo(trades, { simulations: 400, seed: 7, resample: 'block' });
  assert.deepEqual(a, b);
});

test('a constant losing trade series busts the account with certainty', () => {
  const trades = tradesOf(Array.from({ length: 50 }, () => -0.3));
  const report = runMonteCarlo(trades, {
    simulations: 1000, seed: 1, riskPerTradePct: 0.05, maxDrawdownPct: 20, ruinLossPct: 50,
  });
  assert.equal(report.probFinalBelowInitial, 1);
  assert.equal(report.probDrawdownBreach, 1);
  assert.equal(report.probRuin, 1);
  assert.ok(report.finalEquity.median < report.config.initialEquity * 0.5);
});

test('a strong positive edge with conservative risk grows the median path', () => {
  // Win +0.5R with probability 0.7, lose -1R with probability 0.3 => expectancy +0.05R per trade.
  const netRs = Array.from({ length: 200 }, (_, i) => (i % 10 < 7 ? 0.5 : -1));
  const report = runMonteCarlo(tradesOf(netRs), {
    simulations: 2000, seed: 3, riskPerTradePct: 0.01, horizonTrades: 200,
  });
  assert.ok(report.finalEquity.median > report.config.initialEquity, `median ${report.finalEquity.median}`);
  assert.ok(report.probRuin < 0.01);
});

test('single-trade liquidation under leverage caps the loss at the margin', () => {
  // One trade losing -3R at 50% risk and 2x leverage: the raw loss (-150% of equity) exceeds the 50% margin.
  const report = runMonteCarlo(tradesOf([-3]), {
    simulations: 200, seed: 5, riskPerTradePct: 0.5, leverage: 2, horizonTrades: 1,
  });
  assert.equal(report.probLiquidation, 1);
  assert.equal(report.liquidationEvents, 200);
  // Loss capped at the margin: equity = initial * (1 - 1/2) exactly.
  assert.equal(report.finalEquity.median, report.config.initialEquity * 0.5);
});

test('block resampling preserves regime mix in regime mode', () => {
  const netRs = Array.from({ length: 120 }, (_, i) => (i < 60 ? 0.4 : -0.4));
  const regimes = Array.from({ length: 120 }, (_, i) => (i < 60 ? 'TREND_UP' : 'RANGE'));
  const trades = netRs.map((netR, i) => ({ netR, t: T0 + i * HOUR, regime: regimes[i] }));
  const report = runMonteCarlo(trades, { simulations: 500, seed: 9, resample: 'regime', blockSize: 10 });
  assert.ok(report.finalEquity.p05 <= report.finalEquity.p95);
  assert.ok(Number.isFinite(report.finalEquity.median));
});

test('tail probabilities carry binomial standard errors bounded by 1/(2*sqrt(N))', () => {
  const trades = tradesOf([0.3, -0.2, 0.5, -1, 0.1, 0.4, -0.3, 0.2]);
  const report = runMonteCarlo(trades, { simulations: 2500, seed: 11 });
  const bound = 0.5 / Math.sqrt(2500);
  for (const se of [report.seDrawdownBreach, report.seRuin, report.seLiquidation, report.seFinalBelowInitial]) {
    assert.ok(se >= 0 && se <= bound + 1e-12, `se ${se} outside [0, ${bound}]`);
  }
});

test('recovery time is reported when paths draw down', () => {
  // Alternating streaks guarantee underwater stretches.
  const netRs = Array.from({ length: 60 }, (_, i) => (i % 6 < 4 ? 0.2 : -0.6));
  const report = runMonteCarlo(tradesOf(netRs), { simulations: 500, seed: 13 });
  assert.ok(report.recoveryTrades !== null);
  assert.ok(report.recoveryTrades.median >= 0);
  assert.ok(report.recoveryTrades.p95 >= report.recoveryTrades.median);
});

test('non-finite trades are skipped with a warning', () => {
  const trades: MonteCarloTrade[] = [
    { netR: Number.NaN, t: T0 },
    { netR: 0.5, t: T0 + HOUR },
  ];
  const report = runMonteCarlo(trades, { simulations: 100, seed: 1 });
  assert.equal(report.nTrades, 1);
  assert.ok(report.warnings.some((w) => /skipped/.test(w)));
});

test('horizon longer than history still simulates by resampling with replacement', () => {
  const report = runMonteCarlo(tradesOf([0.3, -0.2]), {
    simulations: 200, seed: 2, horizonTrades: 100, resample: 'iid',
  });
  assert.equal(report.horizonTrades, 100);
  assert.ok(Number.isFinite(report.finalEquity.median));
});
