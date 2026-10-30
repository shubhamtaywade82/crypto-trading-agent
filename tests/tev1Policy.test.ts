import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateTradeDecisionResponse, summarizeEvaluation } from '../src/decision-intelligence/evaluators/tradeDecisionEvaluator.js';
import {
  MTF_ALIGNMENT_FLOOR,
  POLICY_VERSION,
  applyTradeDecisionPolicy,
  snapshotPrecheck,
  type TradePolicyOptions,
} from '../src/decision-intelligence/policies/tradeDecisionPolicy.js';
import type { DecisionEvaluation, DecisionSnapshot, SetupWeakness, SystemoneResponse, TradeDecisionChoice } from '../src/decision-intelligence/types.js';

const OPTIONS: TradePolicyOptions = { mode: 'on', minConfidence: 0.6 };

// ─── Fixtures ───

function response(overrides: {
  tradeDecision?: Partial<SystemoneResponse['answers']['trade_decision']> & { present?: boolean };
  weakness?: { choice?: string; present?: boolean };
  mtf?: { noul?: number; present?: boolean };
} = {}): SystemoneResponse {
  const td = {
    type: 'choice' as const,
    choice: 'APPROVE',
    probabilities: { APPROVE: 0.82, WAIT: 0.12, NO_TRADE: 0.04, INSUFFICIENT_DATA: 0.02 },
    confidence: 0.82,
    ...(overrides.tradeDecision ?? {}),
  };
  const weakness = { type: 'choice' as const, choice: (overrides.weakness?.choice ?? 'NONE') as SetupWeakness, probabilities: { NONE: 0.9 }, confidence: 0.9 };
  const mtf = { type: 'noul' as const, noul: 0.71 };
  return {
    model: 'tev1:4b',
    answers: {
      ...(overrides.tradeDecision?.present === false ? {} : { trade_decision: td }),
      ...(overrides.weakness?.present === false ? {} : { primary_weakness: weakness }),
      ...(overrides.mtf?.present === false ? {} : { mtf_alignment: overrides.mtf ? { ...mtf, noul: overrides.mtf.noul ?? mtf.noul } : mtf }),
    } as SystemoneResponse['answers'],
    usage: { input_tokens: 700, output_tokens: 4 },
  };
}

function evaluation(over: Partial<DecisionEvaluation> = {}): DecisionEvaluation {
  return {
    ok: true,
    tradeDecision: { choice: 'APPROVE', probabilities: { APPROVE: 0.82 }, confidence: 0.82 },
    primaryWeakness: { choice: 'NONE', probabilities: { NONE: 0.9 }, confidence: 0.9 },
    mtfAlignment: { probabilityTrue: 0.71 },
    invalidReasons: [],
    ...over,
  };
}

function snapshot(over: Partial<DecisionSnapshot['dataQuality']> = {}): DecisionSnapshot {
  return {
    symbol: 'SOLUSDT', venue: 'BINANCE_USDM', decisionTimeframe: '15m', asOf: 0,
    market: { regime: 'TREND_UP', trendDirection: 'BULLISH', trendStrength: 0.6, volatility: 'MEDIUM', mark: 101.72, fundingRatePct: 0.01, rangePositionPct: 79 },
    higherTimeframes: {},
    setup: { type: 'OPEN_LONG', side: 'LONG', strategy: 'STRUCTURE-TREND-η', entry: 101.72, stopLoss: 100.96, takeProfit: 103.4, riskReward: 2.21, evidenceScore: 68, evidenceReasons: [] },
    orderFlow: { takerBuySellRatio: 0.85, openInterestChangePct: -0.53, globalLongShortRatio: 2.98, orderBookImbalance: -0.12, spreadBps: 0.9 },
    positioning: { positioningExtreme: 'LONG_CROWDED', fundingPercentile: 0.62, topTraderVsGlobalBias: -0.4 },
    dataQuality: { marketStatePresent: true, marketStateAgeMs: 20 * 60_000, stale: false, closedCandlesOnly: true, missingFeatures: [], ...over },
  };
}

