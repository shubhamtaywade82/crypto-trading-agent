/**
 * Kelly criterion position-sizing analysis — RESEARCH-ONLY.
 *
 * This module estimates the fraction of equity a strategy's historical trade distribution would justify
 * risking per trade under expected-log-growth (Kelly) optimization, together with the uncertainty of that
 * estimate. It is an ANALYSIS tool: the live trading core (RiskEngine + positionSizer) remains the sole
 * authority on actual position sizes, and any future sizing policy derived from this module must still be
 * capped by the per-trade risk budget, portfolio risk limit and liquidation-distance checks.
 *
 * Two estimators are provided, because they answer different questions:
 *
 *   - `kellyBinary` — the textbook closed form f* = (b*p - q) / b for a binary payoff model (wins b units per
 *     1 unit risked with probability p). Real perpetual-futures trades are NOT binary, so this is a reference
 *     point, not a recommendation.
 *
 *   - `kellyLogOptimal` — the fraction that maximizes E[log(1 + f*R)] over the EMPIRICAL net-R distribution
 *     (full-trade resampling of the actual payoff shape, fat tails included). This is the estimator the
 *     research reports should quote.
 *
 * Estimation error is real: with 100 trades, the Kelly fraction is itself a noisy statistic. The estimate is
 * therefore bootstrapped (cluster-aware when cluster labels are supplied) and reported with a confidence
 * interval; pros run fractional Kelly (1/2 or 1/4) precisely because full Kelly on a mis-estimated edge is a
 * reliable way to go broke. A win rate above 50% is NOT evidence of a positive Kelly fraction — payoff shape
 * and costs decide that.
 */

import { mulberry32, quantileSorted } from '../research/Bootstrap.js';

export interface KellyBinaryInput {
  /** Probability of a winning trade, in (0, 1). */
  winRate: number;
  /** Average win divided by average loss (both as positive numbers). */
  payoffRatio: number;
}

/** Textbook binary Kelly fraction, clamped at zero (never recommends betting on a negative edge). */
export function kellyBinary(input: KellyBinaryInput): number {
  const { winRate: p, payoffRatio: b } = input;
  if (!(p > 0 && p < 1)) throw new Error('winRate must be in (0, 1)');
  if (!(b > 0)) throw new Error('payoffRatio must be positive');
  const q = 1 - p;
  return Math.max(0, (b * p - q) / b);
}

export interface LogOptimalKelly {
  /** Fraction maximizing E[log(1 + f*R)] over the empirical distribution; 0 when no positive f beats f=0. */
  fraction: number;
  /** E[log(1 + f*R)] at the optimum — the expected log growth rate per trade. */
  expectedLogGrowth: number;
  /** Whether the optimum is an interior solution or the boundary f=0. */
  interior: boolean;
}

/**
 * Empirical (log-optimal) Kelly: maximize g(f) = (1/n) * sum(log(1 + f * R_i)) over a grid.
 *
 * Any f for which 1 + f*R_i <= 0 for some observed trade is treated as -Infinity (ruin on that outcome), so
 * the optimizer can never recommend a fraction that would have gone bust on the observed worst trade.
 */
export function kellyLogOptimal(netRs: readonly number[], gridMax = 3, gridStep = 0.0025): LogOptimalKelly {
  if (netRs.length === 0) throw new Error('kellyLogOptimal needs at least one return');
  if (!netRs.every(Number.isFinite)) throw new Error('netRs must all be finite');

  const g = (f: number): number => {
    let acc = 0;
    for (const r of netRs) {
      const x = 1 + f * r;
      if (x <= 0) return Number.NEGATIVE_INFINITY;
      acc += Math.log(x);
    }
    return acc / netRs.length;
  };

  let bestF = 0;
  let bestG = 0; // g(0) = 0 exactly
  let interior = false;
  for (let f = gridStep; f <= gridMax + 1e-12; f += gridStep) {
    const value = g(f);
    if (value > bestG) {
      bestG = value;
      bestF = f;
      interior = true;
    }
  }
  return { fraction: bestF, expectedLogGrowth: interior ? bestG : 0, interior };
}

export interface KellySample {
  /** Net R of the trade after all costs. */
  netR: number;
  /** Resampling unit (e.g. UTC day); trades sharing a cluster are drawn together. */
  cluster?: string;
}

export interface KellyOptions {
  /** Bootstrap iterations for the Kelly fraction's confidence interval. Default 1000. */
  iterations?: number;
  /** PRNG seed. Default 1. */
  seed?: number;
  /** Two-sided confidence level for the interval, e.g. 0.9. Default 0.9. */
  confidence?: number;
  /** Upper bound of the Kelly grid search. Default 3 (300% of equity — deliberately generous). */
  gridMax?: number;
  /** Grid resolution. Default 0.0025. */
  gridStep?: number;
}

export type KellyEvidence = 'INSUFFICIENT_DATA' | 'UNCERTAIN' | 'POSITIVE_EDGE';

