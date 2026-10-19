import type { Candle } from './types.js';

/**
 * True range per bar. Bar 0 has no previous close, so it uses high - low.
 * Inputs must already be validated (finite, envelope-consistent) by data-quality.
 */
export function trueRanges(candles: readonly Candle[]): number[] {
  const out: number[] = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    if (i === 0) {
      out[i] = bar.high - bar.low;
      continue;
    }
    const previousClose = candles[i - 1].close;
    out[i] = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  }
  return out;
}

/**
 * Wilder-smoothed ATR.
 * Seeded with the SMA of the first `length` true ranges, so the first defined
 * value sits at index length - 1 and every earlier index is null (warm-up),
 * mirroring the ALMA warm-up convention.
 */
export function atrWilder(candles: readonly Candle[], length: number): Array<number | null> {
  if (!Number.isInteger(length) || length < 1) {
    throw new Error('ATR length must be a positive integer');
  }
  const ranges = trueRanges(candles);
  const out: Array<number | null> = Array(candles.length).fill(null);
  if (candles.length < length) return out;

  let sum = 0;
  for (let i = 0; i < length; i++) sum += ranges[i];
  let previous = sum / length;
  out[length - 1] = previous;

  for (let i = length; i < candles.length; i++) {
    previous = (previous * (length - 1) + ranges[i]) / length;
    out[i] = previous;
  }
  return out;
}
