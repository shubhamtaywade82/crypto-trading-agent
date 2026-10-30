/**
 * Statistical-arbitrage research: cointegration-based pairs analysis — RESEARCH PLANE ONLY.
 *
 * What this is: the missing explicit pairs framework. It tests whether two price series are cointegrated
 * (their spread is stationary and mean-reverting), estimates the hedge ratio and the spread half-life, and
 * runs a chronological walk-forward pairs study where the hedge ratio and spread statistics are calibrated
 * on a trailing window and the TRADES happen on the following window — the same honesty rule as every other
 * research module here.
 *
 * What this is NOT:
 *   - It is not a live strategy and wires nothing into the execution plane.
 *   - Historical correlation is NOT evidence of cointegration: two independent random walks correlate ~0 but
 *     their "spread" is still a random walk. Only the Engle-Granger residual test decides, and even that is
 *     a test on one sample path — regime shifts break cointegrating relationships without warning.
 *   - The round-trip economics include an explicit cost assumption; a pairs edge that vanishes at 8 bps was
 *     never an edge.
 *
 * Method notes:
 *   - Engle-Granger two-step: (1) OLS y on x (with intercept), (2) ADF on the residuals without constant.
 *     Critical values follow MacKinnon (1996) for the cointegrating regression with a constant and no trend
 *     (approximate, rounded to 4 decimals; N = number of series in the cointegrating relation).
 *   - Half-life from the AR(1) mean-reversion speed of the spread: HL = -ln(2) / ln(1 + b).
 */

import { bootstrapMean, type BootstrapSummary } from './Bootstrap.js';

// ---------------------------------------------------------------------------
// Small linear algebra
// ---------------------------------------------------------------------------

/** Solves the linear system A·x = b (A square) by Gaussian elimination with partial pivoting. */
function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = col + 1; row < n; row += 1) {
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = m[row][n];
    for (let col = row + 1; col < n; col += 1) sum -= m[row][col] * x[col];
    x[row] = sum / m[row][row];
  }
  return x;
}

export interface OlsFit {
  /** Intercept. */
  alpha: number;
  /** Slope (hedge ratio for pairs). */
  beta: number;
  /** Residuals e_t = y_t - (alpha + beta * x_t). */
  residuals: number[];
  /** R-squared of the regression. */
  r2: number;
}

