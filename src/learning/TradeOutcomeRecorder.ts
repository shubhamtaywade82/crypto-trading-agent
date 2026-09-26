import type { TradeRecord } from '../types.js';
import { gradeTrade } from './TradeGrader.js';
import type { AgentLedger } from './AgentLedger.js';

/**
 * Detects newly closed trades, grades them and updates the learning ledger.
 * Processed-trade keys are persisted so a restart cannot train twice on the same exit.
 */
export class TradeOutcomeRecorder {
  constructor(private readonly ledger: AgentLedger) {}

  process(trades: TradeRecord[]): GradedTrade[] {
    const graded: GradedTrade[] = [];
    for (const trade of trades) {
      const key = tradeKey(trade);
      if (this.ledger.hasProcessedTrade(key)) continue;
      const result = this.grade(trade);
      this.ledger.markProcessedTrade(key);
      if (result) graded.push(result);
    }
    return graded;
  }

  private grade(trade: TradeRecord): GradedTrade {
    const rMultiple = computeR(trade);
    const win = trade.pnl > 0;
    this.ledger.record(trade.strategy, win, rMultiple, { symbol: trade.symbol, at: trade.closedAt });
    const grade = gradeTrade({
      intent: {
        symbol: trade.symbol,
        side: trade.side === 'LONG' ? 'LONG' : 'SHORT',
        sourceAgent: trade.strategy,
        evidenceScore: 50,
        entry: trade.entry,
        stopLoss: trade.side === 'LONG'
          ? trade.entry - (trade.initialRisk ?? trade.entry * 0.01)
          : trade.entry + (trade.initialRisk ?? trade.entry * 0.01),
        takeProfit: trade.side === 'LONG'
          ? trade.entry + (trade.initialRisk ?? trade.entry * 0.01) * 2
          : trade.entry - (trade.initialRisk ?? trade.entry * 0.01) * 2,
        reasons: [trade.reason],
      },
      entryPrice: trade.entry,
      exitPrice: trade.exit,
      pnl: trade.pnl,
      exitReason: trade.reason,
    });
    return { trade, rMultiple, ...grade };
  }
}

export interface GradedTrade {
  trade: TradeRecord;
  rMultiple: number;
  score: number;
  grade: string;
  commentary: string;
}

function tradeKey(trade: TradeRecord): string {
  return [
    trade.symbol,
    trade.strategy,
    trade.side,
    trade.entry,
    trade.qty,
    trade.closedAt,
  ].join(':');
}

function computeR(trade: TradeRecord): number {
  if (!trade.initialRisk || trade.initialRisk === 0) return trade.pnl > 0 ? 1 : -1;
  const realized = (trade.exit - trade.entry) * (trade.side === 'LONG' ? 1 : -1);
  return Number((realized / trade.initialRisk).toFixed(2));
}
