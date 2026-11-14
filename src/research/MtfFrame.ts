/**
 * Multi-timeframe view of one symbol's 1m series (docs/NEMESIS_G4_STRATEGY_SPECS.md §22). Higher timeframes are
 * aggregated from the 1m bars, aligned to UTC from the series start, and read only through `closedBar`, so a value can
 * never include a bar that has not finished by the minute asked about.
 */
export type TfMinutes = 5 | 15 | 60 | 240 | 1440;
export const TIMEFRAMES: readonly TfMinutes[] = [5, 15, 60, 240, 1440];

export interface Tf {
  size: TfMinutes;
  open: Float64Array; high: Float64Array; low: Float64Array; close: Float64Array; volume: Float64Array;
  atr: Float64Array; ema50: Float64Array; ema200: Float64Array; rsi: Float64Array;
}

export interface Frame {
  start: number;
  minutes: number;
  open: Float64Array; high: Float64Array; low: Float64Array; close: Float64Array; volume: Float64Array; takerBuy: Float64Array;
  tf: Record<TfMinutes, Tf>;
  /** 1m EMA(30) of closes. */
  ema30: Float64Array;
  /** Mean and stdev of the 1m return and of the 1m volume over the prior 240 minutes (the current minute excluded). */
  returnStd240: Float64Array; volumeMean240: Float64Array; volumeStd240: Float64Array;
  volumeMean60: Float64Array;
}

export interface MinuteInputs { start: number; open: Float64Array; high: Float64Array; low: Float64Array; close: Float64Array; volume: Float64Array; takerBuy: Float64Array }

/** Index of the latest `size`-minute bar fully closed once minute `k` has closed (-1 before the first). */
export const closedBar = (size: number, k: number): number => Math.floor((k + 1) / size) - 1;

function aggregate(m: MinuteInputs, size: TfMinutes): Pick<Tf, 'open' | 'high' | 'low' | 'close' | 'volume'> {
  const n = Math.floor(m.open.length / size);
  const out = { open: new Float64Array(n).fill(NaN), high: new Float64Array(n).fill(NaN), low: new Float64Array(n).fill(NaN), close: new Float64Array(n).fill(NaN), volume: new Float64Array(n) };
  for (let j = 0; j < n; j += 1) {
    for (let i = j * size; i < (j + 1) * size; i += 1) {
      if (!Number.isFinite(m.open[i]!)) continue;
      if (Number.isNaN(out.open[j]!)) { out.open[j] = m.open[i]!; out.high[j] = m.high[i]!; out.low[j] = m.low[i]!; }
      out.high[j] = Math.max(out.high[j]!, m.high[i]!); out.low[j] = Math.min(out.low[j]!, m.low[i]!);
      out.close[j] = m.close[i]!; out.volume[j]! += m.volume[i]!;
    }
  }
  return out;
}

function ema(values: Float64Array, period: number): Float64Array {
  const out = new Float64Array(values.length).fill(NaN);
  const alpha = 2 / (period + 1);
  let previous = NaN;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]!;
    if (Number.isFinite(v)) previous = Number.isNaN(previous) ? v : previous + alpha * (v - previous);
    out[i] = previous;
  }
  return out;
}

function wilderAtr(bar: Pick<Tf, 'high' | 'low' | 'close'>, period = 14): Float64Array {
  const out = new Float64Array(bar.close.length).fill(NaN);
  let atr = NaN;
  for (let i = 1; i < bar.close.length; i += 1) {
    if (!Number.isFinite(bar.high[i]!) || !Number.isFinite(bar.close[i - 1]!)) { out[i] = atr; continue; }
    const range = Math.max(bar.high[i]! - bar.low[i]!, Math.abs(bar.high[i]! - bar.close[i - 1]!), Math.abs(bar.low[i]! - bar.close[i - 1]!));
    atr = Number.isNaN(atr) ? range : (atr * (period - 1) + range) / period;
    out[i] = i < period ? NaN : atr; // not usable until a full period has been seen
  }
  return out;
}

function wilderRsi(close: Float64Array, period = 14): Float64Array {
  const out = new Float64Array(close.length).fill(NaN);
  let gain = 0; let loss = 0;
  for (let i = 1; i < close.length; i += 1) {
    const change = close[i]! - close[i - 1]!;
    if (!Number.isFinite(change)) { out[i] = out[i - 1]!; continue; }
    const up = Math.max(change, 0); const down = Math.max(-change, 0);
    if (i <= period) { gain += up / period; loss += down / period; } else { gain = (gain * (period - 1) + up) / period; loss = (loss * (period - 1) + down) / period; }
    out[i] = i < period ? NaN : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Mean and stdev of `values` over the `window` entries before each index (the entry itself excluded). */
export function priorMeanStd(values: Float64Array, window: number): { mean: Float64Array; std: Float64Array } {
  const mean = new Float64Array(values.length).fill(NaN);
  const std = new Float64Array(values.length).fill(NaN);
  let sum = 0; let sumSq = 0; let count = 0;
  const add = (v: number, sign: 1 | -1): void => { if (Number.isFinite(v)) { sum += sign * v; sumSq += sign * v * v; count += sign; } };
  for (let k = 0; k < values.length; k += 1) {
    if (k > window) add(values[k - window - 1]!, -1);
    if (k > 0) add(values[k - 1]!, 1);
    if (count >= window * 0.8) { mean[k] = sum / count; std[k] = Math.sqrt(Math.max(0, sumSq / count - (sum / count) ** 2)); }
  }
  return { mean, std };
}

function buildTf(m: MinuteInputs, size: TfMinutes): Tf {
  const bars = aggregate(m, size);
  return { size, ...bars, atr: wilderAtr(bars), ema50: ema(bars.close, 50), ema200: ema(bars.close, 200), rsi: wilderRsi(bars.close) };
}

export function buildFrame(m: MinuteInputs): Frame {
  const returns = new Float64Array(m.open.length);
  for (let i = 0; i < returns.length; i += 1) returns[i] = m.close[i]! / m.open[i]! - 1;
  const volume240 = priorMeanStd(m.volume, 240);
  return {
    ...m, minutes: m.open.length,
    tf: Object.fromEntries(TIMEFRAMES.map((size) => [size, buildTf(m, size)])) as Record<TfMinutes, Tf>,
    ema30: ema(m.close, 30), returnStd240: priorMeanStd(returns, 240).std, volumeMean240: volume240.mean, volumeStd240: volume240.std,
    volumeMean60: priorMeanStd(m.volume, 60).mean,
  };
}
