import type { AlmaParams, AlmaSource, Candle } from './types.js';

/**
 * Arnaud Legoux Moving Average with oldest-to-newest inputs.
 * Returns null during warm-up; no partial-window values are emitted.
 *
 * weight(i) = exp(-((i - offset * (length - 1))^2) / (2 * (length / sigma)^2))
 */
export function alma(values: readonly number[], params: AlmaParams): Array<number | null> {
  const { length, offset, sigma } = params;

  if (!Number.isInteger(length) || length < 1) {
    throw new Error('ALMA length must be a positive integer');
  }
  if (!Number.isFinite(offset) || offset < 0 || offset > 1) {
    throw new Error('ALMA offset must be finite and in [0, 1]');
  }
  if (!Number.isFinite(sigma) || sigma <= 0) {
    throw new Error('ALMA sigma must be finite and > 0');
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error('ALMA input contains a non-finite value at index ' + i);
    }
  }

  const m = offset * (length - 1);
  const s = length / sigma;
  const weights = Array.from({ length }, (_, i) =>
    Math.exp(-((i - m) ** 2) / (2 * s ** 2)),
  );
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const normalized = weights.map((weight) => weight / weightSum);
  const out: Array<number | null> = Array(values.length).fill(null);

  for (let i = length - 1; i < values.length; i++) {
    let value = 0;
    const first = i - length + 1;
    for (let j = 0; j < length; j++) value += values[first + j] * normalized[j];
    out[i] = value;
  }
  return out;
}

export function sourceSeries(candles: readonly Candle[], source: AlmaSource): number[] {
  return candles.map((candle) => {
    switch (source) {
      case 'open': return candle.open;
      case 'high': return candle.high;
      case 'low': return candle.low;
      case 'close': return candle.close;
      case 'hl2': return (candle.high + candle.low) / 2;
      case 'hlc3': return (candle.high + candle.low + candle.close) / 3;
      case 'ohlc4': return (candle.open + candle.high + candle.low + candle.close) / 4;
    }
  });
}