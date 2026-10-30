/**
 * Statistical power and required sample size derivations for trading research.
 * Replaces arbitrary heuristic trade floors with formal power analysis.
 */

export interface PowerCalculationInput {
  /** Target expected return improvement in R units (delta_mu). */
  effectSizeR: number;
  /** Standard deviation of per-trade return in R units (defaults to 1.0R). */
  sigmaR?: number;
  /** Significance level alpha (default 0.05 for two-sided test). */
  alpha?: number;
  /** Desired statistical power (1 - beta), defaults to 0.80. */
  power?: number;
}

export interface PowerCalculationResult {
  requiredSampleSize: number;
  effectSizeR: number;
  sigmaR: number;
  alpha: number;
  power: number;
  zAlpha: number;
  zBeta: number;
}

/** Standard normal quantile approximation (Acklam algorithm). */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new Error('p must be between 0 and 1');

  // Coefficients in rational approximations
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * Calculates the required sample size for detecting an expected edge delta_mu in R units:
 * N >= ((z_alpha + z_beta) * sigma / delta_mu)^2
 */
export function calculateRequiredSampleSize(input: PowerCalculationInput): PowerCalculationResult {
  const { effectSizeR, sigmaR = 1.0, alpha = 0.05, power = 0.80 } = input;
  if (!Number.isFinite(effectSizeR) || effectSizeR <= 0) throw new Error('effectSizeR must be finite and strictly positive');
  if (!Number.isFinite(sigmaR) || sigmaR <= 0) throw new Error('sigmaR must be finite and strictly positive');
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new Error('alpha must be between 0 and 1');
  if (!Number.isFinite(power) || power <= 0.5 || power >= 1) throw new Error('power must be between 0.5 and 1');

  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);

  const nExact = Math.pow(((zAlpha + zBeta) * sigmaR) / effectSizeR, 2);
  const requiredSampleSize = Math.ceil(nExact);

  return {
    requiredSampleSize,
    effectSizeR,
    sigmaR,
    alpha,
    power,
    zAlpha,
    zBeta,
  };
}
