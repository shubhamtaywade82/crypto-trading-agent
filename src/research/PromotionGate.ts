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
import { computeDeflatedSharpe } from './DeflatedSharpe.js';
import { shrinkMean } from './Shrinkage.js';

export interface PromotionPolicy {
  /** Minimum OOS trades. If targetEffectSizeR is provided, derived via power analysis. */
  minTrades?: number;
  /** Target effect size in R for power analysis. When supplied, overrides static minTrades. */
  targetEffectSizeR?: number;
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

/** Determines the effective sample size floor, using power analysis when effect size is stated. */
function getEffectiveMinTrades(policy: PromotionPolicy): number {
  if (policy.targetEffectSizeR && policy.targetEffectSizeR > 0) {
    return calculateRequiredSampleSize({ effectSizeR: policy.targetEffectSizeR }).requiredSampleSize;
  }
  return policy.minTrades ?? 30;
}

/** Evaluates candidate against the promotion policy using strict statistical gates. */
export function evaluatePromotion(
  result: ExperimentResult,
  policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
): PromotionVerdict {
  const minTrades = getEffectiveMinTrades(policy);
  if (result.test.n < minTrades) {
    return {
      decision: 'INSUFFICIENT_DATA',
      reasons: [`OOS n=${result.test.n} below required minTrades=${minTrades}; wait for more data`],
      policy,
    };
  }

  const reasons: string[] = [
    ...checkExpectancyAndDsr(result, policy),
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

function checkExpectancyAndDsr(result: ExperimentResult, policy: PromotionPolicy): string[] {
  const reasons: string[] = [];
  if (result.test.meanNetR < policy.minOosExpectancyR) {
    reasons.push(`OOS mean R ${result.test.meanNetR.toFixed(3)} < ${policy.minOosExpectancyR}`);
  }

  const lcb = result.test.bootstrap?.ciLow ?? Number.NaN;
  if (!Number.isFinite(lcb) || lcb <= 0) {
    reasons.push(`OOS bootstrap LCB ${Number.isFinite(lcb) ? lcb.toFixed(3) : 'n/a'} <= 0`);
  }

  if (policy.minDsr !== undefined && policy.trialCount && policy.trialCount > 1) {
    const dsrRes = computeDeflatedSharpe({
      sharpeRatio: result.test.profitFactor - 1, // Sharpe proxy from excess profit factor
      sampleLength: result.test.n,
      trialCount: policy.trialCount,
    });
    if (dsrRes.dsr < policy.minDsr) {
      reasons.push(`Deflated Sharpe ${dsrRes.dsr.toFixed(2)} < ${policy.minDsr} under ${policy.trialCount} trials`);
    }
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
    reasons.push(`OOS P(E[R]>0) ${probPositive.toFixed(2)} < ${policy.minOosConfidence}`);
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
