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
  /** Empirical skewness of the observed return series. */
  skewness: number;
  /** Empirical Pearson kurtosis of the observed return series (normal = 3). */
  kurtosis: number;
  /** Total number of trials or parameter variants tested (from experiment registry). */
  trialCount: number;
  /** Empirically measured variance across Sharpe ratios in the complete registered trial family. */
  trialSharpeVariance: number;
}

export interface ReturnSeriesStats {
  n: number;
  mean: number;
  sampleStdDev: number;
  sharpe: number;
  skewness: number;
  /** Pearson kurtosis; a Gaussian distribution has kurtosis 3. */
  kurtosis: number;
}

/** Calculate statistics from a finite observation series; null when too short or zero-variance. */
export function describeReturnSeries(values: readonly number[]): ReturnSeriesStats | null {
  if (values.length < 4 || !values.every(Number.isFinite)) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map((value) => value - mean);
  const sumSquares = centered.reduce((sum, value) => sum + value * value, 0);
  const sampleStdDev = Math.sqrt(sumSquares / (values.length - 1));
  const populationStdDev = Math.sqrt(sumSquares / values.length);
  if (!(sampleStdDev > 0) || !(populationStdDev > 0) || !Number.isFinite(sampleStdDev)) return null;
  const skewness = centered.reduce((sum, value) => sum + (value / populationStdDev) ** 3, 0) / values.length;
  const kurtosis = centered.reduce((sum, value) => sum + (value / populationStdDev) ** 4, 0) / values.length;
  if (![mean, skewness, kurtosis].every(Number.isFinite)) return null;
  return { n: values.length, mean, sampleStdDev, sharpe: mean / sampleStdDev, skewness, kurtosis };
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
export function expectedMaxSharpe(trialCount: number, varSharpe: number): number {
  if (!Number.isInteger(trialCount) || trialCount < 1) throw new Error('trialCount must be a positive integer');
  if (!Number.isFinite(varSharpe) || varSharpe < 0) throw new Error('varSharpe must be a finite, non-negative empirical variance');
  if (trialCount <= 1) return 0;
  const stdSharpe = Math.sqrt(varSharpe);
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
export function sharpeStandardError(sr: number, t: number, skew: number, kurt: number): number {
  if (t <= 1 || !Number.isFinite(sr) || !Number.isFinite(skew) || !Number.isFinite(kurt) || kurt < 1) return Number.POSITIVE_INFINITY;
  const variance = (1 - skew * sr + ((kurt - 1) / 4) * Math.pow(sr, 2)) / (t - 1);
  return variance > 0 && Number.isFinite(variance) ? Math.sqrt(variance) : Number.POSITIVE_INFINITY;
}

/**
 * Calculates Deflated Sharpe Ratio (DSR) controlling for sample size, non-normality, and multiple trials.
 * A candidate is statistically significant only when DSR >= 0.95 (5% false discovery rate).
 */
export function computeDeflatedSharpe(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const {
    sharpeRatio,
    sampleLength,
    skewness,
    kurtosis,
    trialCount,
    trialSharpeVariance,
  } = input;
  if (!Number.isFinite(sharpeRatio) || !Number.isInteger(sampleLength) || sampleLength < 2 ||
      !Number.isInteger(trialCount) || trialCount < 1 || !Number.isFinite(skewness) ||
      !Number.isFinite(kurtosis) || kurtosis < 1 || !Number.isFinite(trialSharpeVariance) || trialSharpeVariance < 0) {
    throw new Error('invalid Deflated Sharpe inputs: finite return statistics and empirical trial variance are required');
  }

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
