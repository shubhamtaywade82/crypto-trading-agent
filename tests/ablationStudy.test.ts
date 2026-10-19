import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import type { SMCFrame } from '../src/strategies/smc-ml/types.js';
import { DEFAULT_OUTCOME_POLICY, FRAME_MS, FRAME_MS as MS, listPlaybooks, validateRegistry } from '../src/playbooks/index.js';
import type { PlaybookDecisionRecord } from '../src/playbooks/journal.js';
import { resolveOutcome } from '../src/playbooks/outcome.js';
import {
  DEFAULT_ABLATION_CONFIG, atrPctAt, buildVariants, computeMetrics, costCurve, delayedExpectancy, flipMeanR,
  hashOfConfig, permutationTest, runAblationStudy, segmentBounds, segmentOf, sessionOf, studyIdOf,
  type ExperimentConfig, type TradeRecord,
} from '../src/research/ablation/index.js';

const M5 = FRAME_MS['5m'];
const DAY = 24 * 60 * 60_000;
/** A multiple of 4h so every frame aligns. */
const T = 118_056 * 4 * 60 * 60_000;
const POLICY = { ...DEFAULT_OUTCOME_POLICY, entryTtlBars: 24 };

// ---------------------------------------------------------------------------
// Variant generation
// ---------------------------------------------------------------------------

const baseConfig = (): ExperimentConfig => ({ ...structuredClone(DEFAULT_ABLATION_CONFIG), from: T, to: T + 30 * DAY });

test('variants: unique labels, full equals the registry, core is full minus the toggleable rules', () => {
  const variants = buildVariants(baseConfig());
  const labels = variants.map((v) => v.label);
  assert.equal(new Set(labels).size, labels.length);

  for (const pb of listPlaybooks()) {
    const core = variants.find((v) => v.label === `${pb.id}::core`)!;
    const full = variants.find((v) => v.label === `${pb.id}::full`)!;
    assert.ok(core && full);
    assert.deepEqual(full.definition.rules, pb.rules, `${pb.id}: full must reproduce the registry definition exactly`);
    assert.deepEqual(full.definition.params.maxTriggerBars, 24, 'research param overrides reach every variant');
    for (const rule of core.definition.rules) assert.ok(full.definition.rules.includes(rule), 'core rules survive in full');
    assert.ok(core.definition.rules.includes('net_reward_risk_above_minimum'));
    assert.ok(core.definition.rules.includes('trigger_confirmed'));
    // The variants' rule sets are ordered, deterministic and validated (buildVariant validates every definition)
    assert.ok(new Set(full.definition.rules).size === full.definition.rules.length);
  }
  // validateRegistry refuses duplicate playbook ids, so each variant definition is validated on its own
  for (const v of variants) validateRegistry([v.definition]);
});

test('variants: isolation and ablation families differ from their reference by the component under test', () => {
  const variants = buildVariants(baseConfig());
  for (const pb of listPlaybooks()) {
    const core = variants.find((v) => v.label === `${pb.id}::core`)!;
    const full = variants.find((v) => v.label === `${pb.id}::full`)!;
    const isos = variants.filter((v) => v.label.startsWith(`${pb.id}::iso:`));
    const abls = variants.filter((v) => v.label.startsWith(`${pb.id}::abl:`));
    assert.ok(isos.length > 0 && abls.length > 0);
    for (const iso of isos) {
      // core + exactly the component's rules
      const extra = iso.definition.rules.filter((r) => !core.definition.rules.includes(r));
      assert.ok(extra.length >= 0);
      assert.ok(iso.definition.rules.length >= core.definition.rules.length);
      for (const r of iso.definition.rules) assert.ok(core.definition.rules.includes(r) || extra.includes(r));
    }
    for (const abl of abls) {
      // full minus exactly one component
      const missing = full.definition.rules.filter((r) => !abl.definition.rules.includes(r));
      assert.equal(missing.length, 1, `${abl.label} must remove exactly one rule, removed ${missing.join(',')}`);
    }
  }
});

