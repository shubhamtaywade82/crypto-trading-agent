import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/research/Bootstrap.js';
import {
  adfTest,
  correlation,
  engleGranger,
  halfLife,
  olsFit,
  runPairsStudy,
} from '../src/research/StatArb.js';

function normalRng(seed: number): () => number {
  const rand = mulberry32(seed);
  return () => {
    let u = rand();
    if (u < 1e-12) u = 1e-12;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
}

/** Random-walk price series. */
function randomWalk(n: number, seed: number, start = 100): number[] {
  const z = normalRng(seed);
  const out = [start];
  for (let i = 1; i < n; i += 1) out.push(Math.max(1, out[i - 1] + z()));
  return out;
}

/** Cointegrated pair: b is a random walk, a = 1.2*b + stationary AR(1) basis + const. */
function cointegratedPair(n: number, seed: number): { a: number[]; b: number[] } {
  const z = normalRng(seed);
  const b = randomWalk(n, seed + 1);
  let basis = 0;
  const a: number[] = [];
  for (let i = 0; i < n; i += 1) {
    basis = 0.75 * basis + z() * 1.5;
    a.push(1.2 * b[i] + basis + 40);
  }
  return { a, b };
}

test('olsFit recovers an exact linear relationship', () => {
  const x = [1, 2, 3, 4, 5];
  const y = x.map((v) => 2 * v + 1);
  const fit = olsFit(y, x)!;
  assert.ok(Math.abs(fit.alpha - 1) < 1e-10);
  assert.ok(Math.abs(fit.beta - 2) < 1e-10);
  assert.ok(fit.residuals.every((e) => Math.abs(e) < 1e-10));
  assert.ok(Math.abs(fit.r2 - 1) < 1e-12);
});

test('adfTest rejects a random walk and accepts a stationary series', () => {
  const walk = randomWalk(500, 1);
  assert.equal(adfTest(walk, 1, 2)?.cointegrated, false);

  // Stationary AR(1): x_t = 0.5 * x_{t-1} + eps
  const z = normalRng(2);
  const stationary: number[] = [];
  let prev = 0;
  for (let i = 0; i < 500; i += 1) {
    prev = 0.5 * prev + z();
    stationary.push(prev);
  }
  assert.equal(adfTest(stationary, 1, 2)?.cointegrated, true);
});

test('halfLife of a known AR(1) spread is recovered', () => {
  // x_t = 0.5*x_{t-1} + e => adjustment b = -0.5 => half-life = -ln2/ln(0.5) = 1 bar.
  const z = normalRng(3);
  const spread: number[] = [];
  let prev = 0;
  for (let i = 0; i < 5000; i += 1) {
    prev = 0.5 * prev + z();
    spread.push(prev);
  }
  const hl = halfLife(spread)!;
  assert.ok(Math.abs(hl.b + 0.5) < 0.05, `b ${hl.b}`);
  assert.ok(Math.abs(hl.halfLife! - 1) < 0.15, `half-life ${hl.halfLife}`);
});

test('halfLife shows (at best) weak, slow reversion for a random walk', () => {
  const hl = halfLife(randomWalk(500, 4))!;
  // A random walk has adjustment b ~ 0: any measured half-life must be long, never a crisp short value.
  assert.ok(hl.b > -0.1, `adjustment b ${hl.b} should be ~0 for a random walk`);
  assert.ok(hl.halfLife === null || hl.halfLife > 30, `half-life ${hl.halfLife}`);
});

test('engleGranger finds cointegration in a cointegrated pair', () => {
  const { a, b } = cointegratedPair(600, 5);
  const eg = engleGranger(a, b)!;
  assert.equal(eg.cointegrated, true);
  assert.ok(eg.adf.statistic < eg.adf.criticalValues['5%']);
  assert.ok(Math.abs(eg.ols.beta - 1.2) < 0.1, `beta ${eg.ols.beta}`);
  assert.ok(eg.halfLife !== null && eg.halfLife < 10);
  assert.ok(eg.correlation > 0.95);
});

test('engleGranger rejects two independent random walks', () => {
  const a = randomWalk(600, 6);
  const b = randomWalk(600, 7);
  const eg = engleGranger(a, b)!;
  assert.equal(eg.cointegrated, false);
  // High correlation is NOT cointegration — the two can disagree, and the test reports both honestly.
  assert.ok(eg.correlation > -1 && eg.correlation < 1);
});

test('runPairsStudy trades the synthetic cointegrated pair profitably net of costs', () => {
  const { a, b } = cointegratedPair(1500, 42);
  const result = runPairsStudy(a, b, { calibrationWindow: 180, costBps: 8 });
  assert.ok(result.nTrades > 20, `expected a healthy trade count, got ${result.nTrades}`);
  assert.ok(result.meanPnlPct !== null && result.meanPnlPct > 0.3, `mean pnl ${result.meanPnlPct}`);
  assert.ok(result.winRate > 0.6, `win rate ${result.winRate}`);
  assert.ok(result.foldCointegrationRate > 0.5, `fold cointegration rate ${result.foldCointegrationRate}`);
  assert.ok(result.bootstrap !== null && result.bootstrap.pValue < 0.05);
  assert.ok(result.trades.every((t) => Math.abs(t.zEntry) >= 1.99), 'entries must trigger at |z| >= entryZ');
});

test('UNGATED random-walk pairs manufacture spurious profits — the documented rolling-z artifact', () => {
  // Educational and load-bearing: the z-score of a non-stationary spread against its own rolling mean shows
  // ARTIFICIAL mean reversion (the rolling mean chases the walk). Without the cointegration gate the study
  // would report profitable trades on pure noise. This test pins that behavior so nobody "fixes" it away
  // silently — the fix is the gate, tested next.
  const PAIRS = 10;
  let spuriousPositive = 0;
  for (let i = 0; i < PAIRS; i += 1) {
    const a = randomWalk(1200, 100 + i * 2);
    const b = randomWalk(1200, 101 + i * 2);
    const result = runPairsStudy(a, b, { calibrationWindow: 180, costBps: 8, requireCointegration: false });
    if (result.meanPnlPct !== null && result.meanPnlPct > 0.3) spuriousPositive += 1;
  }
  assert.ok(spuriousPositive >= 5, `${spuriousPositive}/${PAIRS} ungated random-walk pairs showed spurious profit`);
});

test('the cointegration gate suppresses trading on random walks (null simulation over seeds)', () => {
  const PAIRS = 10;
  let cointRates = 0;
  let gatedTrades = 0;
  for (let i = 0; i < PAIRS; i += 1) {
    const a = randomWalk(1200, 100 + i * 2);
    const b = randomWalk(1200, 101 + i * 2);
    const result = runPairsStudy(a, b, { calibrationWindow: 180, costBps: 8 }); // requireCointegration: true (default)
    gatedTrades += result.nTrades;
    cointRates += result.foldCointegrationRate;
    assert.ok(
      result.warnings.some((w) => /cointegration gate blocked|round trips/.test(w)),
      'random-walk pairs must be flagged as untradable or exploratory',
    );
  }
  const averageCointRate = cointRates / PAIRS;
  // The cointegrated-pair benchmark trades > 20 times on the same length series; the gated random walks
  // must trade far less, because the trailing Engle-Granger test (correctly) almost never passes.
  assert.ok(gatedTrades < PAIRS * 10, `gated random-walk pairs traded ${gatedTrades} times — gate is not suppressing noise`);
  assert.ok(averageCointRate < 0.5, `spurious cointegration rate ${averageCointRate} should be far from consistent`);
});

test('runPairsStudy charges costs: zero-cost mean exceeds costed mean by the configured bps', () => {
  const { a, b } = cointegratedPair(1200, 10);
  const costed = runPairsStudy(a, b, { calibrationWindow: 180, costBps: 20 });
  const free = runPairsStudy(a, b, { calibrationWindow: 180, costBps: 0 });
  assert.equal(costed.nTrades, free.nTrades);
  if (free.meanPnlPct !== null && costed.meanPnlPct !== null) {
    assert.ok(Math.abs((free.meanPnlPct - costed.meanPnlPct) - 0.2) < 0.05,
      `cost difference ${(free.meanPnlPct - costed.meanPnlPct).toFixed(4)} should equal 20 bps = 0.2%`);
  }
});

test('correlation of identical series is 1 and of opposite series is -1', () => {
  const xs = [1, 2, 3, 4, 5];
  assert.ok(Math.abs(correlation(xs, xs) - 1) < 1e-12);
  assert.ok(Math.abs(correlation(xs, xs.map((v) => -v)) + 1) < 1e-12);
});

test('runPairsStudy flags insufficient trade counts as exploratory', () => {
  const { a, b } = cointegratedPair(300, 11); // barely past the calibration window
  const result = runPairsStudy(a, b, { calibrationWindow: 180 });
  assert.ok(result.warnings.some((w) => /round trips|bars/.test(w)));
});
