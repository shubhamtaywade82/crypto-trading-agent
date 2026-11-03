import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Position } from '../src/types.js';
import { confirmStop, initState, recover, reduce } from '../src/trailing/stateMachine.js';
import { TrailingStateStore } from '../src/trailing/store.js';
import type { TrailingEvent, TrailingPhase, TrailingState } from '../src/trailing/types.js';

const positionOf = (overrides: Partial<Position> = {}): Position => ({
  id: 'BTCUSDT_ADAPTIVE-ST-ζ', symbol: 'BTCUSDT', side: 'LONG', strategy: 'ADAPTIVE-ST-ζ',
  entry: 100, qty: 2, mark: 105, upnl: 10, upnlPct: 5, leverage: 5, marginType: 'ISOLATED',
  liqDistancePct: null, serverSl: '94', serverTp: '112', initialRisk: 6, ...overrides,
});

const baseState = (overrides: Partial<TrailingState> = {}): TrailingState => ({
  ...initState(positionOf(), 0)!, ...overrides,
});

test('state machine: the full §8 happy path', () => {
  let phase: TrailingPhase = 'INITIALIZING';
  for (const event of ['SL0_CONFIRMED', 'ACTIVATION', 'ACK', 'BREACH', 'ORDER_ACCEPTED', 'FILL'] as const) {
    phase = reduce(phase, { type: event } satisfies TrailingEvent);
  }
  assert.equal(phase, 'CLOSED');
  // and the intermediate stops are exactly the §8 bookends
  assert.equal(reduce('INITIALIZING', { type: 'SL0_CONFIRMED' }), 'PROTECTED');
  assert.equal(reduce('PROTECTED', { type: 'ACTIVATION' }), 'TRAILING_PENDING');
  assert.equal(reduce('TRAILING_PENDING', { type: 'ACK' }), 'TRAILING_ACTIVE');
  assert.equal(reduce('TRAILING_ACTIVE', { type: 'BREACH' }), 'EXIT_PENDING');
  assert.equal(reduce('EXIT_PENDING', { type: 'ORDER_ACCEPTED' }), 'EXIT_SUBMITTED');
  assert.equal(reduce('EXIT_SUBMITTED', { type: 'FILL' }), 'CLOSED');
});

test('state machine: every documented edge of the §8 table', () => {
  assert.equal(reduce('INITIALIZING', { type: 'POSITION_GONE' }), 'RECONCILIATION');
  assert.equal(reduce('PROTECTED', { type: 'BREACH' }), 'EXIT_PENDING');
  assert.equal(reduce('PROTECTED', { type: 'POSITION_GONE' }), 'RECONCILIATION');
  assert.equal(reduce('TRAILING_PENDING', { type: 'PARTIAL_FILL' }), 'PARTIAL');
  assert.equal(reduce('TRAILING_PENDING', { type: 'REJECT' }), 'REJECTED');
  assert.equal(reduce('TRAILING_ACTIVE', { type: 'POSITION_GONE' }), 'RECONCILIATION');
  assert.equal(reduce('EXIT_PENDING', { type: 'PARTIAL_FILL' }), 'PARTIAL');
  assert.equal(reduce('EXIT_SUBMITTED', { type: 'PARTIAL_FILL' }), 'PARTIAL');
  assert.equal(reduce('EXIT_SUBMITTED', { type: 'UNKNOWN_OUTCOME' }), 'RECONCILIATION');
  assert.equal(reduce('PARTIAL', { type: 'REMAINING_MANAGED' }), 'TRAILING_ACTIVE');
  assert.equal(reduce('PARTIAL', { type: 'BREACH' }), 'EXIT_PENDING');
  assert.equal(reduce('REJECTED', { type: 'RECONCILE', to: 'PROTECTED' }), 'PROTECTED');
  assert.equal(reduce('RECONCILIATION', { type: 'RECONCILE', to: 'TRAILING_ACTIVE' }), 'TRAILING_ACTIVE');
  assert.equal(reduce('RECONCILIATION', { type: 'RECONCILE', to: 'CLOSED' }), 'CLOSED');
});

test('state machine: undocumented transitions are refused loudly', () => {
  assert.throws(() => reduce('CLOSED', { type: 'ACTIVATION' }), /invalid transition CLOSED/);
  assert.throws(() => reduce('CLOSED', { type: 'RECONCILE', to: 'PROTECTED' }), /terminal/);
  assert.throws(() => reduce('TRAILING_ACTIVE', { type: 'ACK' }), /invalid transition TRAILING_ACTIVE/);
  assert.throws(() => reduce('PROTECTED', { type: 'FILL' }), /invalid transition PROTECTED/);
  assert.throws(() => reduce('RECONCILIATION', { type: 'ACK' }), /invalid transition RECONCILIATION/);
  // an un-ACKed trailing candidate is not protection: the resting stop still governs
  assert.throws(() => reduce('TRAILING_PENDING', { type: 'BREACH' }), /invalid transition TRAILING_PENDING/);
});

