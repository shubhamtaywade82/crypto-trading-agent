import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import {
  admit, bucketOf, DEFAULT_ADMISSION_POLICY, estimateOutcome, gateVerdict, getPlaybook, gradeVerdict, knownAt,
  PlaybookJournal, prequentialCalibration, resolveOutcome, setupIdOf,
  type CalibrationSample, type OutcomePolicy, type PlaybookVerdict, type RuleEvaluation,
} from '../src/playbooks/index.js';

const M5 = 5 * 60_000;
const DAY = 24 * 60 * 60_000;
const T0 = 1_700_006_400_000;
const POLICY: OutcomePolicy = { entryTtlBars: 6, horizonBars: 48, takerFeeRate: 0.0004, slippageRate: 0.0002 };
const COST = POLICY.takerFeeRate + POLICY.slippageRate;
const LONG_PLAN = { entry: 100, stop: 98, target: 104 };

const bar = (i: number, open: number, high: number, low: number, close: number): Candle => ({ openTime: T0 + i * M5, open, high, low, close, volume: 100 });
const resolveLong = (candles: Candle[], policy: OutcomePolicy = POLICY) =>
  resolveOutcome({ direction: 'LONG', plan: LONG_PLAN, triggeredAt: T0, frame: '5m', candles }, policy);

test('outcome: a fill at the next open at or below the limit, then the target, is TARGET with net R after costs', () => {
  const o = resolveLong([bar(0, 99.9, 100.5, 99.5, 100.2), bar(1, 100.2, 104.2, 100, 104)]);

  assert.equal(o.label, 'TARGET');
  assert.equal(o.fillPrice, 99.9);
  assert.equal(o.exitPrice, 104);
  assert.equal(o.resolvedAt, T0 + 2 * M5);
  assert.equal(o.barsHeld, 2);
  const expected = ((104 - 99.9) - (99.9 + 104) * COST) / (99.9 - 98);
  assert.ok(Math.abs(o.netR! - expected) < 1e-12);
});

test('outcome: a resting limit that price only touches, never trades through, is NOT_FILLED at the end of its TTL', () => {
  const o = resolveLong([bar(0, 100.3, 101, 100, 100.5), bar(1, 100.5, 101, 100.1, 100.6)], { ...POLICY, entryTtlBars: 2 });
  assert.equal(o.label, 'NOT_FILLED');
  assert.equal(o.resolvedAt, T0 + 2 * M5);
  assert.equal(o.netR, null);
});

test('outcome: a strict trade-through fills at the limit price, not at the bar low', () => {
  const o = resolveLong([bar(0, 100.6, 101, 101.2 - 0.6, 100.8), bar(1, 100.8, 101.5, 99.9, 100.2), bar(2, 100.2, 104.1, 100.1, 104)]);
  assert.equal(o.label, 'TARGET');
  assert.equal(o.fillPrice, 100);
  assert.equal(o.filledAt, T0 + M5);
  assert.equal(o.barsHeld, 2);
});

test('outcome: price reaching the target before any fill is a missed move, NOT_FILLED, even if that bar also dipped through', () => {
  const o = resolveLong([bar(0, 100.5, 104.2, 99.8, 104)]);
  assert.equal(o.label, 'NOT_FILLED');
  assert.equal(o.resolvedAt, T0 + M5);
});

test('outcome: a bar that fills intrabar and also reaches the stop is a STOP', () => {
  const o = resolveLong([bar(0, 100.5, 100.8, 97.9, 98.2)]);
  assert.equal(o.label, 'STOP');
  assert.equal(o.fillPrice, 100);
  assert.equal(o.exitPrice, 98);
});

test('outcome: a limit that has not filled and whose TTL has not ended yet is UNRESOLVED', () => {
  assert.equal(resolveLong([bar(0, 100.3, 101, 100.1, 100.5)]).label, 'UNRESOLVED');
});

test('outcome: a bar that touches both stop and target counts as STOP', () => {
  const o = resolveLong([bar(0, 100, 104.5, 97.5, 101)]);
  assert.equal(o.label, 'STOP');
  assert.equal(o.exitPrice, 98);
  assert.ok(o.netR! < -1, 'a full stop costs more than 1 R after fees');
});

test('outcome: a bar that opens through the stop exits at its open', () => {
  const o = resolveLong([bar(0, 99.5, 99.8, 99, 99.6), bar(1, 97, 97.5, 96.5, 97)]);
  assert.equal(o.label, 'STOP');
  assert.equal(o.exitPrice, 97);
});

