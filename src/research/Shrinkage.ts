/**
 * Empirical Bayes shrinkage estimators for regime-conditional expectancies.
 * Regularizes noisy, small-sample context cells toward the baseline grand mean,
 * eliminating false-positive "hot pockets" caused by small-N variance.
 */

export interface ShrunkCell<T> {
  cell: T;
  rawMean: number;
  shrunkenMean: number;
  shrinkageWeight: number;
  n: number;
}

export interface ShrinkageOptions {
  /**
   * Prior pseudo-observations controlling shrinkage intensity.
   * Higher k pulls estimates closer to the baseline.
   */
  k?: number;
  /** Minimum trades required for a cell to be considered for trading. */
  minReliableN?: number;
}

/**
 * Normal-Normal conjugate shrinkage estimator:
 * mu_shrunk = (n / (n + k)) * cellMean + (k / (n + k)) * baselineMean
 */
export function shrinkMean(
  cellMean: number,
  n: number,
  baselineMean: number,
  k = 25,
): number {
  if (n <= 0) return baselineMean;
  const weight = n / (n + k);
  return weight * cellMean + (1 - weight) * baselineMean;
}

/**
 * Estimates optimal k parameter from observed within-cell and between-cell variance.
 * k = sigma_within^2 / tau_between^2
 */
export function estimateK(withinVariance: number, betweenVariance: number, fallbackK = 25): number {
  if (betweenVariance <= 1e-8 || withinVariance <= 0) {
    return fallbackK;
  }
  const estimated = withinVariance / betweenVariance;
  return Math.max(5, Math.min(100, estimated));
}

/**
 * Applies Empirical Bayes shrinkage across an array of partitioned candidate cells.
 * Sorts results by shrunken expectancy descending.
 */
export function applyShrinkage<T extends { mean: number; n: number }>(
  cells: readonly T[],
  baselineMean: number,
  options: ShrinkageOptions = {},
): ShrunkCell<T>[] {
  const k = options.k ?? 25;

  return cells
    .map((cell) => {
      const shrunkenMean = shrinkMean(cell.mean, cell.n, baselineMean, k);
      const shrinkageWeight = cell.n / (cell.n + k);
      return {
        cell,
        rawMean: cell.mean,
        shrunkenMean,
        shrinkageWeight,
        n: cell.n,
      };
    })
    .sort((a, b) => b.shrunkenMean - a.shrunkenMean);
}
