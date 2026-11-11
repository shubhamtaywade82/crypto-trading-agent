import { wilderAtr } from '../binance/indicators.js';
import type { FundingPoint, MetricsPoint } from '../backtesting/archiveDerivatives.js';
import type { Candle } from '../types.js';
import type { Regime, RegimeFeatures } from './RegimeClassifier.js';
import { HOUR_MS, type Signal } from './SignalBacktest.js';

/**
 * Signal rules exactly as pre-registered in docs/NEMESIS_G4_STRATEGY_SPECS.md §5. Each factory returns
 * `signalAt(hour)`, which reads only bars and data available at that hour's close.
 */
export interface HourContext {
  bars: readonly Candle[];
  features: readonly RegimeFeatures[];
  regimes: readonly Regime[];
  atr: readonly number[];
  hourStart: number;
}

const DAY_MS = 86_400_000;
const METRICS_LAG_MS = 5 * 60_000;
const FUNDING_LOOKBACK_MS = 90 * DAY_MS;
const MIN_FUNDING_HISTORY = 200; // ~67 days of 8h settlements before a percentile is trusted

export function hourContext(bars: readonly Candle[], features: readonly RegimeFeatures[], regimes: readonly Regime[]): HourContext {
  return { bars, features, regimes, atr: wilderAtr([...bars], 14), hourStart: bars[0]!.openTime };
}

/** §1: STRESS blocks entries, HIGH_VOL halves size. Null = no entry allowed. */
function sizeFor(ctx: HourContext, hour: number): number | null {
  const regime = ctx.regimes[hour];
  if (regime === 'STRESS_CRASH') return null;
  return regime === 'HIGH_VOL_EXPANSION' ? 0.5 : 1;
}

const usableAtr = (ctx: HourContext, hour: number): number | null => {
  const atr = ctx.atr[hour];
  return atr !== undefined && Number.isFinite(atr) && atr > 0 ? atr : null;
};

export function breakoutB1(ctx: HourContext, lookback: number, maxVolPercentile: number): (hour: number) => Signal | null {
  const label = `B1:N=${lookback},P=${maxVolPercentile}`;
  return (hour) => {
    const size = sizeFor(ctx, hour);
    const atr = usableAtr(ctx, hour);
    if (hour < lookback || size === null || atr === null || !(ctx.features[hour]!.volPercentile <= maxVolPercentile)) return null;
    let high = -Infinity;
    let low = Infinity;
    for (let k = hour - lookback; k < hour; k += 1) { high = Math.max(high, ctx.bars[k]!.high); low = Math.min(low, ctx.bars[k]!.low); }
    const close = ctx.bars[hour]!.close;
    const side = close > high ? 1 : close < low ? -1 : 0;
    if (side === 0) return null;
    const mid = (high + low) / 2;
    return {
      side, hour, label, stopDistance: 1.5 * atr, trailDistance: 2 * atr, maxHoldMs: 48 * HOUR_MS, sizeMultiplier: size,
      invalidate: (h) => side * (ctx.bars[h]!.close - mid) < 0,
    };
  };
}

export function meanReversionC1(ctx: HourContext, sigmas: number, lookback: number): (hour: number) => Signal | null {
  const label = `C1:k=${sigmas},L=${lookback}`;
  return (hour) => {
    const atr = usableAtr(ctx, hour);
    const regime = ctx.regimes[hour];
    if (hour < lookback || atr === null || regime === 'STRESS_CRASH' || regime === 'HIGH_VOL_EXPANSION') return null;
    if (!(ctx.features[hour]!.volPercentile < 0.5)) return null;
    const closes = ctx.bars.slice(hour - lookback + 1, hour + 1).map((b) => b.close);
    const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
    const sd = Math.sqrt(closes.reduce((s, v) => s + (v - mean) ** 2, 0) / closes.length);
    const close = closes[closes.length - 1]!;
    const side = close > mean + sigmas * sd ? -1 : close < mean - sigmas * sd ? 1 : 0;
    if (side === 0 || sd === 0) return null;
    return {
      side, hour, label, stopDistance: 1.5 * atr, target: mean, maxHoldMs: 24 * HOUR_MS, sizeMultiplier: 1,
      invalidate: (h) => ctx.features[h]!.volPercentile >= 0.8,
    };
  };
}

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo]! + (sorted[Math.min(lo + 1, sorted.length - 1)]! - sorted[lo]!) * (pos - lo);
}

