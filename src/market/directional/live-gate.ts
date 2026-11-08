import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Side } from '../../types.js';
import { flowBarFromInput, validateOhlcv } from '../rejection/bars.js';
import { analyzeTimeframe, resolveEngineConfig } from '../rejection/engine.js';
import { TIMEFRAME_MS, barKnownAt, type FlowBar, type OhlcvInput, type RejectionEvent, type ZoneDirection } from '../rejection/types.js';
import { classifyExpansionContext, DEFAULT_CONTEXT_OPTIONS, type ExpansionContext } from './context.js';
import { validateConfig, type ExperimentConfig, type ExperimentResult } from './experiment.js';
import { DEFAULT_ADMISSION_POLICY, type TargetTable } from './probability.js';
import { assessDirectionalPotential, type DirectionalPotential } from './potential.js';
import { availableRoom } from './room.js';

/**
 * Live directional gate: a conflict veto on futures entries, driven by a committed experiment.
 *
 * - off (default): nothing is read or computed.
 * - shadow: each entry gets a directional verdict in the journal and the log. Nothing is blocked.
 * - enforce: an entry is blocked when a calibrated directional verdict for the OPPOSITE side exists. The gate can never
 *   create an entry. If the directional data cannot be evaluated, enforce blocks (fail closed, like the friction gate).
 *
 * The rules come from the experiment's own config.json, which is hash-checked against its manifest, so the live gate
 * applies exactly the rules that produced the table. Enforce refuses to start unless that experiment came from a clean
 * working tree and holds at least one holdout-accepted cell.
 */

export const DIRECTIONAL_GATE_MODES = ['off', 'shadow', 'enforce'] as const;
export type DirectionalGateMode = (typeof DIRECTIONAL_GATE_MODES)[number];

/** Freshness limit for the last closed 5m bar. An operational bound, not a trading parameter. */
export const DEFAULT_DIRECTIONAL_MAX_BAR_AGE_MS = 15 * 60_000;
/** How often the closed 5m bars are refreshed while the gate is on. */
export const DIRECTIONAL_REFRESH_MS = 60_000;
/** Bars requested per refresh. Covers ATR, volume and reference windows with headroom. */
export const DIRECTIONAL_KLINE_LIMIT = 300;
/** Fewer closed bars than this cannot host a confirmed rejection with its baselines. */
const MIN_BARS = 60;

export const directionalEnvSchema = z.object({
  DIRECTIONAL_GATE: z.enum(DIRECTIONAL_GATE_MODES).default('off'),
  /** Output folder of a committed experiment run: must contain config.json, manifest.json and results.json. */
  DIRECTIONAL_EXPERIMENT_DIR: z.string().trim().min(1).optional(),
  /** Widest stop accepted, percent of entry. Required when the gate is on: a risk parameter with no default. */
  DIRECTIONAL_MAX_STOP_PCT: z.coerce.number().positive().optional(),
  DIRECTIONAL_MAX_BAR_AGE_MS: z.coerce.number().int().positive().default(DEFAULT_DIRECTIONAL_MAX_BAR_AGE_MS),
}).superRefine((env, ctx) => {
  if (env.DIRECTIONAL_GATE === 'off') return;
  if (!env.DIRECTIONAL_EXPERIMENT_DIR) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DIRECTIONAL_EXPERIMENT_DIR'], message: `DIRECTIONAL_GATE=${env.DIRECTIONAL_GATE} needs DIRECTIONAL_EXPERIMENT_DIR, the output folder of a committed experiment` });
  }
  if (env.DIRECTIONAL_MAX_STOP_PCT === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DIRECTIONAL_MAX_STOP_PCT'], message: `DIRECTIONAL_GATE=${env.DIRECTIONAL_GATE} needs DIRECTIONAL_MAX_STOP_PCT: the widest stop accepted, in percent of entry. There is no default` });
  }
});

export interface ExperimentManifest {
  experiment: string;
  gitHead: string;
  workingTreeClean: boolean;
  configSha256: string;
  criterionId: string;
}

export interface LoadedExperiment {
  dir: string;
  experiment: string;
  config: ExperimentConfig;
  table: TargetTable;
  gitHead: string;
  workingTreeClean: boolean;
  calibratedCells: number;
}

