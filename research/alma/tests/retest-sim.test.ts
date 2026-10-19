import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simulateRetestTrade } from '../src/retest-sim.js';
import type { Candle } from '../src/types.js';

function bar(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime, closeTime: openTime + 3_599_999, open, high, low, close, volume: 1000 };
}

// Short retest family: level 100 (sell limit), stop 102, risk at fill = 2,
// 2R target = 96. Signal closes at bar 0; earliest fill bar is bar 1.
const SHORT = { direction: -1 as const, level: 100, stopPrice: 102 };

test('short fills exactly at the level when the retest trades through it, then targets', () => {
  const candles = [
    bar(0, 99.0, 99.2, 98.5, 98.8),   // signal bar (reclaim close)
    bar(1, 99.0, 99.5, 98.4, 99.3),   // high < level: no fill
    bar(2, 99.5, 100.5, 98.0, 98.2),  // fill at 100 (open < level)
    bar(3, 98.0, 98.1, 95.5, 95.8),   // target 96 touched
    bar(4, 95.8, 96.2, 95.0, 95.5),
  ];
  const r = simulateRetestTrade(candles, { ...SHORT, signalIndex: 0, targetR: 2, fillWindowBars: 6, timeExitBars: 48 });
  assert.ok(r.filled && !r.degenerate);
  assert.equal(r.fillIndex, 2);
  assert.equal(r.fillPrice, 100);
  assert.equal(r.fillLagBars, 2);
  assert.equal(r.outcome, 'target');
  assert.equal(r.exitPrice, 96);
  assert.ok(Math.abs(r.grossR - 2) < 1e-12);
  assert.ok(Math.abs((r.risk as number) - 2) < 1e-12);
});

test('short fills at the open when it gaps beyond the level (marketable limit)', () => {
  const candles = [
    bar(0, 99.0, 99.2, 98.5, 98.8),
    bar(1, 100.8, 101.0, 99.9, 100.2), // open 100.8 >= level -> fill at 100.8
    bar(2, 100.0, 100.4, 99.0, 99.2),
    bar(3, 99.0, 99.2, 96.4, 96.6),    // target = 100.8 - 2*1.2 = 98.4 touched
    bar(4, 96.5, 97.0, 96.0, 96.2),
  ];
  const r = simulateRetestTrade(candles, { ...SHORT, signalIndex: 0, targetR: 2, fillWindowBars: 6, timeExitBars: 48 });
  assert.ok(r.filled && !r.degenerate);
  assert.equal(r.fillPrice, 100.8);
  assert.ok(Math.abs((r.risk as number) - (102 - 100.8)) < 1e-12);
  assert.equal(r.outcome, 'target');
  assert.ok(Math.abs(r.exitPrice - 98.4) < 1e-12);
  assert.ok(Math.abs(r.grossR - 2) < 1e-12);
});

test('short that never retests the level inside the window stays unfilled', () => {
  const candles = [
    bar(0, 99.0, 99.2, 98.5, 98.8),
    bar(1, 99.0, 99.8, 98.4, 99.0),
    bar(2, 99.0, 99.9, 98.0, 98.5),
  ];
  const r = simulateRetestTrade(candles, { ...SHORT, signalIndex: 0, targetR: 2, fillWindowBars: 2, timeExitBars: 48 });
  assert.deepEqual(r, { filled: false });
});

test('short filled on the same bar the stop extreme is reached loses exactly 1R', () => {
  const candles = [
    bar(0, 99.0, 99.2, 98.5, 98.8),
    bar(1, 99.5, 102.5, 99.0, 99.2), // fill at 100, high >= stop 102
    bar(2, 99.0, 99.5, 98.0, 98.2),
  ];
  const r = simulateRetestTrade(candles, { ...SHORT, signalIndex: 0, targetR: 2, fillWindowBars: 6, timeExitBars: 48 });
  assert.ok(r.filled && !r.degenerate);
  assert.equal(r.outcome, 'stop');
  assert.equal(r.exitPrice, 102);
  assert.ok(Math.abs(r.grossR + 1) < 1e-12);
  assert.equal(r.barsHeld, 1);
});

test('degenerate fill (open at or beyond the stop) cannot be sized and is flagged', () => {
  const candles = [
    bar(0, 99.0, 99.2, 98.5, 98.8),
    bar(1, 102.5, 103.0, 100.5, 100.8), // open 102.5 > stop 102
    bar(2, 100.0, 100.5, 99.0, 99.2),
  ];
  const r = simulateRetestTrade(candles, { ...SHORT, signalIndex: 0, targetR: 2, fillWindowBars: 6, timeExitBars: 48 });
  assert.ok(r.filled);
  assert.equal(r.degenerate, true);
  assert.equal(r.risk, null);
  assert.equal(r.grossR, 0);
});

