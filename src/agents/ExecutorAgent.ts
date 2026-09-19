import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Signal, RiskDecision, LogEntry } from '../types.js';
import type { BinanceService } from '../binance/client.js';
import { config } from '../config.js';
import { formatPrice, formatQty, roundPrice, roundQty } from '../binance/symbolRules.js';

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
      const qty = roundQty(signal.symbol, risk.positionSizeUsdt / entryPrice);
      if (qty <= 0) {
        throw new Error(`${risk.positionSizeUsdt.toFixed(2)} USDT is below one lot of ${signal.symbol} at ${entryPrice}`);
      }
      const round = (price?: number) => (price === undefined ? undefined : roundPrice(signal.symbol, price));
      // Funding harvest earns by shorting the perp when funding is positive
      const isShort = signal.type === 'OPEN_SHORT' || signal.type === 'OPEN_HEDGE';
      const side = isShort ? 'SELL' : 'BUY';

      const stopLoss = round(signal.stopLoss);
      const res = await this.binance.openFuturesPosition({
        symbol: signal.symbol,
        side,
        qty,
        leverage: risk.leverage,
        strategy: signal.agent,
        stopLoss,
        takeProfit: round(signal.takeProfit),
        entryPrice: round(signal.entry),
      });

      return {
        ts: Date.now(),
        agent: this.id,
        msg: `FILLED ${side} ${signal.symbol} qty=${formatQty(signal.symbol, qty)} orderId=${res.orderId} SL=${stopLoss === undefined ? '—' : formatPrice(signal.symbol, stopLoss)} server-side ✓`,
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
