import type { Candle } from '../types.js';

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * multiplier + result[i - 1] * (1 - multiplier));
  }
  return result;
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }
  const periodWindow = trueRanges.slice(-period);
  return periodWindow.reduce((sum, value) => sum + value, 0) / period;
}

export function zscore(values: number[], period = 30): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length;
  const variance = slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / slice.length;
  const standardDeviation = Math.sqrt(variance);
  return standardDeviation === 0 ? 0 : (values[values.length - 1] - mean) / standardDeviation;
}

export function sparkline(values: number[], len = 12): string {
  if (!values.length) return '';
  const slice = values.slice(-len);
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const range = max - min || 1;
  const TICKS = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  return slice.map((v) => TICKS[Math.min(7, Math.floor(((v - min) / range) * 8))]).join('');
}

