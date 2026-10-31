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
  /** Present when the statistic was derived from an explicitly sampled equity return series. */
  samplingFrequencyMs?: number;
  sampleMean?: number;
  sampleStdDev?: number;
  skewness?: number;
  kurtosis?: number;
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

export interface DeflatedSharpeFromReturnsResult extends DeflatedSharpeResult {
  samplingFrequencyMs: number;
  sampleMean: number;
  sampleStdDev: number;
  skewness: number;
  kurtosis: number;
}

export interface DeflatedSharpeFromReturnsInput {
  /** Net simple returns from a real portfolio equity curve, sampled at a fixed cadence. */
  returns: readonly number[];
  samplingFrequencyMs: number;
  trialCount: number;
  /** Empirical variance of per-trial Sharpe ratios in the full search history; required when trialCount > 1. */
  trialSharpeVariance: number;
}

/**
 * Compute DSR from an actual fixed-frequency equity return series.
 * Sharpe is expressed per sampling interval (not annualized), and all trial Sharpe ratios
 * used for the variance estimate must use the same cadence.
 */
export function computeDeflatedSharpeFromReturns(input: DeflatedSharpeFromReturnsInput): DeflatedSharpeFromReturnsResult {
  const { returns, samplingFrequencyMs, trialCount, trialSharpeVariance } = input;
  if (!Number.isFinite(samplingFrequencyMs) || samplingFrequencyMs <= 0) throw new Error('samplingFrequencyMs must be positive');
  if (!Number.isInteger(trialCount) || trialCount < 1) throw new Error('trialCount must be a positive integer');
  if (trialCount > 1 && (!Number.isFinite(trialSharpeVariance) || trialSharpeVariance <= 0)) {
    throw new Error('trialSharpeVariance must be measured and positive when trialCount > 1');
  }
  if (returns.length < 2 || !returns.every(Number.isFinite)) throw new Error('at least two finite equity returns are required');
  const sampleMean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const centered = returns.map((value) => value - sampleMean);
  const m2 = centered.reduce((sum, value) => sum + value ** 2, 0) / returns.length;
  if (!(m2 > 0)) throw new Error('equity return series must have non-zero variance');
  const m3 = centered.reduce((sum, value) => sum + value ** 3, 0) / returns.length;
  const m4 = centered.reduce((sum, value) => sum + value ** 4, 0) / returns.length;
  const skewness = m3 / (m2 ** 1.5);
  const kurtosis = m4 / (m2 ** 2);
  const sampleStdDev = Math.sqrt(returns.reduce((sum, value) => sum + (value - sampleMean) ** 2, 0) / (returns.length - 1));
  const sharpeRatio = sampleMean / sampleStdDev;
  const result = computeDeflatedSharpe({
    sharpeRatio,
    sampleLength: returns.length,
    skewness,
    kurtosis,
    trialCount,
    trialSharpeVariance,
  });
  return { ...result, samplingFrequencyMs, sampleMean, sampleStdDev, skewness, kurtosis };
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
  if (!Number.isFinite(sharpeRatio) || !Number.isInteger(sampleLength) || sampleLength < 2) throw new Error('sharpeRatio must be finite and sampleLength must be >= 2');
  if (!Number.isInteger(trialCount) || trialCount < 1) throw new Error('trialCount must be a positive integer');
  if (!Number.isFinite(skewness) || !Number.isFinite(kurtosis) || kurtosis < 1) throw new Error('invalid return skewness/kurtosis');
  if (!Number.isFinite(trialSharpeVariance) || trialSharpeVariance < 0) throw new Error('trialSharpeVariance must be finite and non-negative');

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
