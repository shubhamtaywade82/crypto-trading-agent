/**
 * A synthetic SOLUSDT MarketState for the tev1-evaluate demo mode.
 *
 * Everything here is FABRICATED to look like a plausible market (bullish 4h
 * BOS, bearish 15m CHOCH, long-crowded positioning — the reference market
 * brief's shape). It exists so `npm run tev1:eval` can exercise the full
 * decision pipeline without touching Binance. It must never be used as market
 * data anywhere in the trading path.
 */

import type { MarketState } from '../../market/types.js';

export function demoMarketState(now: number): MarketState {
  return {
    version: 1,
    symbol: 'SOLUSDT',
    generatedAt: now - 20 * 60_000,
    mark: 101.72,
    fundingRate: 0.0001,
    regime: { regime: 'TREND_UP', trendDirection: 'BULLISH', trendStrength: 0.62, volatility: 'MEDIUM', volatilityPercentile: 0.55, adx14: 27.5, emaSlopePct: 0.31 },
    timeframes: {
      '15m': { timeframe: '15m', candleCount: 200, lastClose: 101.78, ema20: 101.6, ema50: 101.4, ema200: 100.9, emaSlopePct: 0.05, adx14: 21.2, atr14: 0.34, atrPercentile: 0.5, rsi14: 47.8, vwap: 101.55, bollingerMiddle: 101.5, bollingerUpper: 102.1, bollingerLower: 100.9, volumeZ: -0.4 },
      '1h': { timeframe: '1h', candleCount: 200, lastClose: 101.99, ema20: 101.8, ema50: 101.5, ema200: 100.8, emaSlopePct: 0.12, adx14: 28.9, atr14: 0.61, atrPercentile: 0.6, rsi14: 55.1, vwap: 101.7, bollingerMiddle: 101.7, bollingerUpper: 102.6, bollingerLower: 100.8, volumeZ: 0.2 },
      '4h': { timeframe: '4h', candleCount: 150, lastClose: 101.99, ema20: 101.2, ema50: 100.6, ema200: 99.4, emaSlopePct: 0.2, adx14: 31.4, atr14: 1.12, atrPercentile: 0.7, rsi14: 58.3, vwap: 100.9, bollingerMiddle: 100.8, bollingerUpper: 102.9, bollingerLower: 98.7, volumeZ: 0.5 },
    },
    htfStructure: { timeframe: '4h', trend: 'BULLISH', swingHighs: [], swingLows: [], lastBreak: { type: 'BOS', direction: 'BULLISH', level: 101.2, index: 140, time: now - 26 * 3600_000, distanceAtr: 1.4, protectedLevel: 99.1 }, protectedHigh: null, protectedLow: null },
    ltfStructure: { timeframe: '15m', trend: 'BEARISH', swingHighs: [], swingLows: [], lastBreak: { type: 'CHOCH', direction: 'BEARISH', level: 101.9, index: 190, time: now - 40 * 60_000, distanceAtr: 0.8, protectedLevel: 102.41 }, protectedHigh: null, protectedLow: null },
    liquidity: { htf: { timeframe: '4h', pools: [], latestSweeps: [], recentSweeps: [] }, ltf: { timeframe: '15m', pools: [], latestSweeps: [], recentSweeps: [] } },
    zones: [],
    pricing: { high: 102.41, low: 99.11, equilibrium: 100.76, positionPct: 79.1, premium: true, discount: false },
    meanReversion: { mean: 101.4, vwap: 101.55, zscore: 0.4, rsi14: 47.8, bollingerMiddle: 101.5, bollingerUpper: 102.1, bollingerLower: 100.9, deviationPct: 0.3 },
    derivatives: {
      asOf: now - 30_000,
      openInterest: 9_034_000,
      openInterestChangePct: -0.0053,
      globalLongShortRatio: 2.98,
      topTraderAccountLongShortRatio: 1.42,
      topTraderPositionLongShortRatio: 1.8,
      takerBuySellRatio: 0.8472,
      takerVolumeImbalance: -0.08,
      orderBookImbalance: -0.12,
      spreadBps: 0.9,
      basisPct: 0.004,
    },
    crowding: { fundingPercentile: 0.62, topTraderVsGlobalBias: -0.4, positioningExtreme: 'LONG_CROWDED', takerAggressionRatio: 0.84, openInterestExpansion: false },
  };
}
