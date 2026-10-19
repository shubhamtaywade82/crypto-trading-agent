import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atrWilder, trueRanges } from '../src/atr.js';
import type { Candle } from '../src/types.js';

function bar(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime, closeTime: openTime + 59_999, open, high, low, close, volume: 1000 };
}

const bars: Candle[] = [
  bar(0, 9, 10, 8, 9),    // TR = 2
  bar(60_000, 9, 11, 9, 10),   // TR = max(2, 2, 0) = 2
  bar(120_000, 10, 12, 10, 11), // TR = max(2, 2, 0) = 2
  bar(180_000, 11, 12, 9, 10), // TR = max(3, 1, 2) = 3
];

test('true ranges use high-low for the first bar and previous close afterwards', () => {
  assert.deepEqual(trueRanges(bars), [2, 2, 2, 3]);
});

test('ATR is seeded with the SMA of the first N true ranges and null before that', () => {
  const atr = atrWilder(bars, 3);
  assert.deepEqual(atr.slice(0, 2), [null, null]);
  assert.equal(atr[2], (2 + 2 + 2) / 3);
  // Wilder recursion: (prev * (length - 1) + tr) / length
  assert.ok(Math.abs((atr[3] ?? 0) - (2 * 2 + 3) / 3) < 1e-12);
});

test('ATR warm-up never emits partial values and rejects invalid lengths', () => {
  assert.ok(atrWilder(bars.slice(0, 2), 3).every((value) => value === null));
  assert.throws(() => atrWilder(bars, 0), /positive integer/);
  assert.throws(() => atrWilder(bars, 2.5), /positive integer/);
});
