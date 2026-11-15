import { z } from 'zod';
import { isTimeframe } from '../../domain/market.js';
import type { Strategy, StrategyContext, StrategyRequirements, StrategySignal } from '../../domain/strategy.js';
import { atrBracket, parseParameters } from '../shared.js';

export const CrossSectionalParameters = z.object({
  timeframe: z.string().refine(isTimeframe).default('4h'),
  /** Bars over which each symbol's return is measured. */
  lookback: z.number().int().min(2).max(500).default(30),
  /** Symbols with an aligned history needed before a ranking means anything. */
  minUniverse: z.number().int().min(3).default(4),
  /** How many symbols at each end of the ranking are tradable. */
  legs: z.number().int().min(1).default(1),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  stopAtr: z.number().positive().default(2.5),
  targetAtr: z.number().positive().default(5),
}).strict();

/**
 * Ranks the universe by trailing return and trades the evaluated symbol only when it is among the leaders (long) or
 * the laggards (short). Symbols whose latest closed bar differs from the evaluated symbol's are left out of the
 * ranking, so every return in it covers the same window.
 */
export class CrossSectionalMomentumStrategy implements Strategy {
  readonly id = 'cross-sectional-momentum';
  readonly version = '1.0.0';
  readonly parameters: Readonly<z.infer<typeof CrossSectionalParameters>>;
  readonly requirements: StrategyRequirements;
  private readonly atrKey: string;

  constructor(parameters?: z.input<typeof CrossSectionalParameters>) {
    const p = (this.parameters = parseParameters(this.id, CrossSectionalParameters, parameters));
    this.atrKey = `atr:${p.atrPeriod}`;
    this.requirements = {
      primaryTimeframe: p.timeframe,
      timeframes: [p.timeframe],
      features: [this.atrKey],
      warmupBars: Math.max(p.lookback + 1, p.atrPeriod * 3),
    };
  }

  evaluate({ market, features, universe }: StrategyContext): readonly StrategySignal[] {
    const p = this.parameters;
    const timeframe = this.requirements.primaryTimeframe;
    const last = (market.candles[timeframe] ?? []).at(-1);
    const atr = features.at(this.atrKey);
    if (!last || atr === null || atr <= 0) return [];

    const ranked = Object.values(universe)
      .map((snapshot) => {
        const candles = snapshot.candles[timeframe] ?? [];
        const latest = candles.at(-1), base = candles.at(-1 - p.lookback);
        return latest && base && latest.openTime === last.openTime && base.close > 0 ? { symbol: snapshot.symbol, change: latest.close / base.close - 1 } : null;
      })
      .filter((entry): entry is { symbol: string; change: number } => entry !== null)
      // The symbol breaks ties so the ranking is the same on every run
      .sort((a, b) => b.change - a.change || a.symbol.localeCompare(b.symbol));
    // Both ends must be distinct symbols, or one name could be a leader and a laggard at once
    if (ranked.length < Math.max(p.minUniverse, p.legs * 2)) return [];

    const rank = ranked.findIndex((entry) => entry.symbol === market.symbol);
    if (rank < 0) return [];
    const direction = rank < p.legs ? 'LONG' : rank >= ranked.length - p.legs ? 'SHORT' : null;
    if (!direction) return [];
    // A leader that fell, or a laggard that rose, is only relatively strong or weak; that is not momentum
    if (direction === 'LONG' ? ranked[rank].change <= 0 : ranked[rank].change >= 0) return [];
    return [{
      strategyId: this.id, strategyVersion: this.version, symbol: market.symbol, direction,
      ...atrBracket({ direction, entry: last.close, atr, stopAtr: p.stopAtr, targetAtr: p.targetAtr }),
      confidence: 0.6,
      reason: `rank ${rank + 1}/${ranked.length} by ${p.lookback}-bar return (${(ranked[rank].change * 100).toFixed(2)}%)`,
      barTime: last.openTime,
    }];
  }
}
