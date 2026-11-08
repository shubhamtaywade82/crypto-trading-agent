import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeFeatures, type FeatureOptions } from '../src/market/rejection/features.js';
import { type FlowBar } from '../src/market/rejection/types.js';
import { FLAT, SWEEP_DEMAND, flowSeries, randomWalk, type Px } from './rejectionFixtures.js';

const OPTS: FeatureOptions = { atrPeriod: 3, volumeWindow: 5, minVolumeHistory: 3 };
const approx = (a: number | null, b: number, eps = 1e-9): void => {
  assert.ok(a !== null, `expected a number, got null (wanted ${b})`);
  assert.ok(Math.abs(a - b) < eps, `got ${a}, wanted ${b}`);
};

test('wick ratios, close location and range follow the design formulas', () => {
  const f = computeFeatures(flowSeries('5m', [SWEEP_DEMAND]), OPTS)[0]!;
  // H 100.8, L 97, O 99.5, C 100.5 -> R 3.8
  approx(f.range, 3.8);
  approx(f.lowerWickRatio, (99.5 - 97) / 3.8);
  approx(f.upperWickRatio, (100.8 - 100.5) / 3.8);
  approx(f.closeLocation, (100.5 - 97) / 3.8);
});

test('volume delta is buy minus sell, and the ratio is normalised by traded volume', () => {
  const f = computeFeatures(flowSeries('5m', [SWEEP_DEMAND]), OPTS)[0]!;
  assert.equal(f.buyVolume, 30);
  assert.equal(f.sellVolume, 70);
  assert.equal(f.volumeDelta, -40);
  approx(f.deltaRatio, -0.4);
});

test('a bar that traded nothing has delta ratio 0, and a zero-range bar has no wick or close-location features', () => {
  const bars = flowSeries('5m', [{ o: 100, h: 100, l: 100, c: 100, base: 0, quote: 0, takerBuy: 0 }]);
  const f = computeFeatures(bars, OPTS)[0]!;
  assert.equal(f.deltaRatio, 0);
  assert.equal(f.lowerWickRatio, null);
  assert.equal(f.upperWickRatio, null);
  assert.equal(f.closeLocation, null);
});

test('relative volume is null below minVolumeHistory prior bars, and compares against PRIOR bars only', () => {
  const pxs: Px[] = Array.from({ length: 10 }, () => FLAT);
  pxs.push({ ...FLAT, quote: 1_000_000 });
  const feats = computeFeatures(flowSeries('5m', pxs), OPTS);
  assert.equal(feats[2]!.relativeVolume, null, 'two prior bars is below minVolumeHistory = 3');
  approx(feats[3]!.relativeVolume, 1, 1e-12);
  // Baseline is the last 5 prior bars (all 10 000). The spike must be measured against 10 000, not against itself.
  approx(feats[10]!.relativeVolume, 100);
});

test('features at index i do not change when later bars change (causality)', () => {
  const base = randomWalk('5m', 60, 7);
  const altered = base.map((b, i): FlowBar => (i < 40 ? b : { ...b, high: b.high * 1.5, quoteVolume: b.quoteVolume * 9, close: b.close * 0.7 }));
  const a = computeFeatures(base, OPTS);
  const b = computeFeatures(altered, OPTS);
  assert.deepEqual(a.slice(0, 40), b.slice(0, 40));
  assert.notDeepEqual(a.slice(40), b.slice(40), 'the alteration must actually change later features, or the test is vacuous');
});

test('Wilder ATR seeds with the simple mean of the first atrPeriod true ranges', () => {
  // Three flat bars with range 2 and no gaps: TR = 2 each, so ATR = 2 once seeded.
  const feats = computeFeatures(flowSeries('5m', [FLAT, FLAT, FLAT, FLAT]), OPTS);
  assert.equal(feats[0]!.atr, null);
  assert.equal(feats[1]!.atr, null);
  approx(feats[2]!.atr, 2);
  approx(feats[3]!.atr, 2);
});

test('true range includes the gap to the prior close', () => {
  // Bar 3 gaps up: prior close 100, low 103, high 104 -> TR = max(1, 4, 3) = 4, not H-L = 1.
  const pxs: Px[] = [FLAT, FLAT, FLAT, { o: 103.5, h: 104, l: 103, c: 103.5 }];
  const feats = computeFeatures(flowSeries('5m', pxs), OPTS);
  // ATR_3 = (2 * 2 + 4) / 3 = 8 / 3
  approx(feats[3]!.atr, 8 / 3);
});

test('an incomplete bar resets ATR: the next valid ATR waits a full atrPeriod again', () => {
  const bars = flowSeries('5m', Array.from({ length: 9 }, () => FLAT));
  bars[4] = { ...bars[4]!, complete: false };
  const feats = computeFeatures(bars, OPTS);
  assert.equal(feats[4], null, 'incomplete bars carry no features');
  assert.equal(feats[5]!.atr, null, 'first bar after the gap restarts seeding');
  assert.equal(feats[6]!.atr, null);
  approx(feats[7]!.atr, 2, 1e-9);
});

test('a non-contiguous bar (missing interval) also restarts ATR rather than bridging the hole', () => {
  const bars = flowSeries('5m', Array.from({ length: 8 }, () => FLAT));
  const shifted = bars.map((b, i): FlowBar => (i < 5 ? b : { ...b, openTime: b.openTime + 300_000 }));
  const feats = computeFeatures(shifted, OPTS);
  assert.equal(feats[5]!.atr, null);
  assert.equal(feats[6]!.atr, null);
  approx(feats[7]!.atr, 2);
});
