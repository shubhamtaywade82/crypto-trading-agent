import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal, RiskDecision, LogEntry } from '../types.js';
import type { BinanceService } from '../binance/client.js';
import { config } from '../config.js';

export class ExecutorAgent extends BaseAgent {
  readonly id = 'EXECUTOR-ε' as const;
  readonly strategy = 'binance_order_routing';

  constructor(svc: BinanceService) {
    super(svc);
  }

  protected async analyze(_ctx: MarketContext): Promise<Signal[]> {
    return [];
  }

  async execute(signal: Signal, risk: RiskDecision): Promise<LogEntry> {
    try {
      if (!config.symbols.includes(signal.symbol)) {
        throw new Error(`${signal.symbol} is not a tradable symbol (expected one of ${config.symbols.join(',')})`);
      }
      // OPEN_HEDGE carries only a USDT notional, so size it off the live mark
      const entryPrice = signal.entry ?? (await this.binance.getPremiumIndex(signal.symbol)).markPrice;
      const qty = risk.positionSizeUsdt / entryPrice;
      // Funding harvest earns by shorting the perp when funding is positive
      const isShort = signal.type === 'OPEN_SHORT' || signal.type === 'OPEN_HEDGE';
      const side = isShort ? 'SELL' : 'BUY';

      const res = await this.binance.openFuturesPosition({
        symbol: signal.symbol,
        side,
        qty,
        leverage: risk.leverage,
        strategy: signal.agent,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        entryPrice: signal.entry,
      });

      return {
        ts: Date.now(),
        agent: this.id,
        msg: `FILLED ${side} ${signal.symbol} qty=${qty.toFixed(4)} orderId=${res.orderId} SL=${signal.stopLoss ?? '—'} server-side ✓`,
        level: 'success',
      };
    } catch (err: any) {
      return {
        ts: Date.now(),
        agent: this.id,
        msg: `EXECUTION FAILED: ${err.message}`,
        level: 'error',
      };
    }
  }
}