/** Reads and checks an experiment folder. Throws with a specific reason on any mismatch. */
export function loadExperimentArtifact(dir: string): LoadedExperiment {
  const read = (file: string): string => {
    const p = path.join(dir, file);
    if (!existsSync(p)) throw new Error(`${file} is missing in ${dir}`);
    return readFileSync(p, 'utf8');
  };
  const rawConfig = read('config.json');
  const manifest = JSON.parse(read('manifest.json')) as ExperimentManifest;
  const result = JSON.parse(read('results.json')) as ExperimentResult;

  const sha = createHash('sha256').update(rawConfig).digest('hex');
  if (sha !== manifest.configSha256) throw new Error('config.json does not match the hash recorded in manifest.json');
  const config = JSON.parse(rawConfig) as ExperimentConfig;
  validateConfig(config);
  if (config.timeframe !== '5m') throw new Error(`the live gate runs 5m experiments only; this one is ${config.timeframe}`);
  if (result.criterionId !== DEFAULT_ADMISSION_POLICY.holdout.id) {
    throw new Error(`criterion ${result.criterionId} is not ${DEFAULT_ADMISSION_POLICY.holdout.id}`);
  }
  if (result.experiment !== config.experiment || manifest.experiment !== config.experiment) {
    throw new Error('experiment id differs between config, results and manifest');
  }
  return {
    dir,
    experiment: config.experiment,
    config,
    table: result.table,
    gitHead: manifest.gitHead,
    workingTreeClean: manifest.workingTreeClean,
    calibratedCells: result.table.cells.filter((c) => c.admitted && c.holdoutAccepted).length,
  };
}

export interface DirectionalGateState {
  mode: DirectionalGateMode;
  experiment: LoadedExperiment | null;
  maxStopPct: number | null;
  maxBarAgeMs: number;
  /** Why the configured gate cannot run. Enforce blocks entries while this is set. */
  refusal: string | null;
}

/**
 * Parses the environment and loads the experiment. Never throws: a refusal is a value.
 * An unrecognised DIRECTIONAL_GATE value is refused as enforce, so a typo blocks entries instead of disabling the gate.
 */
