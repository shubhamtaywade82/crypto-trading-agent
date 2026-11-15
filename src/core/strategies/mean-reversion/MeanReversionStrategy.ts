import { z } from 'zod';
import { isTimeframe } from '../../domain/market.js';
import type { Strategy, StrategyContext, StrategyRequirements, StrategySignal } from '../../domain/strategy.js';
import { parseParameters } from '../shared.js';

export const MeanReversionParameters = z.object({
  timeframe: z.string().refine(isTimeframe).default('15m'),
  lookback: z.number().int().min(10).max(500).default(30),
  /** |z| the close must have exceeded on the previous bar. */
  entryZ: z.number().positive().default(2),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  stopAtr: z.number().positive().default(1.5),
}).strict();

/**
 * Fades a stretched close once it turns back: the previous bar was beyond the z-score band and the bar that just closed
 * is back inside it. The target is the rolling mean, the stop an ATR multiple beyond the entry.
 */
export class MeanReversionStrategy implements Strategy {
  readonly id = 'mean-reversion-zscore';
  readonly version = '1.0.0';
  readonly parameters: Readonly<z.infer<typeof MeanReversionParameters>>;
  readonly requirements: StrategyRequirements;
  private readonly keys: { z: string; mean: string; atr: string };

  constructor(parameters?: z.input<typeof MeanReversionParameters>) {
    const p = (this.parameters = parseParameters(this.id, MeanReversionParameters, parameters));
    this.keys = { z: `zscore:${p.lookback}`, mean: `sma:${p.lookback}`, atr: `atr:${p.atrPeriod}` };
    this.requirements = {
      primaryTimeframe: p.timeframe,
      timeframes: [p.timeframe],
      features: Object.values(this.keys),
      warmupBars: Math.max(p.lookback + 2, p.atrPeriod * 3),
    };
  }

  evaluate({ market, features }: StrategyContext): readonly StrategySignal[] {
    const last = (market.candles[this.requirements.primaryTimeframe] ?? []).at(-1);
    const z = features.at(this.keys.z), previousZ = features.at(this.keys.z, 1);
    const mean = features.at(this.keys.mean), atr = features.at(this.keys.atr);
    if (!last || z === null || previousZ === null || mean === null || atr === null || atr <= 0) return [];

    const p = this.parameters;
    const direction = previousZ <= -p.entryZ && z > -p.entryZ ? 'LONG' : previousZ >= p.entryZ && z < p.entryZ ? 'SHORT' : null;
    if (!direction) return [];
    const entry = last.close;
    // The mean must still be ahead of the entry; a close that already overshot it has nothing left to revert to
    if (direction === 'LONG' ? mean <= entry : mean >= entry) return [];
    return [{
      strategyId: this.id, strategyVersion: this.version, symbol: market.symbol, direction, entry,
      stopLoss: direction === 'LONG' ? entry - atr * p.stopAtr : entry + atr * p.stopAtr,
      takeProfit: mean,
      confidence: Math.abs(previousZ) >= p.entryZ * 1.5 ? 0.7 : 0.6,
      reason: `z-score turned back inside ±${p.entryZ} (${previousZ.toFixed(2)} -> ${z.toFixed(2)}); target is the ${p.lookback}-bar mean ${mean.toPrecision(7)}`,
      barTime: last.openTime,
    }];
  }
}
