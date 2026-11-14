import type { Regime } from './RegimeClassifier.js';
import { closedBar, type Frame, type Tf } from './MtfFrame.js';
import { HOUR_MS, MINUTE_MS, type Signal } from './SignalBacktest.js';

/**
 * Intraday families F1–F9, rules exactly as pre-registered in docs/NEMESIS_G4_STRATEGY_SPECS.md §22. Each factory
 * returns `signalAt(k)`: it is called once per closed 1m bar k and reads only data closed by then; the trade enters at
 * the next 1m open.
 */
/** `hourIndex` maps a closed 1h bar's open time to its index in the symbol's hourly arrays (months with missing minutes shift plain offsets). */
export interface Env { f: Frame; regimes: readonly Regime[]; hourIndex: ReadonlyMap<number, number> }
export type SignalAt = (k: number) => Signal | null;

const DAY_MIN = 1440;
type Shape = Pick<Signal, 'stopDistance' | 'maxHoldMs'> & Partial<Pick<Signal, 'stopPrice' | 'target' | 'trailDistance'>>;

/** Signal for a trade entering at the open of minute k + 1, or null when §1 blocks it (STRESS) or inputs are missing. */
function build(env: Env, k: number, side: 1 | -1, label: string, shape: Shape): Signal | null {
  const entryTime = env.f.start + (k + 1) * MINUTE_MS;
  const hour = env.hourIndex.get(Math.floor(entryTime / HOUR_MS) * HOUR_MS - HOUR_MS);
  if (hour === undefined) return null;
  const regime = env.regimes[hour];
  if (regime === 'STRESS_CRASH' || !(shape.stopDistance > 0) || !Number.isFinite(shape.stopDistance)) return null;
  return { side, hour, label, entryTime, sizeMultiplier: regime === 'HIGH_VOL_EXPANSION' ? 0.5 : 1, ...shape };
}

const finite = (...xs: number[]): boolean => xs.every((x) => Number.isFinite(x));
const atrAt = (tf: Tf, bar: number): number => tf.atr[bar] ?? NaN;
const minutesToMs = (minutes: number): number => minutes * MINUTE_MS;

/** +1 / -1 when the 4h EMA50 is above / below EMA200, else 0. */
function trend4h(f: Frame, k: number): number {
  const c = closedBar(240, k);
  const gap = f.tf[240].ema50[c]! - f.tf[240].ema200[c]!;
  return finite(gap) && c >= 200 ? Math.sign(gap) : 0;
}

export function pullbackF1(env: Env, rsiLevel: number): SignalAt {
  const { f } = env; const label = `F1:P=${rsiLevel}`;
  return (k) => {
    const side = trend4h(f, k);
    const c1 = closedBar(60, k);
    if (side === 0 || k < 2 || Math.sign(f.tf[60].close[c1]! - f.tf[60].ema50[c1]!) !== side) return null;
    const crossed = side === 1 ? f.close[k]! > f.ema30[k]! && f.close[k - 1]! <= f.ema30[k - 1]! : f.close[k]! < f.ema30[k]! && f.close[k - 1]! >= f.ema30[k - 1]!;
    if (!crossed) return null;
    const c15 = closedBar(15, k);
    let pulledBack = false;
    for (let j = c15 - 7; j <= c15 && !pulledBack; j += 1) pulledBack = side === 1 ? f.tf[15].rsi[j]! <= rsiLevel : f.tf[15].rsi[j]! >= 100 - rsiLevel;
    const atr = atrAt(f.tf[15], c15);
    return pulledBack && finite(atr) ? build(env, k, side as 1 | -1, label, { stopDistance: 1.5 * atr, trailDistance: 3 * atr, maxHoldMs: minutesToMs(72 * 60) }) : null;
  };
}

