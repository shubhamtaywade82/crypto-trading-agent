import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  closedFlowBars, directionalConflict, directionalGateFromEnv, evaluateDirectionalSnapshot, loadExperimentArtifact,
  type DirectionalSnapshot, type LoadedExperiment,
} from '../src/market/directional/live-gate.js';
import type { ExperimentConfig, ExperimentResult } from '../src/market/directional/experiment.js';
import { buildTargetTable, DEFAULT_ADMISSION_POLICY, type AdmissionPolicy } from '../src/market/directional/probability.js';
import type { Side } from '../src/types.js';
import { FLAT, FOLLOW, SWEEP_DEMAND, flowSeries, SYMBOL, type Px } from './rejectionFixtures.js';
import { synthLabels } from './directionalFixtures.js';

const M5 = 300_000;
const POLICY: AdmissionPolicy = { ...DEFAULT_ADMISSION_POLICY, minSample: 50, minDays: 5, bootstrapIterations: 500 };

const CONFIG: ExperimentConfig = {
  experiment: 'EXP-LIVE-TEST',
  description: 'test',
  symbols: [SYMBOL],
  window: { from: '2026-01-01', to: '2026-02-01' },
  timeframe: '5m',
  costs: { feeBpsPerSide: 4, slippageBpsPerSide: 2 },
  fundingSource: 'file',
  stopBufferAtr: 0.1,
  targetsPct: [1, 2],
  horizonsHours: [1],
  holdoutFraction: 0.3,
  criterionId: 'HOLDOUT_V1',
  tagsOfInterest: ['REJECTION_CONFIRMED'],
};

/** 30 flat 5m bars, a sell-led sweep, then the follow-through: a rejection confirmed on the LAST bar. */
function confirmedOnLastBar(): ReturnType<typeof flowSeries> {
  const pxs: Px[] = [...Array.from({ length: 70 }, () => FLAT), SWEEP_DEMAND, FOLLOW];
  return flowSeries('5m', pxs);
}

function experimentWith(table: LoadedExperiment['table'], calibratedCells: number): LoadedExperiment {
  return { dir: 'test', experiment: CONFIG.experiment, config: CONFIG, table, gitHead: 'abc', workingTreeClean: true, calibratedCells };
}

const EMPTY_TABLE = buildTargetTable(synthLabels({ days: 3, perDay: 5, winRate: 0.5 }), 0.34, POLICY);
const CALIBRATED_TABLE = buildTargetTable(
  synthLabels({ days: 40, perDay: 10, winRate: 0.75, tags: ['REJECTION_CONFIRMED'] }),
  0.3,
  POLICY,
);

test('the gate is off by default, and reads nothing when it is off', () => {
  const s = directionalGateFromEnv({});
  assert.equal(s.mode, 'off');
  assert.equal(s.refusal, null);
  assert.equal(s.experiment, null);
});

test('an unrecognised mode is refused as enforce, so a typo blocks entries instead of disabling the gate', () => {
  const s = directionalGateFromEnv({ DIRECTIONAL_GATE: 'enfoce' });
  assert.equal(s.mode, 'enforce');
  assert.match(s.refusal ?? '', /must be off, shadow or enforce/);
});

test('shadow and enforce refuse to start without an experiment folder and a stop limit', () => {
  const noDir = directionalGateFromEnv({ DIRECTIONAL_GATE: 'shadow', DIRECTIONAL_MAX_STOP_PCT: '3' });
  assert.match(noDir.refusal ?? '', /DIRECTIONAL_EXPERIMENT_DIR/);
  const noStop = directionalGateFromEnv({ DIRECTIONAL_GATE: 'enforce', DIRECTIONAL_EXPERIMENT_DIR: '/nowhere' });
  assert.match(noStop.refusal ?? '', /DIRECTIONAL_MAX_STOP_PCT/);
});

