/**
 * Pure, deterministic correlation and covariance routines.
 */

import { calculateMean } from './returns.js';

export interface CorrelationMatrixResult {
  readonly symbols: readonly string[];
  readonly matrix: readonly (readonly number[])[];
}

export function calculateCovariance(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const xSlice = x.slice(0, n);
  const ySlice = y.slice(0, n);
  const meanX = calculateMean(xSlice);
  const meanY = calculateMean(ySlice);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += (xSlice[i] - meanX) * (ySlice[i] - meanY);
  }
  return sum / (n - 1);
}

export function calculatePearsonCorrelation(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const cov = calculateCovariance(x, y);
  const xSlice = x.slice(0, n);
  const ySlice = y.slice(0, n);
  const meanX = calculateMean(xSlice);
  const meanY = calculateMean(ySlice);
  const varX = xSlice.reduce((acc, v) => acc + (v - meanX) ** 2, 0);
  const varY = ySlice.reduce((acc, v) => acc + (v - meanY) ** 2, 0);
  if (varX <= 0 || varY <= 0) return 0;
  const denom = Math.sqrt(varX * varY);
  return Math.max(-1, Math.min(1, cov * (n - 1) / denom));
}

function computeFractionalRanks(values: readonly number[]): number[] {
  const n = values.length;
  const indexed = values.map((val, idx) => ({ val, idx }));
  indexed.sort((a, b) => a.val - b.val);
  const ranks: number[] = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && indexed[j + 1].val === indexed[i].val) j++;
    // Assign average rank to all identical tied values
    const rank = 1 + (i + j) / 2;
    for (let k = i; k <= j; k++) {
      ranks[indexed[k].idx] = rank;
    }
    i = j + 1;
  }
  return ranks;
}

export function calculateSpearmanCorrelation(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const rankX = computeFractionalRanks(x.slice(0, n));
  const rankY = computeFractionalRanks(y.slice(0, n));
  return calculatePearsonCorrelation(rankX, rankY);
}

export function calculateCorrelationMatrix(
  seriesMap: Readonly<Record<string, readonly number[]>>,
  method: 'pearson' | 'spearman' = 'pearson'
): CorrelationMatrixResult {
  const symbols = Object.keys(seriesMap);
  const k = symbols.length;
  const matrix: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const calcFn = method === 'pearson' ? calculatePearsonCorrelation : calculateSpearmanCorrelation;

  for (let i = 0; i < k; i++) {
    matrix[i][i] = 1.0;
    for (let j = i + 1; j < k; j++) {
      const coeff = calcFn(seriesMap[symbols[i]], seriesMap[symbols[j]]);
      matrix[i][j] = coeff;
      matrix[j][i] = coeff;
    }
  }
  return { symbols, matrix };
}
