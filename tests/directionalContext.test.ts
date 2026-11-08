import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALLOWED_TRANSITIONS, DEFAULT_CONTEXT_OPTIONS, ENTRY_CONTEXTS, EXPANSION_CONTEXTS, classifyExpansionContext, type ContextOptions,
} from '../src/market/directional/context.js';
import { confirmedPivots } from '../src/market/directional/structure.js';
import { detectRejections } from '../src/market/rejection/detector.js';
import { setupsFromRejections } from '../src/market/directional/setups.js';
import { barKnownAt, type RejectionEvent } from '../src/market/rejection/types.js';
import {
  FLAT, FOLLOW, SMALL_CONFIG, SWEEP_DEMAND, flowSeries, makeEvent, randomWalk, type Px,
} from './rejectionFixtures.js';

const LONG: ContextOptions = { ...DEFAULT_CONTEXT_OPTIONS, side: 'LONG' };
const flat6 = Array.from({ length: 6 }, () => FLAT);
const bar = (o: number, h: number, l: number, c: number): Px => ({ o, h, l, c });

test('the transition table is closed over the states, and every state can decay to NONE', () => {
  for (const state of EXPANSION_CONTEXTS) {
    for (const to of ALLOWED_TRANSITIONS[state]) assert.ok(EXPANSION_CONTEXTS.includes(to), `${state} → ${to}`);
    if (state !== 'NONE') assert.ok(ALLOWED_TRANSITIONS[state].includes('NONE'), `${state} must be able to decay`);
  }
  assert.ok(ENTRY_CONTEXTS.every((c) => EXPANSION_CONTEXTS.includes(c)));
  assert.equal(ENTRY_CONTEXTS.includes('EXPANSION_EXHAUSTION'), false);
  assert.equal(ENTRY_CONTEXTS.includes('LIQUIDITY_SWEEP'), false);
});

test('a confirmed pivot is known only at index + k, never earlier', () => {
  const high = [1, 2, 3, 5, 3, 2, 1, 0.5, 0.2];
  const low = high.map((x) => x - 0.5);
  const valid = high.map(() => true);
  const pivots = confirmedPivots(high, low, valid, 2);
  const peak = pivots.highs.find((p) => p.index === 3);
  assert.deepEqual(peak, { index: 3, confirmedAt: 5, price: 5 });
  // The prefix that ends before the confirmation bar cannot see the peak.
  const early = confirmedPivots(high.slice(0, 5), low.slice(0, 5), valid.slice(0, 5), 2);
  assert.equal(early.highs.some((p) => p.index === 3), false);
});

test('a pivot whose window contains an invalid bar is not produced', () => {
  const high = [1, 2, 3, 5, 3, 2, 1];
  const valid = [true, true, true, true, false, true, true];
  assert.equal(confirmedPivots(high, high, valid, 2).highs.some((p) => p.index === 3), false);
});

test('an absorbed sweep moves NONE → ABSORPTION_CANDIDATE → REJECTION_CONFIRMED, one bar at a time', () => {
  const bars = flowSeries('5m', [...flat6, SWEEP_DEMAND, FOLLOW]);
  const events = detectRejections(bars, SMALL_CONFIG);
  assert.equal(events.length, 1);
  const series = classifyExpansionContext(bars, events, LONG);
  assert.deepEqual(series.states.slice(5, 8), ['NONE', 'ABSORPTION_CANDIDATE', 'REJECTION_CONFIRMED']);
  assert.deepEqual(series.transitions.map((t) => [t.from, t.to]), [
    ['NONE', 'ABSORPTION_CANDIDATE'],
    ['ABSORPTION_CANDIDATE', 'REJECTION_CONFIRMED'],
  ]);
  assert.equal(series.transitions[1]!.at, barKnownAt(bars[7]!));
});

test('a sweep without absorbed sell flow goes NONE → LIQUIDITY_SWEEP → REJECTION_CONFIRMED', () => {
  const bars = flowSeries('5m', [...flat6, { ...SWEEP_DEMAND, takerBuy: 50 }, FOLLOW]);
  const events = detectRejections(bars, SMALL_CONFIG);
  assert.equal(events[0]?.kind, 'REJECTION');
  const series = classifyExpansionContext(bars, events, LONG);
  assert.deepEqual(series.states.slice(5, 8), ['NONE', 'LIQUIDITY_SWEEP', 'REJECTION_CONFIRMED']);
});

test('a sweep that loses the reclaim fails back to NONE, with the reason recorded', () => {
  const bars = flowSeries('5m', [...flat6, SWEEP_DEMAND, { ...FOLLOW, c: 98 }]);
  const events = detectRejections(bars, SMALL_CONFIG);
  assert.equal(events[0]?.status, 'FAILED');
  const series = classifyExpansionContext(bars, events, LONG);
  assert.equal(series.states[7], 'NONE');
  assert.equal(series.transitions.at(-1)?.reason, 'SWEEP_FAILED_WITHOUT_RECLAIM');
});