/** Writes a results/manifest/config folder the way the experiment CLI does, so the loader is tested on its real layout. */
function writeArtifact(opts: { configBytes?: string; criterionId?: string; clean?: boolean; table?: LoadedExperiment['table']; timeframe?: string }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dirgate-'));
  const config = { ...CONFIG, timeframe: opts.timeframe ?? '5m' };
  const raw = opts.configBytes ?? JSON.stringify(config, null, 2) + '\n';
  writeFileSync(path.join(dir, 'config.json'), raw);
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    experiment: CONFIG.experiment, gitHead: 'abc', workingTreeClean: opts.clean ?? true,
    configSha256: createHash('sha256').update(raw).digest('hex'), criterionId: 'HOLDOUT_V1',
  }));
  const result = {
    experiment: CONFIG.experiment, criterionId: opts.criterionId ?? 'HOLDOUT_V1', table: opts.table ?? CALIBRATED_TABLE,
  } as unknown as ExperimentResult;
  writeFileSync(path.join(dir, 'results.json'), JSON.stringify(result));
  return dir;
}

test('an experiment folder loads only when its config matches the hash it was run with', () => {
  const good = writeArtifact({});
  try {
    const loaded = loadExperimentArtifact(good);
    assert.equal(loaded.experiment, CONFIG.experiment);
    assert.ok(loaded.calibratedCells >= 1, 'the calibrated test table has an admitted cell');
  } finally {
    rmSync(good, { recursive: true, force: true });
  }

  const tampered = writeArtifact({ configBytes: JSON.stringify({ ...CONFIG, stopBufferAtr: 9 }) });
  try {
    // The config bytes are written, but the manifest hash belongs to the original config.
    writeFileSync(path.join(tampered, 'config.json'), JSON.stringify({ ...CONFIG, stopBufferAtr: 0.5 }));
    assert.throws(() => loadExperimentArtifact(tampered), /does not match the hash/);
  } finally {
    rmSync(tampered, { recursive: true, force: true });
  }
});

test('an experiment that is not 5m, or not under HOLDOUT_V1, is refused on load', () => {
  const hour = writeArtifact({ timeframe: '1h' });
  const wrongCriterion = writeArtifact({ criterionId: 'HOLDOUT_V9' });
  try {
    assert.throws(() => loadExperimentArtifact(hour), /5m experiments only/);
    assert.throws(() => loadExperimentArtifact(wrongCriterion), /HOLDOUT_V9 is not HOLDOUT_V1/);
  } finally {
    rmSync(hour, { recursive: true, force: true });
    rmSync(wrongCriterion, { recursive: true, force: true });
  }
});

test('enforce refuses an experiment with no holdout-accepted cell, and a dirty working tree', () => {
  const dir = writeArtifact({ table: EMPTY_TABLE });
  const dirty = writeArtifact({ clean: false });
  try {
    const none = directionalGateFromEnv({ DIRECTIONAL_GATE: 'enforce', DIRECTIONAL_EXPERIMENT_DIR: dir, DIRECTIONAL_MAX_STOP_PCT: '3' });
    assert.match(none.refusal ?? '', /nothing to veto with/);
    const unclean = directionalGateFromEnv({ DIRECTIONAL_GATE: 'enforce', DIRECTIONAL_EXPERIMENT_DIR: dirty, DIRECTIONAL_MAX_STOP_PCT: '3' });
    assert.match(unclean.refusal ?? '', /dirty working tree/);
    const shadow = directionalGateFromEnv({ DIRECTIONAL_GATE: 'shadow', DIRECTIONAL_EXPERIMENT_DIR: dir, DIRECTIONAL_MAX_STOP_PCT: '3' });
    assert.equal(shadow.refusal, null, 'shadow may run with no calibrated cell: it only records');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirty, { recursive: true, force: true });
  }
});

test('the snapshot is UNAVAILABLE when there is too little history, or the last bar is stale', () => {
  const exp = experimentWith(CALIBRATED_TABLE, 1);
  const bars = confirmedOnLastBar();
  const last = bars[bars.length - 1]!;
  const fresh = last.openTime + M5;
  const few = evaluateDirectionalSnapshot({ symbol: SYMBOL, bars: bars.slice(-10), experiment: exp, maxStopPct: 5, nowMs: fresh, maxBarAgeMs: 900_000 });
  assert.match(few.sides.LONG.reason, /INSUFFICIENT_HISTORY/);
  const stale = evaluateDirectionalSnapshot({ symbol: SYMBOL, bars, experiment: exp, maxStopPct: 5, nowMs: fresh + 3_600_000, maxBarAgeMs: 900_000 });
  assert.equal(stale.sides.LONG.verdict, 'UNAVAILABLE');
  assert.match(stale.sides.LONG.reason, /STALE_BARS/);
});

