import type { Candle, Timeframe } from '../../domain/market.js';
import type { FeatureSnapshot } from '../../domain/strategy.js';
import type { FeatureRegistry } from './FeatureRegistry.js';

export class FeatureEngine {
  constructor(private readonly registry: FeatureRegistry) {}

  /** Computes each requested key once over the closed candles of one timeframe. */
  compute(timeframe: Timeframe, candles: readonly Candle[], keys: readonly string[]): FeatureSnapshot {
    const computed = new Map<string, readonly number[]>();
    for (const key of new Set(keys)) computed.set(key, Object.freeze(this.registry.compute(key, candles)));
    const series = (key: string): readonly number[] => {
      const values = computed.get(key);
      if (!values) throw new Error(`feature "${key}" was not declared in the strategy's requirements`);
      return values;
    };
    return {
      timeframe,
      series,
      at: (key, offset = 0) => {
        const values = series(key);
        const value = values[values.length - 1 - offset];
        return value !== undefined && Number.isFinite(value) ? value : null;
      },
    };
  }
}
