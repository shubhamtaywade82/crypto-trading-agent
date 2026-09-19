import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal } from '../types.js';
import { zscore } from '../binance/indicators.js';

const PAIRS: [string, string][] = [
  ['BTCUSDT', 'ETHUSDT'],
  ['SOLUSDT', 'AVAXUSDT'],
];

export class PairsAgent extends BaseAgent {
  readonly id = 'PAIRS-TRD-β' as const;
  readonly strategy = 'statistical_pairs_zscore';
  private history: Record<string, number[]> = {};

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    for (const [a, b] of PAIRS) {
      if (!ctx.marks[a] || !ctx.marks[b]) continue;
      const key = `${a}/${b}`;
      if (!this.history[key] || this.history[key].length < 30) {
        const cA = ctx.candles[a];
        const cB = ctx.candles[b];
        if (cA?.length && cB?.length) {
          const len = Math.min(cA.length, cB.length);
          this.history[key] = [];
          for (let i = Math.max(0, len - 30); i < len; i++) {
            this.history[key].push(cA[i].close / cB[i].close);
          }
        }
      }
      const ratio = ctx.marks[a] / ctx.marks[b];
      (this.history[key] ??= []).push(ratio);
      if (this.history[key].length < 30) continue;

      const z = zscore(this.history[key], 30);
      if (Math.abs(z) > 2.0) {
        const isLong = z < 0;
        signals.push(
          this.signal({
            symbol: key,
            type: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
            confidence: Math.min(0.95, 0.7 + Math.abs(z) / 10),
            entry: ratio,
            stopLoss: isLong ? ratio * 0.97 : ratio * 1.03,
            takeProfit: isLong ? ratio * 1.05 : ratio * 0.95,
            reason: `z-score ${z.toFixed(2)} (entry threshold ±2.0)`,
          })
        );
      }
    }
    return signals;
  }
}