test('a LONG needs a rejection confirmed on the last bar and a calibrated table; unknown room still blocks it', () => {
  const bars = confirmedOnLastBar();
  const fresh = bars[bars.length - 1]!.openTime + M5;
  const withTable = evaluateDirectionalSnapshot({ symbol: SYMBOL, bars, experiment: experimentWith(CALIBRATED_TABLE, 1), maxStopPct: 5, nowMs: fresh, maxBarAgeMs: 900_000 });
  assert.equal(withTable.sides.LONG.verdict, 'NO_TRADE', 'no opposing zone is known, so room is unverified');
  assert.match(withTable.sides.LONG.reason, /ROOM_UNVERIFIED/);
  const noTable = evaluateDirectionalSnapshot({ symbol: SYMBOL, bars, experiment: experimentWith(EMPTY_TABLE, 0), maxStopPct: 5, nowMs: fresh, maxBarAgeMs: 900_000 });
  assert.equal(noTable.sides.LONG.verdict, 'NO_TRADE');
  assert.match(noTable.sides.LONG.reason, /NO_ADMITTED_PROBABILITY/);
  const shortSide = evaluateDirectionalSnapshot({ symbol: SYMBOL, bars, experiment: experimentWith(CALIBRATED_TABLE, 1), maxStopPct: 5, nowMs: fresh, maxBarAgeMs: 900_000 });
  assert.match(shortSide.sides.SHORT.reason, /NO_CONFIRMED_REJECTION_ON_LAST_BAR/);
});

test('the conflict veto blocks an entry only against a calibrated opposing verdict, and never on NO_TRADE', () => {
  const mk = (long: 'LONG' | 'SHORT' | 'NO_TRADE' | 'UNAVAILABLE', short: 'LONG' | 'SHORT' | 'NO_TRADE' | 'UNAVAILABLE'): DirectionalSnapshot => {
    const side = (s: Side, v: typeof long) => ({ side: s, verdict: v, reason: v === 'UNAVAILABLE' ? 'STALE_BARS' : 'x', potential: null });
    return { symbol: SYMBOL, asOf: 0, sides: { LONG: side('LONG', long), SHORT: side('SHORT', short) } };
  };
  assert.equal(directionalConflict(mk('NO_TRADE', 'SHORT'), 'LONG').conflict, true, 'a calibrated SHORT vetoes a LONG');
  assert.equal(directionalConflict(mk('NO_TRADE', 'SHORT'), 'SHORT').conflict, false, 'the same side is never vetoed');
  assert.equal(directionalConflict(mk('NO_TRADE', 'NO_TRADE'), 'LONG').conflict, false, 'NO_TRADE never vetoes');
  assert.equal(directionalConflict(mk('NO_TRADE', 'UNAVAILABLE'), 'LONG').unavailable, true, 'unavailable is reported, not hidden');
});

test('closed-bar conversion drops a forming bar and invalid rows, and keeps the rest in time order', () => {
  const t = Date.UTC(2026, 0, 1);
  const row = (openTime: number, high = 101, takerBuy = 5) => ({
    symbol: SYMBOL, openTime, open: 100, high, low: 99, close: 100, baseVolume: 10, quoteVolume: 1000, trades: 5, takerBuyBaseVolume: takerBuy,
  });
  const raw = [row(t + M5), row(t), row(t + 2 * M5, 98), row(t + 3 * M5)];
  const now = t + 3 * M5 + 1000; // the bar at t + 3·5m is still forming
  const { bars, dropped } = closedFlowBars(raw, now);
  assert.deepEqual(bars.map((b) => b.openTime), [t, t + M5]);
  assert.equal(dropped, 2, 'one forming bar and one invalid row (high below low)');
  assert.ok(bars.every((b) => b.minuteCount === 5 && b.complete));
});
