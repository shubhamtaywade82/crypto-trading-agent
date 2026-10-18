import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertValidCandles, nextOpenTime, validateCandles } from '../src/data-quality.js';
import type { Candle } from '../src/types.js';

const M15 = 15 * 60_000;
const bars: Candle[] = [0, 1, 2].map((i) => ({
  openTime: i * M15,
  closeTime: (i + 1) * M15 - 1,
  open: 100 + i,
  high: 102 + i,
  low: 99 + i,
  close: 101 + i,
  volume: 1000 + i,
}));

test('accepts valid monotonic contiguous candles', () => {
  const report = assertValidCandles(bars, '15m');
  assert.equal(report.valid, true);
  assert.equal(report.bars, 3);
  assert.equal(report.issueCount, 0);
});

test('rejects a missing candle and does not silently repair the series', () => {
  const report = validateCandles([bars[0], bars[2]], '15m');
  assert.equal(report.valid, false);
  assert.equal(report.gapCount, 1);
  assert.throws(() => assertValidCandles([bars[0], bars[2]], '15m'), /gap or missing candle/);
});

test('rejects a malformed OHLC envelope', () => {
  const invalid = [{ ...bars[0], high: 90 }, ...bars.slice(1)];
  assert.match(validateCandles(invalid, '15m').issues.join(' '), /OHLC envelope/);
});

test('rejects duplicate and out-of-order timestamps', () => {
  const duplicate = [bars[0], { ...bars[1], openTime: bars[0].openTime }, bars[2]];
  assert.ok(validateCandles(duplicate, '15m').issues.some((issue) => issue.includes('duplicates openTime')));

  const outOfOrder = [bars[0], bars[2], bars[1]];
  assert.ok(validateCandles(outOfOrder, '15m').issues.some((issue) => issue.includes('non-monotonic')));
});

test('monthly cadence advances by UTC calendar month, not a fixed 30-day duration', () => {
  const jan = Date.UTC(2025, 0, 1);
  assert.equal(nextOpenTime(jan, '1M'), Date.UTC(2025, 1, 1));
  assert.equal(nextOpenTime(Date.UTC(2025, 1, 1), '1M'), Date.UTC(2025, 2, 1));
});