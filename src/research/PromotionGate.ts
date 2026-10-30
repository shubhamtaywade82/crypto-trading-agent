/**
 * Promotion gate: statistical guards a candidate must pass before it can be promoted from
 * challenger to champion.
 *
 * Verdict order:
 *   1. INSUFFICIENT_DATA on absolute sample floors — a stated target effect size (power analysis derives
 *      the required n) or the static minTrades floor.
 *   2. REJECT on any hard floor, evaluated on the observed data: contract integrity (a configured filter
 *      that could not be evaluated), OOS mean/LCB, DSR (from the ACTUAL per-trade Sharpe, never a
 *      profit-factor proxy), profit factor, drawdown, symbol coverage, parent delta, worst-regime
 *      regression, walk-forward positivity.
 *   3. INSUFFICIENT_DATA on power: a candidate that cleared every hard floor but whose positive mean edge
 *      is smaller than the minimum detectable effect at its sample size (80% power) is a small-sample
 *      illusion — it is not promotable evidence yet.
 *
 *   4. PROMOTE: positive expectancy with statistically sufficient power, DSR-defensible Sharpe,
 *      multi-symbol breadth, regime stability, and positive walk-forward out-of-sample results.
 */

import type { ExperimentResult } from './ExperimentRunner.js';
import { calculateRequiredSampleSize, minimumDetectableEffect } from './SampleSize.js';
import { computeDeflatedSharpe } from './DeflatedSharpe.js';
import { shrinkMean } from './Shrinkage.js';

