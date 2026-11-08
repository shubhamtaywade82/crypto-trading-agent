import { aggregateMinutes, ingestMinutes, minuteCoverageByDay } from '../rejection/bars.js';
import { analyzeTimeframe, resolveEngineConfig } from '../rejection/engine.js';
import {
  REJECTION_TIMEFRAMES, TIMEFRAME_MS, barKnownAt,
  type FlowBar, type MinuteInput, type RejectionConfig, type RejectionTimeframe,
} from '../rejection/types.js';
import { labelBarriers, MAX_SETTLEMENT_GAP_MS, type BarrierLabel, type BarrierSetup, type CostModel, type FundingSettlement } from './barriers.js';
import { classifyExpansionContext, DEFAULT_CONTEXT_OPTIONS, EXPANSION_CONTEXTS, type ContextOptions, type ExpansionContext } from './context.js';
import {
  buildTargetTable, DEFAULT_ADMISSION_POLICY, type AdmissionPolicy, type TargetTable,
} from './probability.js';
import {
  pairedDifference, replayPolicy, summarizeReplays,
  type ExitPolicy, type PairedDifference, type ReplaySummary, type TradeReplay, type TrailRule,
} from './scaleout-replay.js';
import { setupsFromRejections } from './setups.js';

/**
 * Pre-specified experiment. The JSON file is committed before the run, and its SHA-256 is written to the manifest.
 * Costs and funding come from the file. Nothing is defaulted.
 */
export interface ExperimentConfig {
  experiment: string;
  description: string;
  symbols: string[];
  /** UTC dates, YYYY-MM-DD. `from` is inclusive and `to` exclusive. */
  window: { from: string; to: string };
  timeframe: RejectionTimeframe;
  costs: { feeBpsPerSide: number; slippageBpsPerSide: number };
  fundingSource: 'db' | 'file';
  rejection?: Partial<RejectionConfig>;
  context?: Partial<Omit<ContextOptions, 'side'>>;
  stopBufferAtr: number;
  targetsPct: number[];
  horizonsHours: number[];
  holdoutFraction: number;
  criterionId: string;
  /** Context tags reported in the table, alongside the untagged baseline. */
  tagsOfInterest: ExpansionContext[];
  scaleout?: {
    maxBars: number;
    singleTargetPct: number;
    ladder: { rungs: { targetPct: number; fraction: number }[]; trail: TrailRule; breakEvenAfterFirstRung: boolean };
  };
}

export function validateConfig(c: ExperimentConfig, policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY): void {
  if (!c.experiment || c.symbols.length === 0) throw new Error('config needs an experiment id and at least one symbol');
  if (c.criterionId !== policy.holdout.id) throw new Error(`criterionId ${c.criterionId} does not match ${policy.holdout.id}`);
  if (!(REJECTION_TIMEFRAMES as readonly string[]).includes(c.timeframe)) throw new Error(`unsupported timeframe ${c.timeframe}`);
  const from = Date.parse(`${c.window.from}T00:00:00Z`);
  const to = Date.parse(`${c.window.to}T00:00:00Z`);
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) throw new Error('window needs valid UTC dates with to > from');
  if (!(c.holdoutFraction > 0 && c.holdoutFraction < 1)) throw new Error('holdoutFraction must be in (0, 1)');
  if (!(c.stopBufferAtr >= 0)) throw new Error('stopBufferAtr must be >= 0');
  if (c.targetsPct.length === 0 || c.horizonsHours.length === 0) throw new Error('targetsPct and horizonsHours must be non-empty');
  if (c.tagsOfInterest.length === 0 || c.tagsOfInterest.some((t) => !EXPANSION_CONTEXTS.includes(t))) {
    throw new Error('tagsOfInterest must be non-empty and name known contexts');
  }
  if (c.scaleout) {
    const booked = c.scaleout.ladder.rungs.reduce((acc, r) => acc + r.fraction, 0);
    if (!(booked > 0 && booked < 1)) throw new Error('scaleout ladder must leave a runner');
  }
}

/** The span of time a settlement list must cover for this experiment: the longest horizon, plus one funding interval. */
export function requiredFundingSpanMs(c: ExperimentConfig): number {
  const horizonMs = Math.max(...c.horizonsHours, c.scaleout ? (c.scaleout.maxBars * TIMEFRAME_MS[c.timeframe]) / 3_600_000 : 0) * 3_600_000;
  return horizonMs + MAX_SETTLEMENT_GAP_MS;
}

