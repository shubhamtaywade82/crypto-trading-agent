import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ADMISSION_POLICY, buildTargetTable, type AdmissionPolicy } from '../src/market/directional/probability.js';
import { assessDirectionalPotential, type PotentialInput } from '../src/market/directional/potential.js';
import { availableRoom, type RoomResult } from '../src/market/directional/room.js';
import { planScaleOut } from '../src/market/directional/ladder.js';
import type { CostModel } from '../src/market/directional/barriers.js';
import { SYMBOL } from './rejectionFixtures.js';
import { synthLabels, zone } from './directionalFixtures.js';

const POLICY: AdmissionPolicy = { ...DEFAULT_ADMISSION_POLICY, minSample: 50, minDays: 5, bootstrapIterations: 1000 };
const COSTS: CostModel = { feeBpsPerSide: 4, slippageBpsPerSide: 2, fundingBpsPerHour: 0 };

/** A LONG edge (75% wins) tagged REJECTION_CONFIRMED, with a holdout that shares it. */
const CONFIRMED_TABLE = buildTargetTable(
  synthLabels({ days: 40, perDay: 10, winRate: 0.75, tags: ['REJECTION_CONFIRMED'] }),
  0.3,
  POLICY,
);

const ROOM_OK: RoomResult = { roomPct: 5, blocking: null, reason: 'OPPOSING_ZONE_AHEAD' };

function input(over: Partial<PotentialInput> = {}): PotentialInput {
  return {
    symbol: SYMBOL,
    side: 'LONG',
    entry: 100,
    stopPrice: 98,
    context: 'REJECTION_CONFIRMED',
    contextPath: ['NONE', 'ABSORPTION_CANDIDATE', 'REJECTION_CONFIRMED'],
    room: ROOM_OK,
    table: CONFIRMED_TABLE,
    maxStopPct: 3,
    minHoldoutSample: 20,
    ...over,
  };
}

test('a confirmed, admitted context with room and a valid stop yields a LONG with target-specific probabilities', () => {
  const p = assessDirectionalPotential(input());
  assert.equal(p.direction, 'LONG');
  assert.equal(p.stopLoss, 98);
  assert.equal(p.expectedMovePct, 1);
  assert.equal(p.probabilities.length, 1);
  const prob = p.probabilities[0]!;
  assert.equal(prob.targetPct, 1);
  assert.ok(Math.abs(prob.hitBeforeStopProbability - 0.75) < 0.01, `p ${prob.hitBeforeStopProbability}`);
  assert.ok(prob.confidenceInterval[0] < prob.hitBeforeStopProbability && prob.hitBeforeStopProbability < prob.confidenceInterval[1]);
  assert.ok(prob.sampleSize >= POLICY.minSample && prob.days >= POLICY.minDays);
  assert.ok(prob.expectedNetReturnCiLowPct > 0);
  assert.ok(prob.holdout.n > 0 && (prob.holdout.netMeanPct ?? 0) > 0);
  assert.ok(p.evidence.some((e) => e.startsWith('context REJECTION_CONFIRMED')));
});

test('a context that is not an entry context is NO_TRADE, including exhaustion', () => {
  for (const context of ['NONE', 'LIQUIDITY_SWEEP', 'EXPANSION_EXHAUSTION'] as const) {
    const p = assessDirectionalPotential(input({ context }));
    assert.equal(p.direction, 'NO_TRADE');
    assert.equal(p.invalidationReason, `CONTEXT_NOT_ENTRY ${context}`);
    assert.deepEqual(p.probabilities, []);
  }
});

test('a stop that is too wide, or on the wrong side, is NO_TRADE and no probability is reported', () => {
  assert.match(assessDirectionalPotential(input({ stopPrice: 90 })).invalidationReason ?? '', /^STOP_TOO_WIDE/);
  assert.equal(assessDirectionalPotential(input({ stopPrice: 101 })).invalidationReason, 'STOP_NOT_BEYOND_ENTRY');
});

test('without an admitted cell for the symbol and context, the engine does not guess a probability', () => {
  const p = assessDirectionalPotential(input({ symbol: 'XRPUSDT' }));
  assert.equal(p.direction, 'NO_TRADE');
  assert.equal(p.invalidationReason, 'NO_ADMITTED_PROBABILITY_FOR_CONTEXT');
  const uncalibrated = buildTargetTable(synthLabels({ days: 3, perDay: 10, winRate: 0.9, tags: ['REJECTION_CONFIRMED'] }), 0.34, POLICY);
  const q = assessDirectionalPotential(input({ table: uncalibrated }));
  assert.equal(q.direction, 'NO_TRADE');
  assert.equal(q.invalidationReason, 'NO_ADMITTED_PROBABILITY_FOR_CONTEXT');
});

