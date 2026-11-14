import { closedBar, type Frame } from './MtfFrame.js';
import type { DepthMinute, TradeMinute } from '../backtesting/archiveTicks.js';

/**
 * Causal market-state features for one decision minute k (docs/NEMESIS_G4_STRATEGY_SPECS.md §29). Everything read here
 * is closed by the end of minute k: 1m bars, higher timeframes through `closedBar`, settled funding, and the 1m tick reductions.
 */
export const PRICE_FEATURES = [
  'ret5', 'ret15', 'ret60', 'ret240', 'ret1440', 'gap1h', 'gap4h', 'slope4h', 'distEma1h', 'rsi15', 'rsi1h',
  'atr15', 'atr1h', 'atr4h', 'atrRatio', 'volSurge', 'taker15', 'taker60', 'rangePos24h', 'hourSin', 'hourCos', 'funding',
] as const;
export const TICK_FEATURES = ['aggressor15', 'aggressor60', 'large15', 'large60', 'tradeRate', 'book1', 'book5'] as const;

export interface TickMinutes { trades: TradeMinute[]; depth: DepthMinute[]; start: number }
export interface StateData {
  f: Frame;
  /** Last settled funding rate in force at each minute. */
  funding: Float64Array;
  cumVolume: Float64Array; cumTakerBuy: Float64Array;
  tick?: { cumBuy: Float64Array; cumSell: Float64Array; cumLargeBuy: Float64Array; cumLargeSell: Float64Array; cumTrades: Float64Array; book1: Float64Array; book5: Float64Array };
}

function prefix(values: ArrayLike<number>): Float64Array {
  const out = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i += 1) out[i + 1] = out[i]! + (Number.isFinite(values[i]!) ? values[i]! : 0);
  return out;
}

const imbalance = (bid: number | null, ask: number | null): number => (bid === null || ask === null || bid + ask === 0 ? NaN : (bid - ask) / (bid + ask));

/** Last non-null book imbalance carried forward, so a minute without a snapshot reuses the previous one. */
function bookSeries(depth: DepthMinute[], bid: 0 | 2, ask: 1 | 3, length: number): Float64Array {
  const out = new Float64Array(length).fill(NaN);
  let last = NaN;
  for (let i = 0; i < length; i += 1) {
    const value = depth[i] ? imbalance(depth[i]![bid], depth[i]![ask]) : NaN;
    if (Number.isFinite(value)) last = value;
    out[i] = last;
  }
  return out;
}

export function buildStateData(f: Frame, funding: Float64Array, ticks?: TickMinutes): StateData {
  const data: StateData = { f, funding, cumVolume: prefix(f.volume), cumTakerBuy: prefix(f.takerBuy) };
  if (!ticks) return data;
  const at = (rows: TradeMinute[], column: number): number[] => Array.from({ length: f.minutes }, (_, i) => rows[i]?.[column] ?? NaN);
  data.tick = {
    cumBuy: prefix(at(ticks.trades, 0)), cumSell: prefix(at(ticks.trades, 1)), cumTrades: prefix(at(ticks.trades, 2)),
    cumLargeBuy: prefix(at(ticks.trades, 3)), cumLargeSell: prefix(at(ticks.trades, 4)),
    book1: bookSeries(ticks.depth, 0, 1, f.minutes), book5: bookSeries(ticks.depth, 2, 3, f.minutes),
  };
  return data;
}

const windowSum = (cum: Float64Array, k: number, minutes: number): number => cum[k + 1]! - cum[k + 1 - minutes]!;

function priceRow(d: StateData, k: number): number[] {
  const { f } = d;
  const c15 = closedBar(15, k); const c1 = closedBar(60, k); const c4 = closedBar(240, k);
  const t15 = f.tf[15]; const t1 = f.tf[60]; const t4 = f.tf[240];
  const close = f.close[k]!;
  const ret = (minutes: number): number => close / f.close[k - minutes]! - 1;
  let hi = -Infinity; let lo = Infinity;
  for (let j = c1 - 23; j <= c1; j += 1) { hi = Math.max(hi, t1.high[j]!); lo = Math.min(lo, t1.low[j]!); }
  const volume60 = windowSum(d.cumVolume, k, 60);
  const baseline = (d.cumVolume[k - 59]! - d.cumVolume[k - 59 - 1440]!) / 24;
  const share = (minutes: number): number => windowSum(d.cumTakerBuy, k, minutes) / windowSum(d.cumVolume, k, minutes) - 0.5;
  const hour = Math.floor((k % 1440) / 60);
  return [
    ret(5), ret(15), ret(60), ret(240), ret(1440),
    (t1.ema50[c1]! - t1.ema200[c1]!) / close, (t4.ema50[c4]! - t4.ema200[c4]!) / close, (t4.ema50[c4]! - t4.ema50[c4 - 6]!) / close,
    (close - t1.ema50[c1]!) / t1.atr[c1]!, t15.rsi[c15]! / 100 - 0.5, t1.rsi[c1]! / 100 - 0.5,
    t15.atr[c15]! / close, t1.atr[c1]! / close, t4.atr[c4]! / close, t15.atr[c15]! / t1.atr[c1]!,
    Math.log(volume60 / baseline), share(15), share(60), (close - lo) / (hi - lo),
    Math.sin((2 * Math.PI * hour) / 24), Math.cos((2 * Math.PI * hour) / 24), d.funding[k]!,
  ];
}

function tickRow(d: StateData, k: number): number[] {
  const t = d.tick!;
  const aggressor = (minutes: number): number => { const buy = windowSum(t.cumBuy, k, minutes); const sell = windowSum(t.cumSell, k, minutes); return (buy - sell) / (buy + sell); };
  const large = (minutes: number): number => (windowSum(t.cumLargeBuy, k, minutes) - windowSum(t.cumLargeSell, k, minutes)) / (windowSum(t.cumBuy, k, minutes) + windowSum(t.cumSell, k, minutes));
  const trades15 = windowSum(t.cumTrades, k, 15);
  const baseline15 = (t.cumTrades[k - 14]! - t.cumTrades[k - 14 - 1440]!) / 96;
  return [aggressor(15), aggressor(60), large(15), large(60), Math.log(trades15 / baseline15), t.book1[k]!, t.book5[k]!];
}

/** Feature vector for decision minute k (price set, plus the tick set when `data.tick` exists); null if anything is missing. */
export function featureRow(d: StateData, k: number): number[] | null {
  if (k < 1440 + 61 || k >= d.f.minutes) return null;
  const row = d.tick ? [...priceRow(d, k), ...tickRow(d, k)] : priceRow(d, k);
  return row.every(Number.isFinite) ? row : null;
}
