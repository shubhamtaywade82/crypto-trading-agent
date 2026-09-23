import type { Candle } from '../types.js';
import type { LiquidityPool, LiquiditySweep, LiquidityState, StructureState, Timeframe } from './types.js';

export function detectLiquidity(
  timeframe: Timeframe,
  candles: Candle[],
  structure: StructureState,
  atrValue: number,
): LiquidityState {
  const pools: LiquidityPool[] = [];
  const tolerance = Math.max(atrValue * 0.15, 1e-12);
  const highs = structure.swingHighs.slice(-12);
  const lows = structure.swingLows.slice(-12);

  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      if (Math.abs(highs[i].price - highs[j].price) <= tolerance) {
        pools.push({
          type: 'EQUAL_HIGH',
          price: (highs[i].price + highs[j].price) / 2,
          tolerance,
          strength: Math.min(1, 0.5 + Math.abs(j - i) / 20),
          timeframe,
          sourceTimes: [highs[i].time, highs[j].time],
        });
      }
    }
  }

  for (let i = 0; i < lows.length; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      if (Math.abs(lows[i].price - lows[j].price) <= tolerance) {
        pools.push({
          type: 'EQUAL_LOW',
          price: (lows[i].price + lows[j].price) / 2,
          tolerance,
          strength: Math.min(1, 0.5 + Math.abs(j - i) / 20),
          timeframe,
          sourceTimes: [lows[i].time, lows[j].time],
        });
      }
    }
  }

  for (const point of highs.slice(-6)) {
    pools.push({
      type: 'SWING_HIGH',
      price: point.price,
      tolerance,
      strength: Math.min(1, 0.4 + (point.index / Math.max(1, candles.length)) * 0.4),
      timeframe,
      sourceTimes: [point.time],
    });
  }

  for (const point of lows.slice(-6)) {
    pools.push({
      type: 'SWING_LOW',
      price: point.price,
      tolerance,
      strength: Math.min(1, 0.4 + (point.index / Math.max(1, candles.length)) * 0.4),
      timeframe,
      sourceTimes: [point.time],
    });
  }

  const lookback = candles.slice(-32);
  if (lookback.length >= 8) {
    const rangeHigh = Math.max(...lookback.map((c) => c.high));
    const rangeLow = Math.min(...lookback.map((c) => c.low));
    pools.push(
      { type: 'RANGE_HIGH', price: rangeHigh, tolerance, strength: 0.7, timeframe, sourceTimes: [lookback.at(-1)!.openTime] },
      { type: 'RANGE_LOW', price: rangeLow, tolerance, strength: 0.7, timeframe, sourceTimes: [lookback.at(-1)!.openTime] },
    );
  }

  const latest = candles.at(-1);
  const latestPrevious = candles.at(-2);
  const latestSweeps: LiquiditySweep[] = latest && latestPrevious
    ? pools.flatMap((pool): LiquiditySweep[] => {
        const bullishSweep = latest.low < pool.price - pool.tolerance && latest.close > pool.price;
        const bearishSweep = latest.high > pool.price + pool.tolerance && latest.close < pool.price;
        if (bullishSweep) {
          return [{
            poolType: pool.type,
            direction: 'SELL_SIDE' as const,
            level: pool.price,
            sweepPrice: latest.low,
            close: latest.close,
            index: candles.length - 1,
            time: latest.openTime,
            confirmed: true,
          }];
        }
        if (bearishSweep) {
          return [{
            poolType: pool.type,
            direction: 'BUY_SIDE' as const,
            level: pool.price,
            sweepPrice: latest.high,
            close: latest.close,
            index: candles.length - 1,
            time: latest.openTime,
            confirmed: true,
          }];
        }
        return [];
      })
    : [];

  return {
    timeframe,
    pools: pools.slice(-40),
    latestSweeps: latestSweeps.slice(-10),
  };
}