test('a holdout that does not confirm the admitted cell blocks the trade', () => {
  // Training: 28 days of a real edge. Holdout: 12 days at a 10% win rate, which loses money.
  const labels = [
    ...synthLabels({ days: 28, perDay: 10, winRate: 0.75, tags: ['REJECTION_CONFIRMED'] }),
    ...synthLabels({ days: 12, perDay: 10, winRate: 0.1, startDay: 28, tags: ['REJECTION_CONFIRMED'] }),
  ];
  const table = buildTargetTable(labels, 0.3, POLICY);
  assert.ok(table.cells.some((c) => c.admitted && c.tag === 'REJECTION_CONFIRMED'), 'training must admit the cell for this test to bite');
  const p = assessDirectionalPotential(input({ table }));
  assert.equal(p.direction, 'NO_TRADE');
  assert.equal(p.invalidationReason, 'HOLDOUT_DID_NOT_CONFIRM');
});

test('room shorter than every admitted target blocks the trade; unknown room is allowed with a warning', () => {
  const tight = assessDirectionalPotential(input({ room: { roomPct: 0.5, blocking: null, reason: 'OPPOSING_ZONE_AHEAD' } }));
  assert.equal(tight.invalidationReason, 'ROOM_BELOW_ALL_ADMITTED_TARGETS');
  const open = assessDirectionalPotential(input({ room: { roomPct: null, blocking: null, reason: 'NO_OPPOSING_ZONE' } }));
  assert.equal(open.direction, 'LONG');
  assert.ok(open.warnings.some((w) => w.startsWith('NO_OPPOSING_ZONE_KNOWN')));
});

test('availableRoom: LONG looks up to the nearest live supply zone; BROKEN and weak zones are ignored', () => {
  const zones = [
    zone('a', '15m', 'SUPPLY', 102, 104, 'ACTIVE'),
    zone('b', '15m', 'SUPPLY', 100.5, 101, 'BROKEN'),
    zone('c', '15m', 'DEMAND', 95, 97, 'ACTIVE'),
    zone('d', '1h', 'SUPPLY', 101.5, 102, 'ACTIVE', 10),
  ];
  const room = availableRoom('LONG', 100, zones, 20);
  assert.equal(room.reason, 'OPPOSING_ZONE_AHEAD');
  assert.equal(room.blocking?.id, 'a');
  assert.ok(Math.abs((room.roomPct ?? 0) - 2) < 1e-9);
  assert.equal(availableRoom('LONG', 103, zones, 20).roomPct, 0);
  assert.equal(availableRoom('LONG', 103, zones, 20).reason, 'INSIDE_OPPOSING_ZONE');
  assert.equal(availableRoom('LONG', 110, zones, 20).roomPct, null);
});

test('availableRoom: SHORT looks down to the nearest live demand zone', () => {
  const room = availableRoom('SHORT', 100, [zone('e', '5m', 'DEMAND', 96, 98, 'TESTED')]);
  assert.ok(Math.abs((room.roomPct ?? 0) - 2) < 1e-9);
  assert.equal(room.blocking?.id, 'e');
});

test('scale-out plan: rung prices, the runner fraction, and a post-first-rung stop that covers costs', () => {
  const plan = planScaleOut({
    side: 'LONG', entry: 100, stopPrice: 98,
    rungs: [{ targetPct: 1, fraction: 0.25 }, { targetPct: 2, fraction: 0.25 }, { targetPct: 3, fraction: 0.25 }],
    costs: COSTS, breakEvenHoldHours: 1,
  });
  assert.deepEqual(plan.rungs.map((r) => r.price), [101, 102, 103]);
  assert.equal(plan.runnerFraction, 0.25);
  assert.ok(Math.abs(plan.stopAfterFirstRung - 100.12) < 1e-9);
  assert.equal(plan.runnerPolicy, 'DELEGATE_TO_TRAILING_ENGINE');

  const short = planScaleOut({ side: 'SHORT', entry: 100, stopPrice: 102, rungs: [{ targetPct: 1, fraction: 0.5 }], costs: COSTS, breakEvenHoldHours: 1 });
  assert.equal(short.rungs[0]!.price, 99);
  assert.ok(Math.abs(short.stopAfterFirstRung - 99.88) < 1e-9);
});

test('scale-out plan refuses unordered rungs, a plan that books everything, and a stop on the wrong side', () => {
  const base = { side: 'LONG' as const, entry: 100, stopPrice: 98, costs: COSTS, breakEvenHoldHours: 1 };
  assert.throws(() => planScaleOut({ ...base, rungs: [{ targetPct: 2, fraction: 0.2 }, { targetPct: 1, fraction: 0.2 }] }), /strictly ascending/);
  assert.throws(() => planScaleOut({ ...base, rungs: [{ targetPct: 1, fraction: 0.5 }, { targetPct: 2, fraction: 0.5 }] }), /runner must remain/);
  assert.throws(() => planScaleOut({ ...base, stopPrice: 101, rungs: [{ targetPct: 1, fraction: 0.25 }] }), /not beyond entry/);
});
