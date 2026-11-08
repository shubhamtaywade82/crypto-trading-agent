import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertFundingCoverage, feeSlippageRoundTripPct, fundingCostPct, fundingSettlementsFromRows, labelBarriers,
  type BarrierSetup, type CostModel, type FundingSettlement,
} from '../src/market/directional/barriers.js';
import { flowSeries, randomWalk, SYMBOL, type Px } from './rejectionFixtures.js';

const COSTS: CostModel = { feeBpsPerSide: 4, slippageBpsPerSide: 2, funding: { kind: 'CONSTANT_FALLBACK', fundingBpsPerHour: 0 } };
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

test('round-trip fee and slippage are charged on both legs; funding is priced separately', () => {
  approx(feeSlippageRoundTripPct(COSTS), 0.12);
});

test('a settlement charges rate × mark / entry for a LONG and credits it to a SHORT', () => {
  const s: FundingSettlement[] = [{ time: 1_000, rate: 0.0001, markPrice: 100 }];
  approx(fundingCostPct('LONG', 0, 2_000, 100, { kind: 'SETTLEMENTS', settlements: s }), 0.01);
  approx(fundingCostPct('SHORT', 0, 2_000, 100, { kind: 'SETTLEMENTS', settlements: s }), -0.01);
  // Mark above entry scales the notional: 0.0001 × 110 / 100 = 0.011%.
  approx(fundingCostPct('LONG', 0, 2_000, 100, { kind: 'SETTLEMENTS', settlements: [{ ...s[0]!, markPrice: 110 }] }), 0.011);
});

test('only settlements a position is open through are charged: entry < time <= exit', () => {
  const s: FundingSettlement[] = [
    { time: 100, rate: 0.0001, markPrice: 100 }, // at or before entry: not charged
    { time: 500, rate: 0.0001, markPrice: 100 }, // inside
    { time: 900, rate: 0.0001, markPrice: 100 }, // exactly at exit: charged
    { time: 1_100, rate: 0.0001, markPrice: 100 }, // after exit: not charged
  ];
  approx(fundingCostPct('LONG', 100, 900, 100, { kind: 'SETTLEMENTS', settlements: s }), 0.02);
});

test('the settlement model changes the net return of a labelled trade, and the label names its funding model', () => {
  const bars = flowSeries('5m', [at100, { o: 100, h: 101.2, l: 99.5, c: 101 }]);
  const entryTime = bars[0]!.openTime + 300_000;
  const withFunding: CostModel = {
    ...COSTS,
    funding: { kind: 'SETTLEMENTS', settlements: [{ time: entryTime + 300_000, rate: 0.0001, markPrice: 100 }] },
  };
  const [label] = labelBarriers(bars, [longSetup(0, 98)], SPEC, withFunding);
  assert.equal(label?.outcome, 'TARGET');
  approx(label?.fundingPct ?? null, 0.01);
  approx(label?.netReturnPct ?? null, 0.87);
  assert.equal(label?.fundingModel, 'SETTLEMENTS');
  const [fallback] = labelBarriers(bars, [longSetup(0, 98)], SPEC, COSTS);
  assert.equal(fallback?.fundingModel, 'CONSTANT_FALLBACK');
});

test('funding coverage fails closed: a gap longer than one interval, or a missing edge, is refused', () => {
  const h = 3_600_000;
  const gapped: FundingSettlement[] = [{ time: 0, rate: 0, markPrice: 1 }, { time: 20 * h, rate: 0, markPrice: 1 }];
  assert.throws(() => assertFundingCoverage(gapped, 0, 20 * h), /FUNDING_COVERAGE: .* gap/);
  const shortEnd: FundingSettlement[] = [{ time: 0, rate: 0, markPrice: 1 }];
  assert.throws(() => assertFundingCoverage(shortEnd, 0, 20 * h), /FUNDING_COVERAGE: no settlement near the end/);
  const covered: FundingSettlement[] = [0, 8, 16, 24].map((hh) => ({ time: hh * h, rate: 0, markPrice: 1 }));
  assert.doesNotThrow(() => assertFundingCoverage(covered, 0, 24 * h));
});

test('settlements must be strictly ascending and plausible', () => {
  assert.throws(() => labelBarriers(flowSeries('5m', [at100, flat]), [longSetup(0, 98)], SPEC, {
    ...COSTS, funding: { kind: 'SETTLEMENTS', settlements: [{ time: 2, rate: 0, markPrice: 1 }, { time: 1, rate: 0, markPrice: 1 }] },
  }), /strictly ascending/);
  assert.throws(() => labelBarriers(flowSeries('5m', [at100, flat]), [longSetup(0, 98)], SPEC, {
    ...COSTS, funding: { kind: 'SETTLEMENTS', settlements: [{ time: 1, rate: 0.5, markPrice: 1 }] },
  }), /plausible fraction/);
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

test('funding rows from perp_funding_history convert to ordered settlements; conflicting duplicates are refused', () => {
  const rows = [
    { funding_time: '1700000800000', funding_rate: '0.0001', mark_price: '100.5' },
    { funding_time: 1700000000000, funding_rate: 0.00005, mark_price: 100 },
    { funding_time: 1700000800000, funding_rate: '0.0001', mark_price: '100.5' },
  ];
  const s = fundingSettlementsFromRows(rows);
  assert.deepEqual(s.map((x) => x.time), [1700000000000, 1700000800000]);
  assert.equal(s[1]?.markPrice, 100.5);
  assert.throws(() => fundingSettlementsFromRows([
    { funding_time: 1, funding_rate: 0.0001, mark_price: 100 },
    { funding_time: 1, funding_rate: 0.0002, mark_price: 100 },
  ]), /conflicting funding rows/);
});
