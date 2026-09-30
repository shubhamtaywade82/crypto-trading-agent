import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SetupLedger } from '../src/decision/SetupLedger.js';
import type { SetupMap, SetupScenario } from '../src/decision/SetupTypes.js';

const T0 = Date.UTC(2026, 8, 30, 0, 45, 0);
const MIN = 60_000;

const scenario = (over: Partial<SetupScenario> = {}): SetupScenario => ({
  id: 'pullback-SOLUSDT-LONG-1',
  kind: 'PULLBACK_RETEST',
  direction: 'LONG',
  state: 'FORMING',
  timeframe: '15m',
  entryLow: 117.29,
  entryHigh: 117.77,
  stopLoss: 116.9,
  target1: 121,
  trigger: 't',
  invalidation: 'i',
  flowHypothesis: 'f',
  expectedMove: { minMinutes: 30, maxMinutes: 60, thesisExpiryMinutes: 90, distanceAtr: 2 },
  sourceTime: T0,
  rewardRisk: 2,
  ...over,
});

const map = (at: number, scenarios: SetupScenario[], mark = 118.5): SetupMap => ({
  symbol: 'SOLUSDT', generatedAt: at, mark, state: scenarios[0]?.state ?? 'NO_TRADE', bias: 'BULLISH', regime: 'TREND_UP',
  volatility: 'MEDIUM', positionPct: 40, location: 'DISCOUNT', htfTrend: 'BULLISH', ltfTrend: 'BULLISH', lastBreak: null,
  nearestUpperLiquidity: null, nearestLowerLiquidity: null, crowding: null, openInterestExpansion: null,
  takerAggressionRatio: null, scenarios, noTradeReasons: [],
});

test('a setup is created once and re-derivations are not material events', () => {
  const ledger = new SetupLedger();
  const first = ledger.apply(map(T0, [scenario()]), 1);
  assert.deepEqual(first.transitions.map((t) => t.kind), ['CREATED']);
  const again = ledger.apply(map(T0 + 15 * MIN, [scenario({ entryLow: 117.3 })]), 1);
  assert.equal(again.transitions.length, 0);
  assert.equal(again.map.scenarios[0].lifecycle?.setupId, first.map.scenarios[0].lifecycle?.setupId);
});

test('state only advances: a recomputed lower state does not flap back', () => {
  const ledger = new SetupLedger();
  ledger.apply(map(T0, [scenario({ state: 'FORMING' })]), 1);
  const up = ledger.apply(map(T0 + 15 * MIN, [scenario({ state: 'TRIGGERED' })]), 1);
  assert.deepEqual(up.transitions.map((t) => t.kind), ['ADVANCED']);
  const down = ledger.apply(map(T0 + 30 * MIN, [scenario({ state: 'FORMING' })]), 1);
  assert.equal(down.transitions.length, 0);
  assert.equal(down.map.scenarios[0].state, 'TRIGGERED');
  assert.equal(down.map.state, 'TRIGGERED');
});

test('expiry is pinned to the origin event and never extended', () => {
  const ledger = new SetupLedger();
  const first = ledger.apply(map(T0, [scenario()]), 1);
  const expiresAt = first.map.scenarios[0].lifecycle?.expiresAt;
  assert.equal(expiresAt, T0 + 90 * MIN);
  const later = ledger.apply(map(T0 + 60 * MIN, [scenario({ expectedMove: { minMinutes: 30, maxMinutes: 60, thesisExpiryMinutes: 300, distanceAtr: 2 } })]), 1);
  assert.equal(later.map.scenarios[0].lifecycle?.expiresAt, expiresAt);
});

test('an expired setup is retired and cannot be resurrected by recomputation', () => {
  const ledger = new SetupLedger();
  ledger.apply(map(T0, [scenario()]), 1);
  const expired = ledger.apply(map(T0 + 91 * MIN, [scenario()]), 1);
  assert.deepEqual(expired.transitions.map((t) => t.kind), ['EXPIRED']);
  assert.equal(expired.map.scenarios.length, 0);
  assert.equal(expired.map.state, 'NO_TRADE');
  const after = ledger.apply(map(T0 + 120 * MIN, [scenario()]), 1);
  assert.equal(after.map.scenarios.length, 0);
  assert.equal(after.transitions.length, 0);
});

test('a setup first seen after its origin window is dead on arrival', () => {
  const ledger = new SetupLedger();
  const late = ledger.apply(map(T0 + 5 * 60 * MIN, [scenario()]), 1);
  assert.equal(late.map.scenarios.length, 0);
  assert.equal(late.transitions.length, 0);
});

test('a scenario the engine stops producing is invalidated, once', () => {
  const ledger = new SetupLedger();
  ledger.apply(map(T0, [scenario()]), 1);
  const gone = ledger.apply(map(T0 + 15 * MIN, []), 1);
  assert.deepEqual(gone.transitions.map((t) => t.kind), ['INVALIDATED']);
  assert.equal(ledger.apply(map(T0 + 30 * MIN, []), 1).transitions.length, 0);
});

test('entry state separates a confirmed trigger from an executable entry', () => {
  const ledger = new SetupLedger();
  const waiting = ledger.apply(map(T0, [scenario({ state: 'TRIGGERED' })], 119), 1);
  assert.equal(waiting.map.scenarios[0].lifecycle?.entryState, 'WAITING_ENTRY');
  const inZone = ledger.apply(map(T0 + 15 * MIN, [scenario({ state: 'TRIGGERED' })], 117.5), 1);
  assert.equal(inZone.map.scenarios[0].lifecycle?.entryState, 'IN_ENTRY_ZONE');
});

test('an entry the price has already run away from is dropped as missed', () => {
  const ledger = new SetupLedger();
  const out = ledger.apply(map(T0, [scenario({ state: 'TRIGGERED' })], 120), 1);
  assert.equal(out.map.scenarios.length, 0);
  assert.ok(out.map.noTradeReasons.some((r) => /entry missed/.test(r)));
});