/** Most recent 1h close beyond the prior `lookback` 1h channel within the last 12 closed hours. */
function recentBreakout(f: Frame, hour: number, lookback: number): { bar: number; side: 1 | -1; level: number } | null {
  const t = f.tf[60];
  for (let h = hour; h > hour - 12 && h > lookback; h -= 1) {
    let high = -Infinity; let low = Infinity;
    for (let j = h - lookback; j < h; j += 1) { high = Math.max(high, t.high[j]!); low = Math.min(low, t.low[j]!); }
    if (t.close[h]! > high) return { bar: h, side: 1, level: high };
    if (t.close[h]! < low) return { bar: h, side: -1, level: low };
  }
  return null;
}

export function retestF2(env: Env, lookback: number): SignalAt {
  const { f } = env; const label = `F2:N=${lookback}`; const used = new Set<number>();
  return (k) => {
    const hour = closedBar(60, k);
    const brk = hour > lookback ? recentBreakout(f, hour, lookback) : null;
    if (!brk || used.has(brk.bar)) return null;
    const c4 = closedBar(240, brk.bar * 60 + 59);
    if (Math.sign(f.tf[240].ema50[c4]! - f.tf[240].ema50[c4 - 6]!) !== brk.side) return null;
    for (let h = brk.bar + 1; h <= hour; h += 1) if (brk.side * (f.tf[60].close[h]! - brk.level) < 0) return null;
    const atr = atrAt(f.tf[60], hour);
    const touched = brk.side === 1 ? f.low[k]! <= brk.level + 0.1 * atr : f.high[k]! >= brk.level - 0.1 * atr;
    if (!finite(atr) || !touched || brk.side * (f.close[k]! - brk.level) <= 0) return null;
    used.add(brk.bar);
    return build(env, k, brk.side, label, { stopDistance: Math.abs(f.close[k]! - brk.level) + 1.2 * atr, stopPrice: brk.level - brk.side * 1.2 * atr, trailDistance: 2.5 * atr, maxHoldMs: minutesToMs(72 * 60) });
  };
}

/** Rolling max of 5m highs and min of 5m lows over `width` bars ending at each bar. */
function rollingExtremes(t: Tf, width: number): { high: Float64Array; low: Float64Array } {
  const n = t.high.length;
  const high = new Float64Array(n).fill(NaN); const low = new Float64Array(n).fill(NaN);
  for (let j = width - 1; j < n; j += 1) {
    let hi = -Infinity; let lo = Infinity;
    for (let i = j - width + 1; i <= j; i += 1) { hi = Math.max(hi, t.high[i]!); lo = Math.min(lo, t.low[i]!); }
    high[j] = hi; low[j] = lo;
  }
  return { high, low };
}

export function sweepF3(env: Env, width: number): SignalAt {
  const { f } = env; const label = `F3:W=${width}`; const range = rollingExtremes(f.tf[5], width);
  return (k) => {
    const c5 = closedBar(5, k);
    const hi = range.high[c5]!; const lo = range.low[c5]!;
    const atr = atrAt(f.tf[15], closedBar(15, k));
    if (!finite(hi, lo, atr) || !(f.volume[k]! >= 2 * f.volumeMean60[k]!)) return null;
    const side: 0 | 1 | -1 = f.high[k]! > hi && f.close[k]! < hi ? -1 : f.low[k]! < lo && f.close[k]! > lo ? 1 : 0;
    if (side === 0) return null;
    const stopPrice = side === 1 ? f.low[k]! - 0.2 * atr : f.high[k]! + 0.2 * atr;
    const target = (hi + lo) / 2;
    const risk = Math.abs(f.close[k]! - stopPrice);
    if (side * (target - f.close[k]!) < 1.5 * risk) return null;
    return build(env, k, side, label, { stopDistance: risk, stopPrice, target, maxHoldMs: minutesToMs(12 * 60) });
  };
}

