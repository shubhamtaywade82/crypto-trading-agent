import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPeriodicEquityReturns,
  hypotheticalTrades,
  passesSpecFilters,
  runExperiment,
  type ExperimentConfig,
} from '../src/research/ExperimentRunner.js';
import { seedStructLiqSpec, mutateSpec, type StructLiqSpecParams, type StrategySpec } from '../src/research/StrategySpec.js';
import { makeLedger, makeMultiRegimeLedger } from './support/ledgerFixture.js';

const NO_COSTS = { feeRate: 0, slippageRate: 0 };
const BASE_CONFIG: ExperimentConfig = {
  trainDays: 30,
  testDays: 15,
  costs: NO_COSTS,
  bootstrap: { iterations: 500, seed: 1, confidence: 0.9 },
  walkForwardTrainDays: 7,
  walkForwardTestDays: 3,
  walkForwardMinN: 5,
};

const child = (parent: StrategySpec<StructLiqSpecParams>, changes: Partial<StructLiqSpecParams>): StrategySpec<StructLiqSpecParams> =>
  mutateSpec(parent, changes, 'test child', { kind: 'manual', note: 'test' });

test('passesSpecFilters respects minimumRewardRisk', () => {
  const spec = seedStructLiqSpec();
  // Seed's minimumRewardRisk is 1.5; rr=1.6 passes, rr=1.4 fails.
  assert.ok(passesSpecFilters(spec, { rr: 1.6, effectiveRr: null, features: { sweepDepthAtr: null, sweepDisplacementAtr: null } } as never));
  assert.ok(!passesSpecFilters(spec, { rr: 1.4, effectiveRr: null, features: { sweepDepthAtr: null, sweepDisplacementAtr: null } } as never));
  // Tighter floor: 1.6 → rr=1.5 fails.
  const tightened = { ...spec, params: { ...spec.params, minimumRewardRisk: 1.6 } };
  assert.ok(!passesSpecFilters(tightened, { rr: 1.5, effectiveRr: null, features: { sweepDepthAtr: null, sweepDisplacementAtr: null } } as never));
});

test('passesSpecFilters respects minSweepDepthAtr', () => {
  const spec = { ...seedStructLiqSpec(), params: { ...seedStructLiqSpec().params, minSweepDepthAtr: 0.5 } };
  assert.ok(passesSpecFilters(spec, { rr: 2, effectiveRr: null, features: { sweepDepthAtr: 0.8, sweepDisplacementAtr: null } } as never));
  assert.ok(!passesSpecFilters(spec, { rr: 2, effectiveRr: null, features: { sweepDepthAtr: 0.3, sweepDisplacementAtr: null } } as never));
  // null sweep depth is allowed (legacy records)
  assert.ok(passesSpecFilters(spec, { rr: 2, effectiveRr: null, features: { sweepDepthAtr: null, sweepDisplacementAtr: null } } as never));
});

test('hypotheticalTrades only counts setups whose entry was touched and outcome is known', () => {
  const spec = seedStructLiqSpec();
  const ledger = makeLedger({ n: 10 });
  // Sabotage: drop the entry-touched timestamp on the first record (it never fired).
  ledger[0] = { ...ledger[0], entryTouchedAt: null };
  // Evaluate as-of just after the final trade's outcome is known: a trade whose outcome resolved at or
  // after the window cutoff would leak future information into the window and is excluded.
  const trades = hypotheticalTrades(spec, ledger, ledger[0].createdAt, (ledger[ledger.length - 1].closedAt ?? 0) + 1);
  assert.equal(trades.length, 9);
  assert.ok(!trades.some((t) => t.record.setupId === 'setup-0'));
});

test('hypotheticalTrades excludes trades whose outcome resolved at or after the window cutoff (look-ahead guard)', () => {
  const spec = seedStructLiqSpec();
  const ledger = makeLedger({ n: 10 });
  // Window ends before the last two records' outcomes are known (fixtures close at createdAt + 2h).
  const end = ledger[ledger.length - 3].createdAt + 1;
  const trades = hypotheticalTrades(spec, ledger, ledger[0].createdAt, end);
  assert.ok(trades.every((t) => (t.record.closedAt ?? Number.POSITIVE_INFINITY) < end));
  assert.ok(trades.length < 9, `expected unresolved-window trades to be dropped; got ${trades.length}`);
});

test('runExperiment returns empty results when the ledger is too short for the train/test windows', () => {
  const spec = seedStructLiqSpec();
  const ledger = makeLedger({ n: 5, spacing: 3_600_000 }); // ~5 hours, way less than 30+15 days
  const result = runExperiment(spec, spec, ledger, BASE_CONFIG);
  assert.equal(result.test.n, 0);
  assert.equal(result.train.n, 0);
  assert.ok(result.experimentNotes.length > 0);
  assert.ok(/spans/.test(result.experimentNotes[0]));
});

test('fixed-cadence DSR returns require complete exact equity-curve coverage', () => {
  const marks = [0, 1, 2, 3].map((i) => ({ t: i * 1_000, equity: 100 * (1 + i * 0.01) }));
  const valid = buildPeriodicEquityReturns(marks, 1_000, 3_000, 1_000);
  assert.equal(valid.reason, null);
  assert.equal(valid.series?.returns.length, 2);
  assert.ok(Math.abs(valid.series!.returns[0] - (102 / 101 - 1)) < 1e-12);

  const gap = buildPeriodicEquityReturns([marks[0], marks[1], marks[3]], 0, 3_000, 1_000);
  assert.equal(gap.series, null);
  assert.match(gap.reason ?? '', /cadence/);
});

