import { bootstrapMean, utcDay } from '../research/Bootstrap.js';
import type { SetupGrade } from './grade.js';
import type { OutcomeLabel } from './outcome.js';
import type { PlaybookVerdict } from './types.js';

/**
 * TP-before-SL calibration. The probability is an empirical, outcome-specific rate per bucket, estimated only from
 * setups that resolved before the moment of the estimate: no estimate ever sees an outcome from its own future.
 *
 * Outputs follow the v1 decision contract (docs/superpowers/specs/2026-10-17-intraday-decision-contract-design.md §5):
 * probabilities and mean net R per outcome on FILLED setups, the expectancy, and a one-sided day-clustered bootstrap
 * lower bound on it. The admission gate uses that spec's values (n >= 200, lower bound > 0.05 R, confidence 0.95) and
 * also needs 20 distinct decision days.
 */

export type ResolvedLabel = Exclude<OutcomeLabel, 'UNRESOLVED'>;

export interface CalibrationSample {
  setupId: string;
  bucket: string;
  /** Trigger close: when the decision was taken. */
  decidedAt: number;
  /** When the outcome became known. */
  resolvedAt: number;
  label: ResolvedLabel;
  /** Null for NOT_FILLED. */
  netR: number | null;
}

export type BucketDimension = 'playbook' | 'direction' | 'grade';

/** Default buckets are playbook@version and direction. Adding the grade band tests whether the grade ranks outcomes. */
export function bucketOf(v: Pick<PlaybookVerdict, 'playbookId' | 'version' | 'direction'>, grade: SetupGrade | null, dims: readonly BucketDimension[] = ['playbook', 'direction']): string {
  const parts: string[] = [];
  if (dims.includes('playbook')) parts.push(`${v.playbookId}@${v.version}`);
  if (dims.includes('direction')) parts.push(v.direction);
  if (dims.includes('grade')) parts.push(`grade:${grade?.band ?? 'none'}`);
  return parts.join('|');
}

export interface OutcomeEstimate {
  bucket: string;
  basis: 'FILLED_TRADES';
  asOf: number;
  /** Filled setups resolved by `asOf`. */
  n: number;
  notFilled: number;
  fillRate: number | null;
  pTarget: number | null;
  pStop: number | null;
  pTimeout: number | null;
  /** Wilson interval for pTarget at the one-sided confidence. */
  pTargetLow: number | null;
  pTargetHigh: number | null;
  rTarget: number | null;
  rStop: number | null;
  rTimeout: number | null;
  /** Mean net R over filled setups, the same as the sum of p times mean R over the three outcomes. */
  evR: number | null;
  /** One-sided lower bound of evR, day-clustered bootstrap. */
  evLowerBoundR: number | null;
  clusters: number;
  confidence: number;
}

export interface EstimateOptions {
  /** One-sided confidence. */
  confidence?: number;
  iterations?: number;
  seed?: number;
}

/** One-sided normal quantiles for the confidence levels this module accepts. */
const Z: Readonly<Record<number, number>> = { 0.9: 1.2816, 0.95: 1.6449, 0.975: 1.96, 0.99: 2.3263 };

function zFor(confidence: number): number {
  const z = Z[confidence];
  if (z === undefined) throw new Error(`unsupported confidence ${confidence}; use one of ${Object.keys(Z).join(', ')}`);
  return z;
}

/** Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Samples a decision at `asOf` may use: decided before it and resolved by it. */
export const knownAt = (samples: readonly CalibrationSample[], bucket: string, asOf: number): CalibrationSample[] =>
  samples.filter((s) => s.bucket === bucket && s.decidedAt < asOf && s.resolvedAt <= asOf);

export function estimateOutcome(samples: readonly CalibrationSample[], bucket: string, asOf: number, options: EstimateOptions = {}): OutcomeEstimate {
  const confidence = options.confidence ?? 0.95;
  const z = zFor(confidence);
  const known = knownAt(samples, bucket, asOf);
  const filled = known.filter((s) => s.label !== 'NOT_FILLED' && s.netR !== null && Number.isFinite(s.netR));
  const notFilled = known.length - filled.length;
  const n = filled.length;
  const of = (label: ResolvedLabel) => filled.filter((s) => s.label === label);
  const share = (label: ResolvedLabel) => (n === 0 ? null : of(label).length / n);
  const interval = n === 0 ? null : wilson(of('TARGET').length, n, z);
  // bootstrapMean's interval is two-sided: its low end at level 2c - 1 is the one-sided lower bound at c
  const boot = n >= 2
    ? bootstrapMean(filled.map((s) => ({ value: s.netR!, cluster: utcDay(s.decidedAt) })), { confidence: 2 * confidence - 1, iterations: options.iterations ?? 2000, seed: options.seed ?? 1 })
    : null;
  return {
    bucket,
    basis: 'FILLED_TRADES',
    asOf,
    n,
    notFilled,
    fillRate: known.length === 0 ? null : n / known.length,
    pTarget: share('TARGET'),
    pStop: share('STOP'),
    pTimeout: share('TIMEOUT'),
    pTargetLow: interval?.low ?? null,
    pTargetHigh: interval?.high ?? null,
    rTarget: mean(of('TARGET').map((s) => s.netR!)),
    rStop: mean(of('STOP').map((s) => s.netR!)),
    rTimeout: mean(of('TIMEOUT').map((s) => s.netR!)),
    evR: mean(filled.map((s) => s.netR!)),
    evLowerBoundR: boot?.ciLow ?? null,
    clusters: boot?.clusters ?? new Set(filled.map((s) => utcDay(s.decidedAt))).size,
    confidence,
  };
}

