import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiquidityPool, LiquiditySweep, MarketState, PriceZone } from '../src/market/types.js';
import type { Candle } from '../src/types.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';
import {
  buildStructureLiquiditySignal,
  DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS,
} from '../src/decision/StructureLiquidityStrategy.js';

const BAR_MS = 15 * 60_000;
const BREAK_TIME = 10 * BAR_MS;

function candle(index: number, close = 100): Candle {
  return {
    openTime: index * BAR_MS,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  };
}

function baseState(): MarketState {
  const candles = Array.from({ length: 300 }, (_, i) => candle(i, 90 + i * 0.05));
  const base = new MarketStateBuilder().build({
    symbol: 'BTCUSDT',
    candles,
    mark: 100,
    fundingRate: 0,
  });

  const sweep: LiquiditySweep = {
    poolType: 'SWING_LOW',
    direction: 'SELL_SIDE',
    level: 98,
    sweepPrice: 97,
    close: 99,
    index: 9,
    time: 9 * BAR_MS,
    confirmed: true,
  };

  const target: LiquidityPool = {
    type: 'SWING_HIGH',
    price: 106,
    tolerance: 0.2,
    strength: 0.8,
    timeframe: '1h',
    sourceTimes: [6 * BAR_MS],
  };

  const demand: PriceZone = {
    type: 'DEMAND',
    timeframe: '15m',
    high: 99,
    low: 97.5,
    originTime: 8 * BAR_MS,
    causedBreak: 'BOS',
    displacementAtr: 2,
    touches: 0,
    fresh: true,
    strength: 0.9,
  };

  return {
    ...base,
    generatedAt: BREAK_TIME,
    mark: 100,
    regime: { ...base.regime, regime: 'TREND_UP', trendDirection: 'BULLISH', adx14: 30 },
    htfStructure: { ...base.htfStructure, trend: 'BULLISH' },
    ltfStructure: {
      ...base.ltfStructure,
      trend: 'BULLISH',
      lastBreak: {
        type: 'BOS',
        direction: 'BULLISH',
        level: 99,
        index: 10,
        time: BREAK_TIME,
        distanceAtr: 1,
      },
    },
    timeframes: { ...base.timeframes, '15m': { ...base.timeframes['15m'], atr14: 1 } },
    liquidity: {
      htf: { ...base.liquidity.htf, pools: [] },
      ltf: { ...base.liquidity.ltf, pools: [target], latestSweeps: [], recentSweeps: [sweep] },
    },
    zones: [demand],
    pricing: { ...base.pricing, positionPct: 25, premium: false, discount: true },
  };
}

test('builds a deterministic long setup from HTF trend, LTF BOS, prior sell-side sweep and opposing liquidity', () => {
  const state = baseState();
  const signal = buildStructureLiquiditySignal(state);

  assert.ok(signal);
  assert.equal(signal.agent, 'STRUCT-LIQ-η');
  assert.equal(signal.type, 'OPEN_LONG');
  assert.equal(signal.symbol, 'BTCUSDT');
  assert.equal(signal.id, `struct-liq-BTCUSDT-${BREAK_TIME}`);
  assert.equal(signal.ts, BREAK_TIME);
  assert.equal(signal.entry, 100);
  assert.ok(signal.stopLoss! < signal.entry!);
  assert.equal(signal.takeProfit, 106);
  assert.ok(signal.confidence >= 0.75);
  assert.match(signal.reason, /SELL_SIDE sweep/);
  assert.match(signal.reason, /target liquidity 106/);
  assert.match(signal.reason, /RR 1\.90/);
});

test('uses the latest eligible sweep and rejects a sweep older than the configured sequence window', () => {
  const state = baseState();
  state.liquidity.ltf.recentSweeps = [{ ...state.liquidity.ltf.recentSweeps[0], time: 3 * BAR_MS, index: 3 }];

  assert.equal(
    buildStructureLiquiditySignal(state, { ...DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS, maxSweepAgeCandles: 6 }),
    null,
  );
});

test('rejects a setup when the liquidity target cannot satisfy the minimum reward:risk', () => {
  const state = baseState();
  state.liquidity.ltf.pools = [{ ...state.liquidity.ltf.pools[0], price: 104 }];

  assert.equal(buildStructureLiquiditySignal(state), null);
});

test('rejects a setup when the stop is wider than the configured ATR budget', () => {
  const state = baseState();
  state.liquidity.ltf.recentSweeps = [{ ...state.liquidity.ltf.recentSweeps[0], sweepPrice: 95, level: 96 }];
  assert.equal(buildStructureLiquiditySignal(state), null);
});

test('requires the confirming break direction to agree with the HTF trend regime', () => {
  const state = baseState();
  state.ltfStructure = {
    ...state.ltfStructure,
    lastBreak: { ...state.ltfStructure.lastBreak!, direction: 'BEARISH' },
  };

  assert.equal(buildStructureLiquiditySignal(state), null);
});

test('builds the symmetric short setup from a buy-side sweep and downside liquidity target', () => {
  const state = baseState();
  const sweep: LiquiditySweep = {
    poolType: 'SWING_HIGH',
    direction: 'BUY_SIDE',
    level: 102,
    sweepPrice: 103,
    close: 101,
    index: 9,
    time: 9 * BAR_MS,
    confirmed: true,
  };
  const target: LiquidityPool = {
    type: 'SWING_LOW',
    price: 94,
    tolerance: 0.2,
    strength: 0.8,
    timeframe: '1h',
    sourceTimes: [6 * BAR_MS],
  };
  const supply: PriceZone = {
    type: 'SUPPLY',
    timeframe: '15m',
    high: 103,
    low: 101,
    originTime: 8 * BAR_MS,
    causedBreak: 'BOS',
    displacementAtr: 2,
    touches: 0,
    fresh: true,
    strength: 0.9,
  };

  state.regime = { ...state.regime, regime: 'TREND_DOWN', trendDirection: 'BEARISH' };
  state.htfStructure = { ...state.htfStructure, trend: 'BEARISH' };
  state.ltfStructure = {
    ...state.ltfStructure,
    trend: 'BEARISH',
    lastBreak: {
      type: 'BOS',
      direction: 'BEARISH',
      level: 101,
      index: 10,
      time: BREAK_TIME,
      distanceAtr: 1,
    },
  };
  state.liquidity.ltf = { ...state.liquidity.ltf, pools: [target], latestSweeps: [], recentSweeps: [sweep] };
  state.zones = [supply];
  state.pricing = { ...state.pricing, positionPct: 75, premium: true, discount: false };

  const signal = buildStructureLiquiditySignal(state);

  assert.ok(signal);
  assert.equal(signal.type, 'OPEN_SHORT');
  assert.equal(signal.entry, 100);
  assert.ok(signal.stopLoss! > signal.entry!);
  assert.equal(signal.takeProfit, 94);
  assert.match(signal.reason, /BUY_SIDE sweep/);
});
