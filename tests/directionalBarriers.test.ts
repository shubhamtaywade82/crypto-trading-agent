import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelBarriers, roundTripCostPct, type BarrierSetup, type CostModel } from '../src/market/directional/barriers.js';
import { flowSeries, randomWalk, SYMBOL, type Px } from './rejectionFixtures.js';

const COSTS: CostModel = { feeBpsPerSide: 4, slippageBpsPerSide: 2, fundingBpsPerHour: 0 };
const SPEC = { targetsPct: [1], horizonsHours: [1] };
const at100: Px = { o: 100, h: 100, l: 100, c: 100 };
const flat: Px = { o: 100, h: 100.5, l: 99.5, c: 100 };
const longSetup = (entryIndex: number, stopPrice: number): BarrierSetup => ({
  id: `L${entryIndex}`, symbol: SYMBOL, side: 'LONG', entryIndex, stopPrice, tags: ['REJECTION_CONFIRMED'],
});
const approx = (a: number | null, b: number, eps = 1e-9): void => {
  assert.ok(a !== null, `expected ${b}, got null`);
  assert.ok(Math.abs(a - b) < eps, `got ${a}, want ${b}`);
};

test('round-trip cost: fees and slippage on both legs, funding signed by side', () => {
  approx(roundTripCostPct(COSTS, 'LONG', 2), 0.12);
  approx(roundTripCostPct({ ...COSTS, fundingBpsPerHour: 0.5 }, 'LONG', 2), 0.13);
  approx(roundTripCostPct({ ...COSTS, fundingBpsPerHour: 0.5 }, 'SHORT', 2), 0.11, 1e-12);
});

test('a target touched on the first bar after entry is TARGET; net return is target minus the holding cost', () => {
  const bars = flowSeries('5m', [at100, { o: 100, h: 101.2, l: 99.5, c: 101 }]);
  const [label] = labelBarriers(bars, [longSetup(0, 98)], SPEC, COSTS);
  assert.ok(label);
  assert.equal(label.outcome, 'TARGET');
  assert.equal(label.barsToOutcome, 1);
  approx(label.grossReturnPct, 1);
  // Held one 5m bar = 1/12 h, so funding is zero and the round trip costs 0.12%.
  approx(label.netReturnPct, 0.88);
  approx(label.mfePct, 1.2);
  approx(label.maePct, 0.5);
  assert.equal(label.entryTime, bars[0]!.openTime + 300_000);
});

test('a bar that touches both stop and target is STOP: the stop is tested first', () => {
  const bars = flowSeries('5m', [at100, { o: 100, h: 101.5, l: 97.5, c: 100 }]);
  const [label] = labelBarriers(bars, [longSetup(0, 98)], SPEC, COSTS);
  assert.equal(label?.outcome, 'STOP');
  approx(label?.grossReturnPct ?? null, -2);
});

test('a stop gap that opens beyond the stop fills at the open, which is worse', () => {
  const bars = flowSeries('5m', [at100, { o: 96, h: 96.5, l: 95, c: 96 }]);
  const [label] = labelBarriers(bars, [longSetup(0, 98)], SPEC, COSTS);
  assert.equal(label?.outcome, 'STOP');
  approx(label?.grossReturnPct ?? null, -4);
});

test('no barrier within the horizon is TIMEOUT, exited at the horizon close, and a timeout is a miss', () => {
  const bars = flowSeries('5m', [at100, ...Array.from({ length: 12 }, () => flat)]);
  const [label] = labelBarriers(bars, [longSetup(0, 98)], SPEC, COSTS);
  assert.equal(label?.outcome, 'TIMEOUT');
  assert.equal(label?.barsToOutcome, 12);
  approx(label?.grossReturnPct ?? null, 0);
  approx(label?.netReturnPct ?? null, -0.12, 1e-9);
});

