import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectCrossovers,
  detectPullbackAfterCross,
  forwardOutcome,
  slopeAt,
  summarizeEvents,
  type CrossEvent,
} from '../src/events.js';
import type { Candle } from '../src/types.js';

function bar(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime, closeTime: openTime + 59_999, open, high, low, close, volume: 1000 };
}

function crossAt(index: number, direction: 1 | -1): CrossEvent {
  return { index, openTime: index, direction };
}

const N = null;

test('slopeAt measures series[index] - series[index - lookback] and handles warm-up', () => {
  const series = [N, 1, 1, 3, 6];
  assert.equal(slopeAt(series, 2), 0);
  assert.equal(slopeAt(series, 3), 2);
  assert.equal(slopeAt(series, 4, 2), 5);
  assert.equal(slopeAt(series, 1, 2), null);
  assert.equal(slopeAt(series, 1), null);
  assert.equal(slopeAt(series, 0), null);
  assert.throws(() => slopeAt(series, 2, 0), /positive integer/);
});

test('detectCrossovers finds bullish and bearish crosses with strict consecutive bars', () => {
  const fast = [N, N, 1, 3, 5, 4, 1.5];
  const slow = [N, N, 2, 2, 2, 2, 2];
  const events = detectCrossovers(fast, slow);
  assert.deepEqual(events, [
    { index: 3, openTime: 3, direction: 1 },
    { index: 6, openTime: 6, direction: -1 },
  ]);
});

test('a null bar between defined bars prevents a cross (no adjacent-defined transition)', () => {
  const fast = [1, N, 3];
  const slow = [2, N, 2];
  assert.deepEqual(detectCrossovers(fast, slow), []);
});

test('cross_with_slope requires the slow line slope to agree with the cross direction', () => {
  // Bullish cross at index 2, but the slow line is falling.
  const fast = [4.0, 4.0, 5.0, 5.0];
  const slow = [5.0, 4.5, 4.0, 3.0];
  const raw = detectCrossovers(fast, slow);
  assert.equal(raw.length, 1);
  const filtered = detectCrossovers(fast, slow, undefined, { requireSlowSlopeAgreement: true });
  assert.deepEqual(filtered, []);
});

test('cross_with_slope keeps the cross when the slow line slopes with the direction', () => {
  const fast = [4.0, 4.0, 5.0, 5.0];
  const slow = [4.4, 4.6, 4.8, 5.0];
  const filtered = detectCrossovers(fast, slow, undefined, { requireSlowSlopeAgreement: true });
  assert.deepEqual(filtered, [{ index: 2, openTime: 2, direction: 1 }]);
});

test('openTime comes from the candle when supplied', () => {
  const candles = [bar(900_000, 1, 1, 1, 1), bar(960_000, 1, 1, 1, 1), bar(1_020_000, 1, 1, 1, 1)];
  const events = detectCrossovers([1, 1.5, 3], [2, 2, 2], candles);
  assert.deepEqual(events, [{ index: 2, openTime: 1_020_000, direction: 1 }]);
});

test('an equality bar is neutral: fast must cross strictly from below/above', () => {
  // fast touches slow (diff 0) then separates upward — not a strict cross.
  assert.deepEqual(detectCrossovers([1, 2, 3], [2, 2, 2]), []);
});

const PULLBACK_OPTS = {
  extendAtr: 0.25,
  touchTolAtr: 0.05,
  maxBarsAfterCross: 12,
  requireSlowSlope: true,
  slopeLookbackBars: 1,
};

function bullishScenario(): { candles: Candle[]; line: (number | null)[]; slow: (number | null)[]; atr: (number | null)[] } {
  const candles: Candle[] = [];
  for (let i = 0; i < 21; i++) candles.push(bar(i * 60_000, 10.2, 10.4, 10.0, 10.3));
  // Extension bar (high 11.3 >= line 10 + 0.25 * ATR 1)
  candles[11] = bar(11 * 60_000, 10.4, 11.3, 10.3, 11.0);
  // Touch + rejection bar (low 9.9 <= 10.05, close 10.6 > 10)
  candles[12] = bar(12 * 60_000, 11.0, 11.1, 9.9, 10.6);
  const line = Array.from({ length: 21 }, () => 10);
  const slow = Array.from({ length: 21 }, (_, i) => 9 + 0.01 * i);
  const atr = Array.from({ length: 21 }, () => 1);
  return { candles, line, slow, atr };
}

test('bullish fast-line pullback: extend, touch, reject confirms one event after the cross', () => {
  const s = bullishScenario();
  const event = detectPullbackAfterCross(s.candles, s.line, s.slow, s.atr, crossAt(10, 1), 'fast', PULLBACK_OPTS);
  assert.ok(event);
  assert.equal(event.index, 12);
  assert.equal(event.direction, 1);
  assert.equal(event.crossIndex, 10);
  assert.equal(event.line, 'fast');
  assert.equal(event.openTime, 12 * 60_000);
});

test('no extension means no pullback event', () => {
  const s = bullishScenario();
  const tame = s.candles.map((c) => ({ ...c, high: Math.min(c.high, 10.2) }));
  const event = detectPullbackAfterCross(tame, s.line, s.slow, s.atr, crossAt(10, 1), 'fast', PULLBACK_OPTS);
  assert.equal(event, null);
});

