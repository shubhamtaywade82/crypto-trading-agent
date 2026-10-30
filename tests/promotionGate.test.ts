import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PROMOTION_POLICY, evaluatePromotion } from '../src/research/PromotionGate.js';
import type { ExperimentResult } from '../src/research/ExperimentRunner.js';
import type { BootstrapSummary } from '../src/research/Bootstrap.js';

const summary = (over: Partial<BootstrapSummary> = {}): BootstrapSummary => ({
  n: 50,
  clusters: 30,
  mean: 0.3,
  median: 0.2,
  ciLow: 0.1,
  ciHigh: 0.5,
  probPositive: 0.95,
  pValue: 0.02,
  pValueSignFlip: 0.03,
  p05: -0.5,
  p95: 1.5,
  ...over,
});

/** Per-trade moments consistent with the fixture's OOS window: mean 0.3R, sd 0.5R. */
const oosSharpe = (over: Partial<import('../src/research/ExperimentRunner.js').TradeSharpeStats> = {}) => ({
  n: 40,
  mean: 0.3,
  std: 0.5,
  skewness: 0,
  excessKurtosis: 0,
  sharpePerTrade: 0.6,
  ...over,
}) as import('../src/research/ExperimentRunner.js').TradeSharpeStats;

const result = (over: Partial<ExperimentResult> = {}): ExperimentResult => ({
  candidateId: 'STRUCT-LIQ-η', candidateVersion: 2,
  parentId: 'STRUCT-LIQ-η', parentVersion: 1,
  train: { n: 60, winRate: 0.55, meanNetR: 0.4, profitFactor: 1.6, maxDrawdownR: 3, symbols: 1, regimes: 2, bootstrap: summary(), sharpe: oosSharpe({ n: 60 }) },
  test: { n: 40, winRate: 0.55, meanNetR: 0.3, profitFactor: 1.5, maxDrawdownR: 4, symbols: 2, regimes: 2, bootstrap: summary(), sharpe: oosSharpe() },
  parentTrain: { n: 60, winRate: 0.50, meanNetR: 0.2, profitFactor: 1.3, maxDrawdownR: 5, symbols: 1, regimes: 2, bootstrap: summary({ mean: 0.2 }), sharpe: oosSharpe({ n: 60, mean: 0.2, sharpePerTrade: 0.4 }) },
  parentTest: { n: 40, winRate: 0.50, meanNetR: 0.15, profitFactor: 1.2, maxDrawdownR: 5, symbols: 2, regimes: 2, bootstrap: summary({ mean: 0.15 }), sharpe: oosSharpe({ n: 40, mean: 0.15, sharpePerTrade: 0.3 }) },
  walkForward: { outOfSample: summary({ mean: 0.2, ciLow: 0.05 }), baseline: summary({ mean: 0.1 }), folds: 5 },
  perSymbol: [{ key: 'BTCUSDT', n: 25, meanNetR: 0.35 }, { key: 'ETHUSDT', n: 15, meanNetR: 0.20 }],
  perRegime: [{ key: 'TREND_UP | EXPANDED', n: 20, meanNetR: 0.45 }, { key: 'TRANSITION | COMPRESSED', n: 20, meanNetR: 0.15 }],
  experimentNotes: [],
  contractViolations: [],
  ...over,
});

test('evaluatePromotion returns PROMOTE when every guard is satisfied', () => {
  const v = evaluatePromotion(result(), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'PROMOTE');
  assert.ok(v.reasons.length > 0);
});

test('evaluatePromotion returns INSUFFICIENT_DATA when OOS n is below minTrades', () => {
  const v = evaluatePromotion(result({ test: { ...result().test, n: 10, bootstrap: null, sharpe: null } }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'INSUFFICIENT_DATA');
  assert.match(v.reasons[0], /minTrades/);
});

test('evaluatePromotion returns REJECT when OOS mean R is below the floor', () => {
  // std 0.02 keeps the MDE guard satisfied (the edge is measurable), isolating the mean-floor rejection path.
  const v = evaluatePromotion(result({ test: { ...result().test, meanNetR: 0.01, sharpe: oosSharpe({ mean: 0.01, std: 0.02, sharpePerTrade: 0.5 }) } }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /OOS mean R/.test(r)));
});

test('evaluatePromotion rejects when the OOS bootstrap LCB is non-positive', () => {
  const v = evaluatePromotion(result({ test: { ...result().test, bootstrap: summary({ ciLow: -0.05 }) } }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /LCB/.test(r)));
});

test('evaluatePromotion rejects when profit factor is below the floor', () => {
  const v = evaluatePromotion(result({ test: { ...result().test, profitFactor: 1.05 } }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /profit factor/.test(r)));
});

test('evaluatePromotion rejects when max drawdown exceeds the ceiling', () => {
  const v = evaluatePromotion(result({ test: { ...result().test, maxDrawdownR: 20 } }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /DD/.test(r)));
});

test('evaluatePromotion rejects when symbol coverage is too thin', () => {
  const v = evaluatePromotion(result({ perSymbol: [{ key: 'BTCUSDT', n: 25, meanNetR: 0.35 }] }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /symbols with n>=5/.test(r)));
});

test('evaluatePromotion rejects when OOS delta vs parent is below the margin', () => {
  // Candidate matches parent: zero delta. std 0.2 keeps the MDE guard satisfied so the delta path is exercised.
  const r = result({
    test: { ...result().test, meanNetR: 0.15, sharpe: oosSharpe({ mean: 0.15, std: 0.2, sharpePerTrade: 0.75 }) },
    parentTest: { ...result().parentTest, meanNetR: 0.15 },
  });
  const v = evaluatePromotion(r, DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /delta vs parent/.test(r)));
});