/** Simple OLS of y on x with intercept. */
export function olsFit(y: readonly number[], x: readonly number[]): OlsFit | null {
  const n = Math.min(y.length, x.length);
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const beta = (n * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / n;
  const residuals: number[] = [];
  let ssRes = 0;
  let ssTot = 0;
  const meanY = sy / n;
  for (let i = 0; i < n; i += 1) {
    const e = y[i] - (alpha + beta * x[i]);
    residuals.push(e);
    ssRes += e * e;
    ssTot += (y[i] - meanY) ** 2;
  }
  return { alpha, beta, residuals, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

// ---------------------------------------------------------------------------
// Augmented Dickey-Fuller on residuals (Engle-Granger step 2)
// ---------------------------------------------------------------------------

/**
 * MacKinnon (1996) critical values for the Engle-Granger cointegration test, model with a constant and no
 * trend. N = number of series in the cointegrating relation (2 for a pair). Approximate, rounded to 4dp.
 */
export const ENGLE_GRANGER_CRITICAL_VALUES: Readonly<Record<number, { '1%': number; '5%': number; '10%': number }>> = {
  1: { '1%': -3.4304, '5%': -2.8616, '10%': -2.5668 },
  2: { '1%': -3.8964, '5%': -3.3361, '10%': -3.0445 },
  3: { '1%': -4.2936, '5%': -3.7427, '10%': -3.4522 },
  4: { '1%': -4.6432, '5%': -4.0956, '10%': -3.8290 },
  5: { '1%': -4.9576, '5%': -4.4153, '10%': -4.1475 },
  6: { '1%': -5.2394, '5%': -4.6997, '10%': -4.4373 },
};

export interface AdfResult {
  /** ADF t-statistic of the lagged-level coefficient. */
  statistic: number;
  lags: number;
  /** MacKinnon critical values for N series. */
  criticalValues: { '1%': number; '5%': number; '10%': number };
  /** True when the statistic is below the 5% critical value — evidence of stationarity/cointegration. */
  cointegrated: boolean;
  /** Number of series in the cointegrating relation. */
  nVars: number;
  nobs: number;
}

/**
 * ADF test on a series, as used in Engle-Granger step 2: regress d(e_t) on e_{t-1} (+ `lags` lagged
 * differences, no constant), and return the t-statistic of the e_{t-1} coefficient.
 */
export function adfTest(series: readonly number[], lags = 1, nVars = 2): AdfResult | null {
  const clean = series.filter(Number.isFinite);
  if (clean.length < 10 + lags) return null;

  // Build regression: y_t = e_t - e_{t-1}; regressors: e_{t-1}, de_{t-1}, ..., de_{t-lags}
  const rows: { y: number; xs: number[] }[] = [];
  for (let t = lags + 1; t < clean.length; t += 1) {
    const xs = [clean[t - 1]];
    for (let i = 1; i <= lags; i += 1) xs.push(clean[t - i] - clean[t - i - 1]);
    rows.push({ y: clean[t] - clean[t - 1], xs });
  }
  const k = 1 + lags;
  const nobs = rows.length;

  // Normal equations.
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (const { y, xs } of rows) {
    for (let i = 0; i < k; i += 1) {
      xty[i] += xs[i] * y;
      for (let j = 0; j < k; j += 1) xtx[i][j] += xs[i] * xs[j];
    }
  }
  const coefficients = solveLinearSystem(xtx, xty);
  if (!coefficients) return null;

  // Residual variance and (X'X)^-1 diagonal for the standard error of gamma (coefficient 0).
  let ssr = 0;
  for (const { y, xs } of rows) {
    let pred = 0;
    for (let i = 0; i < k; i += 1) pred += coefficients[i] * xs[i];
    ssr += (y - pred) ** 2;
  }
  const sigma2 = ssr / Math.max(1, nobs - k);
  const xtxInverseDiag = invertDiagonal(xtx);
  if (!xtxInverseDiag) return null;
  const se = Math.sqrt(Math.max(0, sigma2 * xtxInverseDiag[0]));
  if (!(se > 0)) return null;

  const statistic = coefficients[0] / se;
  const criticalValues = ENGLE_GRANGER_CRITICAL_VALUES[Math.min(6, Math.max(1, nVars))];
  return {
    statistic,
    lags,
    criticalValues,
    cointegrated: statistic < criticalValues['5%'],
    nVars,
    nobs,
  };
}

/** Diagonal of the inverse of a small symmetric matrix (null when singular). */
function invertDiagonal(a: number[][]): number[] | null {
  const n = a.length;
  const inv: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  const m = a.map((row, i) => [...row, ...inv[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-15) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const factor = m[col][col];
    for (let k = col; k <= col + n; k += 1) m[col][k] /= factor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const f = m[row][col];
      if (f === 0) continue;
      for (let k = col; k <= col + n; k += 1) m[row][k] -= f * m[col][k];
    }
  }
  return m.map((row, i) => row[n + i]);
}

// ---------------------------------------------------------------------------
// Spread dynamics
// ---------------------------------------------------------------------------

export interface HalfLifeResult {
  /** Bars for a spread deviation to decay to half its size; null when the spread is not mean-reverting. */
  halfLife: number | null;
  /** AR(1) speed-of-adjustment coefficient b (negative => mean reverting). */
  b: number;
  /** Intercept of the AR(1) adjustment regression (spread drift). */
  a: number;
}

/** Half-life of mean reversion via the discrete AR(1) adjustment: d(s) = a + b*s_{t-1} + e. */
export function halfLife(spread: readonly number[]): HalfLifeResult | null {
  const n = spread.length;
  if (n < 5) return null;
  // Regression of s_t on s_{t-1} with intercept; b = slope. Equivalent to d(s_t) = a + (b-1) s_{t-1}.
  const y: number[] = [];
  const x: number[] = [];
  for (let t = 1; t < n; t += 1) {
    y.push(spread[t]);
    x.push(spread[t - 1]);
  }
  const fit = olsFit(y, x);
  if (!fit) return null;
  const b = fit.beta - 1; // adjustment coefficient
  return {
    halfLife: b < 0 && b > -2 ? -Math.log(2) / Math.log(1 + b) : null,
    b,
    a: fit.alpha,
  };
}

/** True when fewer than a quarter of the calibration windows passed the cointegration test. */
function foldGateBlocked(folds: readonly FoldStat[]): boolean {
  const cointegrated = folds.filter((f) => f.cointegrated).length;
  return cointegrated / folds.length < 0.25;
}

const meanOf = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdOf = (xs: readonly number[]): number => {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1));
};

/** Pearson correlation of two aligned series. */
export function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return Number.NaN;
  const ma = meanOf(a.slice(0, n));
  const mb = meanOf(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  return denom > 0 ? num / denom : 0;
}

export interface EngleGrangerResult {
  ols: OlsFit;
  adf: AdfResult;
  /** Cointegration verdict at the 5% level. */
  cointegrated: boolean;
  /** Pearson correlation of levels — reported so nobody mistakes it for the cointegration test. */
  correlation: number;
  /** Spread half-life in bars; null when the spread does not mean revert. */
  halfLife: number | null;
  n: number;
}

/** Full-sample Engle-Granger cointegration analysis of two aligned price series. */
export function engleGranger(y: readonly number[], x: readonly number[], lags = 1): EngleGrangerResult | null {
  const n = Math.min(y.length, x.length);
  if (n < 30) return null;
  const ols = olsFit(y.slice(0, n), x.slice(0, n));
  if (!ols) return null;
  const adf = adfTest(ols.residuals, lags, 2);
  if (!adf) return null;
  const hl = halfLife(ols.residuals);
  return {
    ols,
    adf,
    cointegrated: adf.cointegrated,
    correlation: correlation(y, x),
    halfLife: hl?.halfLife ?? null,
    n,
  };
}

// ---------------------------------------------------------------------------
// Walk-forward pairs study
// ---------------------------------------------------------------------------

export interface PairsStudyOptions {
  /** Rolling calibration window (bars) for hedge ratio and spread statistics. Default 180. */
  calibrationWindow?: number;
  /** |z| at which a position opens. Default 2.0. */
  entryZ?: number;
  /** |z| at which a position closes (mean reversion taken). Default 0.5. */
  exitZ?: number;
  /** |z| at which the position is stopped (divergence continues). Default 3.5. */
  stopZ?: number;
  /** Maximum holding period in bars; the position is closed at market. Default 100. */
  maxHoldBars?: number;
  /** Round-trip cost in bps of gross pair notional (both legs, entry+exit). Default 8. */
  costBps?: number;
  /**
   * Only take entries while the trailing calibration window passes the Engle-Granger test. Default true.
   *
   * This gate matters more than it looks: the z-score of a NON-stationary spread against its own rolling
   * mean exhibits ARTIFICIAL mean reversion (the rolling mean chases the walk), so an ungated pairs study
   * manufactures spurious profits on pure random walks. Null simulations in the test suite demonstrate
   * exactly this; the cointegration gate is what separates a tradable relationship from that artifact.
   */
  requireCointegration?: boolean;
  /** Bootstrap options for the mean round-trip return. */
  bootstrap?: { iterations?: number; seed?: number; confidence?: number };
}

export interface PairsTrade {
  entryIndex: number;
  exitIndex: number;
  /** +1 = long the spread (y under-priced vs x), -1 = short the spread. */
  direction: number;
  zEntry: number;
  zExit: number;
  /** Round-trip net P&L in % of gross pair notional (after costs). */
  pnlPct: number;
  holdBars: number;
}

export interface FoldStat {
  from: number;
  to: number;
  beta: number;
  /** Cointegration verdict on the calibration window. */
  cointegrated: boolean;
  adfStat: number;
  halfLife: number | null;
  trades: number;
}

export interface PairsStudyResult {
  nBars: number;
  /** Full-sample Engle-Granger analysis (context only — trading decisions never saw it). */
  fullSample: EngleGrangerResult | null;
  /** Per-fold calibration statistics (hedge ratio, cointegration verdict, half-life). */
  folds: FoldStat[];
  trades: PairsTrade[];
  /** Share of calibration folds that found cointegration — stability of the relationship. */
  foldCointegrationRate: number;
  nTrades: number;
  winRate: number;
  /** Mean net round-trip return in % of notional. */
  meanPnlPct: number | null;
  /** Bootstrap summary of round-trip returns (clusters = fold index). */
  bootstrap: BootstrapSummary | null;
  /** Mean holding period in bars. */
  meanHoldBars: number | null;
  warnings: string[];
}

/**
 * Chronological walk-forward pairs study.
 *
 * Each bar uses a hedge ratio and spread statistics calibrated ONLY on the trailing `calibrationWindow`
 * bars. A position opens when |z| crosses `entryZ`, closes when |z| falls under `exitZ` (reversion), is
 * stopped when |z| exceeds `stopZ` (divergence), or is time-stopped at `maxHoldBars`. Round-trip P&L is
 * measured in % of gross pair notional at entry and charged `costBps` of that notional.
 */
export function runPairsStudy(
  pricesA: readonly number[],
  pricesB: readonly number[],
  options: PairsStudyOptions = {},
): PairsStudyResult {
  const n = Math.min(pricesA.length, pricesB.length);
  const calibrationWindow = options.calibrationWindow ?? 180;
  const entryZ = options.entryZ ?? 2.0;
  const exitZ = options.exitZ ?? 0.5;
  const stopZ = options.stopZ ?? 3.5;
  const maxHoldBars = options.maxHoldBars ?? 100;
  const costBps = options.costBps ?? 8;
  const requireCointegration = options.requireCointegration ?? true;
  const warnings: string[] = [];

  if (calibrationWindow < 20) throw new Error('calibrationWindow must be at least 20 bars');
  if (n < calibrationWindow + 20) {
    warnings.push(`only ${n} bars; need calibrationWindow(${calibrationWindow}) + at least 20 trading bars`);
  }

  const fullSample = engleGranger(pricesA, pricesB);
  const trades: PairsTrade[] = [];
  const folds: FoldStat[] = [];

  // State machine over the trading region (bars >= calibrationWindow).
  let open: {
    entryIndex: number;
    entryFold: number;
    direction: number;
    zEntry: number;
    entrySpread: number;
    notional: number;
  } | null = null;
  let currentFold = -1;

  for (let t = Math.max(calibrationWindow, 1); t < n; t += 1) {
    const from = t - calibrationWindow;
    const yWindow = pricesA.slice(from, t);
    const xWindow = pricesB.slice(from, t);
    const fit = olsFit(yWindow, xWindow);
    if (!fit) continue;
    const spreadWindow = fit.residuals;
    const mu = meanOf(spreadWindow);
    const sigma = stdOf(spreadWindow);
    if (!(sigma > 0)) continue;

    // Fold diagnostics: one snapshot per calibration window (hedge ratio, cointegration, half-life).
    const tradeStart = Math.max(calibrationWindow, 1);
    if (t === tradeStart || t - tradeStart >= (folds.length) * calibrationWindow) {
      const adf = adfTest(spreadWindow, 1, 2);
      const hl = halfLife(spreadWindow);
      folds.push({
        from,
        to: t,
        beta: fit.beta,
        cointegrated: adf?.cointegrated ?? false,
        adfStat: adf?.statistic ?? Number.NaN,
        halfLife: hl?.halfLife ?? null,
        trades: 0,
      });
      currentFold = folds.length - 1;
    }

    const spreadNow = pricesA[t] - (fit.alpha + fit.beta * pricesB[t]);
    const z = (spreadNow - mu) / sigma;

    if (open === null) {
      if (Math.abs(z) >= entryZ) {
        // Gate: only trade while the trailing window actually looks cointegrated.
        const foldAllowsEntry = !requireCointegration || (currentFold >= 0 && folds[currentFold]?.cointegrated === true);
        const notional = pricesA[t] + Math.abs(fit.beta) * pricesB[t];
        if (foldAllowsEntry && notional > 0) {
          open = {
            entryIndex: t,
            entryFold: currentFold,
            direction: z > 0 ? -1 : 1, // z high => spread too wide => short the spread
            zEntry: z,
            entrySpread: spreadNow,
            notional,
          };
        }
      }
    } else {
      // Long spread (+1) profits when the spread rises; short spread (-1) when it falls.
      const pnl = (open.direction * (spreadNow - open.entrySpread)) / open.notional * 100;
      const cost = (costBps / 10_000) * 100; // % of notional, round trip
      const holdBars = t - open.entryIndex;
      const exit =
        Math.abs(z) <= exitZ || Math.abs(z) >= stopZ || holdBars >= maxHoldBars;
      if (exit) {
        trades.push({
          entryIndex: open.entryIndex,
          exitIndex: t,
          direction: open.direction,
          zEntry: open.zEntry,
          zExit: z,
          pnlPct: pnl - cost,
          holdBars,
        });
        if (open.entryFold >= 0 && folds[open.entryFold]) folds[open.entryFold].trades += 1;
        open = null;
      }
    }
  }

  const nTrades = trades.length;
  const pnls = trades.map((t) => t.pnlPct);
  const bootstrap =
    nTrades > 0
      ? bootstrapMean(
          trades.map((t) => ({ value: t.pnlPct, cluster: `win-${Math.floor(t.entryIndex / calibrationWindow)}` })),
          {
            iterations: options.bootstrap?.iterations ?? 2000,
            seed: options.bootstrap?.seed ?? 1,
            confidence: options.bootstrap?.confidence ?? 0.9,
          },
        )
      : null;

  if (nTrades < 30) {
    warnings.push(`only ${nTrades} round trips — far below any power-based sample requirement; treat as exploratory`);
  }
  if (requireCointegration && folds.length > 0 && foldGateBlocked(folds)) {
    warnings.push(
      'cointegration gate blocked entries in most calibration windows — the relationship is not stable enough to trade',
    );
  }

  return {
    nBars: n,
    fullSample,
    folds,
    trades,
    foldCointegrationRate: folds.length > 0 ? folds.filter((f) => f.cointegrated).length / folds.length : 0,
    nTrades,
    winRate: nTrades > 0 ? trades.filter((t) => t.pnlPct > 0).length / nTrades : 0,
    meanPnlPct: nTrades > 0 ? meanOf(pnls) : null,
    bootstrap,
    meanHoldBars: nTrades > 0 ? meanOf(trades.map((t) => t.holdBars)) : null,
    warnings,
  };
}
