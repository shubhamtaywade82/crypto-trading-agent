import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketState } from '../src/market/types.js';
import { buildSetupMap, formatDuration } from '../src/decision/SetupEngine.js';

const T0 = Date.UTC(2026, 8, 25, 18, 0, 0);

function baseState(over: Partial<MarketState> = {}): MarketState {
  return {
    version: 1,
    symbol: 'BTCUSDT',
    generatedAt: T0,
    mark: 100,
    fundingRate: 0.0001,
    regime: {
      regime: 'TREND_UP',
      trendDirection: 'BULLISH',
      trendStrength: 0.8,
      volatility: 'MEDIUM',
      volatilityPercentile: 60,
      adx14: 28,
      emaSlopePct: 0.2,
    },
    timeframes: {
      '15m': { timeframe: '15m', candleCount: 200, lastClose: 100, ema20: 99, ema50: 98, ema200: 95, emaSlopePct: 0.2, adx14: 28, atr14: 1, atrPercentile: 60, rsi14: 58, vwap: 99, bollingerMiddle: 99, bollingerUpper: 101, bollingerLower: 97 },
      '1h': { timeframe: '1h', candleCount: 200, lastClose: 100, ema20: 99, ema50: 98, ema200: 95, emaSlopePct: 0.2, adx14: 30, atr14: 2, atrPercentile: 60, rsi14: 60, vwap: 99, bollingerMiddle: 99, bollingerUpper: 103, bollingerLower: 95 },
      '4h': { timeframe: '4h', candleCount: 200, lastClose: 100, ema20: 99, ema50: 98, ema200: 95, emaSlopePct: 0.2, adx14: 32, atr14: 3, atrPercentile: 60, rsi14: 62, vwap: 99, bollingerMiddle: 99, bollingerUpper: 105, bollingerLower: 93 },
    },
    htfStructure: {
      timeframe: '1h', trend: 'BULLISH', swingHighs: [], swingLows: [],
      lastBreak: { type: 'BOS', direction: 'BULLISH', level: 98, index: 199, time: T0 - 3_600_000, distanceAtr: 1 },
      protectedHigh: null, protectedLow: null,
    },
    ltfStructure: {
      timeframe: '15m', trend: 'BULLISH', swingHighs: [], swingLows: [],
      lastBreak: { type: 'BOS', direction: 'BULLISH', level: 99, index: 199, time: T0 - 900_000, distanceAtr: 1 },
      protectedHigh: null, protectedLow: null,
    },
    liquidity: {
      htf: {
        timeframe: '1h', pools: [
          { type: 'SWING_HIGH', price: 105, tolerance: 0.2, strength: 0.8, timeframe: '1h', sourceTimes: [T0 - 7_200_000] },
          { type: 'SWING_HIGH', price: 110, tolerance: 0.2, strength: 0.7, timeframe: '1h', sourceTimes: [T0 - 10_800_000] },
        ],
        latestSweeps: [], recentSweeps: [],
      },
      ltf: {
        timeframe: '15m', pools: [
          { type: 'SWING_HIGH', price: 105, tolerance: 0.2, strength: 0.8, timeframe: '15m', sourceTimes: [T0 - 1_800_000] },
          { type: 'SWING_HIGH', price: 110, tolerance: 0.2, strength: 0.7, timeframe: '15m', sourceTimes: [T0 - 3_600_000] },
        ],
        latestSweeps: [],
        recentSweeps: [{
          poolType: 'EQUAL_LOW', direction: 'SELL_SIDE', level: 98, sweepPrice: 97.4, close: 100, index: 198, time: T0 - 900_000, confirmed: true,
        }],
      },
    },
    zones: [
      { type: 'DEMAND', timeframe: '15m', high: 99.2, low: 98, originTime: T0 - 1_800_000, causedBreak: 'BOS', displacementAtr: 1.2, touches: 0, fresh: true, strength: 0.9 },
    ],
    pricing: { high: 105, low: 95, equilibrium: 100, positionPct: 50, premium: false, discount: false },
    meanReversion: { mean: 99, vwap: 99, zscore: 0.2, rsi14: 58, bollingerMiddle: 99, bollingerUpper: 101, bollingerLower: 97, deviationPct: 1 },
    derivatives: null,
    crowding: {
      fundingPercentile: 60,
      topTraderVsGlobalBias: 1,
      positioningExtreme: 'BALANCED',
      takerAggressionRatio: 1.2,
      openInterestExpansion: true,
    },
    ...over,
  };
}

test('buildSetupMap exposes sweep, pullback and breakout scenarios with timing', () => {
  const map = buildSetupMap(baseState());
  assert.equal(map.state, 'TRIGGERED');
  assert.equal(map.bias, 'BULLISH');
  assert.equal(map.location, 'EQUILIBRIUM');
  assert.ok(map.scenarios.length >= 2);
  const sweep = map.scenarios.find((s) => s.kind === 'LIQUIDITY_SWEEP');
  assert.ok(sweep);
  assert.equal(sweep?.state, 'TRIGGERED');
  assert.ok((sweep?.expectedMove.minMinutes ?? 0) > 0);
  assert.ok((sweep?.expectedMove.maxMinutes ?? 0) >= (sweep?.expectedMove.minMinutes ?? 0));
  assert.match(sweep?.flowHypothesis ?? '', /sweep|reversal/i);
});

test('buildSetupMap refuses to manufacture a setup without directional structure', () => {
  const state = baseState({
    regime: { ...baseState().regime, regime: 'RANGE', trendDirection: 'NEUTRAL' },
    htfStructure: { ...baseState().htfStructure, trend: 'NEUTRAL' },
    ltfStructure: { ...baseState().ltfStructure, trend: 'NEUTRAL' },
    zones: [],
    liquidity: { htf: { ...baseState().liquidity.htf, pools: [] }, ltf: { ...baseState().liquidity.ltf, pools: [], recentSweeps: [], latestSweeps: [] } },
  });
  const map = buildSetupMap(state);
  assert.equal(map.state, 'NO_TRADE');
  assert.equal(map.scenarios.length, 0);
  assert.ok(map.noTradeReasons.some((reason) => /unresolved/i.test(reason)));
});

test('formatDuration keeps Telegram timing compact', () => {
  assert.equal(formatDuration({ minMinutes: 15, maxMinutes: 90, thesisExpiryMinutes: 180, distanceAtr: 1 }), '15m–1.5h');
  assert.equal(formatDuration({ minMinutes: 120, maxMinutes: 240, thesisExpiryMinutes: 360, distanceAtr: 2 }), '2h–4h');
});