test('variants: pairs follow the config, and duplicate definitions are refused', () => {
  const withPairs = baseConfig();
  withPairs.pairs = ['sweep', 'session'];
  const variants = buildVariants(withPairs);
  const pairNames = variants.filter((v) => v.name.startsWith('pair:')).map((v) => v.name);
  assert.equal(pairNames.length, listPlaybooks().length, 'one sweep+session pair per playbook');
  assert.ok(pairNames.every((p) => p === 'pair:sweep+session'));

  const noPairs = baseConfig();
  noPairs.pairs = 'none';
  assert.ok(buildVariants(noPairs).every((v) => !v.name.startsWith('pair:')));

  const reduced = baseConfig();
  reduced.isolation = false;
  reduced.ablation = false;
  reduced.pairs = 'none';
  reduced.sessionPreset = 'none';
  // core and full stay distinct definitions while the registry default has components on
  const reducedVariants = buildVariants(reduced);
  assert.equal(reducedVariants.length, 2 * listPlaybooks().length);
});

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

test('segmentBounds: day-floored chronological thirds that cover the window, or an error', () => {
  const from = T;
  const to = from + 30 * DAY;
  const [train, validation, holdout] = segmentBounds(from, to, { train: 0.5, validation: 0.25, holdout: 0.25 });
  assert.equal(train.start, from);
  assert.ok(train.end % DAY === 0, 'boundaries are floored to UTC day starts');
  assert.equal(validation.start, train.end);
  assert.equal(holdout.start, validation.end, 'holdout starts where validation ends');
  assert.ok(holdout.end > to, 'holdout reaches the end of the window');
  assert.equal(segmentOf(from, [train, validation, holdout]), 'train');
  assert.equal(segmentOf(holdout.start, [train, validation, holdout]), 'holdout');
  assert.equal(segmentOf(to, [train, validation, holdout]), 'holdout');
  assert.equal(segmentOf(from - 1, [train, validation, holdout]), null);
  assert.throws(() => segmentBounds(from, to, { train: 0.5, validation: 0.5, holdout: 0.5 }), /must sum to 1/);
  assert.throws(() => segmentBounds(from, from + 2 * DAY, { train: 0.34, validation: 0.33, holdout: 0.33 }), /segment is empty/);
});

// ---------------------------------------------------------------------------
// Metrics and controls on hand-built trades
// ---------------------------------------------------------------------------

const trade = (over: Partial<TradeRecord>): TradeRecord => ({
  setupId: 's', direction: 'LONG', decidedAt: T, filledAt: T + M5, resolvedAt: T + 10 * M5, label: 'TARGET',
  netR: 1, barsHeld: 5, maeR: 0.2, mfeR: 1.1, costR: 0.08, hourUtc: 13, ...over,
});

test('computeMetrics: expectancy, win rate, profit factor, drawdown and splits over hand-built trades', () => {
  const cfg = baseConfig();
  const trades: TradeRecord[] = [
    trade({ netR: 1.5, label: 'TARGET', direction: 'LONG', hourUtc: 13 }),
    trade({ netR: 0.5, label: 'TIMEOUT', direction: 'LONG', hourUtc: 9, decidedAt: T + DAY, filledAt: T + DAY + M5 }),
    trade({ netR: -1, label: 'STOP', direction: 'SHORT', hourUtc: 2, decidedAt: T + 2 * DAY, filledAt: T + 2 * DAY + M5 }),
    trade({ netR: null, label: 'NOT_FILLED', direction: 'LONG', hourUtc: 20, decidedAt: T + 3 * DAY, filledAt: null, resolvedAt: T + 3 * DAY + 24 * M5 }),
  ];
  const m = computeMetrics(trades, cfg, { bootstrapSeed: 7, pending: 0, triggerFrameMs: M5 });
  assert.equal(m.decisions, 4);
  assert.equal(m.filled, 3);
  assert.equal(m.notFilled, 1);
  assert.ok(Math.abs(m.fillRate! - 0.75) < 1e-9);
  assert.ok(Math.abs(m.evR! - (1.5 + 0.5 - 1) / 3) < 1e-9);
  assert.ok(Math.abs(m.winRate! - 2 / 3) < 1e-9);
  assert.ok(Math.abs(m.profitFactor! - 2 / 1) < 1e-9);
  assert.ok(Math.abs(m.maxDrawdownR! - 1) < 1e-9, 'cumulative 1.5, 2.0, 1.0 draws down 1R from the peak');
  assert.ok(Math.abs(m.avgMfeR! - (1.1 * 3) / 3) < 1e-9);
  assert.ok(m.bootstrap !== null && m.bootstrap.n === 3);
  assert.deepEqual(Object.keys(m.splits.direction).sort(), ['LONG', 'SHORT']);
  assert.equal(m.splits.direction.SHORT!.filled, 1);
  assert.ok(m.splits.session['new_york']!.filled >= 1);
  assert.ok(m.splits.session['asia']!.filled >= 1);
  // sessionOf buckets the decision hour
  assert.equal(sessionOf(3), 'asia');
  assert.equal(sessionOf(9), 'london');
  assert.equal(sessionOf(13), 'new_york');
  assert.equal(sessionOf(21), 'off_hours');
});