test('touch without a closing rejection inside the window means no event', () => {
  const s = bullishScenario();
  // Touch happens (low 9.7) but every close stays below the line.
  s.candles[11] = bar(11 * 60_000, 10.4, 11.3, 10.3, 11.0);
  s.candles[12] = bar(12 * 60_000, 11.0, 11.05, 9.7, 9.8);
  for (let i = 13; i <= 22 - 1 && i < s.candles.length; i++) {
    s.candles[i] = bar(i * 60_000, 9.9, 9.95, 9.6, 9.7);
  }
  const event = detectPullbackAfterCross(s.candles, s.line, s.slow, s.atr, crossAt(10, 1), 'fast', PULLBACK_OPTS);
  assert.equal(event, null);
});

test('requireSlowSlope rejects confirmation when the slow line slopes against the trade', () => {
  const s = bullishScenario();
  const fallingSlow = Array.from({ length: 21 }, (_, i) => 11 - 0.01 * i);
  const event = detectPullbackAfterCross(s.candles, s.line, fallingSlow, s.atr, crossAt(10, 1), 'fast', PULLBACK_OPTS);
  assert.equal(event, null);
});

test('confirmation outside maxBarsAfterCross is ignored', () => {
  const s = bullishScenario();
  const event = detectPullbackAfterCross(s.candles, s.line, s.slow, s.atr, crossAt(10, 1), 'fast', {
    ...PULLBACK_OPTS,
    maxBarsAfterCross: 1,
  });
  assert.equal(event, null);
});

function bearishScenario(): { candles: Candle[]; line: (number | null)[]; slow: (number | null)[]; atr: (number | null)[] } {
  const candles: Candle[] = [];
  for (let i = 0; i < 21; i++) candles.push(bar(i * 60_000, 9.8, 10.0, 9.6, 9.7));
  // Extension bar (low 8.7 <= line 10 - 0.25 * ATR 1)
  candles[11] = bar(11 * 60_000, 9.6, 9.7, 8.7, 9.0);
  // Touch + rejection bar (high 10.1 >= 9.95, close 9.4 < 10)
  candles[12] = bar(12 * 60_000, 9.0, 10.1, 8.9, 9.4);
  const line = Array.from({ length: 21 }, () => 10);
  const slow = Array.from({ length: 21 }, (_, i) => 11 - 0.01 * i);
  const atr = Array.from({ length: 21 }, () => 1);
  return { candles, line, slow, atr };
}

test('bearish pullback mirrors the bullish state machine', () => {
  const s = bearishScenario();
  const event = detectPullbackAfterCross(s.candles, s.line, s.slow, s.atr, crossAt(10, -1), 'slow', PULLBACK_OPTS);
  assert.ok(event);
  assert.equal(event.index, 12);
  assert.equal(event.direction, -1);
  assert.equal(event.line, 'slow');
});

test('forwardOutcome references the next bar open and reports MFE/MAE over the horizon', () => {
  const candles = [
    bar(0, 10, 10, 10, 10),          // event bar (index 0)
    bar(60_000, 100, 102, 99, 101),  // entry bar: open 100
    bar(120_000, 101, 103, 100.5, 102), // exit bar (horizon 2): close 102
  ];
  const long = forwardOutcome(candles, 0, 1, 2);
  assert.ok(long);
  assert.ok(Math.abs(long.pct - 0.02) < 1e-12);
  assert.ok(Math.abs(long.mfePct - 0.03) < 1e-12);
  assert.ok(Math.abs(long.maePct - 0.01) < 1e-12);

  const short = forwardOutcome(candles, 0, -1, 2);
  assert.ok(short);
  assert.ok(Math.abs(short.pct + 0.02) < 1e-12);
  assert.ok(Math.abs(short.mfePct - 0.01) < 1e-12);
  assert.ok(Math.abs(short.maePct - 0.03) < 1e-12);
});

test('forwardOutcome excludes events whose horizon would run past the dataset tail', () => {
  const candles = [bar(0, 10, 10, 10, 10), bar(60_000, 10, 10, 10, 10)];
  assert.equal(forwardOutcome(candles, 0, 1, 2), null);
  assert.throws(() => forwardOutcome(candles, 0, 1, 0), /positive integer/);
});

test('summarizeEvents reports hit rate, quantiles and tail exclusions', () => {
  const stats = summarizeEvents([
    { direction: 1, outcome: { pct: 0.01, mfePct: 0.02, maePct: 0.005 } },
    { direction: -1, outcome: { pct: 0.02, mfePct: 0.03, maePct: 0.01 } },
    { direction: 1, outcome: null },
  ]);
  assert.equal(stats.events, 3);
  assert.equal(stats.longs, 2);
  assert.equal(stats.shorts, 1);
  assert.equal(stats.scored, 2);
  assert.equal(stats.excludedTail, 1);
  assert.equal(stats.hits, 2);
  assert.equal(stats.hitRate, 1);
  // Nearest-rank quantiles of [0.01, 0.02]: floor(q * (n - 1)) indexes the lower middle for even n.
  assert.equal(stats.medianPct, 0.01);
  assert.equal(stats.p25Pct, 0.01);
  assert.equal(stats.p75Pct, 0.01);
  assert.equal(stats.minPct, 0.01);
  assert.equal(stats.maxPct, 0.02);
});

test('summarizeEvents returns nulls instead of NaN for empty input', () => {
  const stats = summarizeEvents([]);
  assert.equal(stats.events, 0);
  assert.equal(stats.hitRate, null);
  assert.equal(stats.medianPct, null);
  assert.equal(stats.meanMfePct, null);
});

test('zero-pct outcomes count as misses, not hits', () => {
  const stats = summarizeEvents([{ direction: 1, outcome: { pct: 0, mfePct: 0.01, maePct: 0.01 } }]);
  assert.equal(stats.hits, 0);
  assert.equal(stats.hitRate, 0);
});
