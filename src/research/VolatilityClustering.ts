/**
 * Volatility-clustering diagnostics and volatility-forecast benchmarking.
 *
 * Volatility clustering is the empirical observation that high-volatility periods follow high-volatility
 * periods (and low follows low). It matters operationally in two places:
 *
 *   1. Risk models: if volatility is clustered, yesterday's squared return carries information about today's
 *      risk, and position sizes that ignore it are systematically wrong in both calm and stressed markets.
 *   2. Strategy validation: backtests whose per-trade variance is estimated as if trades were homoskedastic
 *      understate the drawdown tail.
 *
 * This module deliberately starts with DIAGNOSTICS, not a complex model:
 *
 *   - `archEffectTest` — Ljung-Box tests on squared and absolute returns (the standard ARCH-effect test),
 *     plus the raw autocorrelation structure. This answers "is there clustering worth modeling at all?"
 *
 *   - `evaluateVolForecasts` — a chronological out-of-sample horse race between four one-step-ahead
 *     volatility forecasters: constant (naive), rolling window, EWMA (RiskMetrics), and a GARCH(1,1) fitted
 *     by grid quasi-MLE on the training window only. Scored by QLIKE (the robust, scale-free volatility
 *     forecasting loss) and MSE on squared returns.
 *
 * The standing decision rule (mirroring the repo's research philosophy): a more complicated model is only
 * worth keeping if it measurably beats the simple one out of sample. `sophisticatedModelEarnsItsComplexity`
 * reports exactly that verdict so callers can wire volatility-aware sizing without adding unearned
 * machinery.
 */