export interface SymbolData {
  symbol: string;
  minutes: readonly MinuteInput[];
  settlements: readonly FundingSettlement[];
}

export interface ExcludedSymbol {
  symbol: string;
  reason: string;
}

export interface SymbolSummary {
  symbol: string;
  minutesInWindow: number;
  bars: number;
  daysBelowFullCoverage: number;
  events: number;
  setupsBySide: { LONG: number; SHORT: number };
  /** Setups not labelled because their horizon falls outside the settlement span. */
  skippedNoFunding: number;
  labels: number;
  contextCounts: Partial<Record<ExpansionContext, number>>;
}

export interface ScaleoutResult {
  maxBars: number;
  singleTarget: ReplaySummary;
  ladder: ReplaySummary;
  paired: PairedDifference;
  fundingModels: string[];
}

export interface ExperimentResult {
  experiment: string;
  criterionId: string;
  window: ExperimentConfig['window'];
  timeframe: RejectionTimeframe;
  symbols: SymbolSummary[];
  excluded: ExcludedSymbol[];
  labelCount: number;
  table: TargetTable;
  scaleout: ScaleoutResult | null;
}

class Exclusion extends Error {}

interface SymbolRun {
  labels: BarrierLabel[];
  summary: SymbolSummary;
  single: TradeReplay[];
  ladder: TradeReplay[];
}

const MS_PER_HOUR = 3_600_000;

function labelSymbol(c: ExperimentConfig, data: SymbolData): SymbolRun {
  const fromMs = Date.parse(`${c.window.from}T00:00:00Z`);
  const toMs = Date.parse(`${c.window.to}T00:00:00Z`);
  const tfMs = TIMEFRAME_MS[c.timeframe];
  const inWindow = data.minutes.filter((m) => m.openTime >= fromMs && m.openTime < toMs);
  const ingest = ingestMinutes(data.symbol, inWindow);
  if (ingest.rejected.length > 0) throw new Exclusion(`REJECTED_KLINES ${ingest.rejected.length} (first: ${ingest.rejected[0]?.reason})`);
  if (ingest.conflicts.length > 0) throw new Exclusion(`CONFLICTING_DUPLICATES ${ingest.conflicts.length}`);
  if (ingest.gaps.length > 0) {
    const first = ingest.gaps[0];
    throw new Exclusion(`GAPS ${ingest.gaps.length} (first after ${new Date(first?.fromOpenTime ?? 0).toISOString()}, ${first?.missingMinutes} min)`);
  }
  const coverage = minuteCoverageByDay(ingest.bars);
  const bars: FlowBar[] = aggregateMinutes(ingest.bars, c.timeframe);
  const analysis = analyzeTimeframe(bars, c.timeframe, resolveEngineConfig({ rejection: c.rejection }));

  const settlements = [...data.settlements].sort((a, b) => a.time - b.time);
  const first = settlements[0];
  const last = settlements[settlements.length - 1];
  if (!first || !last) throw new Exclusion('NO_FUNDING_SETTLEMENTS');
  const span = requiredFundingSpanMs(c);
  const covered = (entryTime: number): boolean => entryTime >= first.time - MAX_SETTLEMENT_GAP_MS && entryTime + span <= last.time + MAX_SETTLEMENT_GAP_MS;
  const costs: CostModel = {
    feeBpsPerSide: c.costs.feeBpsPerSide,
    slippageBpsPerSide: c.costs.slippageBpsPerSide,
    funding: { kind: 'SETTLEMENTS', settlements },
  };
  const spec = { targetsPct: c.targetsPct, horizonsHours: c.horizonsHours };

  const labels: BarrierLabel[] = [];
  const single: TradeReplay[] = [];
  const ladder: TradeReplay[] = [];
  const setupsBySide = { LONG: 0, SHORT: 0 };
  const contextCounts: Partial<Record<ExpansionContext, number>> = {};
  let skippedNoFunding = 0;

  for (const side of ['LONG', 'SHORT'] as const) {
    const contextOptions: ContextOptions = { ...DEFAULT_CONTEXT_OPTIONS, ...c.context, side };
    const series = classifyExpansionContext(bars, analysis.events, contextOptions);
    const built = setupsFromRejections(bars, analysis.events, series, { side, stopBufferAtr: c.stopBufferAtr });
    const setups: BarrierSetup[] = [];
    for (const s of built.setups) {
      const entry = bars[s.entryIndex];
      if (!entry) continue;
      if (!covered(barKnownAt(entry))) {
        skippedNoFunding += 1;
        continue;
      }
      setups.push(s);
      const ctx = s.tags[0];
      if (ctx) contextCounts[ctx as ExpansionContext] = (contextCounts[ctx as ExpansionContext] ?? 0) + 1;
    }
    setupsBySide[side] += setups.length;

    try {
      labels.push(...labelBarriers(bars, setups, spec, costs));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('FUNDING_COVERAGE')) throw new Exclusion(msg);
      throw err;
    }

    if (c.scaleout) {
      const opts = { maxBars: c.scaleout.maxBars, costs };
      const singlePolicy: ExitPolicy = { kind: 'SINGLE_TARGET', targetPct: c.scaleout.singleTargetPct };
      const ladderPolicy: ExitPolicy = { kind: 'LADDER_RUNNER', ...c.scaleout.ladder };
      single.push(...replayPolicy(bars, setups, singlePolicy, opts));
      ladder.push(...replayPolicy(bars, setups, ladderPolicy, opts));
    }
  }

  const daysBelowFullCoverage = coverage.filter((d) => d.coverage < 1).length;
  return {
    labels,
    single,
    ladder,
    summary: {
      symbol: data.symbol,
      minutesInWindow: ingest.bars.length,
      bars: bars.length,
      daysBelowFullCoverage,
      events: analysis.events.length,
      setupsBySide,
      skippedNoFunding,
      labels: labels.length,
      contextCounts,
    },
  };
}

