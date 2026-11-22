import type { Candle } from '../types.js';
import type { MarketRegime, MeanReversionState, RegimeSnapshot } from './types.js';
import { bollinger, lastVwap, rsi, zscore } from '../binance/indicators.js';

export interface MeanReversionOptions {
  period?: number;
  regime?: MarketRegime | RegimeSnapshot;
  adx14?: number | null;
}

function detectBollingerRsiReentry(
  candles: Candle[],
  bands: { upper: number[]; lower: number[] },
  rsiSeries: number[],
): 'BULLISH_REENTRY' | 'BEARISH_REENTRY' | null {
  if (candles.length < 3 || rsiSeries.length < 2) return null;

  const currentRsi = rsiSeries.at(-1);
  const prevRsi = rsiSeries.at(-2);
  if (currentRsi === undefined || prevRsi === undefined) return null;

  const recentCandles = candles.slice(-4);
  const lowerBand = bands.lower.at(-1);
  const upperBand = bands.upper.at(-1);

  if (lowerBand !== undefined && prevRsi < 30 && currentRsi >= 30) {
    const touchedLower = recentCandles.some((c) => c.low <= lowerBand * 1.002);
    if (touchedLower) return 'BULLISH_REENTRY';
  }

  if (upperBand !== undefined && prevRsi > 70 && currentRsi <= 70) {
    const touchedUpper = recentCandles.some((c) => c.high >= upperBand * 0.998);
    if (touchedUpper) return 'BEARISH_REENTRY';
  }

  return null;
}

function isRangeFavorable(regime?: MarketRegime, adx?: number | null): boolean {
  if (!regime) return false;
  const isRangeOrLowVol = regime === 'RANGE' || regime === 'LOW_VOL';
  const isLowAdx = adx === null || adx === undefined || adx <= 20;
  return isRangeOrLowVol && isLowAdx;
}

function deriveReversionCandidate(
  rangeFavorable: boolean,
  confirmation: 'BULLISH_REENTRY' | 'BEARISH_REENTRY' | null,
): 'BUY_CANDIDATE' | 'SELL_CANDIDATE' | 'NONE' {
  if (!rangeFavorable || !confirmation) return 'NONE';
  return confirmation === 'BULLISH_REENTRY' ? 'BUY_CANDIDATE' : 'SELL_CANDIDATE';
}

function createEmptyState(): MeanReversionState {
  return {
    mean: null,
    vwap: null,
    zscore: null,
    rsi14: null,
    bollingerMiddle: null,
    bollingerUpper: null,
    bollingerLower: null,
    deviationPct: null,
    bollingerRsiConfirmation: null,
    rangeFavorable: false,
    reversionCandidate: 'NONE',
  };
}

export function calculateMeanReversion(
  candles: Candle[],
  options?: number | MeanReversionOptions,
): MeanReversionState {
  const opts = typeof options === 'number' ? { period: options } : (options ?? {});
  const period = opts.period ?? 20;
  const closes = candles.map((c) => c.close);
  const effectivePeriod = Math.min(period, closes.length);
  if (effectivePeriod < 2) return createEmptyState();

  const bands = bollinger(closes, effectivePeriod, 2);
  const recent = closes.slice(-effectivePeriod);
  const mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const latest = closes.at(-1)!;
  const rsiSeries = rsi(closes, 14);
  const confirmation = detectBollingerRsiReentry(candles, bands, rsiSeries);
  const regime = typeof opts.regime === 'object' ? opts.regime?.regime : opts.regime;
  const adx = opts.adx14 ?? (typeof opts.regime === 'object' ? opts.regime?.adx14 : undefined);
  const rangeFavorable = isRangeFavorable(regime, adx);

  return {
    mean,
    vwap: lastVwap(candles, Math.min(96, Math.max(2, candles.length))),
    zscore: zscore(closes, effectivePeriod),
    rsi14: rsiSeries.at(-1) ?? null,
    bollingerMiddle: bands.middle.at(-1) ?? null,
    bollingerUpper: bands.upper.at(-1) ?? null,
    bollingerLower: bands.lower.at(-1) ?? null,
    deviationPct: mean !== 0 ? ((latest - mean) / mean) * 100 : null,
    bollingerRsiConfirmation: confirmation,
    rangeFavorable,
    reversionCandidate: deriveReversionCandidate(rangeFavorable, confirmation),
  };
}
