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
const COSTS: CostModel = { feeBpsPerSide: 4, slippageBpsPerSide: 2, funding: { kind: 'CONSTANT_FALLBACK', fundingBpsPerHour: 0 } };

/** A LONG edge (75% wins) tagged REJECTION_CONFIRMED. Training and holdout share the edge, so the holdout should accept. */
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
    ...over,
  };
}

test('an admitted, holdout-calibrated context with known room yields a LONG with three separate outputs', () => {
  const p = assessDirectionalPotential(input());
  assert.equal(p.direction, 'LONG');
  assert.equal(p.stopLoss, 98);
  assert.equal(p.expectedMovePct, 1);
  assert.equal(p.capacity.source, 'OPPOSING_ZONE');
  assert.deepEqual(p.capacity.reachableTargetsPct, [1]);
  assert.equal(p.candidates.length, 1);
  const c = p.candidates[0]!;
  assert.equal(c.targetPct, 1);
  const mp = c.moveProbability;
  assert.ok(Math.abs(mp.hitBeforeStop - 0.75) < 0.01, `p ${mp.hitBeforeStop}`);
  assert.ok(mp.trainHitInterval[0] <= mp.hitBeforeStop && mp.hitBeforeStop <= mp.trainHitInterval[1]);
  assert.ok(mp.sampleSize >= POLICY.minSample && mp.days >= POLICY.minDays);
  assert.equal(mp.criterionId, 'HOLDOUT_V1');
  assert.ok(mp.holdoutHitRate !== null && Math.abs(mp.calibrationGap ?? 1) <= 0.05);
  assert.ok(c.tradeExpectancy.netReturnCiLowPct > 0);
  assert.ok((c.tradeExpectancy.holdoutNetReturnPct ?? 0) > 0);
  assert.deepEqual(c.tradeExpectancy.fundingModels, ['CONSTANT_FALLBACK']);
});

test('a training estimate whose holdout realisation is miscalibrated is not published, even if the holdout is profitable', () => {
  // Training: 75% wins, a real edge. Holdout: 90% wins. The holdout is more profitable, yet the training estimate is off.
  const labels = [
    ...synthLabels({ days: 28, perDay: 10, winRate: 0.75, tags: ['REJECTION_CONFIRMED'] }),
    ...synthLabels({ days: 12, perDay: 10, winRate: 0.9, startDay: 28, tags: ['REJECTION_CONFIRMED'] }),
  ];
  const table = buildTargetTable(labels, 0.3, POLICY);
  const tagged = table.cells.find((c) => c.tag === 'REJECTION_CONFIRMED');
  assert.ok(tagged?.admitted, 'training must admit the cell for this test to bite');
  assert.equal(tagged.holdoutAccepted, false);
  assert.ok(tagged.holdoutReasons.some((r) => r.startsWith('CALIBRATION_GAP')), tagged.holdoutReasons.join('; '));
  const p = assessDirectionalPotential(input({ table }));
  assert.equal(p.direction, 'NO_TRADE');
  assert.equal(p.invalidationReason, 'HOLDOUT_CALIBRATION_FAILED');
  assert.equal(p.candidates.length, 0, 'no probability is published for an uncalibrated cell');
});

test('a context that is not an entry context is NO_TRADE, including exhaustion', () => {
  for (const context of ['NONE', 'LIQUIDITY_SWEEP', 'EXPANSION_EXHAUSTION'] as const) {
    const p = assessDirectionalPotential(input({ context }));
    assert.equal(p.direction, 'NO_TRADE');
    assert.equal(p.invalidationReason, `CONTEXT_NOT_ENTRY ${context}`);
    assert.deepEqual(p.candidates, []);
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
  assert.equal(q.invalidationReason, 'NO_ADMITTED_PROBABILITY_FOR_CONTEXT');
});

test('unknown room blocks every target: no opposing zone is not unlimited room', () => {
  const open: RoomResult = { roomPct: null, blocking: null, reason: 'NO_OPPOSING_ZONE' };
  const p = assessDirectionalPotential(input({ room: open }));
  assert.equal(p.direction, 'NO_TRADE');
  assert.match(p.invalidationReason ?? '', /^ROOM_UNVERIFIED/);
  assert.equal(p.capacity.source, 'UNVERIFIED');
  assert.deepEqual(p.candidates, []);
});

test('a validated capacity model can supply capacity where no zone is known, and the source is recorded', () => {
  const open: RoomResult = { roomPct: null, blocking: null, reason: 'NO_OPPOSING_ZONE' };
  const p = assessDirectionalPotential(input({ room: open, validatedCapacityPct: 3 }));
  assert.equal(p.direction, 'LONG');
  assert.equal(p.capacity.source, 'VALIDATED_MODEL');
  assert.equal(p.capacity.capacityPct, 3);
});

test('capacity shorter than every calibrated target blocks the trade', () => {
  const p = assessDirectionalPotential(input({ room: { roomPct: 0.5, blocking: null, reason: 'OPPOSING_ZONE_AHEAD' } }));
  assert.equal(p.invalidationReason, 'CAPACITY_BELOW_ALL_CALIBRATED_TARGETS');
  assert.ok(p.warnings.some((w) => w.startsWith('CAPACITY_BELOW_TARGET')));
});

test('a zone that sits on the entry leaves no capacity', () => {
  const p = assessDirectionalPotential(input({ room: { roomPct: 0, blocking: null, reason: 'INSIDE_OPPOSING_ZONE' } }));
  assert.equal(p.direction, 'NO_TRADE');
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

test('scale-out plan: rung prices, the runner fraction, and a post-first-rung stop covering round-trip fees and slippage', () => {
  const plan = planScaleOut({
    side: 'LONG', entry: 100, stopPrice: 98,
    rungs: [{ targetPct: 1, fraction: 0.25 }, { targetPct: 2, fraction: 0.25 }, { targetPct: 3, fraction: 0.25 }],
    costs: COSTS,
  });
  assert.deepEqual(plan.rungs.map((r) => r.price), [101, 102, 103]);
  assert.equal(plan.runnerFraction, 0.25);
  assert.ok(Math.abs(plan.stopAfterFirstRung - 100.12) < 1e-9);
  assert.equal(plan.runnerPolicy, 'DELEGATE_TO_TRAILING_ENGINE');

  const short = planScaleOut({ side: 'SHORT', entry: 100, stopPrice: 102, rungs: [{ targetPct: 1, fraction: 0.5 }], costs: COSTS });
  assert.equal(short.rungs[0]!.price, 99);
  assert.ok(Math.abs(short.stopAfterFirstRung - 99.88) < 1e-9);
});

test('scale-out plan refuses unordered rungs, a plan that books everything, and a stop on the wrong side', () => {
  const base = { side: 'LONG' as const, entry: 100, stopPrice: 98, costs: COSTS };
  assert.throws(() => planScaleOut({ ...base, rungs: [{ targetPct: 2, fraction: 0.2 }, { targetPct: 1, fraction: 0.2 }] }), /strictly ascending/);
  assert.throws(() => planScaleOut({ ...base, rungs: [{ targetPct: 1, fraction: 0.5 }, { targetPct: 2, fraction: 0.5 }] }), /runner must remain/);
  assert.throws(() => planScaleOut({ ...base, stopPrice: 101, rungs: [{ targetPct: 1, fraction: 0.25 }] }), /not beyond entry/);
});