export interface PromotionPolicy {
  /** Minimum OOS trades. Static floor; superseded by power analysis when targetEffectSizeR or OOS moments exist. */
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
  /** Variance of per-trade Sharpe ratios across trials; defaults to 0.5 when unmeasured. */
  trialSharpeVariance?: number;
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

/** Sample-size sufficiency verdict with the evidence used to derive it. */
interface SampleRequirement {
  sufficient: boolean;
  /** Effective trade floor applied (power-derived or static). */
  minTrades: number;
  /** Minimum detectable effect at the observed n and sigma (only when moments exist). */
  mdeR: number | null;
  reason: string;
}

/**
 * Absolute sample floors, evaluated BEFORE the rejection guards:
 *
 *   1. `targetEffectSizeR` in the policy → classic power analysis (n ≥ ((zα+zβ)σ/δ)²) using the observed OOS
 *      sigma when available.
 *   2. Otherwise → static `minTrades` floor (legacy callers without moment statistics).
 *
 * The self-calibrating MDE guard is deliberately NOT an absolute floor: a candidate that already fails a
 * hard floor (negative mean, PF below 1.10, regime collapse) is REJECTED on the observed data, not
 * "wait for more trades". Power is the last question asked of an otherwise-passing candidate — see
 * `checkPowerToConfirm`.
 */
function absoluteSampleRequirement(result: ExperimentResult, policy: PromotionPolicy): SampleRequirement {
  const n = result.test.n;
  const moments = result.test.sharpe;

  if (policy.targetEffectSizeR && policy.targetEffectSizeR > 0) {
    const required = calculateRequiredSampleSize({
      effectSizeR: policy.targetEffectSizeR,
      sigmaR: moments?.std,
    }).requiredSampleSize;
    return {
      sufficient: n >= required,
      minTrades: required,
      mdeR: null,
      reason: `OOS n=${n} below power-required minTrades=${required} for target effect ${policy.targetEffectSizeR}R; wait for more data`,
    };
  }

  const staticFloor = policy.minTrades ?? 30;
  return {
    sufficient: n >= staticFloor,
    minTrades: staticFloor,
    mdeR: null,
    reason: `OOS n=${n} below required minTrades=${staticFloor}; wait for more data`,
  };
}

/**
 * The power question, asked only of a candidate that cleared every rejection guard: is this sample size
 * actually able to CONFIRM a positive edge of the observed size with 80% power?
 *
 * MDE = (zα + zβ)·σ/√n. If the observed positive mean is smaller than the smallest effect the sample could
 * honestly detect, promoting would be a small-sample illusion — the verdict is INSUFFICIENT_DATA, not
 * PROMOTE. Thirty trades at σ=1R can only confirm edges ≥ ~0.51R; a 0.05R edge on 30 trades is not evidence.
 */
function checkPowerToConfirm(result: ExperimentResult, policy: PromotionPolicy): SampleRequirement | null {
  const moments = result.test.sharpe;
  if (!moments || !Number.isFinite(moments.std) || !(moments.std > 0)) return null;
  if (!(result.test.meanNetR > 0)) return null; // non-positive edges are already rejected elsewhere
  const mde = minimumDetectableEffect({ n: result.test.n, sigmaR: moments.std }).mdeR;
  if (result.test.meanNetR < mde) {
    return {
      sufficient: false,
      minTrades: result.test.n + 1,
      mdeR: mde,
      reason: `OOS n=${result.test.n} can only detect effects >= ${mde.toFixed(3)}R at 80% power (sigma=${moments.std.toFixed(2)}R); observed mean ${result.test.meanNetR.toFixed(3)}R is below that — more data required to confirm the edge`,
    };
  }
  return null;
}

/** Evaluates candidate against the promotion policy using strict statistical gates. */
export function evaluatePromotion(
  result: ExperimentResult,
  policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
): PromotionVerdict {
  const requirement = absoluteSampleRequirement(result, policy);
  if (!requirement.sufficient) {
    return {
      decision: 'INSUFFICIENT_DATA',
      reasons: [requirement.reason],
      policy,
    };
  }

  const reasons: string[] = [
    ...checkContractIntegrity(result),
    ...checkExpectancyAndDsr(result, policy),
    ...checkRiskAndDrawdown(result, policy),
    ...checkBreadthAndRegime(result, policy),
  ];

  if (reasons.length > 0) {
    return { decision: 'REJECT', reasons, policy };
  }

  // Every hard floor passed. The final question is power: can this sample size actually confirm an edge
  // of the observed magnitude? If not, the honest verdict is INSUFFICIENT_DATA, not PROMOTE.
  const power = checkPowerToConfirm(result, policy);
  if (power !== null) {
    return { decision: 'INSUFFICIENT_DATA', reasons: [power.reason], policy };
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

/**
 * A configured filter that could not be evaluated against recorded evidence invalidates the experiment itself:
 * the numbers it produced do not measure what the spec claims to measure. Reject loudly instead of promoting
 * on top of a no-op threshold.
 */
function checkContractIntegrity(result: ExperimentResult): string[] {
  return result.contractViolations.map((v) => `research contract violation: ${v}`);
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
    const moments = result.test.sharpe;
    if (!moments) {
      // Without the actual OOS return series the DSR cannot be computed honestly. Refuse rather than proxy it.
      reasons.push(`DSR gate cannot run: OOS per-trade Sharpe statistics missing (n=${result.test.n} < 2 or zero variance)`);
    } else {
      // The Sharpe ratio fed to the DSR is the per-trade net R mean / std of the actual out-of-sample return
      // series, with empirical skewness and kurtosis. Profit factor is a different statistic and is never a
      // Sharpe substitute.
      const dsrRes = computeDeflatedSharpe({
        sharpeRatio: moments.sharpePerTrade,
        sampleLength: result.test.n,
        skewness: moments.skewness,
        kurtosis: moments.excessKurtosis + 3,
        trialCount: policy.trialCount,
        ...(policy.trialSharpeVariance !== undefined ? { trialSharpeVariance: policy.trialSharpeVariance } : {}),
      });
      if (dsrRes.dsr < policy.minDsr) {
        reasons.push(
          `Deflated Sharpe ${dsrRes.dsr.toFixed(2)} < ${policy.minDsr} under ${policy.trialCount} trials ` +
          `(per-trade SR ${moments.sharpePerTrade.toFixed(3)}, benchmark ${dsrRes.expectedMaxSharpe.toFixed(3)})`,
        );
      }
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