test('evaluatePromotion rejects when walk-forward OOS is not positive', () => {
  const v = evaluatePromotion(result({ walkForward: { outOfSample: summary({ mean: -0.05 }), baseline: summary(), folds: 3 } }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /walk-forward/.test(r)));
});

test('evaluatePromotion rejects when the candidate collapses in its worst regime', () => {
  // Worst regime is much worse than parent overall — a regime collapse even if pooled mean improves.
  const r = result({
    perRegime: [{ key: 'TREND_UP | EXPANDED', n: 20, meanNetR: 0.8 }, { key: 'TRANSITION | COMPRESSED', n: 20, meanNetR: -0.6 }],
    parentTest: { ...result().parentTest, meanNetR: 0.4 },
  });
  const v = evaluatePromotion(r, DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /worst regime/.test(r)));
});

test('a custom policy can be applied (e.g. zero minOosDelta — accept ties)', () => {
  const tie = { ...DEFAULT_PROMOTION_POLICY, minOosDelta: 0 };
  const r = result({
    test: { ...result().test, meanNetR: 0.15, sharpe: oosSharpe({ mean: 0.15, std: 0.2, sharpePerTrade: 0.75 }) },
    parentTest: { ...result().parentTest, meanNetR: 0.15 },
  });
  const v = evaluatePromotion(r, tie);
  assert.equal(v.decision, 'PROMOTE');
});

test('evaluatePromotion rejects when the OOS sample is too small to detect the observed edge (MDE guard)', () => {
  // 40 trades with sigma = 1.0R can only detect effects >= 0.443R at 80% power. The fixture's 0.3R mean
  // edge does not clear that, so the honest verdict is INSUFFICIENT_DATA — not a promotion on thin evidence.
  const wide = result({ test: { ...result().test, sharpe: oosSharpe({ std: 1.0, sharpePerTrade: 0.3 }) } });
  const v = evaluatePromotion(wide, DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'INSUFFICIENT_DATA');
  assert.match(v.reasons[0], /detect effects >=/);
});

test('evaluatePromotion rejects when the research contract was violated (spread filter could not be evaluated)', () => {
  const v = evaluatePromotion(result({
    contractViolations: ['maxSpreadBps=5 configured but 480/480 ledger records lack per-setup spread evidence'],
  }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /research contract violation/.test(r)));
});

test('evaluatePromotion derives minTrades from power analysis when targetEffectSizeR is stated', () => {
  // Stating a target effect size of 0.10R with sigma = 1.0R requires ~784 trades; 40 trades returns INSUFFICIENT_DATA.
  // The power analysis uses the OBSERVED OOS sigma when per-trade moments exist, so the fixture pins std = 1.0.
  const powerPolicy = { ...DEFAULT_PROMOTION_POLICY, targetEffectSizeR: 0.10 };
  const v = evaluatePromotion(
    result({ test: { ...result().test, sharpe: oosSharpe({ std: 1.0, sharpePerTrade: 0.3 }) } }),
    powerPolicy,
  );
  assert.equal(v.decision, 'INSUFFICIENT_DATA');
  assert.match(v.reasons[0], /power-required minTrades=78[0-9]/);
});

test('evaluatePromotion rejects when Deflated Sharpe Ratio fails under large trial count', () => {
  // Candidate clears static guards but fails DSR when 500 trials were searched. The DSR consumes the ACTUAL
  // per-trade Sharpe (mean/std of net R) — a profit-factor proxy would be statistically meaningless here.
  const dsrPolicy = { ...DEFAULT_PROMOTION_POLICY, minDsr: 0.95, trialCount: 500 };
  const v = evaluatePromotion(result(), dsrPolicy);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /Deflated Sharpe/.test(r)));
});

test('evaluatePromotion passes DSR with a strong per-trade Sharpe under a small trial count', () => {
  // Per-trade Sharpe 1.2 (mean 0.3R / sd 0.25R) on 40 trades vs the expected max Sharpe of 2 trials: DSR clears 0.95.
  const dsrPolicy = { ...DEFAULT_PROMOTION_POLICY, minDsr: 0.95, trialCount: 2 };
  const v = evaluatePromotion(result({ test: { ...result().test, sharpe: oosSharpe({ std: 0.25, sharpePerTrade: 1.2 }) } }), dsrPolicy);
  assert.equal(v.decision, 'PROMOTE');
});

test('evaluatePromotion refuses to proxy DSR when OOS Sharpe statistics are missing', () => {
  const dsrPolicy = { ...DEFAULT_PROMOTION_POLICY, minDsr: 0.95, trialCount: 10 };
  const v = evaluatePromotion(result({ test: { ...result().test, sharpe: null } }), dsrPolicy);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /DSR gate cannot run/.test(r)));
});
