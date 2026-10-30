import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PROMOTION_POLICY, evaluatePromotion } from '../src/research/PromotionGate.js';
import type { ExperimentResult } from '../src/research/ExperimentRunner.js';
import type { BootstrapSummary } from '../src/research/Bootstrap.js';

const summary = (over: Partial<BootstrapSummary> = {}): BootstrapSummary => ({
  n: 900,
  clusters: 900,
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
  train: { n: 1000, stdDevNetR: 1, effectiveN: 1000, winRate: 0.55, meanNetR: 0.4, profitFactor: 1.6, maxDrawdownR: 3, symbols: 1, regimes: 2, bootstrap: summary(), sharpe: oosSharpe({ n: 1000, mean: 0.4, std: 1, sharpePerTrade: 0.4 }) },
  test: { n: 900, stdDevNetR: 1, effectiveN: 900, winRate: 0.55, meanNetR: 0.3, profitFactor: 1.5, maxDrawdownR: 4, symbols: 2, regimes: 2, bootstrap: summary(), sharpe: oosSharpe({ n: 900 }) },
  parentTrain: { n: 1000, stdDevNetR: 1, effectiveN: 1000, winRate: 0.50, meanNetR: 0.2, profitFactor: 1.3, maxDrawdownR: 5, symbols: 1, regimes: 2, bootstrap: summary({ mean: 0.2 }), sharpe: oosSharpe({ n: 1000, mean: 0.2, std: 1, sharpePerTrade: 0.2 }) },
  parentTest: { n: 900, stdDevNetR: 1, effectiveN: 900, winRate: 0.50, meanNetR: 0.15, profitFactor: 1.2, maxDrawdownR: 5, symbols: 2, regimes: 2, bootstrap: summary({ mean: 0.15 }), sharpe: oosSharpe({ n: 900, mean: 0.15, sharpePerTrade: 0.3 }) },
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

test('power sizing rejects high trade counts when cluster dependence leaves too few effective observations', () => {
  const v = evaluatePromotion(result({ test: { ...result().test, n: 900, effectiveN: 120 } }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'INSUFFICIENT_DATA');
  assert.ok(v.reasons.some((reason) => /effectiveN=120\.0/.test(reason)));
  assert.ok(v.reasons.some((reason) => /target 0\.100R/.test(reason)));
});

test('incomplete research input can never pass the promotion gate', () => {
  const v = evaluatePromotion(result({ experimentNotes: ['incomplete research input: maxSpreadBps requires spread evidence'] }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'INSUFFICIENT_DATA');
  assert.ok(v.reasons[0].includes('maxSpreadBps'));
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

test('evaluatePromotion holds a candidate whose edge is below the minimum detectable effect at its sample size', () => {
  // 900 trades with sigma = 1.0R can only confirm edges >= 0.093R at 80% power. The fixture's 0.07R mean
  // clears every hard floor but not that, so the honest verdict is INSUFFICIENT_DATA — not a promotion.
  const wide = result({
    test: { ...result().test, meanNetR: 0.07, sharpe: oosSharpe({ mean: 0.07, std: 1.0, sharpePerTrade: 0.07 }) },
    parentTest: { ...result().parentTest, meanNetR: 0.02 },
  });
  const v = evaluatePromotion(wide, DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'INSUFFICIENT_DATA');
  assert.match(v.reasons[0], /detect effects >=/);
});

test('evaluatePromotion rejects when the research contract was violated (a filter could not be evaluated)', () => {
  const v = evaluatePromotion(result({
    contractViolations: ['maxSpreadBps=5 configured but 480/480 ledger records lack per-setup spread evidence'],
  }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'REJECT');
  assert.ok(v.reasons.some((r) => /research contract violation/.test(r)));
});

test('evaluatePromotion derives minTrades from power analysis when targetEffectSizeR is stated', () => {
  // Stating a target effect size of 0.10R requires ~784 trades; 40 trades returns INSUFFICIENT_DATA
  const powerPolicy = { ...DEFAULT_PROMOTION_POLICY, targetEffectSizeR: 0.10 };
  const underpowered = result({ test: { ...result().test, n: 40, effectiveN: 40 } });
  const v = evaluatePromotion(underpowered, powerPolicy);
  assert.equal(v.decision, 'INSUFFICIENT_DATA');
  assert.match(v.reasons[0], /required 78[0-9] independent-equivalent/);
});

test('DSR requires actual fixed-frequency equity returns and measured trial dispersion', () => {
  const policy = { ...DEFAULT_PROMOTION_POLICY, minDsr: 0.95, trialCount: 500, trialSharpeVariance: 0.5 };
  const missing = evaluatePromotion(result(), policy);
  assert.equal(missing.decision, 'INSUFFICIENT_DATA');
  assert.ok(missing.reasons.some((r) => /equity return series/.test(r)));

  const returns = Array.from({ length: 900 }, (_, i) => (i % 2 === 0 ? 0.0001 : -0.0001));
  const withEquity = result({ testEquityReturns: { source: 'CANDIDATE_PORTFOLIO_REPLAY', candidateId: 'STRUCT-LIQ-η', candidateVersion: 2, from: 0, to: 900_000, frequencyMs: 1_000, returns } });
  const verdict = evaluatePromotion(withEquity, policy);
  assert.equal(verdict.decision, 'REJECT');
  assert.ok(verdict.reasons.some((r) => /Deflated Sharpe/.test(r)));
});

test('DSR cannot silently skip trial correction when dispersion metadata is missing', () => {
  const returns = Array.from({ length: 900 }, (_, i) => (i % 2 === 0 ? 0.0001 : -0.0001));
  const withEquity = result({ testEquityReturns: { source: 'CANDIDATE_PORTFOLIO_REPLAY', candidateId: 'STRUCT-LIQ-η', candidateVersion: 2, from: 0, to: 900_000, frequencyMs: 1_000, returns } });
  const verdict = evaluatePromotion(withEquity, { ...DEFAULT_PROMOTION_POLICY, minDsr: 0.95, trialCount: 500 });
  assert.equal(verdict.decision, 'INSUFFICIENT_DATA');
  assert.ok(verdict.reasons.some((r) => /trialSharpeVariance/.test(r)));
});

test('evaluatePromotion passes DSR with a strong equity-return Sharpe under a small trial count', () => {
  // Alternating +0.02%/+0.01% per-mark equity returns give a per-period Sharpe of ~3; under 2 trials with a
  // small measured trial-Sharpe variance the deflated Sharpe stays above 0.95 and the candidate promotes.
  const dsrPolicy = { ...DEFAULT_PROMOTION_POLICY, minDsr: 0.95, trialCount: 2, trialSharpeVariance: 0.01 };
  const returns = Array.from({ length: 900 }, (_, i) => (i % 2 === 0 ? 0.0002 : 0.0001));
  const v = evaluatePromotion(result({ testEquityReturns: { source: 'CANDIDATE_PORTFOLIO_REPLAY', candidateId: 'STRUCT-LIQ-η', candidateVersion: 2, from: 0, to: 900_000, frequencyMs: 1_000, returns } }), dsrPolicy);
  assert.equal(v.decision, 'PROMOTE');
});

test('evaluatePromotion refuses to proxy DSR from per-trade statistics when equity evidence is missing', () => {
  // A strong per-trade Sharpe is NOT account-level evidence: without the actual fixed-frequency equity
  // return series the DSR gate fails closed with INSUFFICIENT_DATA instead of substituting a proxy.
  const dsrPolicy = { ...DEFAULT_PROMOTION_POLICY, minDsr: 0.95, trialCount: 10, trialSharpeVariance: 0.5 };
  const v = evaluatePromotion(result({ test: { ...result().test, sharpe: oosSharpe({ std: 0.25, sharpePerTrade: 1.2 }) } }), dsrPolicy);
  assert.equal(v.decision, 'INSUFFICIENT_DATA');
  assert.ok(v.reasons.some((r) => /equity return series/.test(r)));
});
