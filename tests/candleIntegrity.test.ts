import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignWindow, assertCandleIntegrity, CandleIntegrityError, findCandleViolations, type CandleViolationKind } from '../src/backtesting/candleIntegrity.js';
import type { Candle } from '../src/types.js';

const M15 = 900_000;
const T0 = Date.UTC(2026, 9, 1);
const WINDOW = alignWindow(T0, T0 + 10 * M15, M15); // 10 complete bars: T0 .. T0 + 9 * M15

const bar = (openTime: number, price = 100): Candle => ({ openTime, open: price - 1, high: price + 1, low: price - 2, close: price, volume: 10 });
const series = (count: number, start = T0): Candle[] => Array.from({ length: count }, (_, i) => bar(start + i * M15));
const kinds = (candles: Candle[]): CandleViolationKind[] => findCandleViolations(candles, WINDOW).map((v) => v.kind);
const indicesOf = (candles: Candle[], kind: CandleViolationKind): Array<number | null> =>
  findCandleViolations(candles, WINDOW).filter((v) => v.kind === kind).map((v) => v.index);

test('alignWindow shrinks the window onto complete bars and rejects one with no complete bar', () => {
  assert.deepEqual(alignWindow(T0 + 7 * 60_000, T0 + 10 * M15 + 3 * 60_000, M15), { intervalMs: M15, fromMs: T0 + M15, toMs: T0 + 10 * M15 });
  assert.throws(() => alignWindow(T0 + 1, T0 + M15 - 1, M15), /holds no complete 900000ms bar/);
  assert.throws(() => alignWindow(T0, T0 + M15, 0), /positive integer/);
  assert.throws(() => alignWindow(Number.NaN, T0, M15), /finite/);
});

test('a clean, contiguous, in-window series has no violations', () => {
  assert.deepEqual(findCandleViolations(series(10), WINDOW), []);
  assertCandleIntegrity(series(10), WINDOW, 'SOLUSDT 15m');
});

test('flags impossible OHLC bars', () => {
  const candles = series(10);
  candles[1] = { openTime: T0 + M15, open: 100, high: 99, low: 101, close: 100, volume: 1 }; // high below low
  candles[4] = { openTime: T0 + 4 * M15, open: 100, high: 101, low: 99, close: 102, volume: 1 }; // close above high
  candles[7] = { openTime: T0 + 7 * M15, open: 98, high: 101, low: 99, close: 100, volume: 1 }; // open below low
  assert.deepEqual(indicesOf(candles, 'ohlc'), [1, 4, 7]);
});

test('flags non-finite or non-positive prices and invalid volume', () => {
  const candles = series(10);
  candles[0] = { ...candles[0]!, close: Number.NaN };
  candles[2] = { ...candles[2]!, open: 0 };
  candles[5] = { ...candles[5]!, volume: -1 };
  candles[8] = { ...candles[8]!, volume: Number.POSITIVE_INFINITY };
  assert.deepEqual(indicesOf(candles, 'invalid_value'), [0, 2, 5, 8]);
  assert.deepEqual(indicesOf(candles, 'ohlc'), []); // invalid values are reported once, not also as OHLC breaks
});

test('flags open times that are off the bar grid', () => {
  const candles = series(10);
  candles[3] = bar(T0 + 3 * M15 + 1);
  assert.deepEqual(indicesOf(candles, 'misaligned'), [3]);
});

test('flags bars outside the window, including the forming bar at the end', () => {
  const before = [bar(T0 - M15), ...series(10)];
  assert.deepEqual(indicesOf(before, 'out_of_window'), [0]);
  assert.ok(kinds(before).includes('count'));

  const forming = [...series(10), bar(T0 + 10 * M15)];
  assert.deepEqual(indicesOf(forming, 'out_of_window'), [10]);
  assert.ok(kinds(forming).includes('count'));
});

test('flags duplicate and out-of-order bars', () => {
  const duplicated = series(10);
  duplicated[5] = { ...duplicated[4]! };
  assert.deepEqual(indicesOf(duplicated, 'duplicate'), [5]);

  const unsorted = series(10);
  [unsorted[2], unsorted[3]] = [unsorted[3]!, unsorted[2]!];
  assert.deepEqual(indicesOf(unsorted, 'out_of_order'), [3]);
});

test('reports a mid-series gap with its missing-bar count and fails the count check', () => {
  const candles = series(10).filter((_, i) => i < 3 || i > 5); // drops bars 3, 4, 5
  const gaps = findCandleViolations(candles, WINDOW).filter((v) => v.kind === 'gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.index, 3);
  assert.match(gaps[0]!.detail, /3 missing bar\(s\)/);
  assert.ok(kinds(candles).includes('count'));
});

test('reports missing leading and trailing bars', () => {
  const late = series(8, T0 + 2 * M15); // starts two bars into the window
  const early = series(8); // stops two bars short of the window end
  assert.match(findCandleViolations(late, WINDOW).find((v) => v.kind === 'gap')!.detail, /2 missing leading bar\(s\)/);
  assert.match(findCandleViolations(early, WINDOW).find((v) => v.kind === 'gap')!.detail, /2 missing trailing bar\(s\)/);
});

test('an empty series fails the count check and nothing else', () => {
  assert.deepEqual(kinds([]), ['count']);
});

test('assertCandleIntegrity throws a typed error with the violations, label and hint', () => {
  const candles = series(10);
  candles[2] = { ...candles[2]!, high: 1 };
  assert.throws(() => assertCandleIntegrity(candles, WINDOW, 'SOLUSDT 1h', 'lag hint'), (err: unknown) => {
    assert.ok(err instanceof CandleIntegrityError);
    assert.equal(err.violations.length, 1);
    assert.equal(err.violations[0]!.kind, 'ohlc');
    assert.match(err.message, /SOLUSDT 1h: 1 candle integrity violation\(s\)/);
    assert.match(err.message, /hint: lag hint/);
    return true;
  });
});
