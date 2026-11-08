import { TIMEFRAME_MS, type FlowBar } from './types.js';

export interface BarFeatures {
  /** High minus low. Zero-range bars carry no wick information. */
  range: number;
  /** (min(O,C) − L) / R. Null when R is zero. */
  lowerWickRatio: number | null;
  /** (H − max(O,C)) / R. Null when R is zero. */
  upperWickRatio: number | null;
  /** (C − L) / R in [0,1]. Null when R is zero. */
  closeLocation: number | null;
  /** Aggressor buy base volume (takerBuyBaseVolume). */
  buyVolume: number;
  /** Aggressor sell base volume (baseVolume − takerBuyBaseVolume). */
  sellVolume: number;
  /** buyVolume − sellVolume. */
  volumeDelta: number;
  /** volumeDelta / (buyVolume + sellVolume) in [−1,1]; 0 when the bar traded nothing. */
  deltaRatio: number;
  /**
   * quoteVolume / median(quoteVolume of the previous `volumeWindow` complete bars). Null without `minVolumeHistory`
   * prior bars or when the median is zero. The current bar is never part of its own baseline.
   */
  relativeVolume: number | null;
  /** Wilder ATR(`atrPeriod`) including this bar. Null until seeded, and restarted after any gap. */
  atr: number | null;
}

export interface FeatureOptions {
  atrPeriod: number;
  volumeWindow: number;
  minVolumeHistory: number;
}

/**
 * Computes per-bar features causally: the value at index i depends only on bars 0..i. Incomplete bars return null and
 * reset ATR, so no feature bridges a missing interval.
 */
export function computeFeatures(bars: readonly FlowBar[], opts: FeatureOptions): (BarFeatures | null)[] {
  const out: (BarFeatures | null)[] = new Array<BarFeatures | null>(bars.length).fill(null);
  const quoteHistory: number[] = [];
  let atr: number | null = null;
  let seed: number[] = [];
  let prevClose: number | null = null;
  let prev: FlowBar | null = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;
    if (!bar.complete) {
      atr = null;
      seed = [];
      prevClose = null;
      prev = null;
      continue;
    }

    const tfMs = TIMEFRAME_MS[bar.timeframe];
    const linked = prev !== null && prevClose !== null && prev.openTime + tfMs === bar.openTime;
    if (!linked) {
      atr = null;
      seed = [];
    }
    const tr = linked && prevClose !== null
      ? Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))
      : bar.high - bar.low;

    if (atr === null) {
      seed.push(tr);
      if (seed.length >= opts.atrPeriod) atr = seed.reduce((a, b) => a + b, 0) / seed.length;
    } else {
      atr = (atr * (opts.atrPeriod - 1) + tr) / opts.atrPeriod;
    }

    const baseline = quoteHistory.slice(-opts.volumeWindow);
    const median = baseline.length >= opts.minVolumeHistory ? medianOf(baseline) : null;
    const relativeVolume = median !== null && median > 0 ? bar.quoteVolume / median : null;

    const range = bar.high - bar.low;
    const body = { lo: Math.min(bar.open, bar.close), hi: Math.max(bar.open, bar.close) };
    const buyVolume = bar.takerBuyBaseVolume;
    const sellVolume = bar.baseVolume - bar.takerBuyBaseVolume;
    const volumeDelta = buyVolume - sellVolume;
    const traded = buyVolume + sellVolume;

    out[i] = {
      range,
      lowerWickRatio: range > 0 ? (body.lo - bar.low) / range : null,
      upperWickRatio: range > 0 ? (bar.high - body.hi) / range : null,
      closeLocation: range > 0 ? (bar.close - bar.low) / range : null,
      buyVolume,
      sellVolume,
      volumeDelta,
      deltaRatio: traded > 0 ? volumeDelta / traded : 0,
      relativeVolume,
      atr,
    };

    quoteHistory.push(bar.quoteVolume);
    prev = bar;
    prevClose = bar.close;
  }

  return out;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((lo ?? 0) + (hi ?? 0)) / 2;
}
