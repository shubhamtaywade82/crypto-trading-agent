import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BarrierSetup, CostModel } from '../src/market/directional/barriers.js';
import {
  pairedDifference, replayPolicy, summarizeReplays, type ExitPolicy, type ReplayOptions, type TradeReplay,
} from '../src/market/directional/scaleout-replay.js';
import { barKnownAt } from '../src/market/rejection/types.js';
import { SYMBOL, flowSeries, type Px } from './rejectionFixtures.js';

const COSTS: CostModel = { feeBpsPerSide: 4, slippageBpsPerSide: 2, funding: { kind: 'CONSTANT_FALLBACK', fundingBpsPerHour: 0 } };
const OPTS: ReplayOptions = { maxBars: 12, costs: COSTS };
const entry: Px = { o: 100, h: 100, l: 100, c: 100 };
const setup: BarrierSetup = { id: 'T1', symbol: SYMBOL, side: 'LONG', entryIndex: 0, stopPrice: 98, tags: [] };
const SINGLE: ExitPolicy = { kind: 'SINGLE_TARGET', targetPct: 1 };
const LADDER: ExitPolicy = {
  kind: 'LADDER_RUNNER',
  rungs: [{ targetPct: 1, fraction: 0.25 }, { targetPct: 2, fraction: 0.25 }, { targetPct: 3, fraction: 0.25 }],
  trail: { kind: 'FIXED_PCT', pct: 2 },
  breakEvenAfterFirstRung: true,
};
const approx = (a: number, b: number, eps = 1e-9): void => {
  assert.ok(Math.abs(a - b) < eps, `got ${a}, want ${b}`);
};

/** Price rises through 1%, 2% and 3%, then pulls back through the trailing stop. */
const CONTINUATION: Px[] = [
  entry,
  { o: 100, h: 101.2, l: 99.5, c: 101 },
  { o: 101, h: 102.2, l: 101, c: 102 },
  { o: 102, h: 103.1, l: 102.5, c: 103 },
  { o: 104, h: 105, l: 104, c: 104.5 },
  { o: 104, h: 104.5, l: 102.5, c: 103 },
];

/** Hits 1%, then reverses to the breakeven stop. */
const REVERSAL: Px[] = [entry, { o: 100, h: 101.2, l: 99.5, c: 101 }, { o: 100.5, h: 100.6, l: 100, c: 100.2 }];

test('paired replay: on a continuation path the ladder captures more R than the single 1% target', () => {
  const bars = flowSeries('5m', CONTINUATION);
  const [ladder] = replayPolicy(bars, [setup], LADDER, OPTS);
  const [single] = replayPolicy(bars, [setup], SINGLE, OPTS);
  assert.ok(ladder?.resolved && single?.resolved);
  // Rungs book 0.25 × (1 + 2 + 3) = 1.5%. The runner exits at the trail, 0.25 × 2.9 = 0.725%. Gross 2.225%.
  // Fees 0.12% on the entry and the exits. Net 2.105%, and the initial risk is 2%.
  approx(ladder.grossPct, 2.225);
  approx(ladder.netPct, 2.105);
  approx(ladder.rMultiple, 1.0525);
  assert.deepEqual(ladder.exits.map((e) => [e.reason, Math.round(e.price * 1e6) / 1e6]), [['RUNG', 101], ['RUNG', 102], ['RUNG', 103], ['TRAIL', 102.9]]);
  approx(single.rMultiple, 0.44);
  assert.ok(ladder.rMultiple > single.rMultiple);
});

test('paired replay: the same setup carries the same initial risk under every policy', () => {
  const bars = flowSeries('5m', CONTINUATION);
  const [ladder] = replayPolicy(bars, [setup], LADDER, OPTS);
  const [single] = replayPolicy(bars, [setup], SINGLE, OPTS);
  approx(ladder?.riskPct ?? Number.NaN, 2);
  assert.equal(ladder?.riskPct, single?.riskPct);
});

test('paired replay: after a rung, a reversal exits the runner at breakeven, so the ladder gives back the single target edge', () => {
  const bars = flowSeries('5m', REVERSAL);
  const [ladder] = replayPolicy(bars, [setup], LADDER, OPTS);
  const [single] = replayPolicy(bars, [setup], SINGLE, OPTS);
  assert.deepEqual(ladder?.exits.map((e) => [e.reason, e.fraction]), [['RUNG', 0.25], ['BREAKEVEN', 0.75]]);
  // Rung 0.25 × 1% = 0.25. Runner 0.75 × 0.12% = 0.09 at the breakeven stop. Gross 0.34%, fees 0.12%, net 0.22%.
  approx(ladder?.netPct ?? Number.NaN, 0.22);
  approx(single?.rMultiple ?? Number.NaN, 0.44);
  assert.ok((ladder?.rMultiple ?? 0) < (single?.rMultiple ?? 0), 'the breakeven stop is the cost of the staged policy on this path');
});