test('outcome: neither level within the horizon is TIMEOUT at the last close', () => {
  const o = resolveLong([bar(0, 100, 100.5, 99.5, 100), bar(1, 100, 100.6, 99.6, 100.3), bar(2, 100.3, 100.8, 99.9, 100.7)], { ...POLICY, horizonBars: 3 });
  assert.equal(o.label, 'TIMEOUT');
  assert.equal(o.exitPrice, 100.7);
  assert.equal(o.resolvedAt, T0 + 3 * M5);
});

test('outcome: candles that end early, start late or have a gap leave the setup UNRESOLVED', () => {
  const short = { ...POLICY, horizonBars: 3 };
  assert.equal(resolveLong([bar(0, 100, 100.5, 99.5, 100), bar(1, 100, 100.5, 99.5, 100)], short).label, 'UNRESOLVED');
  assert.equal(resolveLong([bar(1, 100, 100.5, 99.5, 100)]).label, 'UNRESOLVED');
  assert.equal(resolveLong([bar(0, 100, 100.5, 99.5, 100), bar(2, 100, 104.5, 99.5, 104)]).label, 'UNRESOLVED');
});

test('outcome: a SHORT mirrors the rules', () => {
  const o = resolveOutcome({ direction: 'SHORT', plan: { entry: 100, stop: 102, target: 96 }, triggeredAt: T0, frame: '5m', candles: [bar(0, 100.1, 100.4, 99.6, 99.8), bar(1, 99.8, 100, 95.8, 96)] }, POLICY);
  assert.equal(o.label, 'TARGET');
  assert.equal(o.fillPrice, 100.1);
  assert.ok(o.netR! > 1.8);
});

function eligible(evaluations: Partial<RuleEvaluation>[], over: Partial<PlaybookVerdict> = {}): PlaybookVerdict {
  return {
    playbookId: 'sweep_mss_fvg_reversal', version: 1, symbol: 'SOLUSDT', direction: 'LONG', evaluatedAt: T0, verdict: 'ENTRY_ELIGIBLE',
    armedAt: T0 - 3 * M5, triggeredAt: T0, plan: LONG_PLAN, failed: [], pending: [],
    evaluations: evaluations.map((e) => ({ stage: 'SETUP', passed: true, reason: 'r', ...e }) as RuleEvaluation),
    ...over,
  };
}

const EVIDENCE: Partial<RuleEvaluation>[] = [
  { ruleId: 'htf_not_opposed', observedValue: '4h=LONG 1h=LONG' },
  { ruleId: 'displacement_confirmed', observedValue: 2 },
  { ruleId: 'liquidity_swept_before_break', observedValue: true },
  { ruleId: 'entry_not_chased', observedValue: 0.1 },
  { ruleId: 'net_reward_risk_above_minimum', observedValue: 3 },
  { ruleId: 'spread_within_limit', observedValue: 1 },
];

test('grade: a ranking from recorded evidence, with correlated break evidence in one component', () => {
  const pb = getPlaybook('sweep_mss_fvg_reversal');
  const grade = gradeVerdict(eligible(EVIDENCE), pb)!;
  const score = (name: string) => grade.components.find((c) => c.name === name)!.score;

  assert.equal(score('context'), 1);
  assert.equal(score('break'), 1);
  assert.ok(Math.abs(score('location') - 0.8) < 1e-12);
  assert.equal(score('reward'), 1);
  assert.ok(Math.abs(score('execution') - 0.8) < 1e-12);
  assert.equal(grade.band, 'A');

  const noSweep = gradeVerdict(eligible(EVIDENCE.map((e) => (e.ruleId === 'liquidity_swept_before_break' ? { ...e, passed: false } : e))), pb)!;
  assert.ok(Math.abs(noSweep.components.find((c) => c.name === 'break')!.score - 0.7) < 1e-12);
  assert.deepEqual(noSweep.components.filter((c) => c.name !== 'break'), grade.components.filter((c) => c.name !== 'break'));

  assert.equal(gradeVerdict(eligible(EVIDENCE, { verdict: 'WATCH' }), pb), null);
});

test('bucket keys: playbook version and direction by default, grade band on request', () => {
  const v = eligible(EVIDENCE);
  const grade = gradeVerdict(v, getPlaybook('sweep_mss_fvg_reversal'));
  assert.equal(bucketOf(v, grade), 'sweep_mss_fvg_reversal@1|LONG');
  assert.equal(bucketOf(v, grade, ['playbook', 'direction', 'grade']), 'sweep_mss_fvg_reversal@1|LONG|grade:A');
});

