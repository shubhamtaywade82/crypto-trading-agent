import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectRejections, DEFAULT_REJECTION_CONFIG } from '../src/market/rejection/detector.js';
import { barKnownAt, type FlowBar, type RejectionConfig } from '../src/market/rejection/types.js';
import {
  FLAT, FOLLOW, SMALL_CONFIG, SWEEP_DEMAND, flowSeries, mirror, randomWalk, type Px,
} from './rejectionFixtures.js';

const FLAT6: Px[] = Array.from({ length: 6 }, () => FLAT);
const F_FLAT: Px = { o: 100.5, h: 101, l: 100, c: 100.5 };
/** Takes out the 99 low and reclaims, but opens at the low, so the lower wick is 0.13 of the range (below 0.45). */
const SWEEP_SMALL_WICK: Px = { o: 97.5, h: 100.8, l: 97, c: 100.5, quote: 30_000, takerBuy: 30 };
/** One bar after the first sweep, it takes out the 97 low of that sweep and reclaims. Its wick is 0.52. The cooldown must suppress it. */
const SWEEP_SECOND: Px = { o: 98.5, h: 100.8, l: 96, c: 100.5, quote: 30_000, takerBuy: 30 };

test('a sweep, reclaim, wick, volume and follow-through produce one CONFIRMED demand rejection', () => {
  const bars = flowSeries('5m', [...FLAT6, SWEEP_DEMAND, FOLLOW]);
  const events = detectRejections(bars, SMALL_CONFIG);
  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.direction, 'DEMAND');
  assert.equal(ev.status, 'CONFIRMED');
  assert.equal(ev.kind, 'ABSORPTION_LIKE', 'sell-led flow that price reclaimed is absorption-like');
  assert.equal(ev.referenceLevel, 99);
  assert.equal(ev.extreme, 97);
  assert.equal(ev.zoneLow, 97);
  assert.equal(ev.zoneHigh, 99);
  assert.equal(ev.reclaimClose, 100.5);
  assert.ok(Math.abs(ev.atr - 2.6) < 1e-9, `ATR at the sweep bar should be (2*2 + 3.8)/3 = 2.6, got ${ev.atr}`);
  assert.ok(Math.abs((ev.reversalAtr ?? 0) - 1.5 / 2.6) < 1e-9);
  assert.equal(ev.reversalBars, 1);
  assert.equal(ev.resolvedAt, barKnownAt(bars[7]!), 'known-at is the confirming bar close, never its open');
  assert.equal(ev.failReason, null);
  assert.ok(ev.evidence.some((e) => e.startsWith('CONFIRMED')));
});

test('a later close through the reference level fails the candidate with RECLAIM_LOST', () => {
  const bars = flowSeries('5m', [...FLAT6, SWEEP_DEMAND, { ...FOLLOW, c: 98 }]);
  const [ev] = detectRejections(bars, SMALL_CONFIG);
  assert.equal(ev?.status, 'FAILED');
  assert.equal(ev?.failReason, 'RECLAIM_LOST');
  assert.equal(ev?.resolvedAt, barKnownAt(bars[7]!));
});

test('no displacement within confirmBars fails with NO_FOLLOW_THROUGH, stamped at the last window bar', () => {
  const bars = flowSeries('5m', [...FLAT6, SWEEP_DEMAND, F_FLAT, F_FLAT, F_FLAT]);
  const [ev] = detectRejections(bars, SMALL_CONFIG);
  assert.equal(ev?.status, 'FAILED');
  assert.equal(ev?.failReason, 'NO_FOLLOW_THROUGH');
  assert.equal(ev?.reversalBars, 3);
  assert.equal(ev?.resolvedAt, barKnownAt(bars[9]!));
  assert.ok(Math.abs((ev?.reversalAtr ?? 0) - 0.5 / 2.6) < 1e-9, 'the window maximum is recorded for a failed candidate');
});

test('a missing or incomplete bar inside the confirmation window fails with INCOMPLETE_WINDOW', () => {
  const bars = flowSeries('5m', [...FLAT6, SWEEP_DEMAND, F_FLAT, F_FLAT, F_FLAT]);
  bars[8] = { ...bars[8]!, complete: false };
  const [ev] = detectRejections(bars, SMALL_CONFIG);
  assert.equal(ev?.status, 'FAILED');
  assert.equal(ev?.failReason, 'INCOMPLETE_WINDOW');
  assert.equal(ev?.resolvedAt, barKnownAt(bars[8]!));
});

test('when the data ends before the window does, the event stays CANDIDATE and nothing is assumed', () => {
  const bars = flowSeries('5m', [...FLAT6, SWEEP_DEMAND]);
  const events = detectRejections(bars, SMALL_CONFIG);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.status, 'CANDIDATE');
  assert.equal(events[0]!.resolvedAt, null);
});

test('a same-direction candidate inside the cooldown is suppressed, so one multi-bar rejection yields one event', () => {
  const bars = flowSeries('5m', [...FLAT6, SWEEP_DEMAND, SWEEP_SECOND, F_FLAT, F_FLAT]);
  const events = detectRejections(bars, SMALL_CONFIG);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.sweepOpenTime, bars[6]!.openTime);
});

