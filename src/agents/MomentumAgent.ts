import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal, Candle } from '../types.js';
import { ema, atr, rsi } from '../binance/indicators.js';
import { config } from '../config.js';

// The EMA seeds on its first value, so a longer history would shift the crossover points
const MOMENTUM_WINDOW = 60;

export class MomentumAgent extends BaseAgent {
  readonly id = 'MOMENTUM-γ' as const;
  readonly strategy = 'atr_volatility_momentum';

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    for (const symbol of config.symbols) {
      const candles = ctx.candles[symbol]?.slice(-MOMENTUM_WINDOW);
      if (!candles || candles.length < 60) continue;

      const closes = candles.map((c: Candle) => c.close);
      const ema50 = ema(closes, 50);
      const price = closes[closes.length - 1];
      const atr14 = atr(candles, 14);
      const rsiSeries = rsi(closes, 14);
      const currentRsi = rsiSeries[rsiSeries.length - 1] ?? 50;

      // Avoid buying when already overbought (RSI > 75)
      const prevPrice = closes[closes.length - 2];
      const prevEma = ema50[ema50.length - 2];
      const crossed = prevPrice <= prevEma && price > ema50[ema50.length - 1];

      if (crossed && atr14 > 0 && currentRsi < 75) {
        signals.push(
          this.signal({
            symbol,
            type: 'OPEN_LONG',
            confidence: currentRsi > 50 ? 0.75 : 0.65,
            entry: price,
            stopLoss: price - atr14 * 2.5,
            takeProfit: price + atr14 * 5,
            reason: `EMA50 cross + ATR (${atr14.toFixed(2)}) RSI=${currentRsi.toFixed(0)}`,
          })
        );
      }
    }
    return signals;
  }
}
