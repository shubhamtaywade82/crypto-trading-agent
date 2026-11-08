import { bootstrapMean, holm, type BootstrapSummary } from '../../research/Bootstrap.js';
import type { Side } from '../../types.js';
import type { BarrierLabel } from './barriers.js';

/**
 * Target-specific probabilities, estimated from labelled history only. A probability is never derived from a score.
 *
 * - Hit probability: TARGET / (TARGET + STOP + TIMEOUT). A timeout is a miss. UNRESOLVED labels are not outcomes.
 * - Interval: Wilson score, for the hit proportion.
 * - Expectancy: cluster bootstrap over UTC decision days, for the mean net return after costs.
 * - Splits: chronological. Training labels whose horizon runs into the holdout are purged, so no outcome that
 *   resolves inside the holdout informs a training estimate.
 * - Admission is decided on training data only. Holm correction runs across every testable cell, which controls the
 *   family-wise error rate when many (symbol, side, target, horizon, context) cells are compared.
 */

/** Two-sided normal quantiles for the supported confidence levels. */
const Z_FOR_CONFIDENCE: Record<number, number> = {
  0.9: 1.6448536269514722,
  0.95: 1.959963984540054,
  0.99: 2.5758293035489004,
};

export interface WilsonInterval {
  p: number;
  low: number;
  high: number;
}

export function wilsonInterval(hits: number, n: number, confidence: number): WilsonInterval | null {
  const z = Z_FOR_CONFIDENCE[confidence];
  if (z === undefined) throw new Error(`unsupported confidence ${confidence}; use 0.9, 0.95 or 0.99`);
  if (n <= 0) return null;
  if (!Number.isInteger(hits) || hits < 0 || hits > n) throw new Error(`hits ${hits} must be an integer in [0, ${n}]`);
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface AdmissionPolicy {
  /** Resolved setups required in the training split. The calibration decision contract uses 200. */
  minSample: number;
  /** Distinct UTC decision days required. The calibration decision contract uses 20. */
  minDays: number;
  /**
   * Two-sided level for the bootstrap interval. 0.9 gives a 5th-percentile lower bound, which is a one-sided 95% bound.
   */
  confidence: number;
  /** Holm family-wise level for the expectancy test. */
  alpha: number;
  bootstrapIterations: number;
  bootstrapSeed: number;
}

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
  minSample: 200,
  minDays: 20,
  confidence: 0.9,
  alpha: 0.05,
  bootstrapIterations: 2000,
  bootstrapSeed: 1,
};

export interface LabelStats {
  n: number;
  days: number;
  hits: number;
  stops: number;
  timeouts: number;
  hitRate: number | null;
  hitInterval: { low: number; high: number } | null;
  netMeanPct: number | null;
  /** Cluster-bootstrap summary of net return (percent). Its ciLow is the lower bound used for admission. */
  netSummary: BootstrapSummary | null;
}

export function labelStats(labels: readonly BarrierLabel[], policy: Pick<AdmissionPolicy, 'confidence' | 'bootstrapIterations' | 'bootstrapSeed'>): LabelStats {
  const resolved = labels.filter((l) => l.outcome !== 'UNRESOLVED' && l.netReturnPct !== null);
  const hits = resolved.filter((l) => l.outcome === 'TARGET').length;
  const stops = resolved.filter((l) => l.outcome === 'STOP').length;
  const timeouts = resolved.filter((l) => l.outcome === 'TIMEOUT').length;
  const n = resolved.length;
  const wilson = wilsonInterval(hits, n, policy.confidence);
  const netSummary = bootstrapMean(
    resolved.map((l) => ({ value: l.netReturnPct as number, cluster: l.day })),
    { iterations: policy.bootstrapIterations, seed: policy.bootstrapSeed, confidence: policy.confidence },
  );
  return {
    n,
    days: new Set(resolved.map((l) => l.day)).size,
    hits,
    stops,
    timeouts,
    hitRate: wilson?.p ?? null,
    hitInterval: wilson ? { low: wilson.low, high: wilson.high } : null,
    netMeanPct: netSummary?.mean ?? null,
    netSummary,
  };
}

export interface SplitResult {
  train: BarrierLabel[];
  holdout: BarrierLabel[];
  cutoffTime: number;
  /** Training labels dropped because their horizon ends at or after the cut-off. */
  purged: number;
}

export function splitChronological(labels: readonly BarrierLabel[], holdoutFraction: number): SplitResult {
  if (!(holdoutFraction > 0 && holdoutFraction < 1)) throw new Error(`holdoutFraction must be in (0, 1), got ${holdoutFraction}`);
  const times = [...new Set(labels.map((l) => l.entryTime))].sort((a, b) => a - b);
  if (times.length < 2) throw new Error('chronological split needs at least two distinct entry times');
  const idx = Math.min(times.length - 1, Math.floor(times.length * (1 - holdoutFraction)));
  const cutoffTime = times[idx] as number;
  const holdout = labels.filter((l) => l.entryTime >= cutoffTime);
  const beforeCut = labels.filter((l) => l.entryTime < cutoffTime);
  const train = beforeCut.filter((l) => l.horizonEndsAt < cutoffTime);
  return { train, holdout, cutoffTime, purged: beforeCut.length - train.length };
}