export function directionalGateFromEnv(env: NodeJS.ProcessEnv): DirectionalGateState {
  const raw = env.DIRECTIONAL_GATE ?? 'off';
  const off: DirectionalGateState = { mode: 'off', experiment: null, maxStopPct: null, maxBarAgeMs: DEFAULT_DIRECTIONAL_MAX_BAR_AGE_MS, refusal: null };
  if (!(DIRECTIONAL_GATE_MODES as readonly string[]).includes(raw)) {
    return { ...off, mode: 'enforce', refusal: `DIRECTIONAL_GATE must be off, shadow or enforce, got "${raw}"` };
  }
  if (raw === 'off') return off;
  const mode = raw as DirectionalGateMode;
  const parsed = directionalEnvSchema.safeParse(env);
  if (!parsed.success) {
    return { ...off, mode, refusal: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  const e = parsed.data;
  const base: DirectionalGateState = { mode, experiment: null, maxStopPct: e.DIRECTIONAL_MAX_STOP_PCT ?? null, maxBarAgeMs: e.DIRECTIONAL_MAX_BAR_AGE_MS, refusal: null };
  try {
    const experiment = loadExperimentArtifact(e.DIRECTIONAL_EXPERIMENT_DIR as string);
    if (mode === 'enforce' && !experiment.workingTreeClean) {
      return { ...base, experiment, refusal: 'the experiment was run from a dirty working tree; enforce needs a committed run' };
    }
    if (mode === 'enforce' && experiment.calibratedCells === 0) {
      return { ...base, experiment, refusal: 'no cell in this experiment is admitted and holdout-accepted; enforce has nothing to veto with' };
    }
    return { ...base, experiment };
  } catch (err) {
    return { ...base, refusal: err instanceof Error ? err.message : String(err) };
  }
}

/** Converts closed 5m klines into FlowBars. Forming bars and invalid rows are dropped and counted. */
export function closedFlowBars(raw: readonly OhlcvInput[], nowMs: number): { bars: FlowBar[]; dropped: number } {
  const tfMs = TIMEFRAME_MS['5m'];
  const bars: FlowBar[] = [];
  let dropped = 0;
  for (const k of raw) {
    if (k.openTime + tfMs > nowMs || !validateOhlcv(k, '5m').ok) {
      dropped += 1;
      continue;
    }
    const converted = flowBarFromInput(k, '5m');
    if (converted.ok) bars.push(converted.bar);
    else dropped += 1;
  }
  return { bars: bars.sort((a, b) => a.openTime - b.openTime), dropped };
}

export interface SideVerdict {
  side: Side;
  verdict: 'LONG' | 'SHORT' | 'NO_TRADE' | 'UNAVAILABLE';
  reason: string;
  potential: DirectionalPotential | null;
}

export interface DirectionalSnapshot {
  symbol: string;
  asOf: number | null;
  sides: Record<Side, SideVerdict>;
}

const unavailable = (symbol: string, reason: string, asOf: number | null): DirectionalSnapshot => ({
  symbol,
  asOf,
  sides: {
    LONG: { side: 'LONG', verdict: 'UNAVAILABLE', reason, potential: null },
    SHORT: { side: 'SHORT', verdict: 'UNAVAILABLE', reason, potential: null },
  },
});

/**
 * Evaluates both sides on the latest closed 5m bar. A side can only be actionable when a rejection was confirmed ON that
 * bar, the context at that bar is an entry context, and the calibrated table and known room both allow it.
 */
export function evaluateDirectionalSnapshot(input: {
  symbol: string;
  bars: readonly FlowBar[];
  experiment: LoadedExperiment;
  maxStopPct: number;
  nowMs: number;
  maxBarAgeMs: number;
}): DirectionalSnapshot {
  const { symbol, bars, experiment, maxStopPct, nowMs, maxBarAgeMs } = input;
  if (bars.length < MIN_BARS) return unavailable(symbol, `INSUFFICIENT_HISTORY ${bars.length}<${MIN_BARS}`, null);
  if (bars.some((b) => b.timeframe !== '5m')) return unavailable(symbol, 'WRONG_TIMEFRAME', null);
  const last = bars[bars.length - 1];
  if (!last || !last.complete) return unavailable(symbol, 'NO_CLOSED_BAR', null);
  const asOf = barKnownAt(last);
  if (asOf < nowMs - maxBarAgeMs) return unavailable(symbol, `STALE_BARS last closed bar at ${new Date(asOf).toISOString()}`, asOf);

  const cfg = experiment.config;
  const analysis = analyzeTimeframe(bars, '5m', resolveEngineConfig({ rejection: cfg.rejection }));
  const sideOf = (side: Side) => {
    const direction: ZoneDirection = side === 'LONG' ? 'DEMAND' : 'SUPPLY';
    const series = classifyExpansionContext(bars, analysis.events, { ...DEFAULT_CONTEXT_OPTIONS, ...cfg.context, side });
    const context = (series.states[series.states.length - 1] ?? 'NONE') as ExpansionContext;
    const contextPath = series.transitions.slice(-3).map((t) => t.to);
    const confirmed = analysis.events.filter((e): e is RejectionEvent =>
      e.direction === direction && e.status === 'CONFIRMED' && e.resolvedAt === asOf);
    const event = confirmed[confirmed.length - 1];
    if (!event) return { side, verdict: 'NO_TRADE' as const, reason: 'NO_CONFIRMED_REJECTION_ON_LAST_BAR', potential: null };
    const sign = side === 'LONG' ? 1 : -1;
    const entry = last.close;
    const stopPrice = event.extreme - sign * cfg.stopBufferAtr * event.atr;
    const room = availableRoom(side, entry, analysis.zones);
    const potential = assessDirectionalPotential({
      symbol, side, entry, stopPrice, context, contextPath, room, table: experiment.table, maxStopPct, validatedCapacityPct: null,
    });
    return {
      side,
      verdict: potential.direction === 'NO_TRADE' ? ('NO_TRADE' as const) : potential.direction,
      reason: potential.invalidationReason ?? 'CALIBRATED_DIRECTIONAL_VERDICT',
      potential,
    };
  };
  return { symbol, asOf, sides: { LONG: sideOf('LONG'), SHORT: sideOf('SHORT') } };
}

export interface ConflictVerdict {
  /** A calibrated verdict for the opposite side exists. */
  conflict: boolean;
  /** The directional data could not be evaluated. */
  unavailable: boolean;
  reason: string;
}

export function directionalConflict(snapshot: DirectionalSnapshot, entrySide: Side): ConflictVerdict {
  const opposite: Side = entrySide === 'LONG' ? 'SHORT' : 'LONG';
  const other = snapshot.sides[opposite];
  if (other.verdict === 'UNAVAILABLE') return { conflict: false, unavailable: true, reason: `UNAVAILABLE: ${other.reason}` };
  if (other.verdict === 'LONG' || other.verdict === 'SHORT') {
    return { conflict: true, unavailable: false, reason: `calibrated ${other.verdict} verdict opposes this ${entrySide} entry` };
  }
  return { conflict: false, unavailable: false, reason: `no calibrated ${opposite} verdict (${other.reason})` };
}
