import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costsInR, fundingInR, simulateTrade } from '../src/trade-sim.js';
import type { Candle } from '../src/types.js';

function bar(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime, closeTime: openTime + 3_599_999, open, high, low, close, volume: 1000 };
}

// Short plan: entry 100 at bar 1 open, stop 101, risk 1.
function shortPlan(targetPrice: number | null, timeExitIndex: number) {
  return { entryIndex: 1, direction: -1 as const, entryPrice: 100, stopPrice: 101, targetPrice, timeExitIndex };
}

test('time exit fills at the close of the time-exit bar', () => {
  const candles = [
    bar(0, 100, 100.5, 99.5, 100),
    bar(3_600_000, 100, 100.5, 99.5, 100),     // entry bar
    bar(7_200_000, 100, 100.4, 99.6, 99.2),    // drifts down
    bar(10_800_000, 99.2, 99.6, 99.0, 99.0),   // time exit bar: close 99.0
  ];
  const r = simulateTrade(candles, shortPlan(null, 3));
  assert.ok(r);
  assert.equal(r.outcome, 'time');
  assert.equal(r.exitIndex, 3);
  assert.equal(r.exitPrice, 99.0);
  assert.ok(Math.abs(r.grossR - 1.0) < 1e-12); // (100 - 99) / 1
  assert.equal(r.barsHeld, 3);
});

test('intrabar stop touch fills at the stop price', () => {
  const candles = [
    bar(0, 100, 100.5, 99.5, 100),
    bar(3_600_000, 100, 100.4, 99.5, 100),
    bar(7_200_000, 100, 101.6, 99.0, 100.5),   // high 101.6 >= stop 101
    bar(10_800_000, 100.5, 101, 100, 101),
  ];
  const r = simulateTrade(candles, shortPlan(null, 3));
  assert.ok(r);
  assert.equal(r.outcome, 'stop');
  assert.equal(r.exitPrice, 101);
  assert.ok(Math.abs(r.grossR + 1.0) < 1e-12);
});

test('an open gap through the stop fills at the open, not the stop', () => {
  const candles = [
    bar(0, 100, 100.5, 99.5, 100),
    bar(3_600_000, 100, 100.4, 99.5, 100),
    bar(7_200_000, 101.8, 102.0, 101.5, 101.9), // opens beyond the stop
  ];
  const r = simulateTrade(candles, shortPlan(null, 3));
  assert.ok(r);
  assert.equal(r.outcome, 'stop');
  assert.equal(r.exitPrice, 101.8); // worse fill than the 101 stop
  assert.ok(Math.abs(r.grossR + 1.8) < 1e-12);
});

test('when stop and target are touched in the same bar, the stop fills first', () => {
  const candles = [
    bar(0, 100, 100.5, 99.5, 100),
    bar(3_600_000, 100, 100.4, 99.5, 100),
    bar(7_200_000, 100, 101.5, 98.0, 100),     // high >= stop 101 AND low <= target 98
    bar(10_800_000, 100, 100.5, 99.5, 100),
  ];
  const r = simulateTrade(candles, shortPlan(98, 3));
  assert.ok(r);
  assert.equal(r.outcome, 'stop');
  assert.equal(r.exitPrice, 101);
});

test('a clean target hit fills at the target with the exact R multiple', () => {
  const candles = [
    bar(0, 100, 100.5, 99.5, 100),
    bar(3_600_000, 100, 100.4, 99.5, 100),
    bar(7_200_000, 100, 100.2, 98.0, 98.2),    // low <= target 98, high below stop
  ];
  const r = simulateTrade(candles, shortPlan(98, 5));
  assert.ok(r);
  assert.equal(r.outcome, 'target');
  assert.equal(r.exitPrice, 98);
  assert.ok(Math.abs(r.grossR - 2.0) < 1e-12);
});

test('long mirror: target hit from below', () => {
  const candles = [
    bar(0, 100, 100.5, 99.5, 100),
    bar(3_600_000, 100, 100.4, 99.5, 100),
    bar(7_200_000, 100, 102.2, 100.0, 102.0),
  ];
  const plan = { entryIndex: 1, direction: 1 as const, entryPrice: 100, stopPrice: 99, targetPrice: 102, timeExitIndex: 5 };
  const r = simulateTrade(candles, plan);
  assert.ok(r);
  assert.equal(r.outcome, 'target');
  assert.ok(Math.abs(r.grossR - 2.0) < 1e-12);
});

test('invalid plans return null (no risk, out of range)', () => {
  const candles = [bar(0, 100, 101, 99, 100), bar(3_600_000, 100, 101, 99, 100)];
  // Short with stop below entry: no risk.
  assert.equal(simulateTrade(candles, { entryIndex: 1, direction: -1, entryPrice: 100, stopPrice: 99, targetPrice: null, timeExitIndex: 1 }), null);
  // Entry index beyond the data.
  assert.equal(simulateTrade(candles, { entryIndex: 5, direction: -1, entryPrice: 100, stopPrice: 101, targetPrice: null, timeExitIndex: 6 }), null);
});

test('round-trip costs in R scale with the risk fraction', () => {
  // 4 bps fee + 2 bps slippage per side = 12 bps round trip.
  // Risk fraction 1% of notional -> 0.0012 / 0.01 = 0.12 R.
  assert.ok(Math.abs(costsInR(100, 101, 4, 2) - 0.12) < 1e-12);
  // Risk fraction 2% -> 0.06 R.
  assert.ok(Math.abs(costsInR(100, 102, 4, 2) - 0.06) < 1e-12);
});

test('funding in R credits shorts on positive rates and debits longs', () => {
  const rates = [0.0001, 0.0001, -0.00005]; // net +0.00015 of notional
  const short = fundingInR(-1, rates, 100, 101);
  assert.ok(Math.abs(short - 0.015) < 1e-12); // +0.00015 / 0.01
  const long = fundingInR(1, rates, 100, 101);
  assert.ok(Math.abs(long + 0.015) < 1e-12);
  assert.equal(fundingInR(-1, [], 100, 101), 0);
});
