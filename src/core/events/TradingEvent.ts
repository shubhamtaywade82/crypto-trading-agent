import type { OrderResult, PlaceOrderCommand } from '../domain/execution.js';
import type { BarClosedEvent } from '../domain/market.js';
import type { RiskDecision, TradeProposal } from '../domain/risk.js';
import type { StrategySignal } from '../domain/strategy.js';
import type { AdvisorOpinion } from '../ports/DecisionAdvisorPort.js';

interface Base {
  /** Position in the engine's single ordered stream; assigned by the bus. */
  readonly sequence: number;
  readonly at: number;
  /** The market event that caused this one, so a fill can be traced back to the bar. */
  readonly causeEventId: string;
  /** Tags every event of one engine instance (a research run, a paper session). */
  readonly runId: string;
}

export type TradingEventBody =
  | { readonly type: 'market.bar.closed'; readonly event: BarClosedEvent }
  | { readonly type: 'market.event.skipped'; readonly reason: string }
  | { readonly type: 'strategy.signals'; readonly symbol: string; readonly signals: readonly StrategySignal[]; readonly parameters: Readonly<Record<string, Readonly<Record<string, unknown>>>> }
  | { readonly type: 'strategy.failed'; readonly strategyId: string; readonly error: string }
  | { readonly type: 'decision.none'; readonly symbol: string; readonly reason: string }
  | { readonly type: 'decision.proposed'; readonly proposal: TradeProposal }
  | { readonly type: 'advisor.opinion'; readonly decisionId: string; readonly opinion: AdvisorOpinion }
  | { readonly type: 'risk.trade.approved'; readonly decision: RiskDecision }
  | { readonly type: 'risk.trade.rejected'; readonly decision: RiskDecision }
  | { readonly type: 'order.command.created'; readonly command: PlaceOrderCommand }
  | { readonly type: 'order.state.changed'; readonly commandId: string; readonly decisionId: string; readonly result: OrderResult }
  | { readonly type: 'engine.halted'; readonly reason: string };

export type TradingEvent = Base & TradingEventBody;
export type TradingEventType = TradingEventBody['type'];
