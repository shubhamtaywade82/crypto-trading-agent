/**
 * Promotion gate: statistical guards a candidate must pass before it can be promoted from
 * challenger to champion.
 *
 * Enforces:
 *   1. Power-calibrated sample requirements (minTrades derived from effect size).
 *   2. Positive OOS mean net R and positive bootstrap lower confidence bound (LCB).
 *   3. Deflated Sharpe Ratio (DSR) gating against backtest trial count.
 *   4. Profit factor floor and drawdown ceiling.
 *   5. Multi-symbol coverage to prevent single-asset overfitting.
 *   6. Shrunk worst-regime regression check to prevent isolated regime collapses.
 *   7. Positive out-of-sample walk-forward validation.
 */

import type { ExperimentResult } from './ExperimentRunner.js';
import { calculateRequiredSampleSize } from './SampleSize.js';
import { computeDeflatedSharpeFromReturns } from './DeflatedSharpe.js';
import { shrinkMean } from './Shrinkage.js';

export interface PromotionPolicy {
  /** Additional OOS trade floor; power-derived sample size is always enforced as well. */
  minTrades?: number;
  /** Smallest net-R edge the experiment is designed to detect. Required for promotion. */
  targetEffectSizeR?: number;
  /** Type-I error for power sizing. Defaults to 0.05, two-sided. */
  powerAlpha?: number;
  /** Desired statistical power. Defaults to 0.80. */
  desiredPower?: number;
  /** Optional conservative sigma in R. Otherwise estimated from the training split only. */
  powerSigmaR?: number;
  /** Minimum OOS mean net R. Default 0.05R. */
  minOosExpectancyR: number;
  /** Minimum OOS profit factor. Default 1.10. */
  minProfitFactor: number;
  /** Maximum OOS drawdown in R. Default 15R. */
  maxDrawdownR: number;
  /** Minimum OOS bootstrap probPositive. Default 0.85. */
  minOosConfidence: number;
  /** Minimum distinct symbols with at least 5 trades each. Default 2. */
  minSymbolCoverage: number;
  /** Minimum margin by which candidate's OOS mean R must beat parent's. Default 0.05R. */
  minOosDelta: number;
  /** Maximum allowed regression in the worst regime vs parent overall. Default 0.30. */
  maxRegimeRegressionPct: number;
  /** If true, the walk-forward OOS summary must be non-null with a positive mean. */
  requireWalkForwardPositive: boolean;
  /** Minimum Deflated Sharpe Ratio (e.g. 0.95 for 5% false discovery rate). */
  minDsr?: number;
  /** Cumulative trials tested across the experiment lineage (for DSR multiple testing correction). */
  trialCount?: number;
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
  minTrades: 30,
  targetEffectSizeR: 0.10,
  powerAlpha: 0.05,
  desiredPower: 0.80,
  minOosExpectancyR: 0.05,
  minProfitFactor: 1.10,
  maxDrawdownR: 15,
  minOosConfidence: 0.85,
  minSymbolCoverage: 2,
  minOosDelta: 0.05,
  maxRegimeRegressionPct: 0.30,
  requireWalkForwardPositive: true,
};

export type PromotionDecision = 'PROMOTE' | 'REJECT' | 'INSUFFICIENT_DATA';

export interface PromotionVerdict {
  decision: PromotionDecision;
  reasons: string[];
  policy: PromotionPolicy;
}

interface PowerRequirement {
  requiredSampleSize: number;
  sigmaR: number;
  alpha: number;
  power: number;
}

/** Power sizing uses only the training split's dispersion; holdout returns never tune the required N. */
function getPowerRequirement(result: ExperimentResult, policy: PromotionPolicy): PowerRequirement | null {
  const effectSizeR = policy.targetEffectSizeR;
  const sigmaR = policy.powerSigmaR ?? result.train.stdDevNetR;
  const alpha = policy.powerAlpha ?? 0.05;
  const power = policy.desiredPower ?? 0.80;
  if (!Number.isFinite(effectSizeR) || !(effectSizeR! > 0) || !Number.isFinite(sigmaR) || !(sigmaR! > 0)) return null;
  try {
    return {
      ...calculateRequiredSampleSize({ effectSizeR: effectSizeR!, sigmaR: sigmaR!, alpha, power }),
      sigmaR: sigmaR!,
      alpha,
      power,
    };
  } catch {
    return null;
  }
}

