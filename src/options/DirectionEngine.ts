import type { MarketState } from '../market/types.js';
import type { Candle } from '../types.js';
import type { OptionRight } from './types.js';

export interface DirectionThresholds {
  minAdx: number;
  /** A bullish entry is refused above this 15m RSI: buying calls into an overbought print pays for exhausted momentum. */
  rsiMaxLong: number;
  /** A bearish entry is refused below this 15m RSI. */
  rsiMinShort: number;
}

export interface DirectionView {
  right: OptionRight | null;
  reasons: string[];
  /** Annualised close-to-close volatility of the last 48 one-hour returns; null with too little history. */
  realizedVol: number | null;
  /** 1h ATR in underlying price units; null with too little history. */
  atr1h: number | null;
}

const HOURS_PER_YEAR = 24 * 365;
const RV_WINDOW = 48;

/** Annualised realized volatility from hourly closes; null when fewer than `window` returns exist or the series is degenerate. */
export function realizedVolatility(candles1h: ReadonlyArray<Candle>, window = RV_WINDOW): number | null {
  if (candles1h.length < window + 1) return null;
  const closes = candles1h.slice(-(window + 1)).map((c) => c.close);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (!(closes[i] > 0) || !(closes[i - 1] > 0)) return null;
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const vol = Math.sqrt(variance * HOURS_PER_YEAR);
  return Number.isFinite(vol) && vol > 0 ? vol : null;
}

/**
 * Maps the deterministic MarketState to a long-option side: CE only when the regime, the higher-timeframe structure
 * and the 15m EMAs all agree on up with enough trend strength, PE for the mirror case, nothing otherwise. Every refusal
 * is named. This is a direction filter; it makes no claim about the probability of the move.
 */
export function directionFor(state: MarketState, candles1h: ReadonlyArray<Candle>, thresholds: DirectionThresholds): DirectionView {
  const realizedVol = realizedVolatility(candles1h);
  const atr1h = state.timeframes['1h']?.atr14 ?? null;
  const tf = state.timeframes['15m'];
  const reasons: string[] = [];
  const view = (right: OptionRight | null): DirectionView => ({ right, reasons, realizedVol, atr1h });

  if (!tf || tf.ema20 === null || tf.ema50 === null || tf.rsi14 === null) {
    reasons.push('15m indicators not ready');
    return view(null);
  }
  const adx = state.regime.adx14 ?? tf.adx14;
  if (adx === null || adx < thresholds.minAdx) {
    reasons.push(`ADX ${adx === null ? 'n/a' : adx.toFixed(1)} below ${thresholds.minAdx}`);
    return view(null);
  }

  const bullish = state.regime.regime === 'TREND_UP' && state.htfStructure.trend === 'BULLISH' && tf.ema20 > tf.ema50;
  const bearish = state.regime.regime === 'TREND_DOWN' && state.htfStructure.trend === 'BEARISH' && tf.ema20 < tf.ema50;

  if (bullish) {
    if (tf.rsi14 > thresholds.rsiMaxLong) {
      reasons.push(`bullish but 15m RSI ${tf.rsi14.toFixed(1)} above ${thresholds.rsiMaxLong}`);
      return view(null);
    }
    reasons.push(`TREND_UP, HTF BULLISH, EMA20>EMA50, ADX ${adx.toFixed(1)}`);
    return view('CE');
  }
  if (bearish) {
    if (tf.rsi14 < thresholds.rsiMinShort) {
      reasons.push(`bearish but 15m RSI ${tf.rsi14.toFixed(1)} below ${thresholds.rsiMinShort}`);
      return view(null);
    }
    reasons.push(`TREND_DOWN, HTF BEARISH, EMA20<EMA50, ADX ${adx.toFixed(1)}`);
    return view('PE');
  }
  reasons.push(`no aligned trend (regime ${state.regime.regime}, HTF ${state.htfStructure.trend})`);
  return view(null);
}
