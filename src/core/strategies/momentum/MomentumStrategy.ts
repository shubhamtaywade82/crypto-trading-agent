import { z } from 'zod';
import { isTimeframe } from '../../domain/market.js';
import type { Strategy, StrategyContext, StrategyRequirements, StrategySignal } from '../../domain/strategy.js';
import { atrBracket, parseParameters } from '../shared.js';

export const MomentumParameters = z.object({
  timeframe: z.string().refine(isTimeframe).default('15m'),
  emaPeriod: z.number().int().min(5).max(400).default(50),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  rsiPeriod: z.number().int().min(2).max(100).default(14),
  /** Longs are refused above this RSI and shorts below its mirror (100 - x): the move is already extended. */
  rsiCeiling: z.number().min(50).max(100).default(75),
  stopAtr: z.number().positive().default(2.5),
  targetAtr: z.number().positive().default(5),
  allowShort: z.boolean().default(true),
}).strict();

/** Close crossing its EMA, bracketed by ATR. The cross must happen on the bar that just closed. */
export class MomentumStrategy implements Strategy {
  readonly id = 'momentum-ema-cross';
  readonly version = '1.0.0';
  readonly parameters: Readonly<z.infer<typeof MomentumParameters>>;
  readonly requirements: StrategyRequirements;
  private readonly keys: { ema: string; atr: string; rsi: string };

  constructor(parameters?: z.input<typeof MomentumParameters>) {
    const p = (this.parameters = parseParameters(this.id, MomentumParameters, parameters));
    this.keys = { ema: `ema:${p.emaPeriod}`, atr: `atr:${p.atrPeriod}`, rsi: `rsi:${p.rsiPeriod}` };
    this.requirements = {
      primaryTimeframe: p.timeframe,
      timeframes: [p.timeframe],
      features: Object.values(this.keys),
      // The EMA seeds on its first value; three periods lets that seed decay before the first decision
      warmupBars: Math.max(p.emaPeriod * 3, p.atrPeriod + 1, p.rsiPeriod + 2),
    };
  }

  evaluate({ market, features }: StrategyContext): readonly StrategySignal[] {
    const candles = market.candles[this.requirements.primaryTimeframe] ?? [];
    const last = candles.at(-1), previous = candles.at(-2);
    const ema = features.at(this.keys.ema), previousEma = features.at(this.keys.ema, 1);
    const atr = features.at(this.keys.atr), rsi = features.at(this.keys.rsi);
    if (!last || !previous || ema === null || previousEma === null || atr === null || rsi === null || atr <= 0) return [];

    const p = this.parameters;
    const crossedUp = previous.close <= previousEma && last.close > ema;
    const crossedDown = previous.close >= previousEma && last.close < ema;
    const direction = crossedUp && rsi < p.rsiCeiling ? 'LONG' : crossedDown && p.allowShort && rsi > 100 - p.rsiCeiling ? 'SHORT' : null;
    if (!direction) return [];
    return [{
      strategyId: this.id, strategyVersion: this.version, symbol: market.symbol, direction,
      ...atrBracket({ direction, entry: last.close, atr, stopAtr: p.stopAtr, targetAtr: p.targetAtr }),
      confidence: (direction === 'LONG' ? rsi > 50 : rsi < 50) ? 0.75 : 0.65,
      reason: `close crossed EMA${p.emaPeriod} ${direction === 'LONG' ? 'up' : 'down'}; ATR ${atr.toPrecision(5)}, RSI ${rsi.toFixed(0)}`,
      barTime: last.openTime,
    }];
  }
}