test('initState: derives the protected state from the fill with the venue SL₀', () => {
  const state = initState(positionOf(), 1_000);
  assert.ok(state);
  assert.equal(state.stopZ, 94);
  assert.equal(state.confirmedStop, 94);
  assert.equal(state.favorableExtremeX, 105);
  assert.equal(state.initialQty, 2);
  assert.equal(state.reducedQty, 0);
  assert.equal(state.phase, 'PROTECTED');
  assert.equal(state.key, 'BTCUSDT:ADAPTIVE-ST-ζ');
  assert.equal(state.side, 'LONG');
  assert.equal(state.openedAt, 1_000);
  assert.equal(state.lastAcceptedDecision, null);
});

test('initState: shorts land in directional coordinates (Z mirrors price)', () => {
  const state = initState(positionOf({ side: 'SHORT' }), 1_000);
  assert.equal(state?.stopZ, -94);
  assert.equal(state?.favorableExtremeX, -105);
});

test('initState: refuses a position without a usable SL₀ or size', () => {
  assert.equal(initState(positionOf({ serverSl: 'x' }), 1_000), null);
  assert.equal(initState(positionOf({ qty: 0 }), 1_000), null);
});

test('confirmStop: only the ACK fixes the stop and records the attributing decision', () => {
  const moved = baseState({ stopZ: 97 });
  const confirmed = confirmStop(moved, 't-swing', 5_000);
  assert.equal(confirmed.confirmedStop, 97);
  assert.equal(confirmed.policyId, 't-swing');
  assert.deepEqual(confirmed.lastAcceptedDecision, { ts: 5_000, stopZ: 97, policyId: 't-swing' });
  assert.equal(confirmed.updatedAt, 5_000);
});

test('recover: an un-ACKed candidate never survives a restart', () => {
  const base = baseState({
    stopZ: 97, favorableExtremeX: 110, phase: 'TRAILING_ACTIVE',
    lastAcceptedDecision: { ts: 1, stopZ: 94, policyId: 't-swing' },
  });
  const recovered = recover(base, { price: 108, positionOpen: true, stopWorking: true }, 2_000);
  assert.equal(recovered.stopZ, 94);               // rewound to the confirmed stop
  assert.equal(recovered.favorableExtremeX, 110);  // monotone union: 108 adds nothing
  assert.equal(recovered.phase, 'TRAILING_ACTIVE');
});

test('recover: the extreme takes a monotone union with the venue price', () => {
  const long = baseState({ favorableExtremeX: 108 });
  assert.equal(recover(long, { price: 112, positionOpen: true, stopWorking: false }, 2).favorableExtremeX, 112);
  const short = baseState({ side: 'SHORT', favorableExtremeX: -105 });
  // price 96 is a further favorable move for the short than the stored 105
  assert.equal(recover(short, { price: 96, positionOpen: true, stopWorking: false }, 2).favorableExtremeX, -96);
});

test('recover: the phase is re-derived from the venue snapshot', () => {
  const acked = baseState({ lastAcceptedDecision: { ts: 1, stopZ: 94, policyId: 't' } });
  assert.equal(recover(acked, { price: 100, positionOpen: true, stopWorking: true }, 2).phase, 'TRAILING_ACTIVE');
  assert.equal(recover(baseState(), { price: 100, positionOpen: true, stopWorking: true }, 2).phase, 'PROTECTED');
  // no working stop → an intent is outstanding; reconciliation continues from here
  assert.equal(recover(baseState(), { price: 100, positionOpen: true, stopWorking: false }, 2).phase, 'TRAILING_PENDING');
  assert.equal(recover(baseState(), { price: 100, positionOpen: false, stopWorking: true }, 2).phase, 'CLOSED');
});

test('store: round-trips states per mode with an atomic flush', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trailing-store-'));
  try {
    const file = path.join(dir, 'state.json');
    const store = new TrailingStateStore('paper', file, () => 1_000);
    const state = baseState({});
    store.set(state);
    const reloaded = new TrailingStateStore('paper', file, () => 2_000);
    assert.deepEqual(reloaded.get(state.key), state);
    // modes are separate books — live never sees paper states
    const live = new TrailingStateStore('live', file, () => 2_000);
    assert.equal(live.get(state.key), undefined);
    assert.deepEqual(live.keys(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store: a corrupt file restarts empty instead of throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trailing-bad-'));
  try {
    const file = path.join(dir, 'state.json');
    writeFileSync(file, 'not json at all');
    const store = new TrailingStateStore('paper', file, () => 1_000);
    assert.deepEqual(store.keys(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store: material changes flush immediately, extreme-only changes throttle', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trailing-throttle-'));
  try {
    const file = path.join(dir, 'state.json');
    let clock = 1_000;
    const store = new TrailingStateStore('paper', file, () => clock);
    const state = baseState({});
    store.set(state);

    store.set({ ...state, favorableExtremeX: 111 }); // extreme-only → dirty, no flush yet
    let reloaded = new TrailingStateStore('paper', file, () => clock);
    assert.equal(reloaded.get(state.key)?.favorableExtremeX, 105); // still the initial 105, not 111

    clock = 6_500; // past the 5 s extreme window
    store.tick();
    reloaded = new TrailingStateStore('paper', file, () => clock);
    assert.equal(reloaded.get(state.key)?.favorableExtremeX, 111);

    store.set({ ...state, stopZ: 97, confirmedStop: 97, favorableExtremeX: 112 }); // material → flush now
    reloaded = new TrailingStateStore('paper', file, () => clock);
    assert.equal(reloaded.get(state.key)?.stopZ, 97);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