test('flip and permutation: the mirror null inverts the mean and the test is deterministic', () => {
  const trades: TradeRecord[] = [trade({ netR: 2 }), trade({ netR: -1 }), trade({ netR: 0.5 })];
  const mean = (2 - 1 + 0.5) / 3;
  assert.ok(Math.abs(flipMeanR(trades)! + mean) < 1e-9);
  const a = permutationTest([2, -1, 0.5], 500, 42);
  const b = permutationTest([2, -1, 0.5], 500, 42);
  assert.equal(a.pValue, b.pValue, 'same seed, same p-value');
  assert.equal(a.nullP95R, b.nullP95R);
  assert.ok(a.pValue! > 0 && a.pValue! <= 1);
  assert.equal(permutationTest([], 100, 1).pValue, null);
});

const CONTROL_CANDLES: Candle[] = [
  { openTime: T, open: 100, high: 100.4, low: 99.95, close: 100.2, volume: 10 },
  { openTime: T + M5, open: 100.2, high: 100.6, low: 100.0, close: 100.4, volume: 10 },
  { openTime: T + 2 * M5, open: 100.4, high: 101.2, low: 100.3, close: 101.0, volume: 10 },
  { openTime: T + 3 * M5, open: 101.0, high: 101.3, low: 100.8, close: 101.2, volume: 10 },
  { openTime: T + 4 * M5, open: 101.2, high: 101.4, low: 101.0, close: 101.3, volume: 10 },
];
const PLAN = { entry: 100, stop: 99, target: 101 };
const DECISION: PlaybookDecisionRecord = {
  type: 'decision', setupId: 'x', playbookId: 'breakout_retest', version: 3, registryVersion: 3, symbol: 'SOLUSDT',
  direction: 'LONG', triggerFrame: '5m', decidedAt: T, plan: PLAN, grade: null, bucket: 'b', evaluations: [],
};

test('cost curve: multiplier 1 reproduces the baseline, multiplied costs reduce a winner', () => {
  const baseline = resolveOutcome({ direction: 'LONG', plan: PLAN, triggeredAt: T, frame: '5m', candles: CONTROL_CANDLES }, POLICY);
  assert.equal(baseline.label, 'TARGET');
  const curve = costCurve([DECISION], '5m', CONTROL_CANDLES, POLICY, [1, 4]);
  assert.equal(curve[0].n, 1);
  assert.ok(Math.abs(curve[0].evR! - baseline.netR!) < 1e-9, 'the baseline multiplier reproduces the journal outcome');
  assert.ok(curve[1].evR! < curve[0].evR!, 'quadrupled costs reduce the winner');
});

test('delayed entries: shifting the trigger past the move destroys the outcome', () => {
  const onTime = delayedExpectancy([DECISION], '5m', CONTROL_CANDLES, POLICY, 0);
  assert.equal(onTime.n, 1);
  assert.ok(Math.abs(onTime.evR! - resolveOutcome({ direction: 'LONG', plan: PLAN, triggeredAt: T, frame: '5m', candles: CONTROL_CANDLES }, POLICY).netR!) < 1e-9);
  const late = delayedExpectancy([DECISION], '5m', CONTROL_CANDLES, POLICY, 2);
  assert.equal(late.n, 0, 'two bars later the target is hit before any fill: NOT_FILLED');
  assert.equal(late.evR, null);
});