test('runExperiment exposes real test-period equity returns when a fixed-cadence curve is supplied', () => {
  const spec = seedStructLiqSpec();
  const DAY = 86_400_000;
  const ledger = makeMultiRegimeLedger(60);
  const equityCurve = Array.from({ length: 46 }, (_, i) => ({
    t: Date.UTC(2026, 0, 1) + i * DAY,
    equity: 10_000 * (1 + i * 0.001),
  }));
  const result = runExperiment(spec, spec, ledger, { ...BASE_CONFIG, equityCurve: { source: 'CANDIDATE_PORTFOLIO_REPLAY', candidateId: spec.id, candidateVersion: spec.version, frequencyMs: DAY, marks: equityCurve } });
  assert.equal(result.testEquityReturns?.source, 'CANDIDATE_PORTFOLIO_REPLAY');
  assert.equal(result.testEquityReturns?.frequencyMs, DAY);
  assert.equal(result.testEquityReturns?.returns.length, 15);
});

test('runExperiment computes train and test metrics on disjoint windows', () => {
  const parent = seedStructLiqSpec();
  const candidate = child(parent, { minimumRewardRisk: 1.4 });
  // 60 days of data, 8 trades per day = 480 records; train 30 + test 15 = 45 days, well within range.
  const ledger = makeMultiRegimeLedger(60);
  const result = runExperiment(candidate, parent, ledger, BASE_CONFIG);
  assert.ok(result.train.n > 0, `train n > 0; got ${result.train.n}`);
  assert.ok(result.test.n > 0, `test n > 0; got ${result.test.n}`);
  // Train and test windows are disjoint: no setup in both.
  const trainIds = new Set(result.perSymbol.map((s) => s.key));
  assert.ok(trainIds.size > 0);
  // parentTest must also be populated so the gate can compute deltas.
  assert.ok(result.parentTest.n > 0);
});

test('runExperiment flags sweep-age mutations as approximations in experimentNotes', () => {
  const parent = seedStructLiqSpec();
  const candidate = child(parent, { maxSweepAgeCandles: 4 });
  const ledger = makeMultiRegimeLedger(60);
  const result = runExperiment(candidate, parent, ledger, BASE_CONFIG);
  assert.ok(result.experimentNotes.some((n) => /maxSweepAgeCandles/.test(n) && /approximation/.test(n)));
});

test('maxSpreadBps uses recorded setup spread and missing historical spread is incomplete', () => {
  const parent = seedStructLiqSpec();
  const candidate = child(parent, { maxSpreadBps: 2 } as Partial<StructLiqSpecParams>);
  const ledger = makeMultiRegimeLedger(60);
  assert.ok(ledger.some((r) => r.features.spreadBps === 2.5));
  assert.ok(!passesSpecFilters(candidate, ledger[0]));
  const missing = ledger.map((r) => ({ ...r, features: { ...r.features, spreadBps: undefined } }));
  const result = runExperiment(candidate, parent, missing, BASE_CONFIG);
  assert.ok(result.experimentNotes.some((n) => n.startsWith('incomplete research input:') && /spreadBps/.test(n)));
});

test('runExperiment applies maxSpreadBps when the ledger records per-setup spread', () => {
  const parent = seedStructLiqSpec();
  const candidate = child(parent, { maxSpreadBps: 5 } as Partial<StructLiqSpecParams>);
  const ledger = makeLedger({ n: 40, spreadBps: 3, spacing: 3_600_000 * 6, noise: 0.4 });
  // Half the records sit above the cap; the filter must actually exclude them.
  for (let i = 0; i < ledger.length; i += 2) {
    ledger[i] = { ...ledger[i], features: { ...ledger[i].features, spreadBps: 9 } };
  }
  const trades = hypotheticalTrades(candidate, ledger, ledger[0].createdAt, (ledger[ledger.length - 1].closedAt ?? 0) + 1);
  assert.equal(trades.length, 20);
  assert.ok(trades.every((t) => typeof t.record.features.spreadBps === 'number' && t.record.features.spreadBps <= 5));
});

test('runExperiment throws when candidate and parent have different ids', () => {
  const parent = seedStructLiqSpec();
  const candidate = { ...child(parent, { minimumRewardRisk: 1.4 }), id: 'OTHER' };
  const ledger = makeMultiRegimeLedger(60);
  assert.throws(() => runExperiment(candidate as never, parent as never, ledger, BASE_CONFIG), /different strategies/);
});

test('perSymbol and perRegime slice the test-window trades by their respective dimensions', () => {
  const parent = seedStructLiqSpec();
  const candidate = child(parent, { minimumRewardRisk: 1.4 });
  const ledger = makeMultiRegimeLedger(60);
  const result = runExperiment(candidate, parent, ledger, BASE_CONFIG);
  // Multi-regime fixture rotates 4 regimes x 3 volatilities = 12 cells; some must appear in perRegime.
  assert.ok(result.perRegime.length > 0);
  // All trades are BTCUSDT in this fixture, so perSymbol has one entry.
  assert.ok(result.perSymbol.length === 1);
  assert.equal(result.perSymbol[0].key, 'BTCUSDT');
});

test('walk-forward folds are produced when the ledger is long enough', () => {
  const parent = seedStructLiqSpec();
  const candidate = child(parent, { minimumRewardRisk: 1.4 });
  const ledger = makeMultiRegimeLedger(60);
  const result = runExperiment(candidate, parent, ledger, BASE_CONFIG);
  // 45 days total train+test; 7+3 walk-forward windows means up to ~13 folds.
  assert.ok(result.walkForward.folds > 0, `walk-forward folds > 0; got ${result.walkForward.folds}`);
});