interface FundingState { time: number; rate: number; high: number; low: number; normal: boolean }

/** Per settlement: the trailing-90d thresholds known before it, and whether it sits inside the trailing p25–p75 band. */
export function fundingStates(points: readonly FundingPoint[], extremeQuantile: number): (FundingState | null)[] {
  return points.map((p) => {
    const history = points.filter((x) => x.time < p.time && x.time >= p.time - FUNDING_LOOKBACK_MS).map((x) => x.rate).sort((a, b) => a - b);
    if (history.length < MIN_FUNDING_HISTORY) return null;
    const normal = p.rate >= quantile(history, 0.25) && p.rate <= quantile(history, 0.75);
    return { time: p.time, rate: p.rate, high: quantile(history, extremeQuantile), low: quantile(history, 1 - extremeQuantile), normal };
  });
}

/** Latest open interest usable at `time` (snapshot stamp + 5m); NaN when none. */
function openInterestAt(metrics: readonly MetricsPoint[], time: number): number {
  let lo = 0;
  let hi = metrics.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (metrics[mid]!.time + METRICS_LAG_MS <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? NaN : metrics[found]!.openInterest;
}

export function fundingFadeE1(
  ctx: HourContext,
  funding: { points: readonly FundingPoint[]; states: readonly (FundingState | null)[] },
  metrics: readonly MetricsPoint[],
  options: { quantile: number; requireOiRise: boolean },
): (hour: number) => Signal | null {
  const label = `E1:Q=${options.quantile * 100},OI=${options.requireOiRise ? 'on' : 'off'}`;
  const byHour = new Map<number, number>();
  funding.states.forEach((s, j) => { if (s) byHour.set(Math.ceil((s.time - ctx.hourStart) / HOUR_MS) - 1, j); });
  const latestSettlement = (closeTime: number): number => {
    let idx = -1;
    for (let j = 0; j < funding.points.length && funding.points[j]!.time <= closeTime; j += 1) idx = j;
    return idx;
  };
  return (hour) => {
    const j = byHour.get(hour);
    const state = j === undefined ? null : funding.states[j];
    const size = sizeFor(ctx, hour);
    const atr = usableAtr(ctx, hour);
    if (!state || size === null || atr === null) return null;
    const side = state.rate >= state.high ? -1 : state.rate <= state.low ? 1 : 0;
    if (side === 0) return null;
    const closeTime = ctx.hourStart + (hour + 1) * HOUR_MS;
    if (options.requireOiRise && !(openInterestAt(metrics, closeTime) > openInterestAt(metrics, closeTime - DAY_MS))) return null;
    return {
      side, hour, label, stopDistance: 2 * atr, maxHoldMs: 48 * HOUR_MS, sizeMultiplier: size,
      invalidate: (h) => {
        const k = latestSettlement(ctx.hourStart + (h + 1) * HOUR_MS);
        return k > j! && (funding.states[k]?.normal ?? false);
      },
    };
  };
}

/** Benchmark: sign of the last 24h at each UTC day close, held 24h with a 1.5 ATR stop. */
export function momentumBenchmark(ctx: HourContext): (hour: number) => Signal | null {
  return (hour) => {
    const atr = usableAtr(ctx, hour);
    const closeTime = ctx.hourStart + (hour + 1) * HOUR_MS;
    if (hour < 24 || atr === null || closeTime % DAY_MS !== 0) return null;
    const side = ctx.bars[hour]!.close >= ctx.bars[hour - 24]!.close ? 1 : -1;
    return { side, hour, label: 'BENCH:momentum24h', stopDistance: 1.5 * atr, maxHoldMs: 24 * HOUR_MS, sizeMultiplier: 1 };
  };
}

const T1_LOOKBACK_DAYS = 180;
const T1_MAX_BLOCK_HOURS = 6;

/** t-statistic of the open→close log return of the same UTC hour as bar `target`, over the trailing 180 days before it. */
function sameHourT(returns: readonly number[], target: number): number {
  if (target - 24 * T1_LOOKBACK_DAYS < 0 || target >= returns.length + 24) return NaN;
  const values: number[] = [];
  for (let k = 1; k <= T1_LOOKBACK_DAYS; k += 1) values.push(returns[target - 24 * k]!);
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(values.length)) : NaN;
}