/** Evaluates candidate against the promotion policy using strict statistical gates. */
export function evaluatePromotion(
  result: ExperimentResult,
  policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
): PromotionVerdict {
  const incompleteInput = result.experimentNotes.filter((note) => note.startsWith('incomplete research input:'));
  if (incompleteInput.length > 0) {
    return { decision: 'INSUFFICIENT_DATA', reasons: incompleteInput, policy };
  }

  const powerRequirement = getPowerRequirement(result, policy);
  if (!powerRequirement) {
    return {
      decision: 'INSUFFICIENT_DATA',
      reasons: ['power sizing unavailable: provide a positive targetEffectSizeR and a finite positive training-split sigmaR'],
      policy,
    };
  }
  const minTrades = Math.max(policy.minTrades ?? 1, powerRequirement.requiredSampleSize);
  const effectiveN = result.test.effectiveN;
  if (result.test.n < minTrades || !Number.isFinite(effectiveN) || effectiveN < powerRequirement.requiredSampleSize) {
    return {
      decision: 'INSUFFICIENT_DATA',
      reasons: [
        `OOS trades n=${result.test.n}; cluster-adjusted effectiveN=${Number.isFinite(effectiveN) ? effectiveN.toFixed(1) : 'n/a'}; required ${powerRequirement.requiredSampleSize} independent-equivalent observations for target ${policy.targetEffectSizeR!.toFixed(3)}R (sigma=${powerRequirement.sigmaR.toFixed(3)}R, alpha=${powerRequirement.alpha}, power=${powerRequirement.power})`,
      ],
      policy,
    };
  }

  const dsr = checkDsr(result, policy);
  if (dsr.insufficient) {
    return { decision: 'INSUFFICIENT_DATA', reasons: [dsr.insufficient], policy };
  }

  const reasons: string[] = [
    ...checkExpectancyAndDsr(result, policy),
    ...(dsr.rejection ? [dsr.rejection] : []),
    ...checkRiskAndDrawdown(result, policy),
    ...checkBreadthAndRegime(result, policy),
  ];

  if (reasons.length > 0) {
    return { decision: 'REJECT', reasons, policy };
  }

  const delta = result.test.meanNetR - result.parentTest.meanNetR;
  const lcb = result.test.bootstrap?.ciLow ?? 0;
  return {
    decision: 'PROMOTE',
    reasons: [
      `OOS mean ${result.test.meanNetR.toFixed(3)}R (n=${result.test.n}), LCB ${lcb.toFixed(3)}, PF ${result.test.profitFactor.toFixed(2)}`,
      `delta vs parent +${delta.toFixed(3)}R, walk-forward OOS mean ${(result.walkForward.outOfSample?.mean ?? 0).toFixed(3)}R`,
    ],
    policy,
  };
}

function checkDsr(result: ExperimentResult, policy: PromotionPolicy): { insufficient?: string; rejection?: string } {
  if (policy.minDsr === undefined) return {};
  if (!Number.isFinite(policy.minDsr) || policy.minDsr < 0 || policy.minDsr > 1) {
    return { insufficient: 'DSR policy is invalid: minDsr must be between 0 and 1' };
  }
  if (!Number.isInteger(policy.trialCount) || (policy.trialCount ?? 0) < 1) {
    return { insufficient: 'DSR unavailable: cumulative trialCount must be supplied as a positive integer' };
  }
  const series = result.testEquityReturns;
  if (!series || series.source !== 'EQUITY_CURVE' || !Number.isFinite(series.frequencyMs) || series.frequencyMs <= 0) {
    return { insufficient: 'DSR unavailable: an actual fixed-frequency test equity return series is required' };
  }
  const variance = policy.trialSharpeVariance ?? (policy.trialCount === 1 ? 0 : undefined);
  if (variance === undefined || !Number.isFinite(variance) || variance < 0 || (policy.trialCount! > 1 && variance === 0)) {
    return { insufficient: 'DSR unavailable: measured trialSharpeVariance is required when multiple trials were tested' };
  }
  try {
    const dsr = computeDeflatedSharpeFromReturns({
      returns: series.returns,
      samplingFrequencyMs: series.frequencyMs,
      trialCount: policy.trialCount!,
      trialSharpeVariance: variance,
    });
    if (dsr.dsr < policy.minDsr) {
      return { rejection: `Deflated Sharpe ${dsr.dsr.toFixed(3)} < ${policy.minDsr} using ${series.returns.length} net equity returns at ${series.frequencyMs}ms cadence across ${policy.trialCount} trials` };
    }
    return {};
  } catch (error) {
    return { insufficient: `DSR unavailable: ${(error as Error).message}` };
  }
}