// ─── Evaluator ───

test('parses the documented happy-path response into the three answers', () => {
  const evaluation = evaluateTradeDecisionResponse(response());
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.tradeDecision!.choice, 'APPROVE');
  assert.equal(evaluation.tradeDecision!.confidence, 0.82);
  assert.equal(evaluation.primaryWeakness!.choice, 'NONE');
  assert.equal(evaluation.mtfAlignment!.probabilityTrue, 0.71);
  assert.deepEqual(evaluation.invalidReasons, []);
});

test('a null response (transport failure) is an unusable evaluation', () => {
  const evaluation = evaluateTradeDecisionResponse(null);
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.tradeDecision, null);
  assert.deepEqual(evaluation.invalidReasons, ['no response']);
});

test('a choice the question did not offer invalidates the evaluation', () => {
  const evaluation = evaluateTradeDecisionResponse(response({ tradeDecision: { choice: 'MAYBE' } }));
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.invalidReasons.some((r) => r.includes("was not offered")));
});

test('a missing answer, wrong answer type, or missing confidence is recorded and fails the evaluation', () => {
  const missing = evaluateTradeDecisionResponse(response({ tradeDecision: { present: false } }));
  assert.equal(missing.ok, false);
  assert.ok(missing.invalidReasons.includes('trade_decision: answer missing'));

  const wrongType = evaluateTradeDecisionResponse({ model: 'tev1:4b', answers: { trade_decision: { type: 'noul', noul: 0.5 }, primary_weakness: response().answers.primary_weakness!, mtf_alignment: response().answers.mtf_alignment! } });
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.invalidReasons.some((r) => r.includes('expected a choice answer')));

  const noConfidence = evaluateTradeDecisionResponse(response({ tradeDecision: { confidence: Number.NaN } }));
  assert.equal(noConfidence.ok, false);
  assert.ok(noConfidence.invalidReasons.some((r) => r.includes('confidence missing')));
});

test('probabilities and confidence are clamped into [0,1] and non-numeric probabilities dropped', () => {
  const evaluation = evaluateTradeDecisionResponse(
    response({ tradeDecision: { choice: 'WAIT', probabilities: { WAIT: 1.7, APPROVE: Number.NaN }, confidence: -0.4 } }),
  );
  assert.equal(evaluation.tradeDecision!.probabilities.WAIT, 1);
  assert.equal(evaluation.tradeDecision!.probabilities.APPROVE, undefined);
  assert.equal(evaluation.tradeDecision!.confidence, 0);
});

test('summarizeEvaluation renders one auditable line for each outcome', () => {
  assert.equal(summarizeEvaluation(evaluation()), 'APPROVE@0.82 weakness=NONE mtf=0.71');
  assert.match(summarizeEvaluation(evaluation({ ok: false, tradeDecision: null })), /^unusable \(.*\)$/);
});

// ─── Policy: the deterministic rules ───

test('APPROVE at or above the confidence floor with aligned timeframes proceeds', () => {
  const verdict = applyTradeDecisionPolicy(evaluation(), OPTIONS);
  assert.equal(verdict.gate, 'PASS');
  assert.equal(verdict.action, 'PROCEED');
  assert.equal(verdict.enforced, true);
  assert.match(verdict.reason, /APPROVE mtf_alignment 0\.71/);
});

test('APPROVE below the confidence floor holds the candidate for confirmation', () => {
  const verdict = applyTradeDecisionPolicy(evaluation({ tradeDecision: { choice: 'APPROVE', probabilities: { APPROVE: 0.55 }, confidence: 0.55 } }), OPTIONS);
  assert.equal(verdict.gate, 'BLOCK');
  assert.equal(verdict.action, 'HOLD');
  assert.match(verdict.reason, /below floor 0\.60/);
});

test('APPROVE with higher timeframes against the direction holds the candidate', () => {
  const verdict = applyTradeDecisionPolicy(evaluation({ mtfAlignment: { probabilityTrue: MTF_ALIGNMENT_FLOOR - 0.01 } }), OPTIONS);
  assert.equal(verdict.action, 'HOLD');
  assert.match(verdict.reason, /higher timeframes do not support/);
  assert.equal(verdict.gate, 'BLOCK');
});