const sample = (i: number, label: CalibrationSample['label'], netR: number | null, over: Partial<CalibrationSample> = {}): CalibrationSample => ({
  setupId: `s${i}`, bucket: 'b', decidedAt: T0 + Math.floor(i / 5) * DAY + (i % 5) * 60 * 60_000, resolvedAt: 0, label, netR, ...over,
});
const withResolution = (s: CalibrationSample): CalibrationSample => ({ ...s, resolvedAt: s.resolvedAt || s.decidedAt + 30 * 60_000 });

test('estimate: rates, mean R per outcome and fill rate over filled setups', () => {
  const samples = [
    ...Array.from({ length: 4 }, (_, i) => sample(i, 'TARGET', 2)),
    ...Array.from({ length: 6 }, (_, i) => sample(4 + i, 'STOP', -1)),
    sample(10, 'NOT_FILLED', null),
  ].map(withResolution);

  const e = estimateOutcome(samples, 'b', T0 + 100 * DAY);

  assert.equal(e.n, 10);
  assert.equal(e.notFilled, 1);
  assert.ok(Math.abs(e.fillRate! - 10 / 11) < 1e-12);
  assert.equal(e.pTarget, 0.4);
  assert.equal(e.pTimeout, 0);
  assert.equal(e.rTarget, 2);
  assert.equal(e.rStop, -1);
  assert.ok(Math.abs(e.evR! - 0.2) < 1e-12);
  assert.ok(e.pTargetLow! < 0.4 && e.pTargetHigh! > 0.4);
  assert.ok(e.evLowerBoundR! < e.evR!);
});

test('estimate: an outcome resolved after the estimate time, or decided after it, is invisible', () => {
  const asOf = T0 + DAY;
  const samples: CalibrationSample[] = [
    { setupId: 'past', bucket: 'b', decidedAt: asOf - 2 * 60 * 60_000, resolvedAt: asOf - 60 * 60_000, label: 'TARGET', netR: 2 },
    { setupId: 'resolves-later', bucket: 'b', decidedAt: asOf - 60 * 60_000, resolvedAt: asOf + 60 * 60_000, label: 'STOP', netR: -1 },
    { setupId: 'decided-later', bucket: 'b', decidedAt: asOf + 1, resolvedAt: asOf + 2, label: 'STOP', netR: -1 },
    { setupId: 'other-bucket', bucket: 'x', decidedAt: asOf - 2 * 60 * 60_000, resolvedAt: asOf - 60 * 60_000, label: 'STOP', netR: -1 },
  ];
  assert.deepEqual(knownAt(samples, 'b', asOf).map((s) => s.setupId), ['past']);
  assert.equal(estimateOutcome(samples, 'b', asOf).pTarget, 1);
});

/** `n` filled setups over `n / 5` days, TARGET (+2 R) when `isTarget(i)`, else STOP (-1 R). */
const history = (n: number, isTarget: (i: number) => boolean, over: Partial<CalibrationSample> = {}) =>
  Array.from({ length: n }, (_, i) => withResolution(sample(i, isTarget(i) ? 'TARGET' : 'STOP', isTarget(i) ? 2 : -1, over)));
const LATER = T0 + 1000 * DAY;

test('admission: positive expectancy over enough setups and days is admitted', () => {
  const e = estimateOutcome(history(250, (i) => i % 2 === 0), 'b', LATER);
  const a = admit(e);
  assert.equal(a.reason, 'ADMITTED', a.detail);
  assert.ok(e.evLowerBoundR! > 0.05);
});

test('admission: every refusal names its reason', () => {
  assert.equal(admit(estimateOutcome(history(150, (i) => i % 2 === 0), 'b', LATER)).reason, 'SAMPLE_BELOW_MIN');
  assert.equal(admit(estimateOutcome(history(250, (i) => i % 10 < 3), 'b', LATER)).reason, 'EV_LOWER_BOUND_BELOW_MIN');
  const oneDay = history(250, (i) => i % 2 === 0).map((s) => ({ ...s, decidedAt: T0 + (s.decidedAt % 1000), resolvedAt: T0 + 1000 + (s.decidedAt % 1000) }));
  assert.equal(admit(estimateOutcome(oneDay, 'b', LATER)).reason, 'CLUSTERS_BELOW_MIN');
  assert.equal(admit(estimateOutcome(history(250, (i) => i % 2 === 0), 'b', LATER, { confidence: 0.9 })).reason, 'CONFIDENCE_MISMATCH');
  assert.deepEqual(DEFAULT_ADMISSION_POLICY, { minSample: 200, minClusters: 20, minEvLowerBoundR: 0.05, confidence: 0.95 });
});