test('a sweep whose lower wick is below minWickRatio is not a rejection', () => {
  const bars = flowSeries('5m', [...FLAT6, SWEEP_SMALL_WICK, FOLLOW]);
  assert.deepEqual(detectRejections(bars, SMALL_CONFIG), []);
});

test('a sweep below minRelativeVolume is not a rejection, even with a perfect wick and reclaim', () => {
  const bars = flowSeries('5m', [...FLAT6, { ...SWEEP_DEMAND, quote: 10_000 }, FOLLOW]);
  assert.deepEqual(detectRejections(bars, SMALL_CONFIG), []);
});

test('a gap inside the reference window blocks the sweep, because the reference level is not known', () => {
  const bars = flowSeries('5m', [...FLAT6, SWEEP_DEMAND, FOLLOW]);
  bars[3] = { ...bars[3]!, complete: false };
  assert.deepEqual(detectRejections(bars, SMALL_CONFIG), []);
});

test('the mirror image of a rejection is a SUPPLY rejection with identical numeric evidence', () => {
  const demand = detectRejections(flowSeries('5m', [...FLAT6, SWEEP_DEMAND, FOLLOW]), SMALL_CONFIG)[0]!;
  const supply = detectRejections(
    flowSeries('5m', [...FLAT6.map(mirror), mirror(SWEEP_DEMAND), mirror(FOLLOW)]),
    SMALL_CONFIG,
  );
  assert.equal(supply.length, 1);
  const ev = supply[0]!;
  assert.equal(ev.direction, 'SUPPLY');
  assert.equal(ev.status, 'CONFIRMED');
  assert.equal(ev.kind, 'ABSORPTION_LIKE', 'buy-led flow that price rejected at a high is absorption-like');
  assert.equal(ev.referenceLevel, 101);
  assert.equal(ev.extreme, 103);
  assert.equal(ev.zoneLow, 101);
  assert.equal(ev.zoneHigh, 103);
  assert.ok(Math.abs(ev.atr - demand.atr) < 1e-9);
  assert.ok(Math.abs((ev.reversalAtr ?? 0) - (demand.reversalAtr ?? -1)) < 1e-9);
  assert.equal(ev.resolvedAt, demand.resolvedAt);
});

test('a default config is the design note starting point, not a tuned value', () => {
  assert.deepEqual(DEFAULT_REJECTION_CONFIG, {
    atrPeriod: 14,
    volumeWindow: 20,
    minVolumeHistory: 10,
    lookbackBars: 20,
    minRelativeVolume: 1.5,
    minWickRatio: 0.45,
    confirmBars: 3,
    minReversalAtr: 0.5,
  });
});

/**
 * Causality property: whatever a run has resolved by bar k must be identical when the same data is replayed in full.
 * Outcomes that depended on later bars are not allowed to leak backwards.
 */
test('resolved events are prefix-stable: truncating the data never changes an outcome that was already known', () => {
  const dense: RejectionConfig = { ...SMALL_CONFIG, lookbackBars: 3, minRelativeVolume: 1.0, minWickRatio: 0.3 };
  const bars: FlowBar[] = randomWalk('5m', 400, 11);
  const full = detectRejections(bars, dense);
  const resolvedBy = (events: ReturnType<typeof detectRejections>, cutoff: number) =>
    events.filter((e) => e.status !== 'CANDIDATE' && e.resolvedAt !== null && e.resolvedAt <= cutoff);

  const fullResolved = resolvedBy(full, Number.POSITIVE_INFINITY);
  assert.ok(fullResolved.length >= 5, `property needs real events, got ${fullResolved.length}`);

  for (const k of [40, 90, 140, 200, 275, 350, 400]) {
    const cutoff = barKnownAt(bars[k - 1]!);
    const prefix = resolvedBy(detectRejections(bars.slice(0, k), dense), cutoff);
    assert.deepEqual(prefix, resolvedBy(full, cutoff), `prefix ${k} diverged from the full replay`);
  }
});

test('invalid configs fail fast instead of silently changing the rules', () => {
  const bars = flowSeries('5m', [...FLAT6, SWEEP_DEMAND, FOLLOW]);
  assert.throws(() => detectRejections(bars, { ...SMALL_CONFIG, volumeWindow: 0 }), /volumeWindow must be an integer >= 1/);
  assert.throws(() => detectRejections(bars, { ...SMALL_CONFIG, confirmBars: 0 }), /confirmBars must be an integer >= 1/);
  assert.throws(() => detectRejections(bars, { ...SMALL_CONFIG, minVolumeHistory: 9 }), /cannot exceed volumeWindow/);
  assert.throws(() => detectRejections(bars, { ...SMALL_CONFIG, minWickRatio: 1.5 }), /minWickRatio must be in/);
  assert.throws(() => detectRejections(bars, { ...SMALL_CONFIG, minReversalAtr: Number.NaN }), /minReversalAtr must be a positive/);
});

test('the same input always yields the same events (determinism)', () => {
  const bars = randomWalk('15m', 250, 99);
  const a = detectRejections(bars, SMALL_CONFIG);
  const b = detectRejections(bars.map((x) => ({ ...x })), SMALL_CONFIG);
  assert.deepEqual(a, b);
});