/**
 * Runs an experiment over the given symbols. A symbol that fails an integrity gate (gaps, rejected or conflicting klines,
 * or funding that cannot be covered) is excluded, and the reason is recorded in the result. It is never silently dropped.
 * Admission uses the policy given; production passes DEFAULT_ADMISSION_POLICY.
 */
export function runExperiment(c: ExperimentConfig, data: readonly SymbolData[], policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY): ExperimentResult {
  validateConfig(c, policy);
  const labels: BarrierLabel[] = [];
  const symbols: SymbolSummary[] = [];
  const excluded: ExcludedSymbol[] = [];
  const single: TradeReplay[] = [];
  const ladder: TradeReplay[] = [];

  for (const d of data) {
    try {
      const run = labelSymbol(c, d);
      labels.push(...run.labels);
      symbols.push(run.summary);
      single.push(...run.single);
      ladder.push(...run.ladder);
    } catch (err) {
      if (err instanceof Exclusion) excluded.push({ symbol: d.symbol, reason: err.message });
      else throw err;
    }
  }

  // A chronological split needs two distinct entry times. Without them there is nothing to admit, and the exclusions
  // are the result. Report an empty table instead of failing.
  const distinctTimes = new Set(labels.map((l) => l.entryTime)).size;
  const table = distinctTimes >= 2
    ? buildTargetTable(labels, c.holdoutFraction, policy)
    : { criterionId: policy.holdout.id, policy, holdoutFraction: c.holdoutFraction, cutoffTime: 0, purged: 0, familySize: 0, cells: [] };
  let scaleout: ScaleoutResult | null = null;
  if (c.scaleout) {
    const fundingModels = [...new Set([...single, ...ladder].filter((t) => t.resolved).map((t) => t.fundingModel))].sort();
    scaleout = {
      maxBars: c.scaleout.maxBars,
      singleTarget: summarizeReplays(single, c.scaleout.maxBars),
      ladder: summarizeReplays(ladder, c.scaleout.maxBars),
      paired: pairedDifference(single, ladder, { iterations: policy.bootstrapIterations, seed: policy.bootstrapSeed, confidence: policy.confidence }),
      fundingModels,
    };
  }

  return {
    experiment: c.experiment,
    criterionId: policy.holdout.id,
    window: c.window,
    timeframe: c.timeframe,
    symbols,
    excluded,
    labelCount: labels.length,
    table,
    scaleout,
  };
}

const pct = (x: number | null | undefined, digits = 3): string => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(digits));
const ci = (i: { low: number; high: number } | null | undefined): string => (i ? `[${i.low.toFixed(3)}, ${i.high.toFixed(3)}]` : 'n/a');

