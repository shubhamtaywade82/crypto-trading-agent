import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle, Position } from '../src/types.js';
import { buildPolicy, PHASE1_METHODS, validatePolicy } from '../src/trailing/registry.js';
import { evaluate } from '../src/trailing/engine.js';
import type { PolicyContext, TrailingState } from '../src/trailing/types.js';

let seq = 0;
const candle = (o: number, h: number, l: number, c: number): Candle => (
  { openTime: 1_700_000_000_000 + seq++ * 300_000, open: o, high: h, low: l, close: c, volume: 1 });

/** Seven candles of TR=2 then one of TR=3: Wilder ATR(7) seeds 2 at index 6, latest is 15/7. */
function atrCandles(): Candle[] {
  const bars: Candle[] = [];
  for (let t = 0; t < 7; t++) bars.push(candle(10 + t, 10 + t + 2, 10 + t, 10 + t + 1));
  bars.push(candle(17, 20, 17, 18));
  return bars;
}

/** The structure fixture: final close 95 breaches the protected low 97 (CHoCH). */
function structureCandles(): Candle[] {
  const closes = [100, 100, 100, 100, 100, 100, 100, 101, 102, 98, 97, 99, 103, 106, 104, 105, 108, 107, 95];
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1];
    return candle(prev, Math.max(c, prev), Math.min(c, prev), c);
  });
}

const positionOf = (overrides: Partial<Position> = {}): Position => ({
  id: 't1', symbol: 'SOLUSDT', side: 'LONG', strategy: 'ADAPTIVE-ST-ζ', entry: 16, qty: 1,
  mark: 17, upnl: 1, upnlPct: 6.25, leverage: 3, marginType: 'ISOLATED', liqDistancePct: null,
  serverSl: '10', serverTp: '30', initialRisk: 6, ...overrides,
});

function ctxOf(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    position: positionOf(), s: 1, tf: '15m', price: 17,
    mark: { price: 17, fundingRate: 0.0001, nextFundingAt: 0 },
    index: null, book: null, flow: null, atr: { contract: null, mark: null },
    candles: atrCandles(), tickSize: null,
    account: { fundingAccrued: 0, feesAccrued: 0, fundingSettledAt: [] },
    ...overrides,
  };
}

function stateOf(overrides: Partial<TrailingState> = {}): TrailingState {
  return {
    key: 'SOLUSDT:ADAPTIVE-ST-ζ', symbol: 'SOLUSDT', strategy: 'ADAPTIVE-ST-ζ', side: 'LONG',
    entry: 16, initialQty: 1, reducedQty: 0, phase: 'TRAILING_ACTIVE', policyId: 't-atr',
    stopZ: 12, confirmedStop: 12, favorableExtremeX: 18, peakNetPnl: null, mfeX: 2, maeX: 0,
    fundingAccrued: 0, feesAccrued: 0, liquidationPrice: null, openedAt: 0, updatedAt: 0,
    lastBookSeq: null, lastAcceptedDecision: null, ...overrides,
  };
}

test('engine: long MOVE_STOP ratchets to the tightest candidate (F − k·ATR, X space)', () => {
  const policy = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '15m' });
  const { state, decision } = evaluate(stateOf(), ctxOf(), [policy], 7_000);
  assert.equal(decision.action, 'MOVE_STOP');
  assert.equal(decision.reasonCode, 'atr-trail:period7-k2');
  assert.ok(Math.abs((decision.stopZ ?? 0) - (18 - 2 * (15 / 7))) < 1e-9);
  assert.ok(Math.abs((decision.stopPrice ?? 0) - (decision.stopZ ?? 0)) < 1e-9); // s=+1: price == Z
  assert.equal(state.stopZ, decision.stopZ);
  assert.ok(state.confirmedStop === 12); // engine does not ACK; confirmStop() owns confirmation
  assert.equal(decision.ts, 7_000);
});

