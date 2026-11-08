import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holm } from '../src/research/Bootstrap.js';
import {
  DEFAULT_ADMISSION_POLICY, baselineComparison, buildTargetTable, labelStats, splitChronological, wilsonInterval, type AdmissionPolicy,
} from '../src/market/directional/probability.js';
import { synthLabels } from './directionalFixtures.js';

/** Smaller sample floors so the synthetic blocks can clear them. The default floors are asserted separately. */
const POLICY: AdmissionPolicy = { ...DEFAULT_ADMISSION_POLICY, minSample: 50, minDays: 5, bootstrapIterations: 1000 };

test('admission defaults follow the calibration decision contract: 200 setups, 20 decision days', () => {
  assert.equal(DEFAULT_ADMISSION_POLICY.minSample, 200);
  assert.equal(DEFAULT_ADMISSION_POLICY.minDays, 20);
  assert.equal(DEFAULT_ADMISSION_POLICY.alpha, 0.05);
});

test('Wilson interval matches the known value for 50 of 100 at 95%, and stays inside [0, 1] at the edges', () => {
  const w = wilsonInterval(50, 100, 0.95);
  assert.ok(w);
  assert.ok(Math.abs(w.low - 0.4038) < 1e-3, `low ${w.low}`);
  assert.ok(Math.abs(w.high - 0.5962) < 1e-3, `high ${w.high}`);
  const zero = wilsonInterval(0, 10, 0.95);
  assert.equal(zero?.low, 0);
  assert.ok(Math.abs((zero?.high ?? 0) - 0.2775) < 1e-3);
  assert.equal(wilsonInterval(0, 0, 0.95), null);
  assert.throws(() => wilsonInterval(11, 10, 0.95), /hits 11/);
  assert.throws(() => wilsonInterval(1, 10, 0.8), /unsupported confidence/);
});

test('a hit probability counts a timeout as a miss, and UNRESOLVED labels are not outcomes', () => {
  const labels = synthLabels({ days: 1, perDay: 4, winRate: 0.5 });
  labels[0] = { ...labels[0]!, outcome: 'TIMEOUT', netReturnPct: -0.1 };
  labels[1] = { ...labels[1]!, outcome: 'UNRESOLVED', netReturnPct: null, unresolvedReason: 'DATA_ENDED' };
  const stats = labelStats(labels, POLICY);
  assert.equal(stats.n, 3);
  assert.equal(stats.timeouts, 1);
  assert.equal(stats.hitRate, stats.hits / 3);
});

test('chronological split purges training labels whose horizon runs into the holdout', () => {
  // Labels with 2-hour horizons on day 0..3. Cut at the holdout start: labels entered just before the cut must be purged.
  // 96 entries: 24 per day, one per minute from midnight. A 20% holdout cuts at index 76, which is day 3 at 00:04.
  // The four labels entered 00:00-00:03 on day 3 run past the cut and must be purged.
  const labels = synthLabels({ days: 4, perDay: 24, winRate: 0.5, horizonHours: 2 });
  const { train, holdout, cutoffTime, purged } = splitChronological(labels, 0.2);
  assert.ok(train.every((l) => l.horizonEndsAt < cutoffTime), 'no training outcome may resolve inside the holdout');
  assert.ok(holdout.every((l) => l.entryTime >= cutoffTime));
  assert.equal(purged, 4);
  assert.equal(train.length + holdout.length + purged, labels.length);
});

test('a real edge with enough samples and days is admitted; a losing edge is not', () => {
  // 75% wins: EV = 0.75 × 0.88 − 0.25 × 2.12 = +0.13%. 25% wins: EV = −1.37%.
  const winners = [
    ...synthLabels({ days: 40, perDay: 10, winRate: 0.75 }),
  ];
  const table = buildTargetTable(winners, 0.3, POLICY);
  const baseline = table.cells.find((c) => c.tag === null);
  assert.ok(baseline);
  assert.equal(baseline.testable, true);
  assert.equal(baseline.admitted, true, baseline.reasons.join('; '));
  assert.ok((baseline.train.netSummary?.ciLow ?? -1) > 0);

  const losers = synthLabels({ days: 40, perDay: 10, winRate: 0.25 });
  const lossTable = buildTargetTable(losers, 0.3, POLICY);
  assert.equal(lossTable.cells.every((c) => !c.admitted), true);
});