test('short filled and targeted on the same bar is honored when the stop is untouched', () => {
  const candles = [
    bar(0, 99.0, 99.2, 98.5, 98.8),
    bar(1, 99.5, 100.5, 95.5, 96.2), // fill at 100, low <= 96, high < stop
    bar(2, 96.0, 96.5, 95.0, 95.5),
  ];
  const r = simulateRetestTrade(candles, { ...SHORT, signalIndex: 0, targetR: 2, fillWindowBars: 6, timeExitBars: 48 });
  assert.ok(r.filled && !r.degenerate);
  assert.equal(r.outcome, 'target');
  assert.equal(r.barsHeld, 1);
  assert.ok(Math.abs(r.grossR - 2) < 1e-12);
});

test('when stop and target are both touched on a later bar, the stop fills first', () => {
  const candles = [
    bar(0, 99.0, 99.2, 98.5, 98.8),
    bar(1, 99.5, 100.5, 98.0, 99.2),  // fill at 100, no stop/target
    bar(2, 100.0, 102.2, 95.0, 98.0), // high >= stop AND low <= target
    bar(3, 98.0, 98.5, 97.0, 97.5),
  ];
  const r = simulateRetestTrade(candles, { ...SHORT, signalIndex: 0, targetR: 2, fillWindowBars: 6, timeExitBars: 48 });
  assert.ok(r.filled && !r.degenerate);
  assert.equal(r.outcome, 'stop');
  assert.equal(r.exitPrice, 102);
  assert.ok(Math.abs(r.grossR + 1) < 1e-12);
});

test('no-target plan exits at the close of fillIndex + timeExitBars', () => {
  const candles = [
    bar(0, 99.0, 99.2, 98.5, 98.8),
    bar(1, 99.5, 100.5, 98.0, 99.2), // fill at 100
    bar(2, 99.0, 99.5, 98.2, 98.6),
    bar(3, 98.6, 99.0, 98.0, 98.0),  // fillIndex + 2 -> time exit at close 98
    bar(4, 98.0, 98.4, 97.0, 97.2),
  ];
  const r = simulateRetestTrade(candles, { ...SHORT, signalIndex: 0, targetR: null, fillWindowBars: 6, timeExitBars: 2 });
  assert.ok(r.filled && !r.degenerate);
  assert.equal(r.outcome, 'time');
  assert.equal(r.exitIndex, 3);
  assert.equal(r.exitPrice, 98);
  assert.ok(Math.abs(r.grossR - 1) < 1e-12);
});

test('long mirror fills at the level and targets upward; same-bar stop loses 1R', () => {
  const LONG = { direction: 1 as const, level: 100, stopPrice: 98 };
  const candles = [
    bar(0, 101.0, 101.5, 100.8, 101.2), // signal bar
    bar(1, 100.6, 100.8, 99.5, 100.2),  // low <= level -> fill at 100 (min(open, level))
    bar(2, 100.2, 104.5, 100.0, 104.0), // target = 104 touched
    bar(3, 104.0, 104.5, 103.0, 103.5),
  ];
  const r = simulateRetestTrade(candles, { ...LONG, signalIndex: 0, targetR: 2, fillWindowBars: 6, timeExitBars: 48 });
  assert.ok(r.filled && !r.degenerate);
  assert.equal(r.fillPrice, 100);
  assert.equal(r.outcome, 'target');
  assert.equal(r.exitPrice, 104);
  assert.ok(Math.abs(r.grossR - 2) < 1e-12);

  const stopped = simulateRetestTrade(
    [
      bar(0, 101.0, 101.5, 100.8, 101.2),
      bar(1, 100.6, 100.8, 97.5, 99.0), // fill at 100, low <= stop 98
      bar(2, 99.0, 99.5, 98.0, 98.2),
    ],
    { ...LONG, signalIndex: 0, targetR: 2, fillWindowBars: 6, timeExitBars: 48 },
  );
  assert.ok(stopped.filled && !stopped.degenerate);
  assert.equal(stopped.outcome, 'stop');
  assert.ok(Math.abs(stopped.grossR + 1) < 1e-12);
});

test('a fill on the final candle time-exits at that close; window edges are respected', () => {
  const candles = [
    bar(0, 99.0, 99.2, 98.5, 98.8),
    bar(1, 99.0, 99.8, 98.4, 99.0),   // no touch (window W=1 expires)
    bar(2, 99.5, 100.4, 98.5, 99.0),  // would fill, but W=1 -> unfilled for the first plan
  ];
  const missed = simulateRetestTrade(candles, { ...SHORT, signalIndex: 0, targetR: null, fillWindowBars: 1, timeExitBars: 3 });
  assert.deepEqual(missed, { filled: false });

  const tail = [
    bar(0, 99.0, 99.2, 98.5, 98.8),
    bar(1, 99.0, 99.8, 98.4, 99.0),
    bar(2, 99.5, 100.4, 98.5, 99.0), // fill on final candle
  ];
  const r = simulateRetestTrade(tail, { ...SHORT, signalIndex: 0, targetR: null, fillWindowBars: 3, timeExitBars: 5 });
  assert.ok(r.filled && !r.degenerate);
  assert.equal(r.fillIndex, 2);
  assert.equal(r.exitIndex, 2);
  assert.equal(r.outcome, 'time');
  assert.equal(r.exitPrice, 99.0);
});