export interface AdmissionPolicy {
  minSample: number;
  /**
   * Distinct UTC decision days. The bootstrap resamples days, so with one day its interval collapses to the sample mean:
   * 250 setups from one session would pass on one day's luck. Added safeguard, not in the v1 contract.
   */
  minClusters: number;
  minEvLowerBoundR: number;
  confidence: number;
}

/** Values from the v1 decision contract §8 (EV_MIN_BUCKET_SAMPLE, EV_MIN_LOWER_BOUND_R, EV_CONFIDENCE). */
export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = { minSample: 200, minClusters: 20, minEvLowerBoundR: 0.05, confidence: 0.95 };

export type AdmissionReason = 'SAMPLE_BELOW_MIN' | 'CLUSTERS_BELOW_MIN' | 'EV_LOWER_BOUND_BELOW_MIN' | 'CONFIDENCE_MISMATCH' | 'ADMITTED';

export function admit(estimate: OutcomeEstimate, policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY): { admitted: boolean; reason: AdmissionReason; detail: string } {
  if (estimate.confidence !== policy.confidence) {
    return { admitted: false, reason: 'CONFIDENCE_MISMATCH', detail: `estimate at ${estimate.confidence}, policy needs ${policy.confidence}` };
  }
  if (estimate.n < policy.minSample) {
    return { admitted: false, reason: 'SAMPLE_BELOW_MIN', detail: `${estimate.n} filled outcomes in ${estimate.bucket}, need ${policy.minSample}` };
  }
  if (estimate.clusters < policy.minClusters) {
    return { admitted: false, reason: 'CLUSTERS_BELOW_MIN', detail: `${estimate.clusters} distinct decision days in ${estimate.bucket}, need ${policy.minClusters}` };
  }
  const lb = estimate.evLowerBoundR;
  if (lb === null || !(lb > policy.minEvLowerBoundR)) {
    return { admitted: false, reason: 'EV_LOWER_BOUND_BELOW_MIN', detail: `E[R] lower bound ${lb === null ? 'n/a' : lb.toFixed(3)} R, need > ${policy.minEvLowerBoundR} R` };
  }
  return { admitted: true, reason: 'ADMITTED', detail: `n=${estimate.n}, E[R]=${estimate.evR?.toFixed(3)} R, lower bound ${lb.toFixed(3)} R` };
}

export interface GatedVerdict {
  verdict: PlaybookVerdict['verdict'];
  admission: ReturnType<typeof admit> | null;
  estimate: OutcomeEstimate | null;
}

/**
 * The calibration gate after the rule engine: an ENTRY_ELIGIBLE setup becomes NO_TRADE unless its bucket has enough
 * resolved history with a positive expectancy lower bound. WATCH and NO_TRADE pass through unchanged. The grade is not
 * consulted; it reaches the estimate only as a bucket dimension, when the caller chooses one.
 */
export function gateVerdict(v: PlaybookVerdict, estimate: OutcomeEstimate | null, policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY): GatedVerdict {
  if (v.verdict !== 'ENTRY_ELIGIBLE') return { verdict: v.verdict, admission: null, estimate };
  if (!estimate) return { verdict: 'NO_TRADE', admission: { admitted: false, reason: 'SAMPLE_BELOW_MIN', detail: 'no estimate for this bucket' }, estimate };
  const admission = admit(estimate, policy);
  return { verdict: admission.admitted ? 'ENTRY_ELIGIBLE' : 'NO_TRADE', admission, estimate };
}

export interface ReliabilityBin {
  low: number;
  high: number;
  n: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

export interface CalibrationReport {
  /** Filled setups scored: each had at least `minPrior` earlier resolved outcomes in its bucket. */
  n: number;
  /** Brier score of the bucket rate for TARGET, out of sample. */
  brier: number | null;
  /** Brier score of the pooled rate over every bucket, out of sample: the bar the bucket rate must beat to add information. */
  brierPooled: number | null;
  bins: ReliabilityBin[];
}

/**
 * Prequential check: walk the filled setups in decision order and score each against the TARGET rate that was known
 * just before it. The rate uses a Beta(1, 1) prior, so a bucket with few outcomes is pulled toward 0.5 instead of 0 or 1.
 */
export function prequentialCalibration(samples: readonly CalibrationSample[], options: { minPrior?: number; bins?: number } = {}): CalibrationReport {
  const minPrior = options.minPrior ?? 30;
  const binCount = options.bins ?? 10;
  const filled = samples.filter((s) => s.label !== 'NOT_FILLED').sort((a, b) => a.decidedAt - b.decidedAt);
  const rate = (prior: readonly CalibrationSample[]) => (prior.filter((s) => s.label === 'TARGET').length + 1) / (prior.length + 2);
  const scored: { p: number; pooled: number; y: number }[] = [];
  for (const s of filled) {
    const pooled = filled.filter((o) => o.decidedAt < s.decidedAt && o.resolvedAt <= s.decidedAt);
    const prior = pooled.filter((o) => o.bucket === s.bucket);
    if (prior.length < minPrior) continue;
    scored.push({ p: rate(prior), pooled: rate(pooled), y: s.label === 'TARGET' ? 1 : 0 });
  }
  const bins: ReliabilityBin[] = Array.from({ length: binCount }, (_, i) => {
    const low = i / binCount;
    const high = (i + 1) / binCount;
    const inBin = scored.filter((x) => x.p >= low && (x.p < high || (i === binCount - 1 && x.p <= high)));
    return { low, high, n: inBin.length, meanPredicted: mean(inBin.map((x) => x.p)), observedRate: mean(inBin.map((x) => x.y)) };
  });
  return {
    n: scored.length,
    brier: mean(scored.map((x) => (x.p - x.y) ** 2)),
    brierPooled: mean(scored.map((x) => (x.pooled - x.y) ** 2)),
    bins,
  };
}
