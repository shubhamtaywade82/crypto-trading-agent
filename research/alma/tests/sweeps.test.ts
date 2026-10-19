import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPivots, detectSweepReclaim } from '../src/sweeps.js';
import type { Candle } from '../src/types.js';

function bar(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime, closeTime: openTime + 59_999, open, high, low, close, volume: 1000 };
}

test('detectPivots finds strictly extreme bars and confirms them k bars later', () => {
  const candles = [
    bar(0, 10, 11, 9, 10),
    bar(60_000, 10, 11, 9, 10),
    bar(120_000, 10, 11, 8, 10),  // pivot low candidate at index 2 (8 < 9 and < 9)
    bar(180_000, 10, 11, 9, 10),
    bar(240_000, 10, 11, 9, 10),
  ];
  const pivots = detectPivots(candles, 2);
  assert.equal(pivots.length, 1);
  assert.equal(pivots[0].kind, 'low');
  assert.equal(pivots[0].index, 2);
  assert.equal(pivots[0].confirmIndex, 4);
  assert.equal(pivots[0].level, 8);
});

test('equal extremes do not pivot (strict comparison)', () => {
  const candles = [
    bar(0, 10, 11, 9, 10),
    bar(60_000, 10, 11, 9, 10),   // ties the neighbour low -> no pivot
    bar(120_000, 10, 11, 9, 10),
    bar(180_000, 10, 11, 9, 10),
    bar(240_000, 10, 11, 9, 10),
  ];
  assert.deepEqual(detectPivots(candles, 2), []);
});

test('same-bar sweep-and-reclaim fires long after the pivot is confirmed', () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 10; i++) candles.push(bar(i * 60_000, 10, 10.5, 9.5, 10));
  // pivot low at index 5 (low 9.0), confirmed at index 8 (k=3)
  candles[5] = bar(5 * 60_000, 10, 10.5, 9.0, 10);
  // sweep bar: wick below 9.0, close back above -> bullish reclaim, event at index 9
  candles[9] = bar(9 * 60_000, 10, 10.2, 8.8, 10.1);

  const events = detectSweepReclaim(candles, 3, { reclaimWithinBars: 0, cooldownBars: 0 });
  assert.equal(events.length, 1);
  assert.equal(events[0].index, 9);
  assert.equal(events[0].direction, 1);
  assert.equal(events[0].level, 9.0);
  assert.equal(events[0].sameBarReclaim, true);
});

test('a sweep before the pivot is confirmed does not fire (causality)', () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 12; i++) candles.push(bar(i * 60_000, 10, 10.5, 9.5, 10));
  candles[5] = bar(5 * 60_000, 10, 10.5, 9.0, 10);  // pivot low candidate, confirms at 8
  candles[6] = bar(6 * 60_000, 10, 10.2, 8.8, 10.1); // sweep BEFORE confirmation
  const events = detectSweepReclaim(candles, 3, { reclaimWithinBars: 0, cooldownBars: 0 });
  assert.deepEqual(events, []);
});

test('close-below sweep reclaims within the window at the reclaim bar', () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 14; i++) candles.push(bar(i * 60_000, 10, 10.5, 9.5, 10));
  candles[5] = bar(5 * 60_000, 10, 10.5, 9.0, 10);
  candles[9] = bar(9 * 60_000, 10, 10.2, 8.8, 8.9);   // sweep, closes below 9.0
  candles[10] = bar(10 * 60_000, 9.0, 10.0, 8.9, 8.95); // still below
  candles[11] = bar(11 * 60_000, 9.0, 10.2, 8.9, 10.05); // reclaim close, event here
  const events = detectSweepReclaim(candles, 3, { reclaimWithinBars: 2, cooldownBars: 0 });
  assert.equal(events.length, 1);
  assert.equal(events[0].index, 11);
  assert.equal(events[0].sameBarReclaim, false);
});

