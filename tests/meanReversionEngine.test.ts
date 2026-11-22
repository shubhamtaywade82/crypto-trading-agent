import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import { calculateMeanReversion } from '../src/market/MeanReversionEngine.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';

function makeCandle(index: number, price: number): Candle {
  return {
    openTime: index * 15 * 60_000,
    open: price,
    high: price + 2,
    low: price - 2,
    close: price,
    volume: 100,
  };
}

test('TASK-001: calculateMeanReversion computes multi-anchor deviation and z-score', () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 25; i++) {
    candles.push(makeCandle(i, 100));
  }
  // Last candle spikes to 110
  candles.push(makeCandle(25, 110));

  const state = calculateMeanReversion(candles);
  assert.ok(state.mean !== null, 'Mean should be defined');
  assert.ok(state.zscore !== null && state.zscore > 2, 'Z-score should reflect positive deviation');
  assert.ok(state.bollingerUpper !== null, 'Bollinger upper band should be defined');
  assert.ok(state.deviationPct !== null && state.deviationPct > 0, 'Deviation percentage should be positive');
});

test('TASK-002: detects Bollinger Band extreme touch followed by RSI re-entry confirmation', () => {
  // Scenario 1: Bullish Re-entry
  // Build a series where price drops to lower band and RSI drops < 30, then bounces back above 30
  const candlesBullish: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    candlesBullish.push(makeCandle(i, 100));
  }
  // Sharp drop to 80 (touches lower BB and drives RSI < 30)
  candlesBullish.push(makeCandle(20, 80));
  candlesBullish.push(makeCandle(21, 79));
  // Bounce back to 90 (RSI crosses back above 30)
  candlesBullish.push(makeCandle(22, 90));

  const stateBullish = calculateMeanReversion(candlesBullish);
  assert.equal(stateBullish.bollingerRsiConfirmation, 'BULLISH_REENTRY');

  // Scenario 2: Bearish Re-entry
  // Build a series where price spikes to upper band and RSI spikes > 70, then crosses back below 70
  const candlesBearish: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    candlesBearish.push(makeCandle(i, 100));
  }
  // Sharp spike to 120 (touches upper BB and drives RSI > 70)
  candlesBearish.push(makeCandle(20, 120));
  candlesBearish.push(makeCandle(21, 121));
  // Pullback to 110 (RSI crosses back below 70)
  candlesBearish.push(makeCandle(22, 110));

  const stateBearish = calculateMeanReversion(candlesBearish);
  assert.equal(stateBearish.bollingerRsiConfirmation, 'BEARISH_REENTRY');
});

test('TASK-003: regime-gated mean reversion candidate qualification and trend veto', () => {
  // Use the bullish re-entry series from TASK-002
  const candlesBullish: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    candlesBullish.push(makeCandle(i, 100));
  }
  candlesBullish.push(makeCandle(20, 80));
  candlesBullish.push(makeCandle(21, 79));
  candlesBullish.push(makeCandle(22, 90));

  // Case 1: Favorable Regime (RANGE with ADX 16 <= 20) -> BUY_CANDIDATE
  const stateFavorable = calculateMeanReversion(candlesBullish, {
    regime: 'RANGE',
    adx14: 16,
  });
  assert.equal(stateFavorable.rangeFavorable, true);
  assert.equal(stateFavorable.reversionCandidate, 'BUY_CANDIDATE');

  // Case 2: Hostile Regime (TREND_DOWN with ADX 35 > 25) -> Strict Veto to NONE
  const stateVetoed = calculateMeanReversion(candlesBullish, {
    regime: 'TREND_DOWN',
    adx14: 35,
  });
  assert.equal(stateVetoed.rangeFavorable, false);
  assert.equal(stateVetoed.reversionCandidate, 'NONE', 'Strong trend must veto mean reversion');
});

test('TASK-004: MarketStateBuilder integrates MeanReversionEngine cleanly', () => {
  const candles = Array.from({ length: 50 }, (_, i) => makeCandle(i, 100 + (i % 5)));
  const builder = new MarketStateBuilder();
  const state = builder.build({
    symbol: 'BTCUSDT',
    candles,
    mark: 100,
    fundingRate: 0.0001,
  });

  assert.equal(typeof state.meanReversion.rangeFavorable, 'boolean');
  assert.ok(state.meanReversion.reversionCandidate !== undefined);
  assert.ok(['BUY_CANDIDATE', 'SELL_CANDIDATE', 'NONE'].includes(state.meanReversion.reversionCandidate!));
});
