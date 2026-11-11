import { PerpetualExecutionEngine } from '../backtesting/PerpetualExecutionEngine.js';
import type { Candle } from '../types.js';

/**
 * Trade simulator for the G4 pre-registered specs (docs/NEMESIS_G4_STRATEGY_SPECS.md §3): signals on closed 1h bars,
 * entry at the next 1m open, every stop/target/trail/time exit resolved on the 1m path, stop first when both touch in
 * one minute, gaps through the stop fill at the open, funding charged at real settlements on the mark price, and
 * liquidation checked against 1m mark-price extremes.
 */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/** Contiguous 1m series; index = (time - start) / 1 minute. Missing minutes are NaN. */
export interface MinuteSeries { start: number; open: Float64Array; high: Float64Array; low: Float64Array; close: Float64Array }

export function toMinuteSeries(candles: readonly Candle[], start: number, end: number): MinuteSeries {
  const n = (end - start) / MINUTE_MS;
  const series = { start, open: new Float64Array(n).fill(NaN), high: new Float64Array(n).fill(NaN), low: new Float64Array(n).fill(NaN), close: new Float64Array(n).fill(NaN) };
  for (const c of candles) {
    const i = (c.openTime - start) / MINUTE_MS;
    if (i < 0 || i >= n) continue;
    series.open[i] = c.open; series.high[i] = c.high; series.low[i] = c.low; series.close[i] = c.close;
  }
  return series;
}

export interface CostModel { feeRate: number; slippageRate: number }
export const DEFAULT_COSTS: CostModel = { feeRate: 0.0004, slippageRate: 0.0002 };

export interface Signal {
  side: 1 | -1;
  /** Index of the closed 1h bar that produced the signal. */
  hour: number;
  stopDistance: number;
  /** Absolute stop (e.g. behind a sweep). When set, the risk distance is measured from the actual fill to it. */
  stopPrice?: number;
  /** Entry minute for signals that are not on a 1h close (e.g. 15m); defaults to the open after `hour` closes. */
  entryTime?: number;
  target?: number;
  /** Chandelier trail distance in price, ratcheted on 1h closes. */
  trailDistance?: number;
  maxHoldMs: number;
  sizeMultiplier: number;
  label: string;
  /** Checked on every 1h close while open; true exits at the next 1m open. */
  invalidate?: (hour: number) => boolean;
}

export type ExitReason = 'STOP' | 'TARGET' | 'INVALIDATED' | 'TIME' | 'LIQUIDATED' | 'END_OF_DATA';

export interface Trade {
  label: string; side: 1 | -1; hour: number; stopDistance: number; entryTime: number; exitTime: number; entry: number; exit: number; reason: ExitReason;
  grossR: number; costR: number; fundingR: number; netR: number; sizeMultiplier: number; markGap: boolean;
}

/** `fundingByMinute`: settled rate keyed by the 1m index the settlement falls in. */
export interface Market { trade: MinuteSeries; mark: MinuteSeries; fundingByMinute: ReadonlyMap<number, number>; hourStart: number; leverage: number; mmr: number }

const ENGINE = new PerpetualExecutionEngine();

interface Open { signal: Signal; entryIndex: number; entry: number; stop: number; extreme: number; fundingPerUnit: number; markGap: boolean; liquidation: number }

function openPosition(market: Market, requested: Signal): Open | null {
  let signal = requested;
  const entryTime = signal.entryTime ?? market.hourStart + (signal.hour + 1) * HOUR_MS;
  const entryIndex = (entryTime - market.trade.start) / MINUTE_MS;
  const entry = market.trade.open[entryIndex];
  if (entry === undefined || !Number.isFinite(entry)) return null;
  if (signal.stopPrice !== undefined) {
    if (signal.side * (entry - signal.stopPrice) <= 0) return null; // filled through the stop: the setup is gone
    signal = { ...signal, stopDistance: Math.abs(entry - signal.stopPrice) };
  }
  const liquidation = ENGINE.calculateLiquidationPrice({ entryPrice: entry, leverage: market.leverage, mmr: market.mmr, isLong: signal.side === 1 });
  return { signal, entryIndex, entry, stop: entry - signal.side * signal.stopDistance, extreme: entry, fundingPerUnit: 0, markGap: false, liquidation };
}

/** Exit price for minute i if a stop, liquidation or target fires there, stop before target. */
function intraminuteExit(market: Market, pos: Open, i: number): { price: number; reason: ExitReason } | null {
  const { side, target } = pos.signal;
  const t = market.trade;
  const adverse = side === 1 ? t.low[i]! : t.high[i]!;
  const favourable = side === 1 ? t.high[i]! : t.low[i]!;
  const markAdverse = side === 1 ? market.mark.low[i]! : market.mark.high[i]!;
  if (!Number.isFinite(markAdverse)) pos.markGap = true;
  else if (side * (markAdverse - pos.liquidation) <= 0) return { price: pos.liquidation, reason: 'LIQUIDATED' };
  if (side * (t.open[i]! - pos.stop) <= 0) return { price: t.open[i]!, reason: 'STOP' };
  if (side * (adverse - pos.stop) <= 0) return { price: pos.stop, reason: 'STOP' };
  if (target !== undefined && side * (favourable - target) >= 0) return { price: target, reason: 'TARGET' };
  return null;
}