test('WAIT holds, NO_TRADE and INSUFFICIENT_DATA refuse', () => {
  const wait = applyTradeDecisionPolicy(evaluation({ tradeDecision: { choice: 'WAIT', probabilities: {}, confidence: 0.7 } }), OPTIONS);
  assert.equal(wait.action, 'HOLD');

  const noTrade = applyTradeDecisionPolicy(
    evaluation({ tradeDecision: { choice: 'NO_TRADE', probabilities: {}, confidence: 0.9 }, primaryWeakness: { choice: 'TREND_CONFLICT', probabilities: {}, confidence: 0.8 } }),
    OPTIONS,
  );
  assert.equal(noTrade.action, 'REFUSE');
  assert.match(noTrade.reason, /NO_TRADE \(primary weakness: TREND_CONFLICT\)/);

  const insufficient = applyTradeDecisionPolicy(evaluation({ tradeDecision: { choice: 'INSUFFICIENT_DATA', probabilities: {}, confidence: 0.4 } }), OPTIONS);
  assert.equal(insufficient.action, 'REFUSE');
});

test('an unusable evaluation refuses (fail closed) and names what was wrong', () => {
  const verdict = applyTradeDecisionPolicy(evaluation({ ok: false, tradeDecision: null, invalidReasons: ['trade_decision: answer missing'] }), OPTIONS);
  assert.equal(verdict.gate, 'BLOCK');
  assert.equal(verdict.action, 'REFUSE');
  assert.equal(verdict.choice, 'INSUFFICIENT_DATA');
  assert.match(verdict.reason, /unusable response/);
  assert.match(verdict.reason, /answer missing/);
});

test('shadow mode reports the same verdicts but never enforces them', () => {
  const shadow: TradePolicyOptions = { mode: 'shadow', minConfidence: 0.6 };
  const blocked = applyTradeDecisionPolicy(evaluation({ tradeDecision: { choice: 'NO_TRADE', probabilities: {}, confidence: 0.9 } }), shadow);
  assert.equal(blocked.gate, 'BLOCK');
  assert.equal(blocked.action, 'REFUSE');
  assert.equal(blocked.enforced, false);
  assert.equal(blocked.mode, 'shadow');

  const passed = applyTradeDecisionPolicy(evaluation(), shadow);
  assert.equal(passed.gate, 'PASS');
  assert.equal(passed.enforced, false);
});

test('mode off is not evaluated', () => {
  const verdict = applyTradeDecisionPolicy(evaluation(), { mode: 'off', minConfidence: 0.6 });
  assert.equal(verdict.action, 'NOT_EVALUATED');
  assert.equal(verdict.gate, 'PASS');
});

// ─── Snapshot precheck ───

test('a null snapshot (no geometry) is refused before any model call', () => {
  const verdict = snapshotPrecheck(null, OPTIONS);
  assert.equal(verdict!.action, 'REFUSE');
  assert.match(verdict!.reason, /geometry incomplete/);
});

test('a missing or stale MarketState is refused before any model call', () => {
  const missing = snapshotPrecheck(snapshot({ marketStatePresent: false, marketStateAgeMs: null }), OPTIONS);
  assert.equal(missing!.action, 'REFUSE');
  assert.match(missing!.reason, /no MarketState/);

  const stale = snapshotPrecheck(snapshot({ marketStateAgeMs: 46 * 60_000, stale: true }), OPTIONS);
  assert.equal(stale!.action, 'REFUSE');
  assert.match(stale!.reason, /stale/);
});

test('a fresh, complete snapshot passes the precheck and reaches the model', () => {
  assert.equal(snapshotPrecheck(snapshot(), OPTIONS), null);
});

test('the policy version is stamped and semver', () => {
  assert.match(POLICY_VERSION, /^\d+\.\d+\.\d+$/);
});
