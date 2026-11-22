import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateCrowding } from '../src/market/CrowdingEngine.js';
import { flowHypothesis } from '../src/decision/SetupEngine.js';
import type { DerivativesSnapshot } from '../src/market/MarketDataTypes.js';
import type { MarketState } from '../src/market/types.js';

function makeDerivatives(overrides: Partial<DerivativesSnapshot>): DerivativesSnapshot {
  return {
    asOf: Date.now(),
    openInterest: 10_000,
    openInterestChangePct: 0.5,
    globalLongShortRatio: 1.0,
    topTraderAccountLongShortRatio: 1.0,
    topTraderPositionLongShortRatio: 1.0,
    takerBuySellRatio: 1.0,
    takerVolumeImbalance: 0,
    orderBookImbalance: 0,
    spreadBps: 1,
    basisPct: 0.01,
    ...overrides,
  };
}

test('returns default balanced state when derivatives data is absent', () => {
  const result = calculateCrowding(null, 0.0001);
  assert.equal(result.positioningExtreme, 'BALANCED');
  assert.equal(result.topTraderVsGlobalBias, null);
  assert.equal(result.openInterestExpansion, false);
});

test('identifies LONG_CROWDED when global L/S is elevated with positive funding', () => {
  const deriv = makeDerivatives({
    globalLongShortRatio: 2.2,
    topTraderPositionLongShortRatio: 2.6,
    openInterestChangePct: 2.1,
    takerBuySellRatio: 1.4,
  });
  const result = calculateCrowding(deriv, 0.0005);
  assert.equal(result.positioningExtreme, 'LONG_CROWDED');
  assert.equal(result.openInterestExpansion, true);
  assert.ok(result.topTraderVsGlobalBias! > 1.0);
  assert.ok(result.fundingPercentile! >= 90);
});

test('identifies SHORT_CROWDED when global L/S is depressed with negative funding', () => {
  const deriv = makeDerivatives({
    globalLongShortRatio: 0.5,
    topTraderPositionLongShortRatio: 0.4,
    openInterestChangePct: 1.8,
    takerBuySellRatio: 0.7,
  });
  const result = calculateCrowding(deriv, -0.0005);
  assert.equal(result.positioningExtreme, 'SHORT_CROWDED');
  assert.equal(result.openInterestExpansion, true);
  assert.ok(result.fundingPercentile! <= 10);
});

test('correctly calculates top trader vs global positioning asymmetry', () => {
  const deriv = makeDerivatives({
    globalLongShortRatio: 1.0,
    topTraderPositionLongShortRatio: 1.5,
  });
  const result = calculateCrowding(deriv, 0.0001);
  assert.equal(result.positioningExtreme, 'BALANCED');
  assert.equal(result.topTraderVsGlobalBias, 1.5);
});

test('TASK-001: detects smart money divergence and evaluates taker volume imbalance', () => {
  // Case 1: Smart Money Long Divergence (Top traders long 1.6, Retail short 0.7)
  const derivLong = makeDerivatives({
    globalLongShortRatio: 0.7,
    topTraderPositionLongShortRatio: 1.6,
    takerBuySellRatio: 1.5,
    takerVolumeImbalance: 0.35,
  });
  const resultLong = calculateCrowding(derivLong, 0.0001);
  assert.equal(resultLong.smartMoneyDivergence, 'SMART_MONEY_LONG');
  assert.equal(resultLong.takerImbalance, 0.35);
  assert.ok(resultLong.topTraderVsGlobalBias! > 2.0);

  // Case 2: Smart Money Short Divergence (Top traders short 0.6, Retail long 1.8)
  const derivShort = makeDerivatives({
    globalLongShortRatio: 1.8,
    topTraderPositionLongShortRatio: 0.6,
    takerBuySellRatio: 0.6,
    takerVolumeImbalance: -0.4,
  });
  const resultShort = calculateCrowding(derivShort, 0.0001);
  assert.equal(resultShort.smartMoneyDivergence, 'SMART_MONEY_SHORT');
  assert.equal(resultShort.takerImbalance, -0.4);

  // Case 3: Zero or invalid global ratio safety
  const derivZero = makeDerivatives({
    globalLongShortRatio: 0,
    topTraderPositionLongShortRatio: 1.2,
  });
  const resultZero = calculateCrowding(derivZero, 0.0001);
  assert.equal(resultZero.topTraderVsGlobalBias, null);
  assert.equal(resultZero.smartMoneyDivergence, 'NEUTRAL');
});