function settleFunding(market: Market, pos: Open, i: number): void {
  const rate = market.fundingByMinute.get(i);
  if (rate === undefined || i === pos.entryIndex) return; // a position opened in the settlement minute was not held at settlement
  const mark = Number.isFinite(market.mark.close[i]!) ? market.mark.close[i]! : market.trade.close[i]!;
  pos.fundingPerUnit -= pos.signal.side * rate * mark;
}

/** On a 1h close: ratchet the trail, then report whether the position should exit at the next open. */
function onHourClose(market: Market, pos: Open, i: number, hour: number): boolean {
  const { side, trailDistance, invalidate } = pos.signal;
  const from = i - 59;
  for (let k = Math.max(from, pos.entryIndex); k <= i; k += 1) {
    const price = side === 1 ? market.trade.high[k]! : market.trade.low[k]!;
    if (side * (price - pos.extreme) > 0) pos.extreme = price;
  }
  if (trailDistance !== undefined) {
    const trail = pos.extreme - side * trailDistance;
    if (side * (trail - pos.stop) > 0) pos.stop = trail;
  }
  return invalidate?.(hour) ?? false;
}

function closeTrade(market: Market, pos: Open, exitIndex: number, exit: number, reason: ExitReason, costs: CostModel): Trade {
  const { side, stopDistance, sizeMultiplier, label } = pos.signal;
  const perSide = costs.feeRate + costs.slippageRate;
  const grossR = (side * (exit - pos.entry)) / stopDistance;
  const costR = (perSide * (pos.entry + exit)) / stopDistance;
  const fundingR = pos.fundingPerUnit / stopDistance;
  const entryTime = market.trade.start + pos.entryIndex * MINUTE_MS;
  return {
    label, side, hour: pos.signal.hour, stopDistance, entryTime, exitTime: market.trade.start + exitIndex * MINUTE_MS, entry: pos.entry, exit, reason,
    grossR, costR, fundingR, netR: grossR - costR + fundingR, sizeMultiplier, markGap: pos.markGap,
  };
}

/** Walks one position minute by minute until it exits. */
export function simulateTrade(market: Market, signal: Signal, costs: CostModel = DEFAULT_COSTS): Trade | null {
  const pos = openPosition(market, signal);
  if (!pos) return null;
  const last = market.trade.open.length - 1;
  const deadline = pos.entryIndex + signal.maxHoldMs / MINUTE_MS;
  let exitNextOpen: ExitReason | null = null;
  for (let i = pos.entryIndex; i <= last; i += 1) {
    if (exitNextOpen) return closeTrade(market, pos, i, market.trade.open[i]!, exitNextOpen, costs);
    const hit = intraminuteExit(market, pos, i);
    if (hit) return closeTrade(market, pos, i, hit.price, hit.reason, costs);
    settleFunding(market, pos, i);
    if (i + 1 >= deadline) return closeTrade(market, pos, i, market.trade.close[i]!, 'TIME', costs);
    const minuteEnd = market.trade.start + (i + 1) * MINUTE_MS;
    if (minuteEnd % HOUR_MS === 0 && onHourClose(market, pos, i, (minuteEnd - market.hourStart) / HOUR_MS - 1)) exitNextOpen = 'INVALIDATED';
  }
  return closeTrade(market, pos, last, market.trade.close[last]!, 'END_OF_DATA', costs);
}

/**
 * Runs a strategy over the hours: one position at a time, the next signal only after the previous trade exited.
 * `signalAt` sees only hour bars up to and including `hour`.
 */
export function runStrategy(market: Market, hours: number, signalAt: (hour: number) => Signal | null, costs: CostModel = DEFAULT_COSTS): Trade[] {
  const trades: Trade[] = [];
  for (let hour = 0; hour < hours - 1; hour += 1) {
    const signal = signalAt(hour);
    if (!signal) continue;
    const trade = simulateTrade(market, signal, costs);
    if (!trade) continue;
    trades.push(trade);
    hour = Math.floor((trade.exitTime - market.hourStart) / HOUR_MS) - 1; // the exit hour's own close may signal again
  }
  return trades;
}

/** Like runStrategy for signals on any bar grid: `closeTimeOf(k)` is when bar k closes; bars closing before the last exit are skipped. */
export function runOnBars(market: Market, count: number, signalAt: (k: number) => Signal | null, closeTimeOf: (k: number) => number, costs: CostModel = DEFAULT_COSTS): Trade[] {
  const trades: Trade[] = [];
  let flatFrom = -Infinity;
  for (let k = 0; k < count; k += 1) {
    if (closeTimeOf(k) < flatFrom) continue;
    const signal = signalAt(k);
    const trade = signal ? simulateTrade(market, signal, costs) : null;
    if (!trade) continue;
    trades.push(trade);
    flatFrom = trade.exitTime;
  }
  return trades;
}
