/**
 * Cluster bootstrap for the mean of per-trade net R, with a separate null-centered test distribution.
 *
 * Trades are not independent: four symbols move together and one strategy fires on several of them in the same hour. An
 * i.i.d. bootstrap over trades would treat those as separate evidence and produce intervals that are too narrow. Resampling
 * whole clusters (by default the UTC day a decision was made) keeps same-day trades together, which is the honest unit.
 */

export interface Sample {
  value: number;
  /** Resampling unit; samples sharing a cluster are drawn together. */
  cluster: string;
}

export interface BootstrapOptions {
  iterations?: number;
  seed?: number;
  /** Two-sided interval level for the mean, e.g. 0.9 gives the 5th and 95th percentile of the resampled means. */
  confidence?: number;
}

export interface BootstrapSummary {
  n: number;
  clusters: number;
  mean: number;
  median: number;
  /** Percentile interval of the resampled means. `ciLow > 0` is the selection rule used downstream. */
  ciLow: number;
  ciHigh: number;
  /** Fraction of ordinary cluster-bootstrap means above zero; descriptive only, not a posterior probability. */
  probPositive: number;
  /** One-sided null-centered cluster-bootstrap p-value for H0: E[R] <= 0 versus H1: E[R] > 0. */
  pValue: number;
  /** 5th / 95th percentile of the individual trade outcomes (tail shape, not uncertainty of the mean). */
  p05: number;
  p95: number;
}

/** Deterministic PRNG so a report is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * Conservative cluster-adjusted effective sample size.
 *
 * Estimates a one-way random-effects ICC from unequal-sized clusters and applies
 * DEFF = 1 + (m0 - 1) * max(ICC, 0). Negative ICC estimates are not used to claim
 * extra information. This is a planning diagnostic; inference still uses the
 * cluster bootstrap itself.
 */
export function effectiveSampleSize(samples: readonly Sample[]): number {
  if (samples.length <= 1) return samples.length;
  const groups = new Map<string, number[]>();
  for (const sample of samples) {
    const values = groups.get(sample.cluster) ?? [];
    values.push(sample.value);
    groups.set(sample.cluster, values);
  }
  const clusters = [...groups.values()];
  const k = clusters.length;
  const n = samples.length;
  if (k <= 1) return 1;

  const grandMean = samples.reduce((sum, sample) => sum + sample.value, 0) / n;
  let withinSs = 0;
  let betweenSs = 0;
  let sumClusterSizeSquared = 0;
  for (const values of clusters) {
    const clusterMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    sumClusterSizeSquared += values.length ** 2;
    for (const value of values) withinSs += (value - clusterMean) ** 2;
    betweenSs += values.length * (clusterMean - grandMean) ** 2;
  }

  const dfWithin = n - k;
  if (dfWithin <= 0) return n;
  const msWithin = withinSs / dfWithin;
  const msBetween = betweenSs / (k - 1);
  const m0 = (n - sumClusterSizeSquared / n) / (k - 1);
  if (!(m0 > 1) || !(msBetween + (m0 - 1) * msWithin > 0)) return n;

  const rho = Math.max(0, Math.min(1, (msBetween - msWithin) / (msBetween + (m0 - 1) * msWithin)));
  const designEffect = Math.max(1, 1 + (m0 - 1) * rho);
  return Math.max(1, Math.min(n, n / designEffect));
}

export function bootstrapMean(samples: readonly Sample[], options: BootstrapOptions = {}): BootstrapSummary | null {
  const values = samples.map((s) => s.value);
  if (values.length === 0 || !values.every(Number.isFinite)) return null;
  const iterations = Math.max(1, Math.floor(options.iterations ?? 5000));
  const confidence = options.confidence ?? 0.9;
  if (!(confidence > 0 && confidence < 1)) throw new Error('confidence must be in (0, 1)');

  const groups = new Map<string, { sum: number; count: number }>();
  for (const s of samples) {
    const g = groups.get(s.cluster) ?? { sum: 0, count: 0 };
    g.sum += s.value;
    g.count += 1;
    groups.set(s.cluster, g);
  }
  const clusters = [...groups.values()];
  const observedMean = values.reduce((a, b) => a + b, 0) / values.length;
  const rand = mulberry32(options.seed ?? 1);
  const means: number[] = new Array(iterations);
  const nullMeans: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    let count = 0;
    let nullSum = 0;
    let nullCount = 0;
    for (let k = 0; k < clusters.length; k += 1) {
      const c = clusters[Math.floor(rand() * clusters.length)];
      sum += c.sum;
      count += c.count;
      // Center each observation by the observed grand mean before resampling whole clusters.
      // This constructs the H0: E[R] = 0 distribution while preserving within-cluster dependence
      // and unequal cluster sizes. The ordinary bootstrap distribution above remains for the CI.
      nullSum += c.sum - observedMean * c.count;
      nullCount += c.count;
    }
    means[i] = sum / count;
    nullMeans[i] = nullSum / nullCount;
  }
  means.sort((a, b) => a - b);
  const sortedValues = [...values].sort((a, b) => a - b);
  const nullAtOrAboveObserved = nullMeans.filter((m) => m >= observedMean).length;
  const ordinaryAboveZero = means.filter((m) => m > 0).length;
  const tail = (1 - confidence) / 2;
  return {
    n: values.length,
    clusters: clusters.length,
    mean: observedMean,
    median: quantileSorted(sortedValues, 0.5),
    ciLow: quantileSorted(means, tail),
    ciHigh: quantileSorted(means, 1 - tail),
    probPositive: ordinaryAboveZero / iterations,
    pValue: (nullAtOrAboveObserved + 1) / (iterations + 1),
    p05: quantileSorted(sortedValues, 0.05),
    p95: quantileSorted(sortedValues, 0.95),
  };
}

/**
 * Holm step-down over one-sided p-values: controls the family-wise error rate across every cell tested, which is what
 * slicing a strategy by regime x phase x side needs. Returns, in input order, whether each hypothesis is rejected.
 */
export function holm(pValues: readonly number[], alpha: number): boolean[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const rejected = new Array<boolean>(pValues.length).fill(false);
  for (let rank = 0; rank < order.length; rank += 1) {
    if (!(order[rank].p <= alpha / (order.length - rank))) break;
    rejected[order[rank].i] = true;
  }
  return rejected;
}