/** T1 (§8): trade the next UTC hour(s) whose trailing same-hour mean return is significant, as one block. */
export function hourOfDayT1(ctx: HourContext, tau: number): (hour: number) => Signal | null {
  const returns = ctx.bars.map((b) => Math.log(b.close / b.open));
  return (hour) => {
    const size = sizeFor(ctx, hour);
    const atr = usableAtr(ctx, hour);
    const first = sameHourT(returns, hour + 1);
    if (size === null || atr === null || !(Math.abs(first) >= tau)) return null;
    const side = first > 0 ? 1 : -1;
    let block = 1;
    while (block < T1_MAX_BLOCK_HOURS) {
      const next = sameHourT(returns, hour + 1 + block);
      if (!(Math.abs(next) >= tau) || Math.sign(next) !== side) break;
      block += 1;
    }
    return { side, hour, label: `T1:tau=${tau}`, stopDistance: 3 * atr, maxHoldMs: block * HOUR_MS, sizeMultiplier: size };
  };
}

/** T2 (§8): after a settlement in the top (bottom) quartile of trailing funding, expect the dodged side to come back. */
export function settlementReboundT2(
  ctx: HourContext,
  funding: { states: readonly (FundingState | null)[] },
  holdHours: number,
): (hour: number) => Signal | null {
  const byHour = new Map<number, FundingState>();
  for (const s of funding.states) if (s) byHour.set(Math.ceil((s.time - ctx.hourStart) / HOUR_MS) - 1, s);
  return (hour) => {
    const state = byHour.get(hour);
    const size = sizeFor(ctx, hour);
    const atr = usableAtr(ctx, hour);
    if (!state || size === null || atr === null) return null;
    const side = state.rate >= state.high ? 1 : state.rate <= state.low ? -1 : 0;
    if (side === 0) return null;
    return { side, hour, label: `T2:H=${holdHours}`, stopDistance: 3 * atr, maxHoldMs: holdHours * HOUR_MS, sizeMultiplier: size };
  };
}

const isUtcDayClose = (ctx: HourContext, hour: number): boolean => (ctx.hourStart + (hour + 1) * HOUR_MS) % DAY_MS === 0;
const isMondayOpen = (ctx: HourContext, hour: number): boolean =>
  isUtcDayClose(ctx, hour) && new Date(ctx.hourStart + (hour + 1) * HOUR_MS).getUTCDay() === 1;
const dailySigmaPrice = (ctx: HourContext, hour: number): number | null => {
  const sigma = ctx.features[hour]?.dailySigma;
  return sigma !== undefined && Number.isFinite(sigma) && sigma > 0 ? sigma * ctx.bars[hour]!.close : null;
};

/** L1 (§10): every Monday 00:00 UTC, trade the sign of the last L days' return for one week. */
export function weeklyMomentumL1(ctx: HourContext, lookbackDays: number): (hour: number) => Signal | null {
  return (hour) => {
    const size = sizeFor(ctx, hour);
    const sigma = dailySigmaPrice(ctx, hour);
    if (!isMondayOpen(ctx, hour) || hour < 24 * lookbackDays || size === null || sigma === null) return null;
    const side = ctx.bars[hour]!.close >= ctx.bars[hour - 24 * lookbackDays]!.close ? 1 : -1;
    return { side, hour, label: `L1:L=${lookbackDays}`, stopDistance: 2 * sigma * Math.sqrt(7), maxHoldMs: 7 * DAY_MS, sizeMultiplier: size };
  };
}

/** L3 (§10): a UTC day close beyond the prior N days' range, trailed at 3 daily sigma, held up to 14 days. */
export function dailyDonchianL3(ctx: HourContext, days: number): (hour: number) => Signal | null {
  return (hour) => {
    const size = sizeFor(ctx, hour);
    const sigma = dailySigmaPrice(ctx, hour);
    const dayStart = hour - 23; // first hour of the day that just closed
    if (!isUtcDayClose(ctx, hour) || dayStart - 24 * days < 0 || size === null || sigma === null) return null;
    let high = -Infinity;
    let low = Infinity;
    for (let k = dayStart - 24 * days; k < dayStart; k += 1) { high = Math.max(high, ctx.bars[k]!.high); low = Math.min(low, ctx.bars[k]!.low); }
    const close = ctx.bars[hour]!.close;
    const side = close > high ? 1 : close < low ? -1 : 0;
    if (side === 0) return null;
    return { side, hour, label: `L3:N=${days}`, stopDistance: 2 * sigma, trailDistance: 3 * sigma, maxHoldMs: 14 * DAY_MS, sizeMultiplier: size };
  };
}
