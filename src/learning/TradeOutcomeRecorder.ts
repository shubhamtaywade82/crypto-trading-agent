import type { TradeRecord } from '../types.js';
import { gradeTrade } from './TradeGrader.js';
import { wholePosition } from '../position/foldPartials.js';
import type { AgentLedger } from './AgentLedger.js';
import type { DecisionJournal } from '../decision/DecisionJournal.js';
import type { DurableResearchLedger } from '../research/ResearchLedger.js';

/**
 * Detects newly closed trades, grades them and updates the learning ledger.
 * Processed-trade keys are persisted so a restart cannot train twice on the same exit.
 * When the trade carries a decisionId, grading runs against the persisted
 * DecisionRecord — the evidence the entry was actually taken on, and the levels
 * it was actually planned with. Trades without one (opened before the lineage
 * existed, or by a venue that lost it) fall back to a neutral reconstruction.
 * When researchLedger is provided, closed trades are durably recorded for walk-forward replay.
 */
export class TradeOutcomeRecorder {
  constructor(
    private readonly ledger: AgentLedger,
    private readonly journal?: DecisionJournal,
    private readonly researchLedger?: DurableResearchLedger,
  ) {}

  process(trades: TradeRecord[]): GradedTrade[] {
    const graded: GradedTrade[] = [];
    for (const trade of trades) {
      const key = tradeKey(trade);
      if (this.ledger.hasProcessedTrade(key)) continue;
      // A partial take-profit is not a finished trade: it is folded into the final close's grade, so the
      // ledger and the confidence adjuster see one outcome per position, not one win per partial.
      if (trade.partial) { this.ledger.markProcessedTrade(key); continue; }
      const result = this.grade(wholePosition(trade, trades));
      this.ledger.markProcessedTrade(key);
      if (result) graded.push(result);
    }
    return graded;
  }

  private grade(trade: TradeRecord): GradedTrade {
    const rMultiple = computeR(trade);
    const win = trade.pnl > 0;
    this.ledger.record(trade.strategy, win, rMultiple, { symbol: trade.symbol, at: trade.closedAt });
    const decision = trade.decisionId ? this.journal?.get(trade.decisionId) : undefined;
    const grade = gradeTrade({
      intent: this.buildIntent(trade, decision),
      entryPrice: trade.entry,
      exitPrice: trade.exit,
      pnl: trade.pnl,
      exitReason: trade.reason,
    });
    this.attachOutcome(decision, trade, rMultiple);
    this.recordResearchEpisode(trade, rMultiple);
    return {
      trade, rMultiple, ...grade,
      evidence: decision ? { score: decision.evidence.score, source: 'decision' as const } : undefined,
    };
  }

  private buildIntent(trade: TradeRecord, decision?: import('../decision/DecisionJournal.js').DecisionRecord) {
    const fallbackRisk = trade.initialRisk ?? trade.entry * 0.01;
    return {
      symbol: trade.symbol,
      side: trade.side === 'LONG' ? ('LONG' as const) : ('SHORT' as const),
      sourceAgent: trade.strategy,
      evidenceScore: decision ? Math.round(decision.evidence.score) : 50,
      entry: decision?.entry ?? trade.entry,
      stopLoss: decision?.stopLoss ?? (trade.side === 'LONG' ? trade.entry - fallbackRisk : trade.entry + fallbackRisk),
      takeProfit: decision?.takeProfit ?? (trade.side === 'LONG' ? trade.entry + fallbackRisk * 2 : trade.entry - fallbackRisk * 2),
      reasons: decision?.evidence.factors ?? [trade.reason],
    };
  }

  private attachOutcome(decision: import('../decision/DecisionJournal.js').DecisionRecord | undefined, trade: TradeRecord, rMultiple: number): void {
    if (!decision) return;
    this.journal?.attachOutcome(decision.decisionId, {
      closedAt: trade.closedAt,
      exit: trade.exit,
      qty: trade.qty,
      pnl: trade.pnl,
      rMultiple,
      reason: trade.reason,
    });
  }

  private recordResearchEpisode(trade: TradeRecord, rMultiple: number): void {
    if (!this.researchLedger) return;
    const now = Date.now();
    this.researchLedger.append({
      type: 'trade_episode',
      timestamps: { exchange_time: trade.closedAt, received_at: now, available_at: now },
      payload: {
        episodeId: tradeKey(trade),
        decisionId: trade.decisionId,
        symbol: trade.symbol,
        strategy: trade.strategy,
        side: trade.side === 'LONG' ? 'LONG' : 'SHORT',
        entryPrice: trade.entry,
        exitPrice: trade.exit,
        qty: trade.qty,
        grossPnl: trade.pnl,
        netPnl: trade.pnl,
        realizedR: rMultiple,
        exitReason: trade.reason ?? 'UNKNOWN',
        mfeR: rMultiple > 0 ? rMultiple : 0,
        maeR: rMultiple < 0 ? -rMultiple : 0,
        holdingMs: 0,
      },
    });
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