test('gate: an ENTRY_ELIGIBLE setup without enough history becomes NO_TRADE; WATCH passes through', () => {
  const thin = estimateOutcome(history(20, () => true), 'b', LATER);
  const gated = gateVerdict(eligible(EVIDENCE), thin);
  assert.equal(gated.verdict, 'NO_TRADE');
  assert.equal(gated.admission?.reason, 'SAMPLE_BELOW_MIN');
  assert.equal(gateVerdict(eligible(EVIDENCE), null).verdict, 'NO_TRADE');
  assert.equal(gateVerdict(eligible(EVIDENCE, { verdict: 'WATCH' }), thin).verdict, 'WATCH');
  const rich = estimateOutcome(history(250, (i) => i % 2 === 0), 'b', LATER);
  assert.equal(gateVerdict(eligible(EVIDENCE), rich).verdict, 'ENTRY_ELIGIBLE');
});

test('prequential calibration: bucket rates that carry information beat the pooled rate out of sample', () => {
  const a = history(200, (i) => i % 10 < 7, { bucket: 'A' });
  const b = history(200, (i) => i % 10 < 3, { bucket: 'B' }).map((s) => ({ ...s, setupId: `b-${s.setupId}`, decidedAt: s.decidedAt + 30 * 60_000, resolvedAt: s.resolvedAt + 30 * 60_000 }));
  const report = prequentialCalibration([...a, ...b], { minPrior: 30 });

  assert.ok(report.n > 0 && report.n <= 400 - 2 * 30);
  assert.ok(report.brier! < report.brierPooled!, `${report.brier} vs ${report.brierPooled}`);
  assert.equal(report.bins.reduce((sum, bin) => sum + bin.n, 0), report.n);
});

test('prequential calibration: an outcome that resolves after a later decision is not used to score it', () => {
  // 60 decisions over 12 days (5 a day); every outcome takes 10 days to resolve. Only the 10 decisions on days 10 and 11
  // have an earlier outcome already resolved, so only they can be scored
  const slow = history(60, () => true).map((s) => ({ ...s, resolvedAt: s.decidedAt + 10 * DAY }));
  assert.equal(prequentialCalibration(slow, { minPrior: 1 }).n, 10);
  assert.equal(prequentialCalibration(slow.slice(0, 50), { minPrior: 1 }).n, 0, 'within the first 10 days nothing has resolved');
});

test('journal: one decision and one outcome per setup, folded back on reload', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'playbook-journal-')), 'journal.jsonl');
  const journal = new PlaybookJournal(file);
  const v = eligible(EVIDENCE);
  const grade = gradeVerdict(v, getPlaybook('sweep_mss_fvg_reversal'));

  assert.equal(journal.recordDecision(v, '5m', grade, bucketOf(v, grade)), true);
  assert.equal(journal.recordDecision(v, '5m', grade, bucketOf(v, grade)), false, 'same trigger, same setup');
  assert.equal(journal.recordDecision(eligible(EVIDENCE, { verdict: 'WATCH', triggeredAt: T0 + M5 }), '5m', null, 'b'), false);
  assert.equal(journal.recordOutcome(setupIdOf(v), { label: 'UNRESOLVED', fillPrice: null, filledAt: null, exitPrice: null, resolvedAt: null, netR: null, barsHeld: null }, POLICY), false);

  const candles = [bar(0, 99.9, 100.5, 99.5, 100.2), bar(1, 100.2, 104.2, 100, 104)];
  assert.equal(journal.resolvePending(() => candles, POLICY), 1);
  assert.equal(journal.resolvePending(() => candles, POLICY), 0);

  appendFileSync(file, 'not json\n');
  const reloaded = new PlaybookJournal(file);
  assert.equal(reloaded.skippedLines, 1);
  assert.equal(reloaded.decisions().length, 1);
  assert.equal(reloaded.pending().length, 0);
  const [s] = reloaded.samples();
  assert.equal(s.label, 'TARGET');
  assert.equal(s.decidedAt, T0);
  assert.equal(s.bucket, 'sweep_mss_fvg_reversal@1|LONG');
  assert.equal(reloaded.recordDecision(v, '5m', grade, 'b'), false, 'a reload does not forget recorded setups');
});