test('engine: short pass mirrors the long in X space', () => {
  const policy = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '15m' });
  // short rode the drop down to 11: X = −11 is the favorable extreme, stop 20 sits high above
  const state = stateOf({ side: 'SHORT', favorableExtremeX: -11, stopZ: -20, mfeX: 3, maeX: -2 });
  const ctx = ctxOf({ s: -1, price: 11, position: positionOf({ side: 'SHORT', entry: 16 }) });
  const { decision } = evaluate(state, ctx, [policy], 7_000);
  assert.equal(decision.action, 'MOVE_STOP');
  assert.ok(Math.abs((decision.stopZ ?? 0) - (-11 - 2 * (15 / 7))) < 1e-9);
  assert.ok(Math.abs((decision.stopPrice ?? 0) - (11 + 2 * (15 / 7))) < 1e-9); // real stop above the low
});

test('engine: the ratchet never loosens across looser policies (switch-safe)', () => {
  const policies = [
    buildPolicy('loose-a', 'ATR_TRAIL', { period: 7, k: 3, tf: '15m' }),
    buildPolicy('loose-b', 'ATR_TRAIL', { period: 7, k: 2.5, tf: '15m' }),
  ];
  const { decision, state: next } = evaluate(stateOf({ stopZ: 14, confirmedStop: 14 }), ctxOf(), policies, 1_000);
  assert.equal(decision.action, 'HOLD');
  assert.equal(decision.reasonCode, 'NO_CHANGE');
  assert.equal(next.stopZ, 14);
  assert.equal(decision.evidence.rejectedLoosening, 2);
  assert.deepEqual([...decision.policyIds].sort(), ['loose-a', 'loose-b']);
});

test('engine: MFE_R gate holds the pass until the excursion in R reaches the threshold', () => {
  const policy = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '15m' },
    { activation: { type: 'MFE_R', threshold: 0.5 } });
  // (19 − 16)/6 = 0.5 R exactly → inclusive
  const fired = evaluate(stateOf({ favorableExtremeX: 19 }), ctxOf(), [policy], 5_000);
  assert.equal(fired.decision.action, 'MOVE_STOP');
  // (18 − 16)/6 = 1/3 < 0.5 → gated: no policy runs, stop untouched
  const gated = evaluate(stateOf(), ctxOf(), [policy], 5_000);
  assert.equal(gated.decision.action, 'HOLD');
  assert.deepEqual(gated.decision.policyIds, []);
  assert.equal(gated.state.stopZ, 12);
});

test('engine: PEAK_PNL gate reads state.peakNetPnl', () => {
  const policy = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '15m' },
    { activation: { type: 'PEAK_PNL', threshold: 5 } });
  assert.equal(evaluate(stateOf({ peakNetPnl: null }), ctxOf(), [policy], 1).decision.action, 'HOLD');
  assert.equal(evaluate(stateOf({ peakNetPnl: 3 }), ctxOf(), [policy], 1).decision.action, 'HOLD');
  assert.equal(evaluate(stateOf({ peakNetPnl: 6, favorableExtremeX: 19 }), ctxOf(), [policy], 1).decision.action, 'MOVE_STOP');
});

test('engine: TP1_FILLED stays gated until the position manager wires it (phase 4)', () => {
  const policy = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '15m' },
    { activation: { type: 'TP1_FILLED', threshold: 0 } });
  const { decision } = evaluate(stateOf({ favorableExtremeX: 19 }), ctxOf(), [policy], 1);
  assert.equal(decision.action, 'HOLD');
  assert.deepEqual(decision.policyIds, []);
});

test('engine: X == stopZ exactly is a breach (rule X ≤ Z, initial-stop attribution)', () => {
  const policy = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '15m' });
  const { decision } = evaluate(stateOf({ stopZ: 17, confirmedStop: 17 }), ctxOf({ price: 17 }), [policy], 1);
  assert.equal(decision.action, 'EXIT');
  assert.equal(decision.reasonCode, 'INITIAL_STOP_BREACH');
  assert.equal(decision.triggerReference, 'CONTRACT_PRICE');
  assert.equal(decision.triggerDomain, 'CONTRACT');
  assert.deepEqual(decision.policyIds, []); // no policy ran: the breach short-circuits the pass
});