export function ignitionF4(env: Env, zMin: number): SignalAt {
  const { f } = env; const label = `F4:Z=${zMin}`;
  return (k) => {
    const std = f.returnStd240[k]!; const ret = f.close[k]! / f.open[k]! - 1;
    const volumeZ = (f.volume[k]! - f.volumeMean240[k]!) / f.volumeStd240[k]!;
    if (!finite(std, volumeZ) || !(std > 0) || Math.abs(ret / std) < zMin || volumeZ < 3 || !(f.volume[k]! > 0)) return null;
    const share = f.takerBuy[k]! / f.volume[k]!;
    const side = ret > 0 && share >= 0.65 ? 1 : ret < 0 && share <= 0.35 ? -1 : 0;
    const atr = atrAt(f.tf[15], closedBar(15, k));
    if (side === 0 || !finite(atr)) return null;
    return build(env, k, side, label, { stopDistance: atr, target: f.close[k]! + side * 2 * atr, maxHoldMs: minutesToMs(120) });
  };
}

const SESSION_START_MIN: Record<string, number> = { '00:00': 0, '08:00': 480, '13:30': 810 };

export function openingRangeF5(env: Env, session: '00:00' | '08:00' | '13:30'): SignalAt {
  const { f } = env; const label = `F5:${session}`; const start = SESSION_START_MIN[session]!;
  const traded = new Set<number>();
  return (k) => {
    const offset = (((k - start) % DAY_MIN) + DAY_MIN) % DAY_MIN;
    if (offset < 30 || offset >= 360) return null;
    const s0 = k - offset;
    if (traded.has(s0) || s0 < 0) return null;
    let hi = -Infinity; let lo = Infinity;
    for (let i = s0; i < s0 + 30; i += 1) { hi = Math.max(hi, f.high[i]!); lo = Math.min(lo, f.low[i]!); }
    const side = f.close[k]! > hi ? 1 : f.close[k]! < lo ? -1 : 0;
    const atr = atrAt(f.tf[15], closedBar(15, k));
    if (side === 0 || !finite(hi, lo, atr)) return null;
    const risk = Math.min(3 * atr, Math.max(0.8 * atr, Math.abs(f.close[k]! - (side === 1 ? lo : hi))));
    traded.add(s0);
    return build(env, k, side, label, { stopDistance: risk, target: f.close[k]! + side * 2 * risk, maxHoldMs: minutesToMs(s0 + 360 - (k + 1)) });
  };
}

export function btcLeadF6(env: Env, btcClose: Float64Array, threshold: number): SignalAt {
  const { f } = env; const label = `F6:T=${threshold}`;
  return (k) => {
    if (k < 5) return null;
    const lead = btcClose[k]! / btcClose[k - 5]! - 1;
    const own = f.close[k]! / f.close[k - 5]! - 1;
    const side = lead >= threshold && own <= 0.3 * lead ? 1 : lead <= -threshold && own >= 0.3 * lead ? -1 : 0;
    const atr = atrAt(f.tf[15], closedBar(15, k));
    if (side === 0 || !finite(lead, own, atr)) return null;
    return build(env, k, side, label, { stopDistance: 0.5 * atr, target: f.close[k]! + side * atr, maxHoldMs: minutesToMs(60) });
  };
}

/** SMA and stdev of the last `period` closes at each 1h bar, plus the Bollinger width (4 sigma / mean). */
function hourlyBands(t: Tf, period: number): { mean: Float64Array; std: Float64Array } {
  const n = t.close.length;
  const mean = new Float64Array(n).fill(NaN); const std = new Float64Array(n).fill(NaN);
  for (let j = period - 1; j < n; j += 1) {
    let sum = 0; let sumSq = 0;
    for (let i = j - period + 1; i <= j; i += 1) { sum += t.close[i]!; sumSq += t.close[i]! ** 2; }
    mean[j] = sum / period; std[j] = Math.sqrt(Math.max(0, sumSq / period - mean[j]! ** 2));
  }
  return { mean, std };
}

