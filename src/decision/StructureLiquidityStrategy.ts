import type { Signal, Side } from '../types.js';
import type { LiquidityPool, LiquiditySweep, MarketState, PriceZone } from '../market/types.js';

const LTF_BAR_MS = 15 * 60_000;

export interface StructureLiquidityOptions {
  maxSweepAgeCandles: number;
  minBreakDistanceAtr: number;
  stopBufferAtr: number;
  minStopAtr: number;
  maxStopAtr: number;
  minimumRewardRisk: number;
}

export const DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS: StructureLiquidityOptions = {
  maxSweepAgeCandles: 6,
  minBreakDistanceAtr: 0.10,
  stopBufferAtr: 0.15,
  minStopAtr: 0.50,
  maxStopAtr: 4.00,
  minimumRewardRisk: 1.50,
};

const isLong = (side: Side): boolean => side === 'LONG';

function expectedSweep(side: Side): LiquiditySweep['direction'] {
  return isLong(side) ? 'SELL_SIDE' : 'BUY_SIDE';
}

function isTargetPool(side: Side, pool: LiquidityPool, entry: number): boolean {
  const highSide = pool.type === 'EQUAL_HIGH'
    || pool.type === 'SWING_HIGH'
    || pool.type === 'RANGE_HIGH';
  const lowSide = pool.type === 'EQUAL_LOW'
    || pool.type === 'SWING_LOW'
    || pool.type === 'RANGE_LOW';

  return isLong(side) ? highSide && pool.price > entry : lowSide && pool.price < entry;
}

function targetPools(state: MarketState, side: Side, entry: number, breakTime: number): LiquidityPool[] {
  return [...state.liquidity.ltf.pools, ...state.liquidity.htf.pools]
    .filter((pool) => pool.sourceTimes.length > 0)
    .filter((pool) => Math.max(...pool.sourceTimes) < breakTime)
    .filter((pool) => isTargetPool(side, pool, entry))
    .sort((a, b) => (Math.abs(a.price - entry) - Math.abs(b.price - entry)) || (b.strength - a.strength));
}

function latestEligibleSweep(
  state: MarketState,
  side: Side,
  breakTime: number,
  options: StructureLiquidityOptions,
): LiquiditySweep | null {
  const sweeps = state.liquidity.ltf.recentSweeps ?? state.liquidity.ltf.latestSweeps;
  const maxAge = options.maxSweepAgeCandles * LTF_BAR_MS;

  return [...sweeps]
    .filter((sweep) => sweep.confirmed && sweep.direction === expectedSweep(side))
    .filter((sweep) => sweep.time <= breakTime && breakTime - sweep.time <= maxAge)
    .sort((a, b) => (b.time - a.time) || (b.index - a.index))[0] ?? null;
}

function preferredZone(state: MarketState, side: Side, breakTime: number): PriceZone | null {
  const type: PriceZone['type'] = isLong(side) ? 'DEMAND' : 'SUPPLY';

  return [...state.zones]
    .filter((zone) => zone.type === type)
    .filter((zone) => zone.timeframe === '15m' || zone.timeframe === '1h')
    .filter((zone) => zone.originTime < breakTime)
    .filter((zone) => zone.fresh)
    .sort((a, b) => b.originTime - a.originTime)[0] ?? null;
}

function stopAndRisk(
  state: MarketState,
  side: Side,
  entry: number,
  sweep: LiquiditySweep,
  zone: PriceZone | null,
  options: StructureLiquidityOptions,
): { stop: number; riskAtr: number } | null {
  const atr14 = state.timeframes['15m'].atr14;
  if (!atr14 || !(atr14 > 0)) return null;

  const buffer = atr14 * options.stopBufferAtr;
  const rawStop = isLong(side)
    ? Math.min(sweep.sweepPrice, zone?.low ?? Number.POSITIVE_INFINITY) - buffer
    : Math.max(sweep.sweepPrice, zone?.high ?? Number.NEGATIVE_INFINITY) + buffer;

  const riskDistance = Math.abs(entry - rawStop);
  if (!(riskDistance > 0)) return null;

  const riskAtr = riskDistance / atr14;
  if (riskAtr < options.minStopAtr || riskAtr > options.maxStopAtr) return null;

  return { stop: rawStop, riskAtr };
}

