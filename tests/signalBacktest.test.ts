import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR_MS, MINUTE_MS, runStrategy, simulateTrade, toMinuteSeries, type Market, type Signal } from '../src/research/SignalBacktest.js';
import type { Candle } from '../src/types.js';

/** 3 hours of flat 1m bars at 100, with per-minute overrides. Signal hour 0 → entry at minute 60. */
function market(overrides: Record<number, Partial<Candle>> = {}, funding: [number, number][] = []): Market {
  const candles: Candle[] = Array.from({ length: 180 }, (_, i) => ({ openTime: i * MINUTE_MS, open: 100, high: 100, low: 100, close: 100, volume: 1, ...overrides[i] }));
  const series = toMinuteSeries(candles, 0, 180 * MINUTE_MS);
  return { trade: series, mark: series, fundingByMinute: new Map(funding), hourStart: 0, leverage: 5, mmr: 0.01 };
}
const long = (over: Partial<Signal> = {}): Signal => ({ side: 1, hour: 0, label: 't', stopDistance: 2, maxHoldMs: 2 * HOUR_MS, sizeMultiplier: 1, ...over });
const ZERO = { feeRate: 0, slippageRate: 0 };

test('entry is the next 1m open after the signal hour closes, never the signal bar close', () => {
  const t = simulateTrade(market({ 59: { close: 90 }, 60: { open: 101, high: 101, low: 101, close: 101 } }), long(), ZERO)!;
  assert.equal(t.entry, 101);
  assert.equal(t.entryTime, HOUR_MS);
});

test('stop wins when stop and target are both touched in the same minute', () => {
  const t = simulateTrade(market({ 70: { high: 110, low: 97 } }), long({ target: 105 }), ZERO)!;
  assert.equal(t.reason, 'STOP');
  assert.equal(t.exit, 98);
  assert.equal(t.grossR, -1);
});

test('a gap through the stop fills at the worse open price', () => {
  const t = simulateTrade(market({ 70: { open: 95, high: 96, low: 94, close: 95 } }), long(), ZERO)!;
  assert.equal(t.exit, 95);
  assert.equal(t.grossR, -2.5);
});

test('costs are charged per side in R and funding is paid by longs on positive rates', () => {
  const t = simulateTrade(market({}, [[90, 0.001]]), long({ maxHoldMs: 60 * MINUTE_MS }), { feeRate: 0.0004, slippageRate: 0.0002 })!;
  assert.equal(t.reason, 'TIME');
  assert.ok(Math.abs(t.costR - (0.0006 * 200) / 2) < 1e-12);
  assert.ok(Math.abs(t.fundingR - -0.05) < 1e-12, 'long pays 0.1% of 100 = 0.1 per unit = 0.05R');
});

test('trail ratchets on 1h closes and invalidation exits at the next open', () => {
  const up: Record<number, Partial<Candle>> = { 100: { high: 110, close: 109 }, ...Object.fromEntries(Array.from({ length: 24 }, (_, k) => [101 + k, { open: 109, high: 109, low: 109, close: 109 }])) };
  const trailed = simulateTrade(market({ ...up, 125: { open: 108, high: 108, low: 106, close: 107 } }), long({ trailDistance: 3 }), ZERO)!;
  assert.equal(trailed.reason, 'STOP');
  assert.equal(trailed.exit, 107, 'stop moved from 98 to 110 - 3 at the 2h close');
  const invalidated = simulateTrade(market(), long({ invalidate: (h) => h === 1 }), ZERO)!;
  assert.equal(invalidated.reason, 'INVALIDATED');
  assert.equal(invalidated.exitTime, 2 * HOUR_MS);
});

test('runStrategy holds one position at a time', () => {
  const trades = runStrategy(market(), 3, (hour) => long({ hour, maxHoldMs: 30 * MINUTE_MS }), ZERO);
  assert.equal(trades.length, 2);
  assert.deepEqual(trades.map((t) => t.entryTime), [HOUR_MS, 2 * HOUR_MS]);
});

test('a passive entry fills only when price trades strictly through the limit inside the window, at the limit, maker fee', () => {
  const costs = { feeRate: 0.0004, slippageRate: 0.0002, makerFeeRate: 0.0002 };
  const touchOnly = simulateTrade(market({ 60: { low: 100 }, 61: { low: 100 } }), long({ makerEntryWindowMinutes: 5 }), costs);
  assert.equal(touchOnly, null, 'a touch at the limit is not a fill: no queue-position assumption');
  const filled = simulateTrade(market({ 62: { open: 100, high: 100, low: 99.5, close: 99.8 } }), long({ makerEntryWindowMinutes: 5, maxHoldMs: HOUR_MS }), costs)!;
  assert.equal(filled.entry, 100);
  assert.equal(filled.entryTime, HOUR_MS + 2 * MINUTE_MS);
  assert.equal(filled.exitTime, 2 * HOUR_MS - MINUTE_MS, 'the hold ends at the nominal deadline, not 1h after the fill');
  assert.ok(Math.abs(filled.costR - (0.0002 * 100 + 0.0006 * 100) / 2) < 1e-12);
  const late = simulateTrade(market({ 66: { low: 99 } }), long({ makerEntryWindowMinutes: 5 }), costs);
  assert.equal(late, null, 'outside the 5-minute window');
});
