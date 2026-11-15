import { buildPlaceOrderCommand, type AccountScope, type OrderResult } from '../../domain/execution.js';
import { candleDefect, isTimeframe, type BarClosedEvent, type MarketEvent, type MarketSnapshot, type Timeframe } from '../../domain/market.js';
import { foreignSlots } from '../../domain/ownership.js';
import type { RiskLimits } from '../../domain/risk.js';
import type { TradingEventBody } from '../../events/TradingEvent.js';
import type { TradingEventBus } from '../../events/TradingEventBus.js';
import type { Clock } from '../../ports/Clock.js';
import type { DecisionAdvisorPort } from '../../ports/DecisionAdvisorPort.js';
import type { MarketDataPort } from '../../ports/MarketDataPort.js';
import type { PaperExecutionPort } from '../../ports/PaperExecutionPort.js';
import type { PortfolioPort } from '../../ports/PortfolioPort.js';
import type { DecisionBuilder } from '../decisions/DecisionBuilder.js';
import type { PlacePaperOrderHandler } from '../execution/PlacePaperOrderHandler.js';
import type { OwnershipLedger } from '../ownership/OwnershipLedger.js';
import { closeEmptiedEpisodes, resolveOpenIntents } from '../ownership/resolve.js';
import type { CircuitBreaker } from '../risk/CircuitBreaker.js';
import { sizeProposal } from '../risk/PositionSizer.js';
import type { RiskPipeline } from '../risk/RiskPipeline.js';
import type { SessionTracker } from '../risk/SessionTracker.js';
import type { StrategyRunner } from '../strategies/StrategyRunner.js';

export type CycleStatus = 'SKIPPED' | 'NO_SIGNAL' | 'NO_DECISION' | 'VETOED' | 'REJECTED' | 'EXECUTED' | 'FAILED';

export interface CycleOutcome {
  readonly eventId: string;
  readonly status: CycleStatus;
  readonly detail: string;
  readonly order?: OrderResult;
}

export interface OrchestratorDeps {
  readonly symbols: readonly string[];
  readonly limits: RiskLimits;
  readonly marketData: MarketDataPort;
  readonly portfolio: PortfolioPort;
  readonly session: SessionTracker;
  readonly breaker: CircuitBreaker;
  readonly runner: StrategyRunner;
  readonly decisions: DecisionBuilder;
  readonly risk: RiskPipeline;
  readonly orders: PlacePaperOrderHandler;
  /** The venue port the intents are settled against. Bound to the same account as `scope`. */
  readonly execution: PaperExecutionPort;
  readonly ownership: OwnershipLedger;
  /** The one account this engine trades. Every command is built for it. */
  readonly scope: AccountScope;
  readonly bus: TradingEventBus;
  readonly clock: Clock;
  /** Optional. Absent means the deterministic pipeline decides alone. */
  readonly advisor?: DecisionAdvisorPort;
  /** Operator kill switch: a non-null reason refuses every entry. */
  readonly killSwitch?: () => string | null;
  /** Called after every cycle so session and breaker state survive a restart. */
  readonly onCycleEnd?: () => void;
}

const SEEN_EVENT_LIMIT = 10_000;
const EXTRA_BARS = 5;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The one pipeline every market event goes through, in real time and in replay:
 *   snapshot -> features -> strategies -> decision -> sizing -> advisor (veto only) -> risk -> command -> paper order.
 *
 * Events are processed one at a time, in arrival order, over the whole account: two bars can never be decided against
 * the same stale margin. A bar is handled once; a repeat or an older bar is skipped.
 */
