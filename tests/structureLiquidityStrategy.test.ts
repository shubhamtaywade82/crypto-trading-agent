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

function historySweep(overrides: Partial<LiquiditySweep> = {}): LiquiditySweep {
  return {
    poolType: 'SWING_LOW',
    direction: 'SELL_SIDE',
    level: 98,
    sweepPrice: 97,
    close: 99,
    index: 9,
    time: 9 * BAR_MS,
    confirmed: true,
    id: `${9 * BAR_MS}|SELL_SIDE|98|SWING_LOW|${5 * BAR_MS}`,
    poolSourceTimes: [5 * BAR_MS],
    ...overrides,
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

test('fires from the persistent sweep history when the legacy 12-bar window missed the sweep', () => {
  const state = baseState();
  state.liquidity.ltf = {
    ...state.liquidity.ltf,
    latestSweeps: [],
    recentSweeps: [],
    sweepHistory: [historySweep()],
  };

  const signal = buildStructureLiquiditySignal(state);

  assert.ok(signal);
  assert.equal(signal.type, 'OPEN_LONG');
  // The stop anchors to the history event's sweepPrice: min(97, zone low 97.5) - 0.15.
  assert.ok(Math.abs(signal.stopLoss! - 96.85) < 1e-9);
  assert.equal(signal.takeProfit, 106);
});

test('rejects a history sweep older than the configured sequence window', () => {
  const state = baseState();
  state.liquidity.ltf = {
    ...state.liquidity.ltf,
    latestSweeps: [],
    recentSweeps: [],
    sweepHistory: [historySweep({ time: 3 * BAR_MS, index: 3 })],
  };

  assert.equal(
    buildStructureLiquiditySignal(state, { ...DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS, maxSweepAgeCandles: 6 }),
    null,
  );
});

test('ignores sweep-history events that postdate the confirming break', () => {
  const state = baseState();
  state.liquidity.ltf = {
    ...state.liquidity.ltf,
    latestSweeps: [],
    recentSweeps: [],
    sweepHistory: [historySweep({ time: BREAK_TIME + BAR_MS, index: 11 })],
  };

  assert.equal(buildStructureLiquiditySignal(state), null);
});

test('unions history and legacy windows: a newer legacy sweep still wins the trigger', () => {
  const state = baseState();
  state.liquidity.ltf = {
    ...state.liquidity.ltf,
    sweepHistory: [historySweep({ time: 8 * BAR_MS, index: 8, level: 97, sweepPrice: 96 })],
  };
  // recentSweeps keeps the original event at 9 * BAR_MS with sweepPrice 97.

  const signal = buildStructureLiquiditySignal(state);

  assert.ok(signal);
  // The legacy event at 9 * BAR_MS is later than the history event at 8 * BAR_MS,
  // so the stop anchors to its sweepPrice: min(97, 97.5) - 0.15 = 96.85, not 95.85.
  assert.ok(Math.abs(signal.stopLoss! - 96.85) < 1e-9);
});

test('prefers the ledger history event when both windows describe the same candle', () => {
  const state = baseState();
  state.liquidity.ltf = {
    ...state.liquidity.ltf,
    sweepHistory: [historySweep({ level: 98.2, sweepPrice: 96.8 })],
  };
  // recentSweeps holds the same candle at level 98 / sweepPrice 97; time and
  // index tie, so the stable sort must keep the history event first.

  const signal = buildStructureLiquiditySignal(state);

  assert.ok(signal);
  // History sweepPrice drives the stop: min(96.8, 97.5) - 0.15 = 96.65.
  assert.ok(Math.abs(signal.stopLoss! - 96.65) < 1e-9);
});

test('falls back to the legacy sweep window when the state carries no sweep history', () => {
  const state = baseState();
  delete state.liquidity.ltf.sweepHistory;

  const signal = buildStructureLiquiditySignal(state);

  assert.ok(signal);
  assert.equal(signal.type, 'OPEN_LONG');
  assert.equal(signal.takeProfit, 106);
});

test('skips liquidity pools the sweep ledger consumed and targets the nearest untaken pool', () => {
  const state = baseState();
  const untaken = state.liquidity.ltf.pools[0]; // SWING_HIGH at 106
  const consumed: LiquidityPool = { ...untaken, price: 105, taken: true, sweptAt: 9 * BAR_MS };

  // Contrast: without the ledger annotation the nearer pool at 105 wins (RR 1.59).
  state.liquidity.ltf.pools = [{ ...consumed, taken: undefined, sweptAt: undefined }, untaken];
  const legacyBehavior = buildStructureLiquiditySignal(state);
  assert.ok(legacyBehavior);
  assert.equal(legacyBehavior.takeProfit, 105);

  // With the annotation the consumed pool is skipped and the target walks out to 106.
  state.liquidity.ltf.pools = [consumed, untaken];
  const signal = buildStructureLiquiditySignal(state);
  assert.ok(signal);
  assert.equal(signal.takeProfit, 106);
});

test('rejects the setup when every opposing liquidity pool is already taken', () => {
  const state = baseState();
  state.liquidity.ltf.pools = [
    { ...state.liquidity.ltf.pools[0], taken: true, sweptAt: 9 * BAR_MS },
  ];

  assert.equal(buildStructureLiquiditySignal(state), null);
});
