import type { Greeks, OptionRight } from './types.js';

const YEAR_MS = 365 * 24 * 3_600_000;

/** Abramowitz-Stegun 26.2.17 normal CDF; absolute error below 7.5e-8, ample for greeks used as filters. */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

const normPdf = (x: number): number => 0.3989422804014327 * Math.exp((-x * x) / 2);

export interface BlackScholesInput {
  right: OptionRight;
  spot: number;
  strike: number;
  /** Time to expiry in ms; at or below zero the option is priced at intrinsic. */
  timeToExpiryMs: number;
  /** Annualised implied volatility as a decimal. */
  vol: number;
  /** Annualised risk-free rate as a decimal. */
  rate: number;
}

/**
 * European Black-Scholes price and greeks per ONE unit of the underlying. Binance Options are European and
 * cash-settled, so this is the model the venue's own mark IV inverts; computing greeks here (instead of trusting
 * venue greeks whose units are not documented per contract) keeps every economics figure in one known unit.
 * Returns null for inputs the model cannot price.
 */
export function blackScholes(input: BlackScholesInput): Greeks | null {
  const { right, spot, strike, timeToExpiryMs, vol, rate } = input;
  if (!(spot > 0) || !(strike > 0) || !Number.isFinite(rate)) return null;
  if (timeToExpiryMs <= 0) {
    const intrinsic = right === 'CE' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    const delta = right === 'CE' ? (spot > strike ? 1 : 0) : (spot < strike ? -1 : 0);
    return { price: intrinsic, delta, gamma: 0, thetaPerDay: 0, vega: 0 };
  }
  if (!(vol > 0) || !Number.isFinite(vol)) return null;

  const t = timeToExpiryMs / YEAR_MS;
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (rate + (vol * vol) / 2) * t) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const discount = Math.exp(-rate * t);
  const pdf = normPdf(d1);
  const gamma = pdf / (spot * vol * sqrtT);
  const vega = (spot * pdf * sqrtT) / 100;

  if (right === 'CE') {
    const price = spot * normCdf(d1) - strike * discount * normCdf(d2);
    const thetaYear = (-spot * pdf * vol) / (2 * sqrtT) - rate * strike * discount * normCdf(d2);
    return { price, delta: normCdf(d1), gamma, thetaPerDay: thetaYear / 365, vega };
  }
  const price = strike * discount * normCdf(-d2) - spot * normCdf(-d1);
  const thetaYear = (-spot * pdf * vol) / (2 * sqrtT) + rate * strike * discount * normCdf(-d2);
  return { price, delta: normCdf(d1) - 1, gamma, thetaPerDay: thetaYear / 365, vega };
}
