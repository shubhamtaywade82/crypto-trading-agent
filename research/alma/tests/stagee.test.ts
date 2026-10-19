import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import {
  STAGE_E_WINDOWS,
  configId,
  enumerateMarketFamily,
  enumerateRetestFamily,
  enumerateStageEFamily,
  evalStageEConfirmGate,
  evalStageETrainGate,
  pessimisticRetestOutcome,
  pooledTimeFolds,
  sliceWindow,
} from '../src/stagee-lib.js';

function bar(openTime: number, o: number, h: number, l: number, c: number): Candle {
  return { openTime, closeTime: openTime + 14_400_000 - 1, open: o, high: h, low: l, close: c, volume: 1 };
}

const WIN = STAGE_E_WINDOWS.replication; // 2023-10-19 .. 2024-10-19

test('frozen family: exactly 48 tested configs (24 market + 24 retest), unique ids', () => {
  const market = enumerateMarketFamily();
  const retest = enumerateRetestFamily();
  const all = enumerateStageEFamily();
  assert.equal(market.length, 24);
  assert.equal(retest.length, 24);
  assert.equal(all.length, 48);
  const ids = new Set(all.map(configId));
  assert.equal(ids.size, 48);
  // Replication fidelity: the config axes match the previously frozen families.
  assert.deepEqual([...new Set(market.map((c) => c.timeframe))].sort(), ['1h', '4h']);
  assert.deepEqual([...new Set(market.map((c) => c.exitName))].sort(), ['stop_or_1.5R', 'stop_or_2R', 'time6']);
  assert.deepEqual([...new Set(retest.map((c) => c.fillWindowBars))].sort((a, b) => a - b), [6, 12]);
  assert.deepEqual([...new Set(retest.map((c) => c.timeframe))], ['4h']);
});

test('window boundaries mirror the SOLUSDT stage windows to the day', () => {
  assert.equal(STAGE_E_WINDOWS.train.fromMs, Date.UTC(2024, 9, 18));
  assert.equal(STAGE_E_WINDOWS.train.toMs, Date.UTC(2026, 4, 25));
  assert.equal(STAGE_E_WINDOWS.test.toMs, Date.UTC(2026, 9, 18));
  assert.equal(STAGE_E_WINDOWS.replication.fromMs, Date.UTC(2023, 9, 19));
  assert.equal(STAGE_E_WINDOWS.replication.toMs, Date.UTC(2024, 9, 18));
  // train spans exactly 584 days, test 146, replication 365
  assert.equal((STAGE_E_WINDOWS.train.toMs - STAGE_E_WINDOWS.train.fromMs) / 86_400_000, 584);
  assert.equal((STAGE_E_WINDOWS.test.toMs - STAGE_E_WINDOWS.test.fromMs) / 86_400_000, 146);
  assert.equal((STAGE_E_WINDOWS.replication.toMs - STAGE_E_WINDOWS.replication.fromMs) / 86_400_000, 365);
});

test('sliceWindow keeps only bars inside the window and fails closed on gaps', () => {
  const bar4h = 14_400_000;
  const start = Date.UTC(2023, 9, 19);
  const candles: Candle[] = [];
  for (let i = -2; i < 2200; i++) candles.push(bar(start + i * bar4h, 100, 110, 90, 105));
  const sliced = sliceWindow(candles, { ...WIN }, '4h');
  assert.equal(sliced[0].openTime, start);
  assert.ok(sliced[sliced.length - 1].openTime < WIN.toMs);
  assert.equal(sliced.length, 2190); // 365 days * 6 bars/day

  assert.throws(() => sliceWindow(candles.slice(5), { ...WIN }, '4h'), /does not cover the window start/);
  assert.throws(() => sliceWindow(candles.slice(0, 100), { ...WIN }, '4h'), /does not cover the window end/);
  assert.throws(() => sliceWindow([], { ...WIN }, '4h'), /no bars inside/);
});

test('pessimisticRetestOutcome: fill-bar target NOT honored, fill-bar stop honored', () => {
  const start = Date.UTC(2024, 0, 1);
  const cs: Candle[] = [
    bar(start, 100, 101, 99, 100),
    // fill bar: fills short at level 100, touches target 98 but NOT stop 103
    bar(start + day(1), 100.5, 100.6, 97.5, 99),
    // later bar touches the target again
    bar(start + day(2), 99, 99.2, 97.8, 98),
    bar(start + day(3), 98, 98.5, 97.5, 98),
  ];
  // Optimistic semantics (shipped simulator) would exit at target on the fill bar.
  const pess = pessimisticRetestOutcome(cs, {
    fillIndex: 1, fillPrice: 100, direction: -1, stopPrice: 103, targetPrice: 98, timeExitBars: 48,
  });
  assert.equal(pess.outcome, 'target');
  assert.equal(pess.exitIndex, 2);
  assert.equal(pess.exitPrice, 98);

  // Fill bar touches the stop too -> stop fires on the fill bar under BOTH conventions.
  const csStop: Candle[] = [
    bar(start, 100, 101, 99, 100),
    bar(start + day(1), 100.5, 104, 99.5, 103.5),
    bar(start + day(2), 103.5, 104, 103, 103.5),
  ];
  const pessStop = pessimisticRetestOutcome(csStop, {
    fillIndex: 1, fillPrice: 100, direction: -1, stopPrice: 103, targetPrice: 98, timeExitBars: 48,
  });
  assert.equal(pessStop.outcome, 'stop');
  assert.equal(pessStop.exitIndex, 1);
  assert.equal(pessStop.exitPrice, 103);

  // No further touch -> time exit at the close of the last allowed bar.
  const csTime: Candle[] = [
    bar(start, 100, 101, 99, 100),
    bar(start + day(1), 100.5, 100.6, 99.4, 100),
    bar(start + day(2), 100, 100.2, 99.8, 100.1),
  ];
  const pessTime = pessimisticRetestOutcome(csTime, {
    fillIndex: 1, fillPrice: 100, direction: -1, stopPrice: 103, targetPrice: 98, timeExitBars: 1,
  });
  assert.equal(pessTime.outcome, 'time');
  assert.equal(pessTime.exitIndex, 2);
  assert.equal(pessTime.exitPrice, 100.1);
});