function targetAndRewardRisk(
  state: MarketState,
  side: Side,
  entry: number,
  riskDistance: number,
  breakTime: number,
  minimumRewardRisk: number,
): { target: LiquidityPool; rewardRisk: number } | null {
  if (!(riskDistance > 0)) return null;

  for (const pool of targetPools(state, side, entry, breakTime)) {
    const rewardDistance = Math.abs(pool.price - entry);
    const rewardRisk = rewardDistance / riskDistance;
    if (rewardRisk >= minimumRewardRisk) return { target: pool, rewardRisk };
  }

  return null;
}

/**
 * Deterministic SMC-style trend setup:
 * HTF directional regime -> LTF liquidity sweep -> LTF BOS/CHOCH confirmation -> opposing liquidity target.
 *
 * Analysis-only: no venue, risk gate, or executor calls.
 */
export function buildStructureLiquiditySignal(
  state: MarketState,
  options: StructureLiquidityOptions = DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS,
): Signal | null {
  if (!Number.isFinite(state.mark) || state.mark <= 0) return null;

  const { regime, htfStructure, ltfStructure } = state;
  const trendSide =
    regime.regime === 'TREND_UP' && regime.trendDirection === 'BULLISH' && htfStructure.trend === 'BULLISH'
      ? 'LONG'
      : regime.regime === 'TREND_DOWN' && regime.trendDirection === 'BEARISH' && htfStructure.trend === 'BEARISH'
        ? 'SHORT'
        : null;

  if (!trendSide) return null;

  const breakEvent = ltfStructure.lastBreak;
  if (!breakEvent) return null;

  const breakMatches =
    (trendSide === 'LONG' && breakEvent.direction === 'BULLISH')
    || (trendSide === 'SHORT' && breakEvent.direction === 'BEARISH');
  if (!breakMatches || breakEvent.distanceAtr < options.minBreakDistanceAtr) return null;

  const sweep = latestEligibleSweep(state, trendSide, breakEvent.time, options);
  if (!sweep) return null;

  const stopRisk = stopAndRisk(
    state,
    trendSide,
    state.mark,
    sweep,
    preferredZone(state, trendSide, breakEvent.time),
    options,
  );
  if (!stopRisk) return null;

  const { stop, riskAtr } = stopRisk;
  const riskDistance = Math.abs(state.mark - stop);
  const target = targetAndRewardRisk(
    state,
    trendSide,
    state.mark,
    riskDistance,
    breakEvent.time,
    options.minimumRewardRisk,
  );
  if (!target) return null;

  const long = trendSide === 'LONG';
  const id = `struct-liq-${state.symbol}-${breakEvent.time}`;
  const location = long ? state.pricing.discount : state.pricing.premium;
  const confidence = Math.min(0.95, 0.70 + (sweep.time === breakEvent.time ? 0.05 : 0) + (location ? 0.05 : 0));

  return {
    id,
    ts: state.generatedAt,
    agent: 'STRUCT-LIQ-η',
    symbol: state.symbol,
    type: long ? 'OPEN_LONG' : 'OPEN_SHORT',
    confidence,
    entry: state.mark,
    stopLoss: stop,
    takeProfit: target.target.price,
    reason:
      `HTF ${trendSide} regime + LTF ${breakEvent.type}; ${sweep.direction} sweep at ${sweep.level.toFixed(4)}; ` +
      `target liquidity ${target.target.price.toFixed(4)}; RR ${target.rewardRisk.toFixed(2)}; stop ${riskAtr.toFixed(2)} ATR`,
  };
}
