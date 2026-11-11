import { adx } from '../binance/indicators.js';
import type { Candle } from '../types.js';

/**
 * Explainable, point-in-time regime classifier for 1h bars, plus a forward-looking "realized" label used only to score it.
 * Thresholds are fixed up front, never fitted, so the evaluation is not an in-sample optimisation.
 */
export type Regime = 'CALM_TREND' | 'SIDEWAYS_RANGE' | 'HIGH_VOL_EXPANSION' | 'STRESS_CRASH' | 'UNKNOWN';
export const REGIMES: readonly Regime[] = ['CALM_TREND', 'SIDEWAYS_RANGE', 'HIGH_VOL_EXPANSION', 'STRESS_CRASH', 'UNKNOWN'];

export const REGIME_RULES = {
  adxTrend: 25,
  adxRange: 20,
  highVolPercentile: 0.8,
  crashSigma: 2.5,
  rvBars: 24,
  historyBars: 720, // 30 days of 1h bars: the volatility baseline
  trendEfficiency: 0.4,
  rangeEfficiency: 0.1,
} as const;

export interface RegimeFeatures {
  adx: number;
  /** Percentile of the current 24h realized vol within the trailing 30 days, 0..1. */
  volPercentile: number;
  /** Trailing 24h log return in units of the trailing 30-day daily sigma. */
  ret24Sigma: number;
  /** Daily sigma (log-return units) of the trailing 30 days; NaN until there is enough history. */
  dailySigma: number;
}

const logReturns = (bars: readonly Candle[]): number[] => bars.map((b, i) => (i === 0 ? NaN : Math.log(b.close / bars[i - 1]!.close)));

function std(values: readonly number[]): number {
  if (values.length < 2) return NaN;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

/** Realized vol of the `window` returns ending at each index (inclusive); NaN when the window is incomplete. */
function rollingStd(returns: readonly number[], window: number): number[] {
  return returns.map((_, i) => (i < window ? NaN : std(returns.slice(i - window + 1, i + 1))));
}

function percentileOfLast(values: readonly number[], end: number, window: number): number {
  if (end < window) return NaN;
  const current = values[end]!;
  let atOrBelow = 0;
  for (let j = end - window + 1; j <= end; j += 1) if (values[j]! <= current) atOrBelow += 1;
  return atOrBelow / window;
}

/** Features computed from bars[0..i] only, for every i. */
export function regimeFeatures(bars: readonly Candle[]): RegimeFeatures[] {
  const { rvBars, historyBars } = REGIME_RULES;
  const returns = logReturns(bars);
  const rv = rollingStd(returns, rvBars);
  const baseline = rollingStd(returns, historyBars);
  const adxSeries = adx([...bars], 14);
  return bars.map((bar, i) => {
    const dailySigma = baseline[i]! * Math.sqrt(24);
    const ret24 = i >= rvBars ? Math.log(bar.close / bars[i - rvBars]!.close) : NaN;
    return { adx: adxSeries[i]!, volPercentile: percentileOfLast(rv, i, historyBars), ret24Sigma: ret24 / dailySigma, dailySigma };
  });
}

/** BTC stress (a crash in the market anchor) overrides the symbol's own state. */
export function classifyRegime(own: RegimeFeatures, btc: RegimeFeatures | undefined): Regime {
  const r = REGIME_RULES;
  const btcCrash = btc !== undefined && btc.ret24Sigma <= -r.crashSigma;
  if ([own.adx, own.volPercentile, own.ret24Sigma].some((v) => !Number.isFinite(v))) return 'UNKNOWN';
  if (own.ret24Sigma <= -r.crashSigma || btcCrash) return 'STRESS_CRASH';
  if (own.volPercentile >= r.highVolPercentile) return 'HIGH_VOL_EXPANSION';
  if (own.adx >= r.adxTrend) return 'CALM_TREND';
  if (own.adx < r.adxRange) return 'SIDEWAYS_RANGE';
  return 'UNKNOWN';
}

/**
 * What the next 24 bars actually looked like. Uses the future by design: it is the answer key, never a model input.
 * Efficiency ratio = |net move| / path length; a random walk of 24 steps averages about 0.16.
 */
export function realizedRegime(bars: readonly Candle[], i: number, features: readonly RegimeFeatures[]): Regime {
  const r = REGIME_RULES;
  const end = i + r.rvBars;
  const sigma = features[i]?.dailySigma ?? NaN;
  if (end >= bars.length || !Number.isFinite(sigma)) return 'UNKNOWN';
  const entry = bars[i]!.close;
  const window = bars.slice(i + 1, end + 1);
  const worst = Math.min(...window.map((b) => Math.log(b.low / entry)));
  if (worst <= -r.crashSigma * sigma) return 'STRESS_CRASH';
  const forwardRv = std(logReturns([bars[i]!, ...window]).slice(1));
  const trailingRv = rollingStd(logReturns(bars.slice(Math.max(0, i - r.historyBars - r.rvBars), i + 1)), r.rvBars).filter(Number.isFinite);
  const rank = trailingRv.filter((v) => v <= forwardRv).length / Math.max(1, trailingRv.length);
  if (rank >= r.highVolPercentile) return 'HIGH_VOL_EXPANSION';
  const moves = logReturns([bars[i]!, ...window]).slice(1);
  const efficiency = Math.abs(moves.reduce((s, v) => s + v, 0)) / moves.reduce((s, v) => s + Math.abs(v), 0);
  if (efficiency >= r.trendEfficiency) return 'CALM_TREND';
  if (efficiency <= r.rangeEfficiency) return 'SIDEWAYS_RANGE';
  return 'UNKNOWN';
}

export type ConfusionMatrix = Record<Regime, Record<Regime, number>>;

export function confusionMatrix(pairs: readonly { predicted: Regime; actual: Regime }[]): ConfusionMatrix {
  const matrix = Object.fromEntries(REGIMES.map((p) => [p, Object.fromEntries(REGIMES.map((a) => [a, 0]))])) as ConfusionMatrix;
  for (const { predicted, actual } of pairs) matrix[predicted][actual] += 1;
  return matrix;
}

export interface ClassScore { regime: Regime; predicted: number; precision: number; recall: number; baseRate: number; lift: number }

/** Precision against the realized label, and lift = precision / how often that label occurs anyway. */
export function scoreClasses(matrix: ConfusionMatrix): ClassScore[] {
  const total = REGIMES.reduce((s, p) => s + REGIMES.reduce((t, a) => t + matrix[p][a], 0), 0);
  return REGIMES.filter((r) => r !== 'UNKNOWN').map((regime) => {
    const predicted = REGIMES.reduce((s, a) => s + matrix[regime][a], 0);
    const actual = REGIMES.reduce((s, p) => s + matrix[p][regime], 0);
    const hit = matrix[regime][regime];
    const precision = predicted ? hit / predicted : NaN;
    const baseRate = total ? actual / total : NaN;
    return { regime, predicted, precision, recall: actual ? hit / actual : NaN, baseRate, lift: precision / baseRate };
  });
}

/** Mean consecutive bars a label is held, and label changes per 100 bars. */
export function transitionStats(labels: readonly Regime[]): { meanDwellBars: number; changesPer100: number } {
  let changes = 0;
  for (let i = 1; i < labels.length; i += 1) if (labels[i] !== labels[i - 1]) changes += 1;
  return { meanDwellBars: labels.length / (changes + 1), changesPer100: labels.length ? (100 * changes) / labels.length : 0 };
}