function day(n: number): number {
  return n * 14_400_000;
}

test('pooledTimeFolds: contiguous chronological folds, deterministic tie-break', () => {
  const trades = [
    { symbol: 'ETHUSDT', entryTime: 4 },
    { symbol: 'BTCUSDT', entryTime: 4 },
    { symbol: 'BTCUSDT', entryTime: 1 },
    { symbol: 'ETHUSDT', entryTime: 2 },
    { symbol: 'BTCUSDT', entryTime: 3 },
    { symbol: 'ETHUSDT', entryTime: 5 },
    { symbol: 'BTCUSDT', entryTime: 6 },
    { symbol: 'ETHUSDT', entryTime: 7 },
    { symbol: 'BTCUSDT', entryTime: 8 },
    { symbol: 'ETHUSDT', entryTime: 9 },
    { symbol: 'BTCUSDT', entryTime: 10 },
    { symbol: 'ETHUSDT', entryTime: 11 },
  ];
  const assign = pooledTimeFolds(trades, 4);
  assert.equal(assign.length, 12);
  assert.deepEqual(assign.filter((f) => f === 0).length, 3);
  assert.deepEqual(assign.filter((f) => f === 3).length, 3);
  // Chronology: every trade in fold k has entryTime <= every trade in fold k+1.
  const maxByFold = [0, 1, 2, 3].map((f) => Math.max(...trades.filter((_, i) => assign[i] === f).map((t) => t.entryTime)));
  const minByFold = [0, 1, 2, 3].map((f) => Math.min(...trades.filter((_, i) => assign[i] === f).map((t) => t.entryTime)));
  for (let f = 0; f < 3; f++) assert.ok(maxByFold[f] <= minByFold[f + 1]);
  // Tie at time 4: BTCUSDT must land in an earlier-or-equal fold than ETHUSDT.
  const btcIdx = trades.findIndex((t) => t.symbol === 'BTCUSDT' && t.entryTime === 4);
  const ethIdx = trades.findIndex((t) => t.symbol === 'ETHUSDT' && t.entryTime === 4);
  assert.ok(assign[btcIdx] <= assign[ethIdx]);
  // Determinism
  assert.deepEqual(pooledTimeFolds(trades, 4), assign);
});

test('train gate includes the pessimistic clause for retest configs only', () => {
  const base = { n: 40, holmSignificant: true, netMeanR: 0.1, foldMeanR: [0.2, 0.1, 0.05, 0.15] };
  // Market config: no pessimistic clause -> passes.
  assert.equal(evalStageETrainGate({ ...base }, { minFills: 30, minPositiveFolds: 3 }).pass, true);
  // Retest config with pessimistic E[R] > 0 -> passes.
  assert.equal(evalStageETrainGate({ ...base, pessimisticMeanR: 0.05 }, { minFills: 30, minPositiveFolds: 3 }).pass, true);
  // Retest config with pessimistic E[R] <= 0 -> fails with the declared clause.
  const verdict = evalStageETrainGate({ ...base, pessimisticMeanR: -0.01 }, { minFills: 30, minPositiveFolds: 3 });
  assert.equal(verdict.pass, false);
  assert.ok(verdict.failures.some((f) => f.includes('pessimistic-convention')));
  // Null pessimistic (degenerate?) also fails.
  assert.equal(evalStageETrainGate({ ...base, pessimisticMeanR: null }, { minFills: 30, minPositiveFolds: 3 }).pass, false);
  // Standard legs still enforced alongside.
  const weak = evalStageETrainGate({ ...base, n: 10, holmSignificant: false, pessimisticMeanR: 0.05 }, { minFills: 30, minPositiveFolds: 3 });
  assert.equal(weak.pass, false);
  assert.ok(weak.failures.some((f) => f.includes('fills')));
});

test('confirmation gate mirrors the pessimistic clause and the C/D legs', () => {
  const base = { n: 40, netMeanR: 0.08, permutationP: 0.01 };
  assert.equal(evalStageEConfirmGate({ ...base }, { minFills: 30, alpha: 0.05 }).pass, true);
  const failP = evalStageEConfirmGate({ ...base, permutationP: 0.5 }, { minFills: 30, alpha: 0.05 });
  assert.equal(failP.pass, false);
  const failPess = evalStageEConfirmGate({ ...base, pessimisticMeanR: -0.02 }, { minFills: 30, alpha: 0.05 });
  assert.equal(failPess.pass, false);
  assert.ok(failPess.failures.some((f) => f.includes('pessimistic-convention')));
});
