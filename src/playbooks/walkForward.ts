import { bootstrapMean, utcDay } from '../research/Bootstrap.js';
import { admit, DEFAULT_ADMISSION_POLICY, estimateOutcome, type AdmissionPolicy, type CalibrationSample } from './calibration.js';

/**
 * Walk-forward test of the calibration gate. History is cut into chronological folds of equal duration. For each fold
 * after the first, buckets are admitted with only what was known at the fold's start, then judged on the setups the
 * fold itself contains. The gate earns its keep only if admitted setups do better out of sample than all setups.
 */

export interface WalkForwardFold {
  index: number;
  start: number;
  end: number;
  admittedBuckets: string[];
  /** Filled setups decided inside the fold. */
  n: number;
  evAll: number | null;
  nAdmitted: number;
  evAdmitted: number | null;
}

export interface WalkForwardReport {
  folds: WalkForwardFold[];
  /** All out-of-sample setups from admitted buckets, pooled across folds, with a day-clustered bootstrap. */
  admittedOutOfSample: { n: number; mean: number | null; lowerBound: number | null };
}

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export function walkForward(samples: readonly CalibrationSample[], options: { folds?: number; policy?: AdmissionPolicy } = {}): WalkForwardReport {
  const foldCount = options.folds ?? 4;
  const policy = options.policy ?? DEFAULT_ADMISSION_POLICY;
  if (samples.length === 0 || foldCount < 2) return { folds: [], admittedOutOfSample: { n: 0, mean: null, lowerBound: null } };
  const times = samples.map((s) => s.decidedAt);
  const lo = Math.min(...times);
  const hi = Math.max(...times) + 1;
  const width = (hi - lo) / foldCount;
  const buckets = [...new Set(samples.map((s) => s.bucket))];
  const folds: WalkForwardFold[] = [];
  const admittedOut: CalibrationSample[] = [];

  for (let k = 1; k < foldCount; k += 1) {
    const start = lo + k * width;
    const end = k === foldCount - 1 ? hi : lo + (k + 1) * width;
    const admitted = buckets.filter((b) => admit(estimateOutcome(samples, b, start, { confidence: policy.confidence }), policy).admitted);
    const inFold = samples.filter((s) => s.decidedAt >= start && s.decidedAt < end && s.netR !== null);
    const picked = inFold.filter((s) => admitted.includes(s.bucket));
    admittedOut.push(...picked);
    folds.push({
      index: k, start, end, admittedBuckets: admitted,
      n: inFold.length, evAll: mean(inFold.map((s) => s.netR!)),
      nAdmitted: picked.length, evAdmitted: mean(picked.map((s) => s.netR!)),
    });
  }
  const boot = admittedOut.length >= 2
    ? bootstrapMean(admittedOut.map((s) => ({ value: s.netR!, cluster: utcDay(s.decidedAt) })), { confidence: 2 * policy.confidence - 1, iterations: 2000 })
    : null;
  return { folds, admittedOutOfSample: { n: admittedOut.length, mean: mean(admittedOut.map((s) => s.netR!)), lowerBound: boot?.ciLow ?? null } };
}
