/**
 * Deflated Sharpe Ratio (DSR) and Probabilistic Sharpe Ratio (PSR).
 * Reference: Bailey & López de Prado (2014) "The Deflated Sharpe Ratio: Correcting for
 * Selection Bias, Backtest Overfitting and Non-Normality".
 */

import { normalQuantile } from './SampleSize.js';

export interface DeflatedSharpeInput {
  /** Observed annualized or per-period Sharpe ratio. */
  sharpeRatio: number;
  /** Number of return observations (trades or bars). */
  sampleLength: number;
  /** Estimated skewness of returns (0 for normal). */
  skewness?: number;
  /** Estimated kurtosis of returns (3 for normal). */
  kurtosis?: number;
  /** Total number of trials or parameter variants tested (from experiment registry). */
  trialCount: number;
  /** Variance of Sharpe ratios across all tested trials (defaults to 0.5 if unmeasured). */
  trialSharpeVariance?: number;
}

export interface DeflatedSharpeResult {
  sharpeRatio: number;
  expectedMaxSharpe: number;
  standardError: number;
  psr: number;
  dsr: number;
  isSignificant: boolean;
}

const EULER_MASCHERONI = 0.57721566490153286;

/** Standard normal cumulative distribution function (Abramowitz & Stegun approximation). */
export function normalCdf(z: number): number {
  if (z > 8.0) return 1.0;
  if (z < -8.0) return 0.0;

  const b1 = 0.31938153;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;

  const x = Math.abs(z);
  const t = 1.0 / (1.0 + p * x);
  const pdf = (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
  const cdf = 1.0 - pdf * (b1 * t + b2 * t ** 2 + b3 * t ** 3 + b4 * t ** 4 + b5 * t ** 5);

  return z >= 0 ? cdf : 1.0 - cdf;
}

/**
 * Expected maximum Sharpe ratio among N trials under the null hypothesis:
 * E[max_N] = sqrt(V[SR]) * ((1 - gamma) * Phi^-1(1 - 1/N) + gamma * Phi^-1(1 - 1/(N * e)))
 */
export function expectedMaxSharpe(trialCount: number, varSharpe = 0.5): number {
  if (trialCount <= 1) return 0;
  const stdSharpe = Math.sqrt(Math.max(0, varSharpe));
  if (stdSharpe <= 0) return 0;

  const p1 = 1 - 1 / trialCount;
  const p2 = 1 - 1 / (trialCount * Math.E);

  const z1 = normalQuantile(Math.max(0.0001, Math.min(0.9999, p1)));
  const z2 = normalQuantile(Math.max(0.0001, Math.min(0.9999, p2)));

  return stdSharpe * ((1 - EULER_MASCHERONI) * z1 + EULER_MASCHERONI * z2);
}

/**
 * Standard error of the Sharpe ratio under non-normality (Mertens 2002):
 * se = sqrt((1 - skew*SR + ((kurt - 1)/4)*SR^2) / (T - 1))
 */
export function sharpeStandardError(sr: number, t: number, skew = 0, kurt = 3): number {
  if (t <= 1) return Number.POSITIVE_INFINITY;
  const variance = (1 - skew * sr + ((kurt - 1) / 4) * Math.pow(sr, 2)) / (t - 1);
  return Math.sqrt(Math.max(1e-12, variance));
}

/**
 * Calculates Deflated Sharpe Ratio (DSR) controlling for sample size, non-normality, and multiple trials.
 * A candidate is statistically significant only when DSR >= 0.95 (5% false discovery rate).
 */
export function computeDeflatedSharpe(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const {
    sharpeRatio,
    sampleLength,
    skewness = 0,
    kurtosis = 3,
    trialCount,
    trialSharpeVariance = 0.5,
  } = input;

  const se = sharpeStandardError(sharpeRatio, sampleLength, skewness, kurtosis);
  const maxBenchmark = expectedMaxSharpe(trialCount, trialSharpeVariance);

  // Probabilistic Sharpe Ratio vs 0 benchmark
  const psr = normalCdf(sharpeRatio / se);

  // Deflated Sharpe Ratio vs expected maximum across all trials
  const zDsr = (sharpeRatio - maxBenchmark) / se;
  const dsr = normalCdf(zDsr);

  return {
    sharpeRatio,
    expectedMaxSharpe: maxBenchmark,
    standardError: se,
    psr,
    dsr,
    isSignificant: dsr >= 0.95,
  };
}