export class TradingOrchestrator {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly seenEvents = new Set<string>();
  private readonly lastBarTime = new Map<string, number>();
  private readonly executedDecisionIds = new Set<string>();
  /** Why ownership is unresolved right now (an intent the venue contradicts). Null when everything is settled. */
  private ownershipHold: string | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    if (deps.symbols.length === 0) throw new Error('the orchestrator needs at least one symbol');
  }

  processMarketEvent(event: MarketEvent): Promise<CycleOutcome> {
    const run = this.queue.then(() => this.cycle(event));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves when every queued event has been processed. */
  async idle(): Promise<void> {
    await this.queue;
  }

  private async cycle(event: BarClosedEvent): Promise<CycleOutcome> {
    const { deps } = this;
    const publish = (body: TradingEventBody) => deps.bus.publish(body, deps.clock.now(), event.eventId);
    const skip = (reason: string, status: CycleStatus = 'SKIPPED'): CycleOutcome => {
      publish({ type: 'market.event.skipped', reason });
      return { eventId: event.eventId, status, detail: reason };
    };

    const stream = `${event.symbol}:${event.timeframe}`;
    if (this.seenEvents.has(event.eventId)) return skip('duplicate event');
    if (!deps.symbols.includes(event.symbol)) return skip(`${event.symbol} is not a configured symbol`);
    const defect = candleDefect(event.bar);
    if (defect) return skip(`malformed bar: ${defect}`);
    if (event.bar.openTime <= (this.lastBarTime.get(stream) ?? -Infinity)) return skip('out-of-order bar: a later bar was already processed');
    this.remember(event.eventId);
    this.lastBarTime.set(stream, event.bar.openTime);
    publish({ type: 'market.bar.closed', event });

    try {
      const universe = await this.loadUniverse(event);
      const market = universe[event.symbol];
      const primary = market?.candles[event.timeframe] ?? [];
      // The snapshot and the event must describe the same bar, or a strategy would be reading a different market
      if (!market || primary.at(-1)?.openTime !== event.bar.openTime) return skip('the market snapshot does not end at the triggering bar', 'FAILED');

      // Ownership is settled before the account is classified: queued fills are confirmed, and slots the venue closed are
      // recorded as closed, so a reused slot is never attributed to an episode that has ended.
      const settled = deps.ownership.openIntents().length > 0
        ? await resolveOpenIntents({ ledger: deps.ownership, execution: deps.execution, at: deps.clock.now() })
        : null;
      this.ownershipHold = settled && settled.held.length > 0
        ? settled.held.map((hold) => `${hold.episodeId}: ${hold.reason}`).join('; ')
        : null;
      const account = await deps.portfolio.getAccount(event.closedAt);
      const slots = account.positions.map((p) => ({ symbol: p.symbol, slotId: p.slotId, quantity: p.quantity }));
      closeEmptiedEpisodes({ ledger: deps.ownership, slots, at: deps.clock.now() });
      const foreignPositionSymbols = foreignSlots(slots, deps.ownership.snapshot()).map((slot) => slot.symbol);

      const portfolio = deps.session.observe(account);
      if (deps.breaker.observe(portfolio)) publish({ type: 'engine.halted', reason: deps.breaker.haltReason() ?? 'circuit breaker tripped' });

      const { signals, failures, parameters } = deps.runner.run(event, universe, portfolio);
      for (const failure of failures) publish({ type: 'strategy.failed', strategyId: failure.strategyId, error: failure.error });
      publish({ type: 'strategy.signals', symbol: event.symbol, signals, parameters });
      if (signals.length === 0) return { eventId: event.eventId, status: 'NO_SIGNAL', detail: 'no signals' };

      const none = (reason: string, status: CycleStatus = 'NO_DECISION'): CycleOutcome => {
        publish({ type: 'decision.none', symbol: event.symbol, reason });
        return { eventId: event.eventId, status, detail: reason };
      };
      const built = deps.decisions.build(event.symbol, signals, portfolio);
      if (built.kind === 'none') return none(built.reason);
      const sized = sizeProposal(built.draft, portfolio, deps.limits);
      if (!sized.ok) return none(`sizing: ${sized.reason}`);
      const { proposal } = sized;
      publish({ type: 'decision.proposed', proposal });

      // The advisor runs before the risk pipeline and can only remove a candidate. Risk still judges whatever is left.
      if (deps.advisor) {
        const opinion = await this.consult(deps.advisor, proposal, market);
        publish({ type: 'advisor.opinion', decisionId: proposal.decisionId, opinion });
        if (opinion.verdict === 'VETO') return none(`advisor veto: ${opinion.reason}`, 'VETOED');
      }

      const haltReason = deps.killSwitch?.() ?? deps.breaker.haltReason() ?? this.ownershipHold;
      const verdict = deps.risk.evaluate(proposal, {
        market, portfolio, limits: deps.limits, executedDecisionIds: this.executedDecisionIds, haltReason, foreignPositionSymbols,
      });
      if (!verdict.approved) {
        publish({ type: 'risk.trade.rejected', decision: verdict.decision });
        const reasons = verdict.decision.findings.filter((f) => f.severity === 'block').map((f) => f.code).join(', ');
        return { eventId: event.eventId, status: 'REJECTED', detail: reasons };
      }
      publish({ type: 'risk.trade.approved', decision: verdict.decision });

      const command = buildPlaceOrderCommand(verdict.approved, deps.clock.now(), deps.scope);
      // Recorded before the submission: whatever happens next, this decision is never sent a second time
      this.executedDecisionIds.add(proposal.decisionId);
      publish({ type: 'order.command.created', command });
      const order = await deps.orders.handle(command);
      publish({ type: 'order.state.changed', commandId: command.commandId, decisionId: command.decisionId, result: order });

      const unsafe = order.state === 'UNKNOWN'
        ? `order ${command.commandId} outcome is unknown`
        : order.detail.startsWith('UNPROTECTED POSITION') || order.detail.startsWith('UNOWNED POSITION') ? order.detail : null;
      if (unsafe && deps.breaker.trip(unsafe, deps.clock.now())) publish({ type: 'engine.halted', reason: unsafe });
      return { eventId: event.eventId, status: 'EXECUTED', detail: `${order.state}: ${order.detail}`, order };
    } catch (error) {
      return skip(`cycle failed: ${message(error)}`, 'FAILED');
    } finally {
      deps.onCycleEnd?.();
    }
  }

  private async consult(advisor: DecisionAdvisorPort, proposal: { decisionId: string; symbol: string; direction: 'LONG' | 'SHORT'; entry: number; stopLoss: number; takeProfit: number; signal: { strategyId: string; reason: string } }, market: MarketSnapshot) {
    try {
      return await advisor.review({
        decisionId: proposal.decisionId, symbol: proposal.symbol, direction: proposal.direction, strategyId: proposal.signal.strategyId,
        reason: proposal.signal.reason, entry: proposal.entry, stopLoss: proposal.stopLoss, takeProfit: proposal.takeProfit,
        rewardRisk: Math.abs(proposal.takeProfit - proposal.entry) / Math.abs(proposal.entry - proposal.stopLoss),
        fundingRate: market.fundingRate,
      });
    } catch (error) {
      return { verdict: 'UNAVAILABLE' as const, reason: `advisor error: ${message(error)}`, model: null };
    }
  }

  /** The event's symbol must load; any other symbol that fails is left out of the universe. */
  private async loadUniverse(event: BarClosedEvent): Promise<Record<string, MarketSnapshot>> {
    const requirements = this.deps.runner.dataRequirements();
    const timeframes = [...new Set([event.timeframe, ...requirements.timeframes.filter(isTimeframe)])] as Timeframe[];
    const request = (symbol: string) => this.deps.marketData.getSnapshot({ symbol, timeframes, bars: requirements.bars + EXTRA_BARS, asOf: event.closedAt });
    const universe: Record<string, MarketSnapshot> = { [event.symbol]: await request(event.symbol) };
    await Promise.all(this.deps.symbols.filter((symbol) => symbol !== event.symbol).map(async (symbol) => {
      try {
        universe[symbol] = await request(symbol);
      } catch {
        // A missing peer narrows a cross-sectional ranking; it must not stop the event symbol's own evaluation
      }
    }));
    return universe;
  }

  private remember(eventId: string): void {
    this.seenEvents.add(eventId);
    if (this.seenEvents.size > SEEN_EVENT_LIMIT) this.seenEvents.delete(this.seenEvents.values().next().value as string);
  }
}
