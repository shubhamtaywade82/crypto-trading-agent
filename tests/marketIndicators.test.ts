import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import { adx, atrPercentile, emaSlopePct, lastVwap, vwap, wilderAtr } from '../src/binance/indicators.js';

function candle(index: number, open: number, high: number, low: number, close: number, volume = 1): Candle {
  return { openTime: index * 60_000, open, high, low, close, volume };
}

test('Wilder ATR uses an SMA seed and recursive smoothing', () => {
  const candles = Array.from({ length: 14 }, (_, i) => candle(i, 10, 11, 9, 10));
  candles.push(candle(14, 10, 13, 9, 10));
  const series = wilderAtr(candles, 14);
  assert.ok(Number.isNaN(series[12]));
  assert.equal(series[13], 2);
  assert.ok(Math.abs(series[14] - (30 / 14)) < 1e-12);
});

test('ADX reaches a stable high value for a persistent directional move', () => {
  const candles = Array.from({ length: 40 }, (_, i) => candle(i, 100 + i, 101 + i, 99 + i, 100 + i));
  const series = adx(candles, 14);
  const value = series.at(-1)!;
  assert.ok(Number.isFinite(value));
  assert.ok(value > 90);
});

test('VWAP uses typical price weighted by volume', () => {
  const candles = [
    candle(0, 9, 11, 9, 10, 1),
    candle(1, 11, 13, 11, 12, 3),
  ];
  const series = vwap(candles, 2);
  const expected = (((11 + 9 + 10) / 3) * 1 + ((13 + 11 + 12) / 3) * 3) / 4;
  assert.ok(Math.abs(series.at(-1)! - expected) < 1e-12);
});

test('EMA slope reports positive movement', () => {
  const values = Array.from({ length: 40 }, (_, i) => 100 + i);
  const slope = emaSlopePct(values, 20, 5);
  assert.ok(slope !== null && slope > 0);
});

test('percentile rank is bounded and monotonic', () => {
  const low = atrPercentile([1, 2, 3, 4, 5], 1);
  const high = atrPercentile([1, 2, 3, 4, 5], 5);
  assert.ok(low >= 0 && low <= 100);
  assert.ok(high >= 0 && high <= 100);
  assert.ok(high > low);
});

test('lastVwap matches the last value of the full vwap series exactly', () => {
  const candles = Array.from({ length: 300 }, (_, i) => {
    const close = 100 + Math.sin(i / 7) * 3 + i * 0.01;
    return candle(i, close - 0.2, close + 0.5, close - 0.6, close, 1 + (i % 13));
  });
  for (const length of [1, 2, 50, 96, 300]) {
    const slice = candles.slice(0, length);
    const period = Math.min(96, Math.max(2, length));
    const full = vwap(slice, period).at(-1);
    assert.equal(lastVwap(slice, period), full !== undefined && Number.isFinite(full) ? full : null);
  }
});
