import { ema, rsi, sma, wilderAtr } from '../../../binance/indicators.js';
import type { Candle } from '../../domain/market.js';

/** Returns a series aligned with `candles` (same length); positions without enough history are NaN. */
export type FeatureCalculator = (candles: readonly Candle[], period: number) => number[];

const closes = (candles: readonly Candle[]): number[] => candles.map((c) => c.close);

/** Highest high (or lowest low) of the `period` bars BEFORE each bar, so a close can break out of it. */
const priorExtreme = (pick: (c: Candle) => number, choose: (...values: number[]) => number): FeatureCalculator => (candles, period) =>
  candles.map((_, i) => (i < period ? NaN : choose(...candles.slice(i - period, i).map(pick))));

const rollingZscore: FeatureCalculator = (candles, period) => {
  const values = closes(candles);
  return values.map((value, i) => {
    if (i < period - 1) return NaN;
    const window = values.slice(i - period + 1, i + 1);
    const mean = window.reduce((sum, v) => sum + v, 0) / period;
    const deviation = Math.sqrt(window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period);
    return deviation === 0 ? 0 : (value - mean) / deviation;
  });
};

const rateOfChange: FeatureCalculator = (candles, period) =>
  candles.map((candle, i) => (i < period ? NaN : candle.close / candles[i - period].close - 1));

const FEATURE_KEY = /^([a-zA-Z]+):(\d+)$/;

export function parseFeatureKey(key: string): { name: string; period: number } {
  const match = FEATURE_KEY.exec(key);
  if (!match || Number(match[2]) <= 0) throw new Error(`invalid feature key "${key}": expected name:period with a positive period`);
  return { name: match[1], period: Number(match[2]) };
}

/** Shared indicator calculations, registered once and requested by key. Strategies never compute their own. */
export class FeatureRegistry {
  private readonly calculators = new Map<string, FeatureCalculator>();

  register(name: string, calculator: FeatureCalculator): this {
    if (this.calculators.has(name)) throw new Error(`feature "${name}" is already registered`);
    this.calculators.set(name, calculator);
    return this;
  }

  has(key: string): boolean {
    try {
      return this.calculators.has(parseFeatureKey(key).name);
    } catch {
      return false;
    }
  }

  compute(key: string, candles: readonly Candle[]): number[] {
    const { name, period } = parseFeatureKey(key);
    const calculator = this.calculators.get(name);
    if (!calculator) throw new Error(`feature "${name}" is not registered`);
    const series = calculator(candles, period);
    if (series.length !== candles.length) throw new Error(`feature "${key}" returned ${series.length} values for ${candles.length} candles`);
    return series;
  }

  names(): string[] {
    return [...this.calculators.keys()].sort();
  }
}

export function defaultFeatureRegistry(): FeatureRegistry {
  return new FeatureRegistry()
    .register('ema', (candles, period) => ema(closes(candles), period))
    .register('sma', (candles, period) => sma(closes(candles), period))
    .register('rsi', (candles, period) => rsi(closes(candles), period))
    .register('atr', (candles, period) => wilderAtr([...candles], period))
    .register('donchianHigh', priorExtreme((c) => c.high, Math.max))
    .register('donchianLow', priorExtreme((c) => c.low, Math.min))
    .register('zscore', rollingZscore)
    .register('roc', rateOfChange);
}