export function bandReversionF7(env: Env, sigmas: number): SignalAt {
  const { f } = env; const label = `F7:S=${sigmas}`; const bands = hourlyBands(f.tf[60], 48);
  return (k) => {
    const c1 = closedBar(60, k); const c4 = closedBar(240, k);
    const gap = Math.abs(f.tf[240].ema50[c4]! - f.tf[240].ema200[c4]!) / f.tf[240].close[c4]!;
    const mid = bands.mean[c1]!; const width = sigmas * bands.std[c1]!; const atr = atrAt(f.tf[60], c1);
    if (!finite(mid, width, atr, gap) || gap >= 0.02 || c4 < 200) return null;
    const side = f.high[k]! > mid + width && f.close[k]! < mid + width ? -1 : f.low[k]! < mid - width && f.close[k]! > mid - width ? 1 : 0;
    if (side === 0) return null;
    const stopPrice = side === 1 ? f.low[k]! - atr : f.high[k]! + atr;
    const risk = Math.abs(f.close[k]! - stopPrice);
    if (side * (mid - f.close[k]!) < 1.2 * risk) return null;
    return build(env, k, side, label, { stopDistance: risk, stopPrice, target: mid, maxHoldMs: minutesToMs(24 * 60) });
  };
}

/** Fraction of the previous 720 Bollinger(24, 2) widths that are narrower than the current one, per 1h bar. */
function widthPercentile(t: Tf, bands: { mean: Float64Array; std: Float64Array }): Float64Array {
  const n = t.close.length; const width = new Float64Array(n).fill(NaN); const out = new Float64Array(n).fill(NaN);
  for (let j = 0; j < n; j += 1) width[j] = (4 * bands.std[j]!) / bands.mean[j]!;
  for (let j = 720; j < n; j += 1) {
    let narrower = 0;
    for (let i = j - 720; i < j; i += 1) if (width[i]! < width[j]!) narrower += 1;
    out[j] = narrower / 720;
  }
  return out;
}

export function squeezeF8(env: Env, percentile: number): SignalAt {
  const { f } = env; const label = `F8:P=${percentile}`;
  const bands = hourlyBands(f.tf[60], 24); const rank = widthPercentile(f.tf[60], bands);
  return (k) => {
    if ((k + 1) % 15 !== 0) return null;
    const c1 = closedBar(60, k); const c15 = closedBar(15, k);
    const atr = atrAt(f.tf[60], c1);
    if (!finite(rank[c1]!, atr) || rank[c1]! > percentile / 100) return null;
    const upper = bands.mean[c1]! + 2 * bands.std[c1]!; const lower = bands.mean[c1]! - 2 * bands.std[c1]!;
    const side = f.tf[15].close[c15]! > upper ? 1 : f.tf[15].close[c15]! < lower ? -1 : 0;
    return side === 0 ? null : build(env, k, side, label, { stopDistance: 1.5 * atr, trailDistance: 3 * atr, maxHoldMs: minutesToMs(72 * 60) });
  };
}

export function dailyBreakF9(env: Env, days: number): SignalAt {
  const { f } = env; const label = `F9:N=${days}`; const fired = new Set<string>();
  return (k) => {
    const day = closedBar(DAY_MIN, k);
    const side = trend4h(f, k);
    if (day < days || side === 0) return null;
    let high = -Infinity; let low = Infinity;
    for (let d = day - days + 1; d <= day; d += 1) { high = Math.max(high, f.tf[1440].high[d]!); low = Math.min(low, f.tf[1440].low[d]!); }
    const broke = side === 1 ? f.close[k]! > high : f.close[k]! < low;
    const key = `${day}|${side}`;
    const atr = atrAt(f.tf[240], closedBar(240, k));
    if (!broke || fired.has(key) || !finite(high, low, atr)) return null;
    fired.add(key);
    return build(env, k, side as 1 | -1, label, { stopDistance: 1.5 * atr, trailDistance: 3 * atr, maxHoldMs: minutesToMs(7 * DAY_MIN) });
  };
}