test('atrPctAt: the zone-frame ATR fraction at the bar that closed before t', () => {
  const zone: Candle[] = Array.from({ length: 30 }, (_, i) => ({
    openTime: T - (30 - i) * FRAME_MS['15m'], open: 100, high: 101, low: 99, close: 100.5, volume: 10,
  }));
  const pct = atrPctAt(zone, '15m', T + FRAME_MS['5m']);
  assert.ok(pct !== null && pct > 0);
  assert.equal(atrPctAt(zone, '15m', T - 30 * FRAME_MS['15m']), null, 'no closed zone bar before t');
});

// ---------------------------------------------------------------------------
// End-to-end study on synthetic candles
// ---------------------------------------------------------------------------

/** Deterministic random walk with trending stretches (mirrors tests/playbookReplay.test.ts). */
function walk(frame: SMCFrame, count: number, end: number, seed: number): Candle[] {
  let state = seed;
  const rand = () => { state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296; return state / 4_294_967_296; };
  let price = 150;
  return Array.from({ length: count }, (_, i) => {
    const drift = Math.sin(i / 40) * 0.002;
    const open = price;
    const close = open * (1 + drift + (rand() - 0.5) * 0.012);
    price = close;
    const wick = open * rand() * 0.003;
    return { openTime: end - (count - i) * MS[frame], open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, volume: 50 + rand() * 200 };
  });
}

function studyCandles(days: number, to: number, ttlBars: number) {
  const end = to + (ttlBars + POLICY.horizonBars + 5) * M5;
  return {
    '5m': walk('5m', Math.ceil((days * DAY) / M5) + 300 + ttlBars + POLICY.horizonBars + 10, end, 1),
    '15m': walk('15m', Math.ceil((days * DAY) / FRAME_MS['15m']) + 310, to, 2),
    '1h': walk('1h', Math.ceil((days * DAY) / FRAME_MS['1h']) + 310, to, 3),
    '4h': walk('4h', Math.ceil((days * DAY) / FRAME_MS['4h']) + 310, to, 4),
  };
}