test('TASK-002: tracks open interest delta and calibrated funding rate percentile distribution', () => {
  // Case 1: Extreme positive funding rate (+0.08% / 8h) with high OI expansion (+4.5%)
  const derivHigh = makeDerivatives({
    openInterestChangePct: 4.5,
  });
  const resultHigh = calculateCrowding(derivHigh, 0.0008);
  assert.equal(resultHigh.openInterestExpansion, true);
  assert.equal(resultHigh.oiDeltaPct, 4.5);
  assert.equal(resultHigh.fundingPercentile, 100);
  assert.equal(resultHigh.fundingRegime, 'EXTREME_POSITIVE');

  // Case 2: Extreme negative funding rate (-0.06% / 8h) with contraction (-2.1%)
  const derivLow = makeDerivatives({
    openInterestChangePct: -2.1,
  });
  const resultLow = calculateCrowding(derivLow, -0.0006);
  assert.equal(resultLow.openInterestExpansion, false);
  assert.equal(resultLow.oiDeltaPct, -2.1);
  assert.equal(resultLow.fundingPercentile, 0);
  assert.equal(resultLow.fundingRegime, 'EXTREME_NEGATIVE');

  // Case 3: Neutral baseline funding rate (+0.01% / 8h) with flat OI (+0.2%)
  const derivNeutral = makeDerivatives({
    openInterestChangePct: 0.2,
  });
  const resultNeutral = calculateCrowding(derivNeutral, 0.0001);
  assert.equal(resultNeutral.openInterestExpansion, false);
  assert.equal(resultNeutral.oiDeltaPct, 0.2);
  assert.equal(resultNeutral.fundingRegime, 'NEUTRAL');
});

test('TASK-003: computes normalized crowding score and flags squeeze risk', () => {
  // Case 1: Long Squeeze Risk (Heavily long crowded + positive funding + high taker buy + expanding OI)
  const derivLongSqueeze = makeDerivatives({
    globalLongShortRatio: 2.5,
    topTraderPositionLongShortRatio: 2.2,
    takerBuySellRatio: 1.6,
    openInterestChangePct: 3.5,
  });
  const resultLong = calculateCrowding(derivLongSqueeze, 0.0006);
  assert.ok(resultLong.crowdingScore! > 0.6, 'Crowding score should indicate heavy long skew');
  assert.equal(resultLong.squeezeRisk, 'LONG_SQUEEZE_RISK');

  // Case 2: Short Squeeze Risk (Heavily short crowded + negative funding + high taker sell + expanding OI)
  const derivShortSqueeze = makeDerivatives({
    globalLongShortRatio: 0.4,
    topTraderPositionLongShortRatio: 0.5,
    takerBuySellRatio: 0.5,
    openInterestChangePct: 2.8,
  });
  const resultShort = calculateCrowding(derivShortSqueeze, -0.0006);
  assert.ok(resultShort.crowdingScore! < -0.6, 'Crowding score should indicate heavy short skew');
  assert.equal(resultShort.squeezeRisk, 'SHORT_SQUEEZE_RISK');

  // Case 3: Balanced / Neutral Squeeze Risk (No OI expansion, neutral funding)
  const derivNeutral = makeDerivatives({
    globalLongShortRatio: 1.0,
    takerBuySellRatio: 1.0,
    openInterestChangePct: 0.1,
  });
  const resultNeutral = calculateCrowding(derivNeutral, 0.0001);
  assert.ok(Math.abs(resultNeutral.crowdingScore!) < 0.3, 'Crowding score should be near zero');
  assert.equal(resultNeutral.squeezeRisk, 'NEUTRAL');
});

test('TASK-004: SetupEngine incorporates squeeze risk into hypothesis thesis', () => {
  const deriv = makeDerivatives({
    globalLongShortRatio: 0.4,
    topTraderPositionLongShortRatio: 0.5,
    takerBuySellRatio: 0.5,
    openInterestChangePct: 3.0,
  });
  const crowding = calculateCrowding(deriv, -0.0006);
  assert.equal(crowding.squeezeRisk, 'SHORT_SQUEEZE_RISK');

  const mockState = {
    crowding,
  } as unknown as MarketState;

  const thesis = flowHypothesis(mockState, 'LONG', 'LIQUIDITY_SWEEP');
  assert.ok(thesis.includes('short squeeze'), `Expected thesis to contain 'short squeeze', got: "${thesis}"`);
});