test('a stop touched on the same bar as a rung is a stop: the rung does not book', () => {
  const bars = flowSeries('5m', [entry, { o: 100, h: 101.5, l: 97.5, c: 100 }]);
  const [t] = replayPolicy(bars, [setup], LADDER, OPTS);
  assert.deepEqual(t?.exits.map((e) => [e.reason, e.fraction, e.price]), [['STOP', 1, 98]]);
  approx(t?.netPct ?? Number.NaN, -2.12);
});

test('funding inside the hold is charged on the fraction still open, and reduces the net return', () => {
  const bars = flowSeries('5m', [entry, { o: 100, h: 101.2, l: 99.5, c: 101 }]);
  const entryKnown = barKnownAt(bars[0]!);
  const withFunding: ReplayOptions = {
    maxBars: 12,
    costs: { ...COSTS, funding: { kind: 'SETTLEMENTS', settlements: [{ time: entryKnown + 300_000, rate: 0.0001, markPrice: 100 }] } },
  };
  const [t] = replayPolicy(bars, [setup], SINGLE, withFunding);
  approx(t?.fundingPct ?? Number.NaN, 0.01);
  approx(t?.netPct ?? Number.NaN, 0.87);
  assert.equal(t?.fundingModel, 'SETTLEMENTS');
});

test('a data gap before resolution leaves the trade unresolved and out of the summary', () => {
  const bars = flowSeries('5m', [entry, entry, entry, entry]);
  bars[2] = { ...bars[2]!, complete: false };
  const [t] = replayPolicy(bars, [setup], SINGLE, { maxBars: 3, costs: COSTS });
  assert.equal(t?.resolved, false);
  assert.equal(t?.unresolvedReason, 'GAP_BEFORE_RESOLUTION');
  assert.equal(summarizeReplays([t!], 3).n, 0);
  assert.equal(summarizeReplays([t!], 3).unresolved, 1);
});

test('a flat path times out at the horizon close, with the round trip charged', () => {
  const bars = flowSeries('5m', [entry, ...Array.from({ length: 12 }, () => ({ o: 100, h: 100.5, l: 99.5, c: 100 }))]);
  const [t] = replayPolicy(bars, [setup], SINGLE, OPTS);
  assert.deepEqual(t?.exits.map((e) => [e.reason, e.barIndex]), [['TIMEOUT', 12]]);
  assert.equal(t?.barsHeld, 12);
  approx(t?.netPct ?? Number.NaN, -0.12);
});

test('a ladder whose rungs book the whole position is refused', () => {
  const bars = flowSeries('5m', CONTINUATION);
  assert.throws(() => replayPolicy(bars, [setup], {
    ...LADDER,
    rungs: [{ targetPct: 1, fraction: 0.5 }, { targetPct: 2, fraction: 0.5 }],
  } as ExitPolicy, OPTS), /runner must remain/);
});

function fake(id: string, r: number, entryTime: number): TradeReplay {
  return {
    setupId: id, side: 'LONG', day: '2026-01-01', entryTime, entryPrice: 100, riskPct: 2, resolved: true,
    unresolvedReason: null, exits: [], grossPct: 0, feePct: 0, fundingPct: 0, netPct: r * 2, rMultiple: r,
    barsHeld: 4, fundingModel: 'CONSTANT_FALLBACK',
  };
}

test('summary: drawdown is the largest fall of cumulative R in time order, and profit factor is gains over losses', () => {
  const trades = [fake('a', 1, 1), fake('b', -0.5, 2), fake('c', -0.5, 3), fake('d', 1, 4)];
  const s = summarizeReplays(trades, 12);
  assert.equal(s.n, 4);
  approx(s.meanR ?? Number.NaN, 0.25);
  approx(s.winRate ?? Number.NaN, 0.5);
  approx(s.profitFactor ?? Number.NaN, 2);
  // Cumulative R: 1, 0.5, 0, 1. Peak 1, trough 0, fall 1.
  approx(s.maxDrawdownR, 1);
  approx(s.exposure ?? Number.NaN, 4 / 12);
  assert.equal(summarizeReplays([fake('x', 1, 1)], 12).profitFactor, null, 'no losses means no profit factor, not infinity');
});

test('paired difference: B minus A on setups both policies resolve, clustered by day', () => {
  const bars = flowSeries('5m', CONTINUATION);
  const a = replayPolicy(bars, [setup], SINGLE, OPTS);
  const b = replayPolicy(bars, [setup], LADDER, OPTS);
  const d = pairedDifference(a, b, { iterations: 200, seed: 1, confidence: 0.9 });
  assert.equal(d.n, 1);
  approx(d.meanDiffR ?? Number.NaN, 1.0525 - 0.44);
});
