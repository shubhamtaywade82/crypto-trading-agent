import { z } from 'zod';
import { isTimeframe } from '../../domain/market.js';
import type { Strategy, StrategyContext, StrategyRequirements, StrategySignal } from '../../domain/strategy.js';
import { atrBracket, parseParameters } from '../shared.js';

export const RangeBreakoutParameters = z.object({
  timeframe: z.string().refine(isTimeframe).default('1h'),
  /** Bars of the range the close must leave. */
  rangeBars: z.number().int().min(5).max(500).default(20),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  stopAtr: z.number().positive().default(2),
  targetAtr: z.number().positive().default(4),
  allowShort: z.boolean().default(true),
}).strict();

/** First close outside the prior N-bar range. A bar that was already outside on the previous close is not a new breakout. */
export class RangeBreakoutStrategy implements Strategy {
  readonly id = 'range-breakout';
  readonly version = '1.0.0';
  readonly parameters: Readonly<z.infer<typeof RangeBreakoutParameters>>;
  readonly requirements: StrategyRequirements;
  private readonly keys: { high: string; low: string; atr: string };

  constructor(parameters?: z.input<typeof RangeBreakoutParameters>) {
    const p = (this.parameters = parseParameters(this.id, RangeBreakoutParameters, parameters));
    this.keys = { high: `donchianHigh:${p.rangeBars}`, low: `donchianLow:${p.rangeBars}`, atr: `atr:${p.atrPeriod}` };
    this.requirements = {
      primaryTimeframe: p.timeframe,
      timeframes: [p.timeframe],
      features: Object.values(this.keys),
      warmupBars: Math.max(p.rangeBars + 2, p.atrPeriod * 3),
    };
  }

  evaluate({ market, features }: StrategyContext): readonly StrategySignal[] {
    const candles = market.candles[this.requirements.primaryTimeframe] ?? [];
    const last = candles.at(-1), previous = candles.at(-2);
    const high = features.at(this.keys.high), low = features.at(this.keys.low);
    const previousHigh = features.at(this.keys.high, 1), previousLow = features.at(this.keys.low, 1);
    const atr = features.at(this.keys.atr);
    if (!last || !previous || high === null || low === null || previousHigh === null || previousLow === null || atr === null || atr <= 0) return [];

    const p = this.parameters;
    const brokeUp = last.close > high && previous.close <= previousHigh;
    const brokeDown = last.close < low && previous.close >= previousLow;
    const direction = brokeUp ? 'LONG' : brokeDown && p.allowShort ? 'SHORT' : null;
    if (!direction) return [];
    const excessAtr = Math.abs(last.close - (direction === 'LONG' ? high : low)) / atr;
    return [{
      strategyId: this.id, strategyVersion: this.version, symbol: market.symbol, direction,
      ...atrBracket({ direction, entry: last.close, atr, stopAtr: p.stopAtr, targetAtr: p.targetAtr }),
      // A close far beyond the range has less room left; it ranks below a clean break
      confidence: excessAtr <= 1 ? 0.7 : 0.6,
      reason: `close ${last.close} left the ${p.rangeBars}-bar range [${low}, ${high}] ${direction === 'LONG' ? 'upward' : 'downward'}`,
      barTime: last.openTime,
    }];
  }
}
