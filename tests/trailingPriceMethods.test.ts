import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle, Position } from '../src/types.js';
import { buildPolicy } from '../src/trailing/registry.js';
import { atrOf, atrTrail, chandelier } from '../src/trailing/price.js';
import type { PolicyContext, TrailingState } from '../src/trailing/types.js';

let seq = 0;
const candle = (o: number, h: number, l: number, c: number): Candle => (
  { openTime: 1_700_000_000_000 + seq++ * 300_000, open: o, high: h, low: l, close: c, volume: 1 });

function ctxOf(overrides: Partial<PolicyContext> = {}): PolicyContext {
  const position: Position = {
    id: 't1', symbol: 'SOLUSDT', side: 'LONG', strategy: 'ADAPTIVE-ST-ζ', entry: 100, qty: 1,
    mark: 100, upnl: 0, upnlPct: 0, leverage: 3, marginType: 'ISOLATED', liqDistancePct: null,
    serverSl: '94', serverTp: '112', initialRisk: 6,
  };
  return {
    position, s: 1, tf: '15m', price: 100, mark: { price: 100, fundingRate: 0.0001, nextFundingAt: 0 },
    index: null, book: null, flow: null, atr: { contract: null, mark: null }, candles: [],
    tickSize: null, account: { fundingAccrued: 0, feesAccrued: 0, fundingSettledAt: [] },
    ...overrides,
  };
}

function stateOf(overrides: Partial<TrailingState> = {}): TrailingState {
  return {
    key: 'SOLUSDT:ADAPTIVE-ST-ζ', symbol: 'SOLUSDT', strategy: 'ADAPTIVE-ST-ζ', side: 'LONG',
    entry: 100, initialQty: 1, reducedQty: 0, phase: 'TRAILING_ACTIVE', policyId: 't-atr',
    stopZ: 12, confirmedStop: 12, favorableExtremeX: 103.5, peakNetPnl: null, mfeX: 3.5, maeX: 0,
    fundingAccrued: 0, feesAccrued: 0, liquidationPrice: null, openedAt: 0, updatedAt: 0,
    lastBookSeq: null, lastAcceptedDecision: null, ...overrides,
  };
}

/** Seven candles of TR=2 each, then one of TR=3: Wilder period 7 seeds ATR=2, next = 15/7. */
function atrCandles(): Candle[] {
  const flat = (t: number) => [10 + t, 10 + t + 2, 10 + t, 10 + t + 1] as const;
  const bars = [0, 1, 2, 3, 4, 5, 6].map((t) => candle(...flat(t)));
  bars.push(candle(17, 20, 17, 18)); // TR3 vs prev close 17: max(3, 3, 0)
  return bars;
}

test('atr: Wilder period-7 seed and one smoothing step', () => {
  const series = atrCandles();
  assert.equal(atrOf(series.slice(0, 7), 7), 2);        // seed SMA of seven TR=2 bars
  assert.equal(atrOf(series, 7), (6 * 2 + 3) / 7);     // latest = one Wilder step on TR=3
});

test('atr: warmup returns null before the seed bar', () => {
  assert.equal(atrOf(atrCandles().slice(0, 7), 7), 2); // seed exactly at index period-1
  assert.equal(atrOf(atrCandles().slice(0, 6), 7), null); // short for period 7
});

test('atr trail: long candidate sits k ATR below the favorable extreme (X space)', () => {
  const policy = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '15m' });
  const state = stateOf({ favorableExtremeX: 18 }); // extreme is the latest close of the padded series
  const candidate = atrTrail(policy, ctxOf({ candles: atrCandles(), price: 18 }), state);
  assert.ok(candidate);
  assert.equal(candidate.levelZ, 18 - (2 * 15) / 7);
  assert.equal(candidate.policyId, 't-atr');
  assert.equal(candidate.priceReference, 'CONTRACT_PRICE');
});

test('atr trail: short candidate mirrors the long in X space (same candles, s=-1)', () => {
  const policy = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '15m' });
  const candles = atrCandles();
  // Short: favorable X direction is downward; entry 16 lifted the working extreme to -11 (lowest close).
  const state = stateOf({ side: 'SHORT', favorableExtremeX: -11, stopZ: -20 });
  const ctx = ctxOf({ candles, price: 18, s: -1, position: { ...ctxOf().position, side: 'SHORT' } });
  const candidate = atrTrail(policy, ctx, state);
  assert.ok(candidate);
  assert.equal(candidate.levelZ, -11 - (2 * 15) / 7); // stop price = 11 + 4.2857…, above the low ✓
});

test('atr trail: no candidate while ATR is still warming up', () => {
  const policy = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '15m' });
  const candidate = atrTrail(policy, ctxOf({ candles: atrCandles().slice(0, 5) }), stateOf());
  assert.equal(candidate, null);
});

test('atr trail: tf mismatch refuses the candidate', () => {
  const policy = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '1h' });
  const candidate = atrTrail(policy, ctxOf({ candles: atrCandles() }), stateOf());
  assert.equal(candidate, null);
});

test('chandelier: same extreme-minus-k-ATR form with its own reason and grid', () => {
  const policy = buildPolicy('t-chan', 'CHANDELIER', { n: 14, k: 3.5, tf: '15m' });
  // 7 TR=2 bars + 7 TR=3 bars -> ATR(14) seeds on bars 0..13: (2*7 + 3*7)/14 = 2.5
  const bars = atrCandles();
  for (let t = 0; t < 6; t++) bars.push(candle(18, 21, 18, 19));
  const state = stateOf({ favorableExtremeX: 21 });
  const candidate = chandelier(policy, ctxOf({ candles: bars, price: 19 }), state);
  assert.ok(candidate);
  assert.equal(candidate.reason, 'chandelier:n14-k3.5');
  assert.equal(candidate.levelZ, 21 - 3.5 * 2.5);
});

function atr14Candles(): Candle[] {
  // 14 bars, every TR exactly 3: o=clamped series, h=o+3, l=o, c=o+1.5 — prev close inside [l,h]
  const bars: Candle[] = [];
  for (let t = 0; t < 14; t++) bars.push(candle(10 + t, 13 + t, 10 + t, 11.5 + t));
  return bars;
}

test('chandelier: golden candidate on a flat-TR series', () => {
  const candles = atr14Candles();
  const policy = buildPolicy('t-chan', 'CHANDELIER', { n: 22, k: 3, tf: '15m' });
  // n=22 impossible with 14 candles: ATR(22) never seeds -> null. Use n validated at 14 with k=2.
  const policy14 = buildPolicy('t-chan2', 'CHANDELIER', { n: 14, k: 2, tf: '15m' });
  assert.equal(chandelier(policy, ctxOf({ candles }), stateOf({ favorableExtremeX: 13.5 })), null);
  const candidate = chandelier(policy14, ctxOf({ candles, price: 11.5 }), stateOf({ favorableExtremeX: 13.5 }));
  assert.ok(candidate);
  assert.equal(candidate.levelZ, 13.5 - 2 * 3); // every TR = h−l = 3, seed SMA = 3
});