// ---------------------------------------------------------------------------
// Gamma / chi-square machinery (needed for Ljung-Box p-values)
// ---------------------------------------------------------------------------

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Lanczos approximation of ln(Gamma(z)). */
export function logGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i += 1) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized incomplete gamma P(a, x) via series (valid for x < a + 1). */
function gammaPSeries(a: number, x: number): number {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 1; n < 1000; n += 1) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Regularized incomplete gamma Q(a, x) via Lentz continued fraction (valid for x >= a + 1). */
function gammaQContinuedFraction(a: number, x: number): number {
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Upper regularized incomplete gamma Q(a, x) = 1 - P(a, x). */
export function gammaQ(a: number, x: number): number {
  if (!(a > 0) || x < 0) return Number.NaN;
  if (x === 0) return 1;
  return x < a + 1 ? 1 - gammaPSeries(a, x) : gammaQContinuedFraction(a, x);
}

/** Upper tail probability of a chi-square distribution with `df` degrees of freedom. */
export function chiSquareUpperTail(x: number, df: number): number {
  if (df <= 0) return Number.NaN;
  if (x <= 0) return 1;
  return gammaQ(df / 2, x / 2);
}

// ---------------------------------------------------------------------------
// Autocorrelation and Ljung-Box
// ---------------------------------------------------------------------------

/** Sample autocorrelation at the given lag (lag 0 = 1 by construction). */
export function autocorrelation(xs: readonly number[], lag: number): number {
  if (lag < 0 || lag >= xs.length) return Number.NaN;
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  let denom = 0;
  for (const x of xs) denom += (x - mean) ** 2;
  if (denom === 0) return 0;
  let num = 0;
  for (let t = lag; t < n; t += 1) num += (xs[t] - mean) * (xs[t - lag] - mean);
  return num / denom;
}

export interface LjungBoxResult {
  /** Ljung-Box Q statistic. */
  statistic: number;
  /** Degrees of freedom (number of lags). */
  df: number;
  /** Upper-tail p-value under the white-noise null. */
  pValue: number;
  lags: number;
}

/**
 * Ljung-Box portmanteau test for autocorrelation up to `lags`:
 * Q = n(n+2) * sum_k rho_k^2 / (n - k), Q ~ chi-square(lags) under the null of no autocorrelation.
 */
export function ljungBox(xs: readonly number[], lags = 10): LjungBoxResult {
  const n = xs.length;
  if (n <= lags + 2) throw new Error(`need at least lags+3 observations (${lags + 3}) for Ljung-Box, got ${n}`);
  let q = 0;
  for (let k = 1; k <= lags; k += 1) {
    const rho = autocorrelation(xs, k);
    q += (rho * rho) / (n - k);
  }
  q *= n * (n + 2);
  return { statistic: q, df: lags, pValue: chiSquareUpperTail(q, lags), lags };
}

// ---------------------------------------------------------------------------
// ARCH-effect diagnostics
// ---------------------------------------------------------------------------

export interface ArchEffectResult {
  /** Ljung-Box on SQUARED returns — the classic ARCH-effect test. */
  lbSquared: LjungBoxResult;
  /** Ljung-Box on ABSOLUTE returns — robust alternative (less sensitive to outliers). */
  lbAbsolute: LjungBoxResult;
  /** ACF of squared returns, lags 1..lags. */
  acfSquared: number[];
  /** ACF of absolute returns, lags 1..lags. */
  acfAbsolute: number[];
  /** True when squared-return autocorrelation is significant at alpha — i.e. volatility clusters. */
  clusters: boolean;
  alpha: number;
}

/** Tests for volatility clustering (ARCH effects) in a return series. */
export function archEffectTest(
  returns: readonly number[],
  options: { lags?: number; alpha?: number } = {},
): ArchEffectResult | null {
  const lags = options.lags ?? 10;
  const alpha = options.alpha ?? 0.05;
  const clean = returns.filter(Number.isFinite);
  if (clean.length < lags + 20) return null;

  const squared = clean.map((r) => r * r);
  const absolute = clean.map((r) => Math.abs(r));
  const lbSquared = ljungBox(squared, lags);
  const lbAbsolute = ljungBox(absolute, lags);
  return {
    lbSquared,
    lbAbsolute,
    acfSquared: Array.from({ length: lags }, (_, k) => autocorrelation(squared, k + 1)),
    acfAbsolute: Array.from({ length: lags }, (_, k) => autocorrelation(absolute, k + 1)),
    clusters: lbSquared.pValue < alpha,
    alpha,
  };
}

// ---------------------------------------------------------------------------
// Volatility forecasting models
// ---------------------------------------------------------------------------

export interface GarchParams {
  omega: number;
  alpha: number;
  beta: number;
  /** alpha + beta — volatility persistence; shock half-life is ln(0.5)/ln(persistence). */
  persistence: number;
  /** Bar-count for a volatility shock to decay to half its size; null when persistence <= 0. */
  shockHalfLife: number | null;
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Gaussian quasi-log-likelihood of GARCH(1,1) parameters on a return series (up to constants). */
function garchLogLikelihood(returns: readonly number[], omega: number, alpha: number, beta: number): number {
  const variance = mean(returns.map((r) => r * r));
  let sigma2 = variance; // initialize at the unconditional variance
  let ll = 0;
  for (const r of returns) {
    sigma2 = omega + alpha * r * r + beta * sigma2;
    if (!(sigma2 > 0)) return Number.NEGATIVE_INFINITY;
    ll += -0.5 * (Math.log(sigma2) + (r * r) / sigma2);
  }
  return ll;
}

/**
 * Fits GARCH(1,1) by grid quasi-MLE: alpha and beta on a grid (alpha + beta <= 0.999), omega tied to the
 * sample unconditional variance and then locally refined. This is not a full numerical optimizer, but for
 * research-grade diagnostics it recovers persistence accurately and is fully deterministic.
 */
export function fitGarch11(returns: readonly number[]): GarchParams | null {
  const clean = returns.filter(Number.isFinite);
  if (clean.length < 30) return null;
  const variance = mean(clean.map((r) => r * r));
  if (!(variance > 0)) return null;

  let best = { omega: variance * 0.05, alpha: 0.05, beta: 0.9, ll: Number.NEGATIVE_INFINITY };
  for (let alpha = 0.01; alpha <= 0.30; alpha += 0.01) {
    for (let beta = 0.50; beta <= 0.98; beta += 0.02) {
      if (alpha + beta > 0.999) continue;
      const omega = variance * (1 - alpha - beta);
      const ll = garchLogLikelihood(clean, omega, alpha, beta);
      if (ll > best.ll) best = { omega, alpha, beta, ll };
    }
  }
  // Local refinement of omega around the grid optimum.
  const { alpha, beta } = best;
  let refinedOmega = best.omega;
  let refinedLl = best.ll;
  for (const scale of [0.5, 0.7, 0.85, 1, 1.15, 1.3, 1.5, 2]) {
    const omega = best.omega * scale;
    const ll = garchLogLikelihood(clean, omega, alpha, beta);
    if (ll > refinedLl) {
      refinedLl = ll;
      refinedOmega = omega;
    }
  }

  const persistence = alpha + beta;
  return {
    omega: refinedOmega,
    alpha,
    beta,
    persistence,
    shockHalfLife: persistence > 0 && persistence < 1 ? Math.log(0.5) / Math.log(persistence) : null,
  };
}

/** One-step-ahead EWMA (RiskMetrics) variance forecasts: sigma2[t] forecasts the variance of return t. */
export function ewmaVarianceForecasts(returns: readonly number[], lambda = 0.94): number[] {
  if (returns.length === 0) return [];
  const variance = mean(returns.map((r) => r * r));
  const out: number[] = [];
  let sigma2 = variance;
  for (const r of returns) {
    out.push(sigma2);
    sigma2 = lambda * sigma2 + (1 - lambda) * r * r;
  }
  return out;
}

/** One-step-ahead rolling-window variance forecasts (window includes returns up to t-1). */
export function rollingVarianceForecasts(returns: readonly number[], window = 30): number[] {
  const out: number[] = [];
  for (let t = 0; t < returns.length; t += 1) {
    if (t < window) {
      // Warm-up: expanding window over everything observed so far.
      const slice = returns.slice(0, t);
      out.push(slice.length > 0 ? mean(slice.map((r) => r * r)) : mean(returns.map((r) => r * r)));
    } else {
      const slice = returns.slice(t - window, t);
      out.push(mean(slice.map((r) => r * r)));
    }
  }
  return out;
}

/** One-step-ahead GARCH(1,1) variance forecasts using parameters fitted on `fitUpTo` returns. */
export function garchVarianceForecasts(
  returns: readonly number[],
  params: GarchParams,
): number[] {
  const variance = mean(returns.map((r) => r * r));
  let sigma2 = variance;
  const out: number[] = [];
  for (const r of returns) {
    out.push(sigma2);
    sigma2 = params.omega + params.alpha * r * r + params.beta * sigma2;
    if (!(sigma2 > 0)) sigma2 = variance;
  }
  return out;
}

export interface VolForecastEvaluation {
  model: 'naive' | 'rolling' | 'ewma' | 'garch11';
  /** QLIKE loss: mean(log(sigma2) + r^2 / sigma2) — the robust volatility-forecasting loss. */
  qlike: number;
  /** MSE of the variance forecast against realized squared returns. */
  mse: number;
}

export interface VolatilityForecastReport {
  trainN: number;
  testN: number;
  models: VolForecastEvaluation[];
  /** Lowest-QLIKE model on the out-of-sample window. */
  best: VolForecastEvaluation['model'];
  /** GARCH parameters fitted on the training window only (null when fitting was impossible). */
  garch: GarchParams | null;
  /** EWMA lambda used. */
  lambda: number;
  /** Rolling window used. */
  rollingWindow: number;
  /**
   * True when the best model beats EWMA by more than `improvementThreshold` (relative QLIKE). Complexity has
   * to pay for itself: if EWMA is within a few percent, use EWMA.
   */
  sophisticatedModelEarnsItsComplexity: boolean;
  improvementThreshold: number;
}

/**
 * Chronological out-of-sample evaluation of one-step-ahead volatility forecasts.
 *
 * Models are configured on the first `trainFraction` of the series (GARCH is FIT there, never on the test
 * window) and scored on the remainder by QLIKE and MSE. Naive = constant train variance — the baseline any
 * model must beat before it deserves to exist.
 */
export function evaluateVolForecasts(
  returns: readonly number[],
  options: { lambda?: number; rollingWindow?: number; trainFraction?: number; improvementThreshold?: number } = {},
): VolatilityForecastReport | null {
  const clean = returns.filter(Number.isFinite);
  const lambda = options.lambda ?? 0.94;
  const rollingWindow = options.rollingWindow ?? 30;
  const trainFraction = options.trainFraction ?? 0.7;
  const improvementThreshold = options.improvementThreshold ?? 0.05;
  if (clean.length < 60) return null;

  const trainN = Math.max(30, Math.floor(clean.length * trainFraction));
  const train = clean.slice(0, trainN);
  const testStart = trainN;

  const trainVariance = mean(train.map((r) => r * r));
  const ewmaAll = ewmaVarianceForecasts(clean, lambda);
  const rollingAll = rollingVarianceForecasts(clean, rollingWindow);

  const garch = fitGarch11(train);
  const garchAll = garch ? garchVarianceForecasts(clean, garch) : null;

  const score = (name: VolForecastEvaluation['model'], forecasts: number[]): VolForecastEvaluation => {
    let qlike = 0;
    let mse = 0;
    let count = 0;
    for (let t = testStart; t < clean.length; t += 1) {
      const sigma2 = forecasts[t];
      if (!(sigma2 > 0)) continue;
      const realized = clean[t] * clean[t];
      qlike += Math.log(sigma2) + realized / sigma2;
      mse += (sigma2 - realized) ** 2;
      count += 1;
    }
    return { model: name, qlike: qlike / count, mse: mse / count };
  };

  const naiveForecasts = clean.map(() => trainVariance);
  const models = [
    score('naive', naiveForecasts),
    score('rolling', rollingAll),
    score('ewma', ewmaAll),
    ...(garchAll ? [score('garch11', garchAll)] : []),
  ];
  const best = models.reduce((a, b) => (b.qlike < a.qlike ? b : a));
  const ewma = models.find((m) => m.model === 'ewma')!;

  return {
    trainN,
    testN: clean.length - testStart,
    models,
    best: best.model,
    garch,
    lambda,
    rollingWindow,
    sophisticatedModelEarnsItsComplexity:
      best.model === 'garch11' && ewma.qlike > 0 ? 1 - best.qlike / ewma.qlike > improvementThreshold : false,
    improvementThreshold,
  };
}

// ---------------------------------------------------------------------------
// Combined report
// ---------------------------------------------------------------------------

export interface VolatilityClusteringReport {
  n: number;
  arch: ArchEffectResult | null;
  forecasts: VolatilityForecastReport | null;
  /**
   * Operator-facing verdict: which volatility model (if any) the risk plane should use for position sizing.
   * When clustering is absent or no model beats EWMA out of sample, the answer is deliberately simple.
   */
  recommendation:
    | 'NO_CLUSTERING_CONSTANT_VOL_OK'
    | 'CLUSTERING_USE_EWMA'
    | 'CLUSTERING_USE_GARCH'
    | 'INSUFFICIENT_DATA';
}

/** Full volatility-clustering diagnostic + forecast comparison over a return series. */
export function volatilityClusteringReport(
  returns: readonly number[],
  options: { lags?: number; alpha?: number; lambda?: number; rollingWindow?: number; trainFraction?: number } = {},
): VolatilityClusteringReport {
  const clean = returns.filter(Number.isFinite);
  if (clean.length < 60) {
    return { n: clean.length, arch: null, forecasts: null, recommendation: 'INSUFFICIENT_DATA' };
  }
  const arch = archEffectTest(clean, { lags: options.lags, alpha: options.alpha });
  const forecasts = evaluateVolForecasts(clean, {
    lambda: options.lambda,
    rollingWindow: options.rollingWindow,
    trainFraction: options.trainFraction,
  });

  let recommendation: VolatilityClusteringReport['recommendation'] = 'NO_CLUSTERING_CONSTANT_VOL_OK';
  if (arch?.clusters) {
    recommendation = 'CLUSTERING_USE_EWMA';
    if (forecasts?.sophisticatedModelEarnsItsComplexity) recommendation = 'CLUSTERING_USE_GARCH';
  }

  return { n: clean.length, arch, forecasts, recommendation };
}

/** Simple log returns from a close-price series. */
export function logReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}