function checkExpectancyAndDsr(result: ExperimentResult, policy: PromotionPolicy): string[] {
  const reasons: string[] = [];
  if (result.test.meanNetR < policy.minOosExpectancyR) {
    reasons.push(`OOS mean R ${result.test.meanNetR.toFixed(3)} < ${policy.minOosExpectancyR}`);
  }

  const lcb = result.test.bootstrap?.ciLow ?? Number.NaN;
  if (!Number.isFinite(lcb) || lcb <= 0) {
    reasons.push(`OOS bootstrap LCB ${Number.isFinite(lcb) ? lcb.toFixed(3) : 'n/a'} <= 0`);
  }

  return reasons;
}

function checkRiskAndDrawdown(result: ExperimentResult, policy: PromotionPolicy): string[] {
  const reasons: string[] = [];
  if (result.test.profitFactor < policy.minProfitFactor) {
    reasons.push(`OOS profit factor ${result.test.profitFactor.toFixed(2)} < ${policy.minProfitFactor}`);
  }
  if (result.test.maxDrawdownR > policy.maxDrawdownR) {
    reasons.push(`OOS max DD ${result.test.maxDrawdownR.toFixed(2)}R > ${policy.maxDrawdownR}R`);
  }
  const probPositive = result.test.bootstrap?.probPositive ?? 0;
  if (probPositive < policy.minOosConfidence) {
    reasons.push(`OOS bootstrap positive-mean fraction ${probPositive.toFixed(2)} < ${policy.minOosConfidence}`);
  }
  return reasons;
}

function checkBreadthAndRegime(result: ExperimentResult, policy: PromotionPolicy): string[] {
  const reasons: string[] = [];
  const covered = result.perSymbol.filter((s) => s.n >= 5).length;
  if (covered < policy.minSymbolCoverage) {
    reasons.push(`OOS symbols with n>=5: ${covered} < ${policy.minSymbolCoverage}`);
  }

  const delta = result.test.meanNetR - result.parentTest.meanNetR;
  if (delta < policy.minOosDelta) {
    reasons.push(`OOS delta vs parent ${delta.toFixed(3)}R < ${policy.minOosDelta}R`);
  }

  checkWorstRegime(result, policy, reasons);

  if (policy.requireWalkForwardPositive) {
    const wfMean = result.walkForward.outOfSample?.mean;
    if (wfMean === undefined || wfMean === null || !(wfMean > 0)) {
      reasons.push(`walk-forward OOS mean ${wfMean ?? 'n/a'} not positive`);
    }
  }

  return reasons;
}

function checkWorstRegime(result: ExperimentResult, policy: PromotionPolicy, reasons: string[]): void {
  const worstEntry = result.perRegime[result.perRegime.length - 1];
  const parentOverall = result.parentTest.meanNetR;
  if (!worstEntry || !Number.isFinite(parentOverall) || parentOverall <= 0) return;

  // Regularize raw worst regime mean with shrinkage so tiny-N strata don't cause false regressions
  const shrunkWorst = shrinkMean(worstEntry.meanNetR, worstEntry.n, parentOverall, 25);
  const regression = (parentOverall - shrunkWorst) / Math.abs(parentOverall);
  if (regression > policy.maxRegimeRegressionPct) {
    reasons.push(
      `OOS worst regime (shrunk) ${shrunkWorst.toFixed(3)}R is ${(regression * 100).toFixed(0)}% below parent ${parentOverall.toFixed(3)}R`,
    );
  }
}