/** Markdown report. Lists every cell in the tags of interest plus the untagged baseline, with both halves of the split. */
export function renderReport(r: ExperimentResult, tags: readonly ExpansionContext[]): string {
  const lines: string[] = [];
  lines.push(`# ${r.experiment}`, '');
  lines.push(`Window: ${r.window.from} to ${r.window.to} (UTC, exclusive end). Timeframe: ${r.timeframe}. Criterion: ${r.criterionId}.`);
  const cutoff = r.table.cutoffTime > 0 ? new Date(r.table.cutoffTime).toISOString() : 'n/a';
  lines.push(`Labels: ${r.labelCount}. Holdout cut-off: ${cutoff}. Purged: ${r.table.purged}.`);
  if (r.labelCount === 0) lines.push('', 'No labels: every symbol was excluded, so no table was built. See the exclusions below.');
  lines.push('');
  lines.push('## Symbols', '', '| symbol | minutes | bars | days < full | events | LONG setups | SHORT setups | skipped (funding) | labels |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const s of r.symbols) {
    lines.push(`| ${s.symbol} | ${s.minutesInWindow} | ${s.bars} | ${s.daysBelowFullCoverage} | ${s.events} | ${s.setupsBySide.LONG} | ${s.setupsBySide.SHORT} | ${s.skippedNoFunding} | ${s.labels} |`);
  }
  if (r.excluded.length > 0) {
    lines.push('', '## Excluded symbols', '');
    for (const e of r.excluded) lines.push(`- ${e.symbol}: ${e.reason}`);
  }
  lines.push('', '## Cells', '', 'Holdout columns use labels entered after the cut-off. Admission is decided on training labels only.', '');
  lines.push('| cell | n | days | train hit [day-clustered 90%] | holdout n | holdout hit | gap | holdout accepted | admitted | train EV % | holdout EV % |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  const wanted = new Set<string | null>([null, ...tags]);
  for (const cell of r.table.cells) {
    if (!wanted.has(cell.tag)) continue;
    const t = cell.train;
    const h = cell.holdout;
    const gap = h?.hitRate !== null && h?.hitRate !== undefined && t.hitRate !== null ? h.hitRate - t.hitRate : null;
    lines.push(`| ${cell.key} | ${t.n} | ${t.days} | ${pct(t.hitRate)} ${ci(t.hitInterval)} | ${h?.n ?? 0} | ${pct(h?.hitRate ?? null)} | ${pct(gap)} | ${cell.holdoutAccepted ? 'yes' : 'no'} | ${cell.admitted ? 'yes' : 'no'} | ${pct(t.netMeanPct)} | ${pct(h?.netMeanPct ?? null)} |`);
  }
  const published = r.table.cells.filter((c) => c.admitted && c.holdoutAccepted);
  lines.push('', `Cells with a publishable probability: ${published.length} of ${r.table.familySize} tested (Holm family).`);
  lines.push('', '## Reasons for cells that did not pass', '');
  for (const cell of r.table.cells) {
    if (!wanted.has(cell.tag) || (cell.admitted && cell.holdoutAccepted)) continue;
    lines.push(`- ${cell.key}: ${[...cell.reasons, ...cell.holdoutReasons].join('; ') || 'not testable'}`);
  }
  if (r.scaleout) {
    const s = r.scaleout;
    lines.push('', `## Scale-out (paired, max ${s.maxBars} bars, funding: ${s.fundingModels.join(', ') || 'none'})`, '');
    lines.push('| policy | n | unresolved | mean R | median R | win rate | profit factor | max drawdown R | p05 R | worst R | exposure |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [label, sum] of [['single target', s.singleTarget], ['ladder + runner', s.ladder]] as const) {
      lines.push(`| ${label} | ${sum.n} | ${sum.unresolved} | ${pct(sum.meanR)} | ${pct(sum.medianR)} | ${pct(sum.winRate)} | ${pct(sum.profitFactor)} | ${pct(sum.maxDrawdownR)} | ${pct(sum.p05R)} | ${pct(sum.worstR)} | ${pct(sum.exposure)} |`);
    }
    lines.push('', `Paired difference (ladder − single), R: n=${s.paired.n}, mean ${pct(s.paired.meanDiffR)}, day-clustered 90% ${ci(s.paired.interval ? { low: s.paired.interval.ciLow, high: s.paired.interval.ciHigh } : null)}.`);
  }
  return `${lines.join('\n')}\n`;
}
