import { createHash } from 'node:crypto';
import type { PortfolioSnapshot } from '../../domain/portfolio.js';
import type { StrategySignal } from '../../domain/strategy.js';

export interface DecisionDraft {
  readonly decisionId: string;
  readonly signal: StrategySignal;
  readonly supportingStrategies: readonly string[];
}

export type DecisionOutcome =
  | { readonly kind: 'draft'; readonly draft: DecisionDraft }
  | { readonly kind: 'none'; readonly reason: string };

export const decisionIdOf = (signal: StrategySignal): string =>
  `dec_${createHash('sha256').update([signal.symbol, signal.barTime, signal.direction, signal.strategyId, signal.strategyVersion].join('|')).digest('hex').slice(0, 20)}`;

/**
 * Turns one bar's signals for one symbol into at most one trade idea. Disagreement is not averaged or outvoted:
 * strategies pointing in opposite directions produce no trade.
 */
export class DecisionBuilder {
  build(symbol: string, signals: readonly StrategySignal[], portfolio: PortfolioSnapshot): DecisionOutcome {
    if (signals.length === 0) return { kind: 'none', reason: 'no signals' };
    if (portfolio.positions.some((p) => p.symbol === symbol)) return { kind: 'none', reason: `a ${symbol} position is already open` };
    const directions = new Set(signals.map((s) => s.direction));
    if (directions.size > 1) return { kind: 'none', reason: `conflicting signals: ${signals.map((s) => `${s.strategyId}=${s.direction}`).join(', ')}` };
    // Highest confidence leads; the id breaks ties so the choice never depends on evaluation order
    const [lead, ...rest] = [...signals].sort((a, b) => b.confidence - a.confidence || a.strategyId.localeCompare(b.strategyId));
    return { kind: 'draft', draft: { decisionId: decisionIdOf(lead), signal: lead, supportingStrategies: rest.map((s) => s.strategyId) } };
  }
}
