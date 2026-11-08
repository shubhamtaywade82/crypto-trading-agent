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

/**
 * Pre-registered holdout criterion. A cell is calibrated only if its training estimate survives the holdout. The
 * values are fixed in code and stamped on every table by `id`. Changing any value creates a new id, so results can
 * never be re-scored under a criterion chosen after seeing them.
 */
export interface HoldoutCriterion {
  id: string;
  minSample: number;
  minDays: number;
  /** |holdout hit rate − training hit rate| must not exceed this. */
  maxCalibrationGap: number;
  /** The training hit rate must lie inside the holdout's day-clustered interval. */
  requireTrainInsideHoldoutInterval: boolean;
  /** Holdout mean net return after costs must be positive. */
  requirePositiveHoldoutNet: boolean;
}

export const HOLDOUT_CRITERION_V1: HoldoutCriterion = {
  id: 'HOLDOUT_V1',
  minSample: 100,
  minDays: 10,
  maxCalibrationGap: 0.05,
  requireTrainInsideHoldoutInterval: true,
  requirePositiveHoldoutNet: true,
};

export interface AdmissionPolicy {
  /** Resolved setups required in the training split. The calibration decision contract uses 200. */
  minSample: number;
  /** Distinct UTC decision days required. The calibration decision contract uses 20. */
  minDays: number;
  /**
   * Two-sided level for every bootstrap interval. 0.9 gives a 5th-percentile lower bound, which is a one-sided 95% bound.
   */
  confidence: number;
  /** Holm family-wise level for the expectancy test. */
  alpha: number;
  bootstrapIterations: number;
  bootstrapSeed: number;
  holdout: HoldoutCriterion;
}

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
  minSample: 200,
  minDays: 20,
  confidence: 0.9,
  alpha: 0.05,
  bootstrapIterations: 2000,
  bootstrapSeed: 1,
  holdout: HOLDOUT_CRITERION_V1,
};

export interface LabelStats {
  n: number;
  days: number;
  hits: number;
  stops: number;
  timeouts: number;
  hitRate: number | null;
  /** Day-clustered bootstrap interval for the hit rate. This is the interval to report. */
  hitInterval: { low: number; high: number } | null;
  /** Wilson interval that assumes independent outcomes. Diagnostic only: trades cluster in time. */
  hitWilson: { low: number; high: number } | null;
  netMeanPct: number | null;
  /** Cluster-bootstrap summary of net return (percent). Its ciLow is the lower bound used for admission. */
  netSummary: BootstrapSummary | null;
  fundingModels: string[];
}

export function labelStats(labels: readonly BarrierLabel[], policy: Pick<AdmissionPolicy, 'confidence' | 'bootstrapIterations' | 'bootstrapSeed'>): LabelStats {
  const resolved = labels.filter((l) => l.outcome !== 'UNRESOLVED' && l.netReturnPct !== null);
  const hits = resolved.filter((l) => l.outcome === 'TARGET').length;
  const stops = resolved.filter((l) => l.outcome === 'STOP').length;
  const timeouts = resolved.filter((l) => l.outcome === 'TIMEOUT').length;
  const n = resolved.length;
  const wilson = wilsonInterval(hits, n, policy.confidence);
  const bootstrap = { iterations: policy.bootstrapIterations, seed: policy.bootstrapSeed, confidence: policy.confidence };
  const netSummary = bootstrapMean(resolved.map((l) => ({ value: l.netReturnPct as number, cluster: l.day })), bootstrap);
  const hitSummary = bootstrapMean(resolved.map((l) => ({ value: l.outcome === 'TARGET' ? 1 : 0, cluster: l.day })), bootstrap);
  return {
    n,
    days: new Set(resolved.map((l) => l.day)).size,
    hits,
    stops,
    timeouts,
    hitRate: wilson?.p ?? null,
    hitInterval: hitSummary ? { low: hitSummary.ciLow, high: hitSummary.ciHigh } : null,
    hitWilson: wilson ? { low: wilson.low, high: wilson.high } : null,
    netMeanPct: netSummary?.mean ?? null,
    netSummary,
    fundingModels: [...new Set(resolved.map((l) => l.fundingModel))].sort(),
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
  /** Passed the pre-registered holdout criterion. A probability is published only when this and `admitted` both hold. */
  holdoutAccepted: boolean;
  holdoutReasons: string[];
  reasons: string[];
}

export interface TargetTable {
  criterionId: string;
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
      holdoutAccepted: false,
      holdoutReasons: [],
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

  for (const cell of cells) {
    const verdict = evaluateHoldout(cell.train, cell.holdout, policy.holdout);
    cell.holdoutAccepted = verdict.accepted;
    cell.holdoutReasons = verdict.reasons;
  }

  return {
    criterionId: policy.holdout.id,
    policy,
    holdoutFraction,
    cutoffTime,
    purged,
    familySize: testableIdx.length,
    cells,
  };
}

/**
 * Tests a training estimate against the holdout under the pre-registered criterion. Calibration is what is checked:
 * the realised holdout hit rate must sit close to the training estimate and inside its day-clustered interval.
 * Positive holdout net return is required as well.
 */
export function evaluateHoldout(
  train: LabelStats,
  holdout: LabelStats | null,
  c: HoldoutCriterion,
): { accepted: boolean; reasons: string[] } {
  if (!holdout) return { accepted: false, reasons: ['NO_HOLDOUT_LABELS'] };
  const reasons: string[] = [];
  if (holdout.n < c.minSample) reasons.push(`HOLDOUT_SAMPLE ${holdout.n}<${c.minSample}`);
  if (holdout.days < c.minDays) reasons.push(`HOLDOUT_DAYS ${holdout.days}<${c.minDays}`);
  const trainHit = train.hitRate;
  const holdoutHit = holdout.hitRate;
  const interval = holdout.hitInterval;
  if (trainHit === null || holdoutHit === null || interval === null) {
    reasons.push('HIT_RATE_UNDEFINED');
  } else {
    const gap = holdoutHit - trainHit;
    if (Math.abs(gap) > c.maxCalibrationGap) reasons.push(`CALIBRATION_GAP ${gap.toFixed(3)} exceeds ${c.maxCalibrationGap}`);
    if (c.requireTrainInsideHoldoutInterval && (trainHit < interval.low || trainHit > interval.high)) {
      reasons.push(`TRAIN_ESTIMATE_OUTSIDE_HOLDOUT_INTERVAL [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}]`);
    }
  }
  if (c.requirePositiveHoldoutNet && !(holdout.netMeanPct !== null && holdout.netMeanPct > 0)) {
    reasons.push('HOLDOUT_NET_NOT_POSITIVE');
  }
  return { accepted: reasons.length === 0, reasons };
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