export interface CellMeta {
  symbol: string;
  side: Side;
  targetPct: number;
  horizonHours: number;
  /** Context tag, or null for the baseline cell that takes every setup. */
  tag: string | null;
}

export const cellKey = (m: CellMeta): string => `${m.symbol}|${m.side}|${m.targetPct}%|${m.horizonHours}h|${m.tag ?? '*'}`;

/** Every label goes into the baseline cell and into one cell per context tag it carries. */
export function groupCells(labels: readonly BarrierLabel[]): Map<string, { meta: CellMeta; labels: BarrierLabel[] }> {
  const out = new Map<string, { meta: CellMeta; labels: BarrierLabel[] }>();
  for (const label of labels) {
    const tags: (string | null)[] = [null, ...new Set(label.tags)];
    for (const tag of tags) {
      const meta: CellMeta = { symbol: label.symbol, side: label.side, targetPct: label.targetPct, horizonHours: label.horizonHours, tag };
      const key = cellKey(meta);
      const cell = out.get(key) ?? { meta, labels: [] };
      cell.labels.push(label);
      out.set(key, cell);
    }
  }
  return out;
}

export interface CellReport extends CellMeta {
  key: string;
  train: LabelStats;
  holdout: LabelStats | null;
  /** Enough training samples and decision days to enter the Holm family. */
  testable: boolean;
  pValue: number | null;
  holmRejected: boolean;
  admitted: boolean;
  reasons: string[];
}

export interface TargetTable {
  policy: AdmissionPolicy;
  holdoutFraction: number;
  cutoffTime: number;
  purged: number;
  /** Cells that entered the multiple-testing family. */
  familySize: number;
  cells: CellReport[];
}

export function buildTargetTable(
  labels: readonly BarrierLabel[],
  holdoutFraction: number,
  policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY,
): TargetTable {
  const { train, holdout, cutoffTime, purged } = splitChronological(labels, holdoutFraction);
  const trainCells = groupCells(train);
  const holdoutCells = groupCells(holdout);

  const cells: CellReport[] = [...trainCells.keys()].sort().map((key) => {
    const cell = trainCells.get(key);
    if (!cell) throw new Error(`missing cell ${key}`);
    const stats = labelStats(cell.labels, policy);
    const reasons: string[] = [];
    if (stats.n < policy.minSample) reasons.push(`SAMPLE_BELOW_MIN ${stats.n}<${policy.minSample}`);
    if (stats.days < policy.minDays) reasons.push(`DAYS_BELOW_MIN ${stats.days}<${policy.minDays}`);
    const testable = reasons.length === 0 && stats.netSummary !== null;
    const heldOut = holdoutCells.get(key);
    return {
      ...cell.meta,
      key,
      train: stats,
      holdout: heldOut ? labelStats(heldOut.labels, policy) : null,
      testable,
      pValue: testable && stats.netSummary ? stats.netSummary.pValue : null,
      holmRejected: false,
      admitted: false,
      reasons,
    };
  });

  const testableIdx = cells.map((c, i) => (c.testable ? i : -1)).filter((i) => i >= 0);
  const pValues = testableIdx.map((i) => cells[i]?.pValue ?? 1);
  const rejected = holm(pValues, policy.alpha);
  testableIdx.forEach((cellIdx, k) => {
    const cell = cells[cellIdx];
    if (!cell) return;
    cell.holmRejected = rejected[k] === true;
    if (!cell.holmRejected) cell.reasons.push('HOLM_NOT_SIGNIFICANT');
    const lower = cell.train.netSummary?.ciLow ?? Number.NEGATIVE_INFINITY;
    if (!(lower > 0)) cell.reasons.push(`EV_LOWER_BOUND_NOT_POSITIVE ${lower.toFixed(4)}`);
    cell.admitted = cell.holmRejected && lower > 0;
  });

  return {
    policy,
    holdoutFraction,
    cutoffTime,
    purged,
    familySize: testableIdx.length,
    cells,
  };
}

/** Descriptive comparison of a context-tagged cell with the untagged baseline over all labels. In-sample: not a validation. */
export function baselineComparison(
  labels: readonly BarrierLabel[],
  meta: Omit<CellMeta, 'tag'>,
  tag: string,
  policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY,
): { baseline: LabelStats | null; tagged: LabelStats | null; hitRateDifference: number | null } {
  const cells = groupCells(labels);
  const base = cells.get(cellKey({ ...meta, tag: null }));
  const tagged = cells.get(cellKey({ ...meta, tag }));
  const baseline = base ? labelStats(base.labels, policy) : null;
  const taggedStats = tagged ? labelStats(tagged.labels, policy) : null;
  const hitRateDifference = baseline?.hitRate != null && taggedStats?.hitRate != null
    ? taggedStats.hitRate - baseline.hitRate
    : null;
  return { baseline, tagged: taggedStats, hitRateDifference };
}
