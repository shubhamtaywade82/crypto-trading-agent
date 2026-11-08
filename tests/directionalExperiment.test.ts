import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FundingSettlement } from '../src/market/directional/barriers.js';
import { renderReport, runExperiment, validateConfig, type ExperimentConfig, type SymbolData } from '../src/market/directional/experiment.js';
import { DEFAULT_ADMISSION_POLICY, type AdmissionPolicy } from '../src/market/directional/probability.js';
import type { MinuteInput } from '../src/market/rejection/types.js';
import { FLAT, FOLLOW, SWEEP_DEMAND, kline, type Px } from './rejectionFixtures.js';

const SYMBOL = 'SOLUSDT';
const M1 = 60_000;
const START = Date.UTC(2026, 0, 1);
const H = 3_600_000;
/** 25 flat minutes, a sell-led sweep that is reclaimed and confirmed at minute 26, then flat. One block is 60 minutes. */
const BLOCK: Px[] = [...Array.from({ length: 25 }, () => FLAT), SWEEP_DEMAND, FOLLOW, ...Array.from({ length: 33 }, () => FLAT)];
const BLOCKS = 300;

function minutes(symbol = SYMBOL, drop: number | null = null): MinuteInput[] {
  const out: MinuteInput[] = [];
  for (let b = 0; b < BLOCKS; b++) {
    BLOCK.forEach((p, i) => {
      const t = START + (b * BLOCK.length + i) * M1;
      if (t === drop) return;
      out.push(kline(t, p, symbol));
    });
  }
  return out;
}

/** A settlement every 8 hours across the window and the span an experiment needs after it. */
function settlements(from = START - 8 * H, to = START + 14 * 24 * H, gap: [number, number] | null = null): FundingSettlement[] {
  const out: FundingSettlement[] = [];
  for (let t = from; t <= to; t += 8 * H) {
    if (gap && t > gap[0] && t < gap[1]) continue;
    out.push({ time: t, rate: 0.0001, markPrice: 100 });
  }
  return out;
}

const CONFIG: ExperimentConfig = {
  experiment: 'EXP-TEST',
  description: 'synthetic',
  symbols: [SYMBOL],
  window: { from: '2026-01-01', to: '2026-01-15' },
  timeframe: '1m',
  costs: { feeBpsPerSide: 4, slippageBpsPerSide: 2 },
  fundingSource: 'file',
  stopBufferAtr: 0.1,
  targetsPct: [2],
  horizonsHours: [1],
  holdoutFraction: 0.3,
  criterionId: 'HOLDOUT_V1',
  tagsOfInterest: ['REJECTION_CONFIRMED'],
  scaleout: {
    maxBars: 60,
    singleTargetPct: 2,
    ladder: {
      rungs: [{ targetPct: 1, fraction: 0.25 }, { targetPct: 2, fraction: 0.25 }],
      trail: { kind: 'CHANDELIER', atrPeriod: 14, multiple: 2.5 },
      breakEvenAfterFirstRung: true,
    },
  },
};

/** Small floors so the synthetic run can reach the table. Production always uses DEFAULT_ADMISSION_POLICY. */
const POLICY: AdmissionPolicy = { ...DEFAULT_ADMISSION_POLICY, minSample: 20, minDays: 2, bootstrapIterations: 300 };

test('the pipeline finds every block, labels every setup, and reports both halves of the holdout split', () => {
  const r = runExperiment(CONFIG, [{ symbol: SYMBOL, minutes: minutes(), settlements: settlements() }], POLICY);
  assert.deepEqual(r.excluded, []);
  const s = r.symbols[0];
  assert.ok(s);
  assert.equal(s.events, BLOCKS, 'one confirmed rejection per block');
  assert.equal(s.setupsBySide.LONG, BLOCKS);
  assert.equal(s.setupsBySide.SHORT, 0);
  assert.equal(s.skippedNoFunding, 0);
  assert.equal(r.labelCount, BLOCKS);
  assert.equal(r.criterionId, 'HOLDOUT_V1');
  assert.ok(r.table.cells.some((c) => c.tag === 'REJECTION_CONFIRMED'));
  assert.ok(r.table.cells.every((c) => c.holdoutReasons.length > 0 || c.holdoutAccepted));
  assert.ok(r.scaleout && r.scaleout.singleTarget.n + r.scaleout.singleTarget.unresolved === BLOCKS);
});