test('a missing bar before resolution makes the label UNRESOLVED, never a loss', () => {
  const bars = flowSeries('5m', [at100, flat, flat, flat]);
  bars[2] = { ...bars[2]!, complete: false };
  const [label] = labelBarriers(bars, [longSetup(0, 98)], SPEC, COSTS);
  assert.equal(label?.outcome, 'UNRESOLVED');
  assert.equal(label?.unresolvedReason, 'GAP_BEFORE_RESOLUTION');
  assert.equal(label?.netReturnPct, null);
});

test('a series that ends before the horizon is UNRESOLVED with DATA_ENDED', () => {
  const bars = flowSeries('5m', [at100, flat]);
  const [label] = labelBarriers(bars, [longSetup(0, 98)], SPEC, COSTS);
  assert.equal(label?.outcome, 'UNRESOLVED');
  assert.equal(label?.unresolvedReason, 'DATA_ENDED');
});

test('the SHORT side mirrors every rule', () => {
  const bars = flowSeries('5m', [at100, { o: 100, h: 100.5, l: 98.8, c: 99 }]);
  const [label] = labelBarriers(bars, [{ id: 'S', symbol: SYMBOL, side: 'SHORT', entryIndex: 0, stopPrice: 102, tags: [] }], SPEC, COSTS);
  assert.equal(label?.outcome, 'TARGET');
  approx(label?.grossReturnPct ?? null, 1);
});

test('causality: changing bars at or before the entry never changes its labels', () => {
  const bars = randomWalk('5m', 80, 5);
  const setup = longSetup(30, bars[30]!.close * 0.98);
  const spec = { targetsPct: [1, 2], horizonsHours: [1, 2] };
  // Rewrite every bar before the entry, including the entry bar's extremes. Its close is the fill, and stays fixed.
  const altered = bars.map((b, i) => (i < 30 ? { ...b, high: b.high * 2, low: b.low * 0.5, close: b.close * 3 } : b));
  assert.deepEqual(labelBarriers(bars, [setup], spec, COSTS), labelBarriers(altered, [setup], spec, COSTS));
});

test('prefix stability: every label resolved inside a truncated series matches the full replay', () => {
  const bars = randomWalk('5m', 300, 21);
  const spec = { targetsPct: [1, 2, 3], horizonsHours: [1, 4] };
  const setups: BarrierSetup[] = [];
  for (let e = 0; e < 200; e += 10) setups.push(longSetup(e, bars[e]!.close * 0.985));

  const full = labelBarriers(bars, setups, spec, COSTS);
  const key = (l: { setupId: string; targetPct: number; horizonHours: number }) => `${l.setupId}|${l.targetPct}|${l.horizonHours}`;
  const fullByKey = new Map(full.map((l) => [key(l), l]));
  let compared = 0;
  for (const k of [120, 180, 250]) {
    const head = bars.slice(0, k);
    const prefixSetups = setups.filter((s) => s.entryIndex < k);
    for (const l of labelBarriers(head, prefixSetups, spec, COSTS)) {
      if (l.outcome === 'UNRESOLVED') continue;
      assert.deepEqual(l, fullByKey.get(key(l)), `label ${key(l)} changed when more data arrived`);
      compared += 1;
    }
  }
  assert.ok(compared > 50, `property needs resolved labels, got ${compared}`);
});

test('invalid setups and horizons throw instead of labelling silently', () => {
  const bars = flowSeries('5m', [at100, flat, flat]);
  assert.throws(() => labelBarriers(bars, [longSetup(0, 101)], SPEC, COSTS), /not beyond entry/);
  assert.throws(() => labelBarriers(bars, [longSetup(0, 98)], { targetsPct: [1], horizonsHours: [0.07] }, COSTS), /whole number of 5m bars/);
  assert.throws(() => labelBarriers(bars, [longSetup(0, 98)], SPEC, { ...COSTS, feeBpsPerSide: -1 }), /feeBpsPerSide/);
});