export interface KellyEstimate {
  n: number;
  /** Fraction of winning trades. */
  winRate: number;
  /** Mean net R per trade. */
  meanNetR: number;
  /** Std dev of net R. */
  stdNetR: number;
  /** Average win / average loss (both positive); null when there are no losses. */
  payoffRatio: number | null;
  /** Binary closed-form reference value. */
  kellyBinary: number;
  /** Log-optimal fraction over the empirical distribution — the primary number. */
  kellyLogOptimal: number;
  /** Expected log growth per trade at the log-optimal fraction. */
  expectedLogGrowth: number;
  /** Bootstrap median of the log-optimal fraction. */
  median: number;
  /** Bootstrap confidence interval of the log-optimal fraction. */
  ciLow: number;
  ciHigh: number;
  /** Conservative fractional-Kelly recommendations derived from the point estimate. */
  halfKelly: number;
  quarterKelly: number;
  /** Whether the evidence supports any positive Kelly fraction at all. */
  evidence: KellyEvidence;
  warnings: string[];
}

/**
 * Full Kelly sizing analysis over a trade series, with bootstrap uncertainty on the recommended fraction.
 *
 * Evidence grading:
 *   - INSUFFICIENT_DATA: fewer than 30 trades — the fraction is not estimable to any useful precision.
 *   - UNCERTAIN: the bootstrap interval of the Kelly fraction includes zero (or the mean edge is <= 0). The
 *     correct bet size under this evidence is zero, regardless of how the point estimate looks.
 *   - POSITIVE_EDGE: interval strictly positive. Even then, prefer the fractional recommendations.
 */
export function estimateKelly(samples: readonly KellySample[], options: KellyOptions = {}): KellyEstimate {
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1000));
  const seed = options.seed ?? 1;
  const confidence = options.confidence ?? 0.9;
  const gridMax = options.gridMax ?? 3;
  const gridStep = options.gridStep ?? 0.0025;
  const warnings: string[] = [];

  const clean = samples.filter((s) => Number.isFinite(s.netR));
  if (samples.length !== clean.length) {
    warnings.push(`${samples.length - clean.length} samples with non-finite netR were skipped`);
  }
  if (clean.length === 0) throw new Error('estimateKelly needs at least one sample');

  const netRs = clean.map((s) => s.netR);
  const n = netRs.length;
  const meanNetR = netRs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? netRs.reduce((acc, r) => acc + (r - meanNetR) ** 2, 0) / (n - 1) : 0;
  const stdNetR = Math.sqrt(variance);

  const wins = netRs.filter((r) => r > 0);
  const losses = netRs.filter((r) => r < 0);
  const winRate = wins.length / n;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : null;

  const binary = payoffRatio !== null ? kellyBinary({ winRate, payoffRatio }) : 0;
  const optimal = kellyLogOptimal(netRs, gridMax, gridStep);

  // Cluster-aware bootstrap of the log-optimal fraction.
  const clusters = new Map<string, number[]>();
  let clustered = false;
  for (const s of clean) {
    if (s.cluster === undefined) continue;
    clustered = true;
    const list = clusters.get(s.cluster) ?? [];
    list.push(s.netR);
    clusters.set(s.cluster, list);
  }
  if (!clustered) clusters.set('all', netRs);
  const clusterArrays = [...clusters.values()];

  const rand = mulberry32(seed);
  const fractions: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const resample: number[] = [];
    for (let k = 0; k < clusterArrays.length; k += 1) {
      resample.push(...clusterArrays[Math.floor(rand() * clusterArrays.length)]);
    }
    if (resample.length === 0) continue;
    fractions.push(kellyLogOptimal(resample, gridMax, gridStep).fraction);
  }
  fractions.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  const median = quantileSorted(fractions, 0.5);
  const ciLow = quantileSorted(fractions, tail);
  const ciHigh = quantileSorted(fractions, 1 - tail);

  if (clustered && clusters.size < 10) {
    warnings.push(`only ${clusters.size} clusters; the bootstrap interval understates true uncertainty`);
  }

  let evidence: KellyEvidence;
  if (n < 30) {
    evidence = 'INSUFFICIENT_DATA';
    warnings.push(`n=${n} < 30: the Kelly fraction is not estimable to useful precision`);
  } else if (meanNetR <= 0 || ciLow <= 0) {
    evidence = 'UNCERTAIN';
    if (meanNetR <= 0) warnings.push('mean net R <= 0: the correct Kelly bet is zero');
    if (ciLow <= 0 && meanNetR > 0) warnings.push('bootstrap interval of the Kelly fraction includes zero');
  } else {
    evidence = 'POSITIVE_EDGE';
  }

  return {
    n,
    winRate,
    meanNetR,
    stdNetR,
    payoffRatio,
    kellyBinary: binary,
    kellyLogOptimal: optimal.fraction,
    expectedLogGrowth: optimal.expectedLogGrowth,
    median,
    ciLow,
    ciHigh,
    halfKelly: optimal.fraction / 2,
    quarterKelly: optimal.fraction / 4,
    evidence,
    warnings,
  };
}