test('a state with no follow-up decays to NONE after maxStateBars, reason STALE', () => {
  // A sweep still CANDIDATE (its window never completes) holds LIQUIDITY_SWEEP until the state goes stale.
  const bars = flowSeries('5m', [...flat6, { ...SWEEP_DEMAND, takerBuy: 50 }, ...Array.from({ length: 5 }, () => FLAT)]);
  const pending: RejectionEvent = {
    ...makeEvent({ id: 'p', direction: 'DEMAND', zoneLow: 97, zoneHigh: 99, resolvedAt: null, atr: 2, status: 'CANDIDATE' }),
    sweepOpenTime: bars[6]!.openTime,
    kind: 'REJECTION',
  };
  const series = classifyExpansionContext(bars, [pending], { ...LONG, maxStateBars: 3 });
  assert.equal(series.states[6], 'LIQUIDITY_SWEEP');
  assert.equal(series.transitions.at(-1)?.reason, 'STALE');
  assert.equal(series.transitions.at(-1)?.to, 'NONE');
  assert.equal(series.states[10], 'NONE');
});

test('a lower high broken on a close, after a rejection, is a STRUCTURE_SHIFT', () => {
  const bars = flowSeries('5m', [
    ...flat6,
    SWEEP_DEMAND,
    FOLLOW,
    bar(101.8, 103, 101.5, 102.8),
    bar(102.8, 105, 102.5, 104.5), // swing high 105 (index 9)
    bar(104.5, 104, 102.6, 103.2),
    bar(103.2, 103.5, 102.2, 102.6),
    bar(102.6, 103.2, 102, 102.4),
    bar(102.4, 103.8, 102.1, 103.6), // lower swing high 103.8 (index 13)
    bar(103.6, 103.7, 102.9, 103),
    bar(103, 103.4, 102.5, 103.1),
    bar(103.1, 104.5, 103, 104.2), // closes through 103.8 (index 16)
  ]);
  const events = detectRejections(bars, SMALL_CONFIG);
  const series = classifyExpansionContext(bars, events, LONG);
  assert.equal(series.states[15], 'REJECTION_CONFIRMED', 'no break before the lower high is confirmed at index 15');
  assert.equal(series.states[16], 'STRUCTURE_SHIFT');
  assert.equal(series.transitions.at(-1)?.reason, 'LOWER_HIGH_BROKEN');
});

test('the SHORT side reads the same sequence from the mirrored, adverse extremes', () => {
  // Rejected SUPPLY: a high is swept above the 101 reference, closed back under it, then the price falls.
  const mirror = (p: Px): Px => ({ o: 200 - p.o, h: 200 - p.l, l: 200 - p.h, c: 200 - p.c, quote: p.quote, takerBuy: p.takerBuy === undefined ? undefined : 100 - p.takerBuy });
  const bars = flowSeries('5m', [...flat6.map(mirror), mirror(SWEEP_DEMAND), mirror(FOLLOW)]);
  const events = detectRejections(bars, SMALL_CONFIG);
  assert.equal(events[0]?.direction, 'SUPPLY');
  const series = classifyExpansionContext(bars, events, { ...LONG, side: 'SHORT' });
  assert.deepEqual(series.states.slice(5, 8), ['NONE', 'ABSORPTION_CANDIDATE', 'REJECTION_CONFIRMED']);
});

test('an incomplete bar resets the machine to NONE and records INVALID_BAR', () => {
  const bars = flowSeries('5m', [...flat6, SWEEP_DEMAND, FOLLOW]);
  const events = detectRejections(bars, SMALL_CONFIG);
  bars[7] = { ...bars[7]!, complete: false };
  const series = classifyExpansionContext(bars, events, LONG);
  assert.equal(series.states[7], 'NONE');
  assert.equal(series.transitions.at(-1)?.reason, 'INVALID_BAR');
});

test('causality: the context states up to a cut-off are identical in a truncated run', () => {
  const dense = { ...SMALL_CONFIG, lookbackBars: 3, minRelativeVolume: 1.0, minWickRatio: 0.3 };
  const opts: ContextOptions = { ...LONG, percentileWindow: 40, minRelativeVolume: 1.0, expansionAtr: 1.0 };
  const bars = randomWalk('5m', 300, 17);
  const full = classifyExpansionContext(bars, detectRejections(bars, dense), opts);
  assert.ok(full.transitions.length >= 4, `property needs transitions, got ${full.transitions.length}`);

  for (const k of [60, 140, 220]) {
    const head = bars.slice(0, k);
    const prefix = classifyExpansionContext(head, detectRejections(head, dense), opts);
    assert.deepEqual(prefix.states, full.states.slice(0, k), `states diverged in a prefix of ${k}`);
    const cutoff = barKnownAt(bars[k - 1]!);
    assert.deepEqual(prefix.transitions, full.transitions.filter((t) => t.at <= cutoff));
  }
});

test('a confirmed rejection becomes a setup entered at the confirming close, stopped beyond the sweep extreme, tagged with its context', () => {
  const bars = flowSeries('5m', [...flat6, SWEEP_DEMAND, FOLLOW]);
  const events = detectRejections(bars, SMALL_CONFIG);
  const series = classifyExpansionContext(bars, events, LONG);
  const built = setupsFromRejections(bars, events, series, { side: 'LONG', stopBufferAtr: 0.1 });
  assert.equal(built.setups.length, 1);
  const s = built.setups[0]!;
  assert.equal(s.entryIndex, 7, 'entry is the confirming bar, whose close is when the rejection became known');
  // Sweep low 97 less 0.1 × ATR 2.6.
  assert.ok(Math.abs(s.stopPrice - (97 - 0.26)) < 1e-9);
  assert.deepEqual(s.tags, ['REJECTION_CONFIRMED']);
  assert.equal(built.skippedNotBeyondEntry, 0);
  assert.throws(() => setupsFromRejections(bars, events, series, { side: 'SHORT', stopBufferAtr: 0.1 }), /context is for LONG/);
});