test('a cell below the sample or day floor is reported with its reason and never admitted', () => {
  const few = synthLabels({ days: 3, perDay: 10, winRate: 0.9 });
  const table = buildTargetTable(few, 0.34, POLICY);
  const baseline = table.cells.find((c) => c.tag === null);
  assert.ok(baseline);
  assert.equal(baseline.admitted, false);
  assert.ok(baseline.reasons.some((r) => r.startsWith('SAMPLE_BELOW_MIN') || r.startsWith('DAYS_BELOW_MIN')));
  assert.equal(table.familySize, 0, 'untestable cells do not enter the multiple-testing family');
});

test('context-tagged cells are separate from the baseline, and each carries its own sample and interval', () => {
  const labels = [
    ...synthLabels({ days: 40, perDay: 10, winRate: 0.75, tags: ['REJECTION_CONFIRMED'] }),
    ...synthLabels({ days: 40, perDay: 10, winRate: 0.5, startDay: 0, tags: ['EXPANSION_EXHAUSTION'] }),
  ];
  const table = buildTargetTable(labels, 0.3, POLICY);
  const tagged = table.cells.find((c) => c.tag === 'REJECTION_CONFIRMED');
  const exhaust = table.cells.find((c) => c.tag === 'EXPANSION_EXHAUSTION');
  assert.ok(tagged && exhaust);
  assert.equal(tagged.admitted, true);
  assert.equal(exhaust.admitted, false, 'a 50% win rate with 2% stops loses money and must not be admitted');
  assert.ok(tagged.train.hitInterval && tagged.train.hitInterval.low < tagged.train.hitRate!);
});

test('holdout statistics are reported for every admitted cell, computed on data admission never saw', () => {
  const labels = synthLabels({ days: 40, perDay: 10, winRate: 0.75 });
  const table = buildTargetTable(labels, 0.3, POLICY);
  const cell = table.cells.find((c) => c.tag === null);
  assert.ok(cell?.holdout);
  const holdoutCount = labels.filter((l) => l.entryTime >= table.cutoffTime && l.outcome !== 'UNRESOLVED').length;
  assert.equal(cell.holdout.n, holdoutCount, 'holdout statistics use exactly the labels entered at or after the cut');
  assert.equal(cell.train.n + cell.holdout.n + table.purged, labels.length);
});

test('Holm family: a p-value that passes alone can fail once the family grows, and admission requires the family test', () => {
  // Pure holm() behaviour: 0.03 is admitted alone at alpha 0.05 but not with a second hypothesis of 0.04.
  assert.deepEqual(holm([0.03], 0.05), [true]);
  assert.deepEqual(holm([0.03, 0.04], 0.05), [false, false]);
  // Table invariant: every admitted cell is Holm-rejected, and familySize counts the testable cells.
  const table = buildTargetTable(
    [...synthLabels({ days: 40, perDay: 10, winRate: 0.75, symbol: 'A' }), ...synthLabels({ days: 40, perDay: 10, winRate: 0.75, symbol: 'B' })],
    0.3,
    POLICY,
  );
  assert.equal(table.familySize, table.cells.filter((c) => c.testable).length);
  assert.ok(table.cells.filter((c) => c.admitted).every((c) => c.holmRejected));
});

test('the baseline comparison is descriptive: it reports the tagged hit-rate difference against all setups', () => {
  const labels = [
    ...synthLabels({ days: 10, perDay: 10, winRate: 0.5, tags: [] }),
    ...synthLabels({ days: 10, perDay: 10, winRate: 0.9, startDay: 10, tags: ['REJECTION_CONFIRMED'] }),
  ];
  const cmp = baselineComparison(labels, { symbol: labels[0]!.symbol, side: 'LONG', targetPct: 1, horizonHours: 1 }, 'REJECTION_CONFIRMED', POLICY);
  assert.ok(cmp.baseline && cmp.tagged);
  assert.equal(cmp.tagged.n, 100);
  assert.equal(cmp.baseline.n, 200);
  // Baseline hit rate 140/200 = 0.70; tagged 90/100 = 0.90.
  assert.ok(Math.abs((cmp.hitRateDifference ?? 0) - 0.2) < 1e-9, `difference ${cmp.hitRateDifference}`);
});