test('engine: breach attribution follows the last ACKed stop policy', () => {
  const swing = buildPolicy('t-swing', 'SWING', { bufferAtr: 0.2, tf: '5m' });
  const state = stateOf({
    stopZ: 17, confirmedStop: 17,
    lastAcceptedDecision: { ts: 9, stopZ: 17, policyId: 't-swing' },
  });
  const { decision } = evaluate(state, ctxOf({ price: 16.5 }), [swing], 10);
  assert.equal(decision.action, 'EXIT');
  assert.equal(decision.reasonCode, 'STOP_BREACH:t-swing');
  assert.equal(decision.triggerReference, 'CONTRACT_PRICE'); // the ACKed policy's reference
  assert.equal(decision.triggerDomain, 'CONTRACT');
});

test('engine: a CHoCH exit candidate wins over same-pass move candidates', () => {
  const bos = buildPolicy('t-bos', 'BOS_CHOCH', { bufferAtr: 0.2, tf: '15m' });
  const atr = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '15m' });
  const candles = structureCandles(); // last close 95 breaches the protected 97
  const state = stateOf({ favorableExtremeX: 108 });
  const { decision } = evaluate(state, ctxOf({ price: 95, candles }), [bos, atr], 1);
  assert.equal(decision.action, 'EXIT');
  assert.equal(decision.reasonCode, 'choch-break@97');
  assert.equal(decision.triggerReference, 'CONTRACT_PRICE');
});

test('engine: identical inputs give identical results (dedup lives above this layer)', () => {
  const policy = buildPolicy('t-atr', 'ATR_TRAIL', { period: 7, k: 2, tf: '15m' });
  const first = evaluate(stateOf(), ctxOf(), [policy], 42);
  const second = evaluate(stateOf(), ctxOf(), [policy], 42);
  assert.deepEqual(first, second);
});

test('registry: phase-1 methods build from defaults and validate clean', () => {
  for (const method of PHASE1_METHODS) {
    const policy = buildPolicy(`t-${method}`, method, {});
    assert.deepEqual(validatePolicy(policy), []);
  }
});

test('registry: in-grid overrides are accepted and merged over defaults', () => {
  const policy = buildPolicy('t1', 'ATR_TRAIL', { period: 7, k: 3, tf: '1h' });
  assert.deepEqual(policy.params, { period: 7, k: 3, tf: '1h' });
  assert.equal(policy.domain, 'CONTRACT');
  assert.equal(policy.layer, 'PRICE');
  assert.equal(policy.priority, 'P0');
  assert.equal(policy.priceReference, 'CONTRACT_PRICE');
  assert.equal(policy.enabled, true);
});

test('registry: out-of-grid params, unknown params, and unknown methods are refused at load', () => {
  assert.throws(() => buildPolicy('t1', 'ATR_TRAIL', { period: 10 }), /outside research grid/);
  assert.throws(() => buildPolicy('t1', 'ATR_TRAIL', { k: 4 }), /outside research grid/);
  assert.throws(() => buildPolicy('t1', 'SWING', { bufferTicks: 4 }), /outside research grid/);
  assert.throws(() => buildPolicy('t1', 'ATR_TRAIL', { bogus: 1 }), /unknown param bogus/);
  assert.throws(() => buildPolicy('t1', 'SUPERTREND', {}), /unknown trailing method/);
});

test('registry: a tampered policy is rejected by validation', () => {
  const policy = buildPolicy('t1', 'ATR_TRAIL', {});
  const tampered = { ...policy, domain: 'MARK' } as typeof policy;
  assert.deepEqual(validatePolicy(tampered), ['field disagreement with method spec']);
});