test('end-to-end study: injected evidence flows through segments, selection, controls and the report', () => {
  const days = 12;
  const cfg = baseConfig();
  cfg.to = T + days * DAY;
  cfg.from = cfg.to - days * DAY;
  cfg.pairs = 'none';
  cfg.bootstrap = { confidence: 0.95, iterations: 500, seed: 11 };
  cfg.permutations = 200;
  cfg.selection = { minTrainFilled: 2, minValidationFilled: 1, minHoldoutFilled: 1, minDays: 1, alpha: 0.05, topK: 3 };
  cfg.paramOverrides = { maxTriggerBars: 24 };
  cfg.outcomePolicy = { ...POLICY };
  const candles = studyCandles(days, cfg.to, cfg.outcomePolicy.entryTtlBars);
  const [train, validation, holdout] = segmentBounds(cfg.from, cfg.to, cfg.splits);

  // Seed one variant's journal with resolved outcomes in every segment, so the decision path runs with evidence the
  // synthetic walk cannot guarantee on its own. The journal folds these in exactly like a previous partial run.
  const dirA = path.join(mkdtempSync(path.join(tmpdir(), 'ablation-a-')), 'study');
  mkdirSync(path.join(dirA, 'variants'), { recursive: true });
  const seeded = path.join(dirA, 'variants', 'sweep_mss_fvg_reversal__core.jsonl');
  const records: string[] = [];
  const inject = (segment: { start: number }, dayStep: number, count: number, minuteOfDay: number): void => {
    for (let i = 0; i < count; i += 1) {
      // A distinct minute-of-day per segment keeps the setup ids unique even when a train day lands in validation
      const decidedAt = segment.start + i * dayStep + minuteOfDay * 60_000;
      const id = `sweep_mss_fvg_reversal@3:SOLUSDT:LONG:${decidedAt}`;
      records.push(JSON.stringify({
        type: 'decision', setupId: id, playbookId: 'sweep_mss_fvg_reversal', version: 3, registryVersion: 3,
        symbol: 'SOLUSDT', direction: 'LONG', triggerFrame: '5m', decidedAt,
        plan: { entry: 100, stop: 99, target: 101 }, grade: null, bucket: 'sweep_mss_fvg_reversal@3|LONG', evaluations: [],
      }));
      records.push(JSON.stringify({
        type: 'outcome', setupId: id, label: 'TARGET', fillPrice: 100, filledAt: decidedAt, exitPrice: 101,
        resolvedAt: decidedAt + 30 * 60_000, netR: 2, barsHeld: 6,
        policy: { ...POLICY, takerFeeRate: POLICY.takerFeeRate, slippageRate: POLICY.slippageRate },
      }));
    }
  };
  inject(train, DAY, 8, 37);
  inject(validation, DAY, 3, 83);
  inject(holdout, DAY, 3, 149); // the holdout spans about three days: one seeded trade per day
  writeFileSync(seeded, `${records.join('\n')}\n`);

  const resultA = runAblationStudy({ config: cfg, candles, outDir: dirA, gitSha: 'test-sha', log: () => {} });
  const variants = buildVariants(cfg);
  assert.equal(resultA.manifest.variantCount, variants.length);
  assert.equal(resultA.manifest.studyId, studyIdOf(cfg));
  assert.equal(resultA.manifest.configHash, hashOfConfig(cfg));

  for (const file of ['REPORT.md', 'results.json', 'manifest.json', 'config.json']) {
    assert.ok(existsSync(path.join(dirA, file)), `${file} written`);
  }
  assert.ok(readdirSync(path.join(dirA, 'variants')).length <= variants.length, 'at most one journal per variant');
  assert.ok(reportHasTables(path.join(dirA, 'REPORT.md')));

  // Segments tile the decisions for every variant
  for (const v of resultA.variants) {
    const { full, train: tr, validation: va, holdout: ho } = v.metrics;
    assert.equal(full.filled, tr.filled + va.filled + ho.filled, `${v.spec.label}: segments tile the filled trades`);
    assert.equal(full.decisions, tr.decisions + va.decisions + ho.decisions, `${v.spec.label}: segments tile the decisions`);
  }

  // The seeded variant cleared train (8 TARGET trades), validation (3) and the holdout gates (3 over 3 days,
  // bootstrap lower bound 2R > 0, Holm family of the tested variants): it is the promoted candidate.
  const seededVariant = resultA.variants.find((v) => v.spec.label === 'sweep_mss_fvg_reversal::core')!;
  assert.ok(seededVariant.metrics.full.filled >= 14, `seeded variant filled ${seededVariant.metrics.full.filled}`);
  assert.ok(seededVariant.selection.considered, 'ranked into the top-K on train evidence');
  assert.ok(seededVariant.controls !== null, 'the promoted variant gets negative controls');
  assert.ok(seededVariant.controls.delay.length === cfg.delayBars.length);
  assert.ok(seededVariant.controls.costs.length === cfg.costMultipliers.length);
  assert.ok(seededVariant.controls.permutation.pValue !== null);
  assert.ok(seededVariant.selection.promoted, JSON.stringify(seededVariant.selection));
  assert.ok(readFileSync(path.join(dirA, 'REPORT.md'), 'utf8').includes('PROMOTED'));

  // Determinism: two fresh runs on separate directories produce identical variant evidence
  const dirB = path.join(mkdtempSync(path.join(tmpdir(), 'ablation-b-')), 'study');
  const dirC = path.join(mkdtempSync(path.join(tmpdir(), 'ablation-c-')), 'study');
  const resultB = runAblationStudy({ config: cfg, candles, outDir: dirB, gitSha: 'test-sha', log: () => {} });
  const resultC = runAblationStudy({ config: cfg, candles, outDir: dirC, gitSha: 'test-sha', log: () => {} });
  assert.deepEqual(JSON.parse(JSON.stringify(resultB.variants)), JSON.parse(JSON.stringify(resultC.variants)));

  // Resumability: the same directory folds the journals back and records nothing twice
  const resultAgain = runAblationStudy({ config: cfg, candles, outDir: dirA, gitSha: 'test-sha', log: () => {} });
  assert.equal(resultAgain.manifest.replay.decisionsRecorded, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(resultAgain.variants)), JSON.parse(JSON.stringify(resultA.variants)));
});

/** The report must carry the holdout table, the selection note and the caveats. */
function reportHasTables(file: string): boolean {
  const text = readFileSync(file, 'utf8');
  return text.includes('## Holdout results') && text.includes('## Reading notes') && text.includes('Holm');
}
