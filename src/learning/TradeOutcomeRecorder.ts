import type { TradeRecord, AgentId } from '../types.js';
import { gradeTrade } from './TradeGrader.js';
import type { AgentLedger } from './AgentLedger.js';
import type { DecisionJournal } from '../decision/DecisionJournal.js';

/**
 * Detects newly closed trades each cycle, grades them, and updates the ledger.
 * When the trade carries a decisionId, grading runs against the persisted
 * DecisionRecord — the evidence the entry was actually taken on, and the levels
 * it was actually planned with. Trades without one (opened before the lineage
 * existed, or by a venue that lost it) fall back to a neutral reconstruction.
 */
export class TradeOutcomeRecorder {
  // Keyed on `${symbol}:${strategy}:${closedAt}` — survives restarts via AgentLedger persistence
  private seen = new Set<string>();

  constructor(private readonly ledger: AgentLedger, private readonly journal?: DecisionJournal) {}

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
    const decision = trade.decisionId ? this.journal?.get(trade.decisionId) : undefined;
    const grade = gradeTrade({
      intent: {
        symbol: trade.symbol,
        side: trade.side === 'LONG' ? 'LONG' : 'SHORT',
        sourceAgent: trade.strategy,
        evidenceScore: decision ? Math.round(decision.evidence.score) : 50, // no stored decision — neutral
        entry: decision?.entry ?? trade.entry,
        stopLoss: decision?.stopLoss ?? trade.entry - (trade.initialRisk ?? trade.entry * 0.01),
        takeProfit: decision?.takeProfit ?? trade.entry + (trade.initialRisk ?? trade.entry * 0.01) * 2,
        reasons: decision?.evidence.factors ?? [trade.reason],
      },
      entryPrice: trade.entry,
      exitPrice: trade.exit,
      pnl: trade.pnl,
      exitReason: trade.reason,
    });
    if (decision) {
      // Close the loop: the decision record now carries its realized outcome
      this.journal?.attachOutcome(decision.decisionId, {
        closedAt: trade.closedAt,
        exit: trade.exit,
        qty: trade.qty,
        pnl: trade.pnl,
        rMultiple,
        reason: trade.reason,
      });
    }
    return {
      trade, rMultiple, ...grade,
      evidence: decision ? { score: decision.evidence.score, source: 'decision' as const } : undefined,
    };
  }
}

export interface GradedTrade {
  trade: TradeRecord;
  rMultiple: number;
  score: number;
  grade: string;
  commentary: string;
  /** The evidence score the entry was actually taken on, when its decision is known. */
  evidence?: { score: number; source: 'decision' };
}

function computeR(trade: TradeRecord): number {
  if (!trade.initialRisk || trade.initialRisk === 0) return trade.pnl > 0 ? 1 : -1;
  const realized = (trade.exit - trade.entry) * (trade.side === 'LONG' ? 1 : -1);
  return Number((realized / trade.initialRisk).toFixed(2));
}