test('no reclaim inside the window means no event', () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 14; i++) candles.push(bar(i * 60_000, 10, 10.5, 9.5, 9.6));
  candles[5] = bar(5 * 60_000, 10, 10.5, 9.0, 10);
  candles[9] = bar(9 * 60_000, 10, 10.2, 8.8, 8.9);
  for (let i = 10; i <= 13; i++) candles[i] = bar(i * 60_000, 8.9, 9.0, 8.85, 8.89); // stays below 9.0
  const events = detectSweepReclaim(candles, 3, { reclaimWithinBars: 2, cooldownBars: 0 });
  assert.deepEqual(events, []);
});

test('cooldown suppresses events that fire too close together', () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 20; i++) candles.push(bar(i * 60_000, 10, 10.5, 9.5, 10));
  candles[5] = bar(5 * 60_000, 10, 10.5, 9.0, 10);
  candles[9] = bar(9 * 60_000, 10, 10.2, 8.8, 10.1);   // event at 9
  candles[13] = bar(13 * 60_000, 10, 10.2, 8.7, 10.1); // would fire at 13; 13-9 <= 5 -> suppressed
  const blocked = detectSweepReclaim(candles, 3, { reclaimWithinBars: 0, cooldownBars: 5 });
  assert.equal(blocked.length, 1);
  const allowed = detectSweepReclaim(candles, 3, { reclaimWithinBars: 0, cooldownBars: 3 });
  assert.equal(allowed.length, 2);
});

test('a newer confirmed pivot replaces the reference level', () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 24; i++) candles.push(bar(i * 60_000, 10, 10.5, 9.5, 10));
  candles[5] = bar(5 * 60_000, 10, 10.5, 9.0, 10);   // pivot low 9.0, confirms at 8
  candles[9] = bar(9 * 60_000, 10, 10.2, 8.8, 10.1); // event 1 sweeps 9.0
  candles[12] = bar(12 * 60_000, 10, 10.5, 8.7, 10); // sweeps 9.0 AND forms the new pivot low 8.7 (confirms at 15)
  candles[16] = bar(16 * 60_000, 10, 10.2, 8.65, 10.1); // sweeps the NEW level 8.7
  const events = detectSweepReclaim(candles, 3, { reclaimWithinBars: 0, cooldownBars: 0 });
  // The transition bar itself is a legitimate sweep-and-reclaim of the old level.
  assert.equal(events.length, 3);
  assert.equal(events[0].level, 9.0);
  assert.equal(events[1].index, 12);
  assert.equal(events[1].level, 9.0);
  assert.equal(events[2].index, 16);
  assert.equal(events[2].level, 8.7);
});

test('bearish mirror: highs swept and reclaimed downward fire short', () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 12; i++) candles.push(bar(i * 60_000, 10, 10.5, 9.5, 10));
  candles[5] = bar(5 * 60_000, 10, 11.0, 9.5, 10);   // pivot high 11.0, confirms at 8
  candles[9] = bar(9 * 60_000, 10, 11.2, 9.8, 10.0); // sweep high, close back below -> short
  const events = detectSweepReclaim(candles, 3, { reclaimWithinBars: 0, cooldownBars: 0 });
  assert.equal(events.length, 1);
  assert.equal(events[0].direction, -1);
  assert.equal(events[0].level, 11.0);
  assert.equal(events[0].index, 9);
});

test('rejects invalid options', () => {
  const candles = [bar(0, 10, 11, 9, 10), bar(60_000, 10, 11, 9, 10)];
  assert.throws(() => detectSweepReclaim(candles, 0, { reclaimWithinBars: 0, cooldownBars: 0 }), /positive integer/);
  assert.throws(() => detectSweepReclaim(candles, 2, { reclaimWithinBars: -1, cooldownBars: 0 }), /reclaimWithinBars/);
  assert.throws(() => detectSweepReclaim(candles, 2, { reclaimWithinBars: 0, cooldownBars: 1.5 }), /cooldownBars/);
});
