import { atrPercentile } from '../binance/indicators.js';
import type { Candle } from '../types.js';
import { detectLiquidity } from './LiquidityEngine.js';
import { classifyRegime, buildTimeframeState } from './RegimeEngine.js';
import { analyzeStructure } from './StructureEngine.js';
import { closedCandles, resampleCandles } from './TimeframeEngine.js';
import { detectCauseZone } from './ZoneEngine.js';
import type {
  MarketState,
  MarketStateInput,
  MeanReversionState,
  RangePricing,
  Timeframe,
} from './types.js';
import { bollinger, rsi, vwap, zscore } from '../binance/indicators.js';

const TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h'];

function rangePricing(candles: Candle[]): RangePricing {
  const sample = candles.slice(-50);
  const high = sample.length ? Math.max(...sample.map((c) => c.high)) : 0;
  const low = sample.length ? Math.min(...sample.map((c) => c.low)) : 0;
  const equilibrium = high > low ? (high + low) / 2 : high;
  const last = sample.at(-1)?.close ?? 0;
  const positionPct = high > low ? ((last - low) / (high - low)) * 100 : 50;
  return {
    high,
    low,
    equilibrium,
    positionPct,
    premium: positionPct > 50,
    discount: positionPct < 50,
  };
}

function meanReversion(candles: Candle[]): MeanReversionState {
  const closes = candles.map((c) => c.close);
  const period = Math.min(20, closes.length);
  if (period < 2) {
    return {
      mean: null, vwap: null, zscore: null, rsi14: null,
      bollingerMiddle: null, bollingerUpper: null, bollingerLower: null, deviationPct: null,
    };
  }

  const bands = bollinger(closes, period, 2);
  const meanValue = bands.middle.at(-1);
  const standard = bands.upper.at(-1) !== undefined && meanValue !== undefined
    ? Math.abs(bands.upper.at(-1)! - meanValue) / 2
    : null;
  const recent = closes.slice(-period);
  const mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const latest = closes.at(-1)!;

  return {
    mean,
    vwap: vwap(candles, Math.min(96, Math.max(2, candles.length))).at(-1) ?? null,
    zscore: zscore(closes, period),
    rsi14: rsi(closes, 14).at(-1) ?? null,
    bollingerMiddle: meanValue ?? null,
    bollingerUpper: bands.upper.at(-1) ?? null,
    bollingerLower: bands.lower.at(-1) ?? null,
    deviationPct: mean !== 0 ? ((latest - mean) / mean) * 100 : null,
  };
}

export class MarketStateBuilder {
  private cache = new Map<string, MarketState>();

  build(input: MarketStateInput): MarketState {
    const closed = closedCandles(input.candles);
    const latestClosedTime = closed.at(-1)?.openTime ?? 0;
    const cached = this.cache.get(input.symbol);

    if (cached && latestClosedTime === Number(cached.generatedAt)) {
      return { ...cached, generatedAt: latestClosedTime, mark: input.mark, fundingRate: input.fundingRate };
    }

    const tf15 = closed;
    const tf1h = resampleCandles(tf15, '1h');
    const tf4h = resampleCandles(tf15, '4h');

    const timeframes = {
      '15m': buildTimeframeState('15m', tf15),
      '1h': buildTimeframeState('1h', tf1h),
      '4h': buildTimeframeState('4h', tf4h),
    };

    const htfStructure = analyzeStructure('1h', tf1h, timeframes['1h'].atr14 ?? 0);
    const ltfStructure = analyzeStructure('15m', tf15, timeframes['15m'].atr14 ?? 0);

    const liquidity = {
      htf: detectLiquidity('1h', tf1h, htfStructure, timeframes['1h'].atr14 ?? 0),
      ltf: detectLiquidity('15m', tf15, ltfStructure, timeframes['15m'].atr14 ?? 0),
    };

    const zones = [
      ...detectCauseZone('1h', tf1h, htfStructure.lastBreak, timeframes['1h'].atr14 ?? 0),
      ...detectCauseZone('15m', tf15, ltfStructure.lastBreak, timeframes['15m'].atr14 ?? 0),
    ];

    const state: MarketState = {
      version: 1,
      symbol: input.symbol,
      generatedAt: latestClosedTime,
      mark: input.mark,
      fundingRate: input.fundingRate,
      regime: classifyRegime(timeframes['15m'], timeframes['1h']),
      timeframes,
      htfStructure,
      ltfStructure,
      liquidity,
      zones,
      pricing: rangePricing(tf1h),
      meanReversion: meanReversion(tf15),
    };

    this.cache.set(input.symbol, state);
    return state;
  }

  buildAll(inputs: MarketStateInput[]): Record<string, MarketState> {
    return Object.fromEntries(inputs.map((input) => [input.symbol, this.build(input)]));
  }
}
