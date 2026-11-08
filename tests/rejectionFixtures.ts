import {
  TIMEFRAME_MS, barKnownAt,
  type FlowBar, type MinuteInput, type RejectionConfig, type RejectionEvent, type RejectionTimeframe, type ZoneDirection,
} from '../src/market/rejection/types.js';

export const SYMBOL = 'SOLUSDT';

/** Start aligned to every supported timeframe. */
export function alignedStart(tf: RejectionTimeframe): number {
  const ms = TIMEFRAME_MS[tf];
  return Math.floor(1_700_000_000_000 / ms) * ms;
}

/** Price and volume of one bar. Defaults: base 100, quote 10 000, half of base bought by takers, 50 trades. */
export interface Px {
  o: number;
  h: number;
  l: number;
  c: number;
  base?: number;
  quote?: number;
  takerBuy?: number;
  trades?: number;
}

export const FLAT: Px = { o: 100, h: 101, l: 99, c: 100 };
/** Bullish sweep: takes out 99, reclaims at 100.5, wick 0.66 of range, sell-led (delta -0.4), 3x relative volume. */
export const SWEEP_DEMAND: Px = { o: 99.5, h: 100.8, l: 97, c: 100.5, quote: 30_000, takerBuy: 30 };
/** Bullish follow-through: 1.5 above the reclaim close, which is 0.58 ATR when ATR is 2.6. */
export const FOLLOW: Px = { o: 100.5, h: 102, l: 100.2, c: 101.8 };

/** Mirror image around 100: every price maps to 200 - p, and buy and sell volume swap. Used for the SUPPLY tests. */
export function mirror(p: Px): Px {
  const base = p.base ?? 100;
  const takerBuy = p.takerBuy ?? base / 2;
  return {
    o: 200 - p.o,
    h: 200 - p.l,
    l: 200 - p.h,
    c: 200 - p.c,
    base: p.base,
    quote: p.quote,
    takerBuy: base - takerBuy,
    trades: p.trades,
  };
}

export function flowSeries(tf: RejectionTimeframe, pxs: readonly Px[], start = alignedStart(tf)): FlowBar[] {
  return pxs.map((p, i) => {
    const base = p.base ?? 100;
    return {
      symbol: SYMBOL,
      timeframe: tf,
      openTime: start + i * TIMEFRAME_MS[tf],
      open: p.o,
      high: p.h,
      low: p.l,
      close: p.c,
      baseVolume: base,
      quoteVolume: p.quote ?? 10_000,
      takerBuyBaseVolume: p.takerBuy ?? base / 2,
      trades: p.trades ?? 50,
      minuteCount: TIMEFRAME_MS[tf] / TIMEFRAME_MS['1m'],
      complete: true,
    };
  });
}

export function kline(openTime: number, p: Px, symbol = SYMBOL): MinuteInput {
  const base = p.base ?? 100;
  return {
    symbol,
    openTime,
    open: p.o,
    high: p.h,
    low: p.l,
    close: p.c,
    baseVolume: base,
    quoteVolume: p.quote ?? 10_000,
    takerBuyBaseVolume: p.takerBuy ?? base / 2,
    trades: p.trades ?? 50,
  };
}

/** Minute klines from a list of prices, starting at the aligned 1m origin. */
export function minuteKlines(pxs: readonly Px[], symbol = SYMBOL): MinuteInput[] {
  const start = alignedStart('1m');
  return pxs.map((p, i) => kline(start + i * TIMEFRAME_MS['1m'], p, symbol));
}

/** A small, hand-checkable config: ATR(3), 5-bar reference, 5-bar volume median, 3-bar confirmation. */
export const SMALL_CONFIG: RejectionConfig = {
  atrPeriod: 3,
  volumeWindow: 5,
  minVolumeHistory: 3,
  lookbackBars: 5,
  minRelativeVolume: 1.5,
  minWickRatio: 0.45,
  confirmBars: 3,
  minReversalAtr: 0.5,
};

/** Deterministic pseudo-random generator (LCG). Same seed, same stream, in every run. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

/** Random-walk bars with realistic wicks and volumes, for property tests. */
export function randomWalk(tf: RejectionTimeframe, n: number, seed: number): FlowBar[] {
  const rand = lcg(seed);
  const pxs: Px[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = open * (1 + (rand() - 0.5) * 0.012);
    const hi = Math.max(open, close) * (1 + rand() * 0.006);
    const lo = Math.min(open, close) * (1 - rand() * 0.006);
    const base = 50 + rand() * 150;
    pxs.push({
      o: open,
      h: hi,
      l: lo,
      c: close,
      base,
      quote: base * close * (0.5 + rand() * 2.5),
      takerBuy: base * rand(),
    });
  }
  return flowSeries(tf, pxs);
}

/** Builds a RejectionEvent for zone tests. Fields not relevant to zone building get neutral defaults. */
export function makeEvent(p: {
  id: string;
  direction: ZoneDirection;
  zoneLow: number;
  zoneHigh: number;
  resolvedAt: number | null;
  atr: number;
  status?: RejectionEvent['status'];
  timeframe?: RejectionTimeframe;
  reversalAtr?: number;
  reversalBars?: number;
  relativeVolume?: number;
  deltaRatio?: number;
}): RejectionEvent {
  const status = p.status ?? 'CONFIRMED';
  const demand = p.direction === 'DEMAND';
  return {
    id: p.id,
    symbol: SYMBOL,
    timeframe: p.timeframe ?? '5m',
    direction: p.direction,
    kind: 'REJECTION',
    status,
    failReason: status === 'FAILED' ? 'RECLAIM_LOST' : null,
    sweepOpenTime: p.resolvedAt === null ? 0 : p.resolvedAt - 2 * TIMEFRAME_MS[p.timeframe ?? '5m'],
    resolvedAt: p.resolvedAt,
    referenceLevel: demand ? p.zoneHigh : p.zoneLow,
    extreme: demand ? p.zoneLow : p.zoneHigh,
    zoneLow: p.zoneLow,
    zoneHigh: p.zoneHigh,
    reclaimClose: demand ? p.zoneHigh : p.zoneLow,
    atr: p.atr,
    relativeVolume: p.relativeVolume ?? 3,
    volumeDelta: 0,
    deltaRatio: p.deltaRatio ?? -0.2,
    wickRatio: 0.6,
    closeLocation: 0.9,
    reversalAtr: p.reversalAtr ?? 1,
    reversalBars: p.reversalBars ?? 1,
    evidence: [],
  };
}

/** Known-at time of bar i in a series, for stamping events. */
export const knownAt = (bars: readonly FlowBar[], i: number): number => {
  const bar = bars[i];
  if (!bar) throw new Error(`no bar at ${i}`);
  return barKnownAt(bar);
};
