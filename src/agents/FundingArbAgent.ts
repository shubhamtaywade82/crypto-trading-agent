import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal } from '../types.js';

export class FundingArbAgent extends BaseAgent {
  readonly id = 'FUNDING-ARB-α' as const;
  readonly strategy = 'funding_rate_cash_carry';
  private readonly APR_THRESHOLD = 0.15; // 15% annualized return threshold

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    for (const symbol of Object.keys(ctx.funding)) {
      const rate = ctx.funding[symbol];
      const apr = rate * 3 * 365; // 3 funding settlements per day
      if (apr > this.APR_THRESHOLD) {
        signals.push(
          this.signal({
            symbol,
            type: 'OPEN_HEDGE',
            confidence: Math.min(0.99, 0.8 + apr / 100),
            notionalUsdt: Math.min(ctx.equity * 0.1, 10_000),
            reason: `funding ${rate.toFixed(4)} (${(apr * 100).toFixed(1)}% APR) > 15% threshold`,
          })
        );
      }
    }
    return signals;
  }
}
