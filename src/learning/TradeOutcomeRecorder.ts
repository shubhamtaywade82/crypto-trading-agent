import type { TradeRecord, AgentId } from '../types.js';
import { gradeTrade } from './TradeGrader.js';
import type { AgentLedger } from './AgentLedger.js';

/**
 * Detects newly closed trades each cycle, grades them, and updates the ledger.
 * Stateless beyond the seen-trade set — no I/O except through AgentLedger.
 */
export class TradeOutcomeRecorder {
  // Keyed on `${symbol}:${strategy}:${closedAt}` — survives restarts via AgentLedger persistence
  private seen = new Set<string>();

  constructor(private readonly ledger: AgentLedger) {}

  /** Call once per cycle with the full trade journal. Only new exits are processed. */
  process(trades: TradeRecord[]): GradedTrade[] {
    const graded: GradedTrade[] = [];
    for (const trade of trades) {
      const key = `${trade.symbol}:${trade.strategy}:${trade.closedAt}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const result = this.grade(trade);
      if (result) graded.push(result);
    }
    return graded;
  }

  private grade(trade: TradeRecord): GradedTrade | null {
    const rMultiple = computeR(trade);
    const win = trade.pnl > 0;
    this.ledger.record(trade.strategy, win, rMultiple);
    const grade = gradeTrade({
      intent: {
        symbol: trade.symbol,
        side: trade.side === 'LONG' ? 'LONG' : 'SHORT',
        sourceAgent: trade.strategy,
        evidenceScore: 50, // base — no intent stored yet, neutral
        entry: trade.entry,
        stopLoss: trade.entry - (trade.initialRisk ?? trade.entry * 0.01),
        takeProfit: trade.entry + (trade.initialRisk ?? trade.entry * 0.01) * 2,
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

function computeR(trade: TradeRecord): number {
  if (!trade.initialRisk || trade.initialRisk === 0) return trade.pnl > 0 ? 1 : -1;
  const realized = (trade.exit - trade.entry) * (trade.side === 'LONG' ? 1 : -1);
  return Number((realized / trade.initialRisk).toFixed(2));
}