test('a symbol with a missing minute is excluded with a reason, and the other symbols still run', () => {
  const data: SymbolData[] = [
    { symbol: SYMBOL, minutes: minutes(SYMBOL, START + 3 * M1), settlements: settlements() },
    { symbol: 'ETHUSDT', minutes: minutes('ETHUSDT'), settlements: settlements() },
  ];
  const r = runExperiment({ ...CONFIG, symbols: [SYMBOL, 'ETHUSDT'] }, data, POLICY);
  assert.equal(r.excluded.length, 1);
  assert.equal(r.excluded[0]?.symbol, SYMBOL);
  assert.match(r.excluded[0]?.reason ?? '', /^GAPS 1/);
  assert.equal(r.symbols.length, 1);
  assert.equal(r.symbols[0]?.symbol, 'ETHUSDT');
});

test('a settlement gap that a setup\'s window spans excludes the symbol, and the reason names the coverage failure', () => {
  const gapped = settlements(START - 8 * H, START + 14 * 24 * H, [START + 5 * H, START + 20 * H]);
  const r = runExperiment(CONFIG, [{ symbol: SYMBOL, minutes: minutes(), settlements: gapped }], POLICY);
  assert.equal(r.symbols.length, 0);
  assert.match(r.excluded[0]?.reason ?? '', /FUNDING_COVERAGE/);
});

test('settlements that end early skip the setups they cannot price, and count them', () => {
  const short = settlements(START - 8 * H, START + 2 * 24 * H);
  const r = runExperiment(CONFIG, [{ symbol: SYMBOL, minutes: minutes(), settlements: short }], POLICY);
  const s = r.symbols[0];
  assert.ok(s);
  assert.ok(s.skippedNoFunding > 0, 'setups beyond the settlement span are skipped');
  assert.equal(s.labels + s.skippedNoFunding, BLOCKS);
});

test('the criterion and the window are checked before anything runs', () => {
  assert.throws(() => validateConfig({ ...CONFIG, criterionId: 'HOLDOUT_V9' }), /does not match HOLDOUT_V1/);
  assert.throws(() => validateConfig({ ...CONFIG, window: { from: '2026-02-01', to: '2026-01-01' } }), /window/);
  assert.throws(() => validateConfig({ ...CONFIG, tagsOfInterest: ['NOT_A_CONTEXT'] as never }), /tagsOfInterest/);
  assert.throws(() => validateConfig({
    ...CONFIG,
    scaleout: { maxBars: 60, singleTargetPct: 2, ladder: { rungs: [{ targetPct: 1, fraction: 1 }], trail: { kind: 'FIXED_PCT', pct: 2 }, breakEvenAfterFirstRung: false } },
  }), /runner/);
});

test('the report names the window, the criterion, every excluded symbol, and the scale-out comparison', () => {
  const data: SymbolData[] = [
    { symbol: SYMBOL, minutes: minutes(SYMBOL, START + 3 * M1), settlements: settlements() },
    { symbol: 'ETHUSDT', minutes: minutes('ETHUSDT'), settlements: settlements() },
  ];
  const r = runExperiment({ ...CONFIG, symbols: [SYMBOL, 'ETHUSDT'] }, data, POLICY);
  const md = renderReport(r, ['REJECTION_CONFIRMED']);
  assert.match(md, /^# EXP-TEST/);
  assert.match(md, /Criterion: HOLDOUT_V1/);
  assert.match(md, /## Excluded symbols/);
  assert.match(md, /- SOLUSDT: GAPS/);
  assert.match(md, /## Scale-out/);
  assert.match(md, /Paired difference \(ladder − single\)/);
});
