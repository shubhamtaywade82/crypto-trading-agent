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
  p05: -0.5,
  p95: 1.5,
  ...over,
});

const result = (over: Partial<ExperimentResult> = {}): ExperimentResult => ({
  candidateId: 'STRUCT-LIQ-η', candidateVersion: 2,
  parentId: 'STRUCT-LIQ-η', parentVersion: 1,
  train: { n: 1000, stdDevNetR: 1, effectiveN: 1000, winRate: 0.55, meanNetR: 0.4, profitFactor: 1.6, maxDrawdownR: 3, symbols: 1, regimes: 2, bootstrap: summary() },
  test: { n: 900, stdDevNetR: 1, effectiveN: 900, winRate: 0.55, meanNetR: 0.3, profitFactor: 1.5, maxDrawdownR: 4, symbols: 2, regimes: 2, bootstrap: summary() },
  parentTrain: { n: 1000, stdDevNetR: 1, effectiveN: 1000, winRate: 0.50, meanNetR: 0.2, profitFactor: 1.3, maxDrawdownR: 5, symbols: 1, regimes: 2, bootstrap: summary({ mean: 0.2 }) },
  parentTest: { n: 900, stdDevNetR: 1, effectiveN: 900, winRate: 0.50, meanNetR: 0.15, profitFactor: 1.2, maxDrawdownR: 5, symbols: 2, regimes: 2, bootstrap: summary({ mean: 0.15 }) },
  walkForward: { outOfSample: summary({ mean: 0.2, ciLow: 0.05 }), baseline: summary({ mean: 0.1 }), folds: 5 },
  perSymbol: [{ key: 'BTCUSDT', n: 25, meanNetR: 0.35 }, { key: 'ETHUSDT', n: 15, meanNetR: 0.20 }],
  perRegime: [{ key: 'TREND_UP | EXPANDED', n: 20, meanNetR: 0.45 }, { key: 'TRANSITION | COMPRESSED', n: 20, meanNetR: 0.15 }],
  experimentNotes: [],
  ...over,
});

test('evaluatePromotion returns PROMOTE when every guard is satisfied', () => {
  const v = evaluatePromotion(result(), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'PROMOTE');
  assert.ok(v.reasons.length > 0);
});

test('evaluatePromotion returns INSUFFICIENT_DATA when OOS n is below minTrades', () => {
  const v = evaluatePromotion(result({ test: { ...result().test, n: 10, bootstrap: null } }), DEFAULT_PROMOTION_POLICY);
  assert.equal(v.decision, 'INSUFFICIENT_DATA');
  assert.match(v.reasons[0], /required/);
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
  const v = evaluatePromotion(result({ test: { ...result().test, meanNetR: 0.01 } }), DEFAULT_PROMOTION_POLICY);
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
  // Candidate matches parent: zero delta.
  const r = result({ test: { ...result().test, meanNetR: 0.15 }, parentTest: { ...result().parentTest, meanNetR: 0.15 } });
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
  const r = result({ test: { ...result().test, meanNetR: 0.15 }, parentTest: { ...result().parentTest, meanNetR: 0.15 } });
  const v = evaluatePromotion(r, tie);
  assert.equal(v.decision, 'PROMOTE');
});

test('evaluatePromotion derives minTrades from power analysis when targetEffectSizeR is stated', () => {
  // Stating a target effect size of 0.10R requires ~784 trades; 40 trades returns INSUFFICIENT_DATA
  const powerPolicy = { ...DEFAULT_PROMOTION_POLICY, targetEffectSizeR: 0.10 };
  const v = evaluatePromotion(result(), powerPolicy);
  assert.equal(v.decision, 'INSUFFICIENT_DATA');
  assert.match(v.reasons[0], /required minTrades=78[0-9]/);
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
  const withEquity = result({ testEquityReturns: { source: 'EQUITY_CURVE', from: 0, to: 900_000, frequencyMs: 1_000, returns } });
  const verdict = evaluatePromotion(withEquity, { ...DEFAULT_PROMOTION_POLICY, minDsr: 0.95, trialCount: 500 });
  assert.equal(verdict.decision, 'INSUFFICIENT_DATA');
  assert.ok(verdict.reasons.some((r) => /trialSharpeVariance/.test(r)));
});
