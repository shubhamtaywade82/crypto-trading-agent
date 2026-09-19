import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal, RiskDecision, LogEntry } from '../types.js';
import type { BinanceService } from '../binance/client.js';

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
      const entryPrice = signal.entry ?? 1;
      const qty = risk.positionSizeUsdt / (entryPrice || 1);
      const side = signal.type === 'OPEN_SHORT' ? 'SELL' : 'BUY';

      const res = await this.binance.openFuturesPosition({
        symbol: signal.symbol.replace('/', ''),
        side,
        qty,
        leverage: risk.leverage,
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
