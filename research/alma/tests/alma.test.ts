import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alma, sourceSeries } from '../src/alma.js';
import type { Candle } from '../src/types.js';

test('ALMA emits null during warm-up and a full-window value at length - 1', () => {
  const result = alma([1, 2, 3, 4, 5], { length: 3, offset: 0.85, sigma: 6 });
  assert.deepEqual(result.slice(0, 2), [null, null]);
  assert.equal(typeof result[2], 'number');
  assert.equal(result.length, 5);
});

test('ALMA preserves constant series for every valid offset', () => {
  for (const offset of [0, 0.5, 0.85, 1]) {
    const result = alma(Array(30).fill(42), { length: 9, offset, sigma: 6 });
    assert.ok(result.slice(8).every((value) => Math.abs((value ?? 0) - 42) < 1e-10));
  }
});

test('ALMA rejects invalid parameters and non-finite values', () => {
  assert.throws(() => alma([1, 2], { length: 0, offset: 0.85, sigma: 6 }), /length/);
  assert.throws(() => alma([1, 2], { length: 2, offset: 1.1, sigma: 6 }), /offset/);
  assert.throws(() => alma([1, 2], { length: 2, offset: 0.85, sigma: 0 }), /sigma/);
  assert.throws(() => alma([1, Number.NaN], { length: 2, offset: 0.85, sigma: 6 }), /non-finite/);
});

test('offset changes the weighting location and changes response to a step', () => {
  const values = [10, 10, 10, 10, 20];
  const slow = alma(values, { length: 5, offset: 0.5, sigma: 6 }).at(-1);
  const fast = alma(values, { length: 5, offset: 0.99, sigma: 6 }).at(-1);
  assert.ok(typeof slow === 'number' && typeof fast === 'number');
  assert.ok(fast > slow);
});

test('sourceSeries returns deterministic OHLC-derived sources', () => {
  const candle: Candle = { openTime: 0, closeTime: 899999, open: 10, high: 16, low: 8, close: 14, volume: 100 };
  assert.equal(sourceSeries([candle], 'close')[0], 14);
  assert.equal(sourceSeries([candle], 'hl2')[0], 12);
  assert.equal(sourceSeries([candle], 'hlc3')[0], (16 + 8 + 14) / 3);
  assert.equal(sourceSeries([candle], 'ohlc4')[0], 12);
});