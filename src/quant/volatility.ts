/**
 * Pure, deterministic multi-estimator volatility routines.
 */

import { calculateLogReturns, calculateSampleVariance } from './returns.js';

export interface OHLCBar {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export type VolatilityEstimator = 'close' | 'parkinson' | 'garmanKlass' | 'yangZhang';

export function calculateCloseVol(closes: readonly number[], periodsPerYear = 365): number {
  if (closes.length < 2) return 0;
  const returns = calculateLogReturns(closes);
  const variance = calculateSampleVariance(returns);
  return Math.sqrt(variance * periodsPerYear);
}

export function calculateParkinsonVol(bars: readonly OHLCBar[], periodsPerYear = 365): number {
  if (bars.length === 0) return 0;
  let sumSq = 0;
  let validCount = 0;
  for (const b of bars) {
    if (b.high > 0 && b.low > 0 && b.high >= b.low) {
      sumSq += Math.log(b.high / b.low) ** 2;
      validCount++;
    }
  }
  if (validCount === 0) return 0;
  // Parkinson factor: 1 / (4 * ln(2)) adjusts for extreme-value distribution
  const factor = 1 / (4 * Math.log(2));
  const variance = (factor * sumSq) / validCount;
  return Math.sqrt(variance * periodsPerYear);
}

export function calculateGarmanKlassVol(bars: readonly OHLCBar[], periodsPerYear = 365): number {
  if (bars.length === 0) return 0;
  let sum = 0;
  let validCount = 0;
  const constFactor = 2 * Math.log(2) - 1;
  for (const b of bars) {
    if (b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0) {
      const hl = Math.log(b.high / b.low);
      const co = Math.log(b.close / b.open);
      sum += 0.5 * (hl ** 2) - constFactor * (co ** 2);
      validCount++;
    }
  }
  if (validCount === 0) return 0;
  const variance = Math.max(0, sum / validCount);
  return Math.sqrt(variance * periodsPerYear);
}

function calculateRogersSatchellVariance(bars: readonly OHLCBar[]): number {
  let sum = 0;
  for (const b of bars) {
    const ho = Math.log(b.high / b.open);
    const hc = Math.log(b.high / b.close);
    const lo = Math.log(b.low / b.open);
    const lc = Math.log(b.low / b.close);
    sum += ho * hc + lo * lc;
  }
  return sum / bars.length;
}

export function calculateYangZhangVol(bars: readonly OHLCBar[], periodsPerYear = 365): number {
  const n = bars.length;
  if (n < 2) return 0;
  const overnightReturns: number[] = new Array(n - 1);
  const openToCloseReturns: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    openToCloseReturns[i] = Math.log(bars[i].close / bars[i].open);
    if (i > 0) {
      overnightReturns[i - 1] = Math.log(bars[i].open / bars[i - 1].close);
    }
  }
  const varOvernight = calculateSampleVariance(overnightReturns);
  const varOpenClose = calculateSampleVariance(openToCloseReturns);
  const varRs = calculateRogersSatchellVariance(bars);
  // Weighting constant k balances sample variance against Rogers-Satchell drift term
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const variance = Math.max(0, varOvernight + k * varOpenClose + (1 - k) * varRs);
  return Math.sqrt(variance * periodsPerYear);
}

export function calculateRollingVol(
  bars: readonly OHLCBar[],
  window: number,
  estimator: VolatilityEstimator = 'parkinson',
  periodsPerYear = 365
): number[] {
  const result: number[] = new Array(bars.length).fill(0);
  if (bars.length < window || window < 2) return result;
  for (let i = window - 1; i < bars.length; i++) {
    const slice = bars.slice(i - window + 1, i + 1);
    if (estimator === 'close') {
      result[i] = calculateCloseVol(slice.map((b) => b.close), periodsPerYear);
    } else if (estimator === 'parkinson') {
      result[i] = calculateParkinsonVol(slice, periodsPerYear);
    } else if (estimator === 'garmanKlass') {
      result[i] = calculateGarmanKlassVol(slice, periodsPerYear);
    } else {
      result[i] = calculateYangZhangVol(slice, periodsPerYear);
    }
  }
  return result;
}
