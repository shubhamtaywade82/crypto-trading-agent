import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal } from '../types.js';
import { config } from '../config.js';
import type { MarketState } from '../market/types.js';

export class CrowdingAgent extends BaseAgent {
  readonly id = 'CROWDING-ι' as const;
  readonly strategy = 'contrarian_crowding_reversal';
  private lastHandledTime = new Map<string, number>();

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    if (!ctx.marketState) return [];
    const signals: Signal[] = [];
    for (const symbol of config.symbols) {
      const state = ctx.marketState[symbol];
      if (!state) continue;
      const signal = this.evaluateSymbol(symbol, state);
      if (signal) signals.push(signal);
    }
    return signals;
  }

  private evaluateSymbol(symbol: string, state: MarketState): Signal | null {
    if (this.lastHandledTime.get(symbol) === state.generatedAt) return null;
    const crowding = state.crowding;
    if (!crowding || crowding.positioningExtreme === 'BALANCED') return null;

    const atr = state.timeframes['15m'].atr14 ?? state.timeframes['1h'].atr14 ?? 0;
    if (atr <= 0) return null;

    if (crowding.positioningExtreme === 'LONG_CROWDED' && state.pricing.premium) {
      return this.buildFadeLongs(symbol, state, atr);
    }
    if (crowding.positioningExtreme === 'SHORT_CROWDED' && state.pricing.discount) {
      return this.buildFadeShorts(symbol, state, atr);
    }
    return null;
  }

  private buildFadeLongs(symbol: string, state: MarketState, atr: number): Signal | null {
    // Only fade over-leveraged longs if buy-side liquidity was swept at resistance
    const sweep = state.liquidity.ltf.latestSweeps.find((s) => s.direction === 'BUY_SIDE');
    if (!sweep) return null;

    const entry = state.mark;
    const stopLoss = Math.max(sweep.sweepPrice, entry + 1.2 * atr);
    const takeProfit = state.pricing.equilibrium;
    if (takeProfit >= entry) return null;

    this.lastHandledTime.set(symbol, state.generatedAt);
    return this.signal({
      symbol,
      type: 'OPEN_SHORT',
      confidence: 0.85,
      entry,
      stopLoss,
      takeProfit,
      reason: `Fading LONG_CROWDED at premium after buy-side sweep at ${sweep.sweepPrice}`,
      ts: state.generatedAt,
    });
  }

  private buildFadeShorts(symbol: string, state: MarketState, atr: number): Signal | null {
    // Only squeeze over-leveraged shorts if sell-side liquidity was swept at support
    const sweep = state.liquidity.ltf.latestSweeps.find((s) => s.direction === 'SELL_SIDE');
    if (!sweep) return null;

    const entry = state.mark;
    const stopLoss = Math.min(sweep.sweepPrice, entry - 1.2 * atr);
    const takeProfit = state.pricing.equilibrium;
    if (takeProfit <= entry) return null;

    this.lastHandledTime.set(symbol, state.generatedAt);
    return this.signal({
      symbol,
      type: 'OPEN_LONG',
      confidence: 0.85,
      entry,
      stopLoss,
      takeProfit,
      reason: `Squeezing SHORT_CROWDED at discount after sell-side sweep at ${sweep.sweepPrice}`,
      ts: state.generatedAt,
    });
  }
}
