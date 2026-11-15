import { DecisionBuilder } from '../application/decisions/DecisionBuilder.js';
import { TradingOrchestrator } from '../application/engine/TradingOrchestrator.js';
import { PlacePaperOrderHandler } from '../application/execution/PlacePaperOrderHandler.js';
import { FeatureEngine } from '../application/features/FeatureEngine.js';
import { defaultFeatureRegistry } from '../application/features/FeatureRegistry.js';
import { CircuitBreaker, type BreakerSnapshot } from '../application/risk/CircuitBreaker.js';
import { RiskPipeline } from '../application/risk/RiskPipeline.js';
import { SessionTracker, type SessionState } from '../application/risk/SessionTracker.js';
import { StrategyRegistry } from '../application/strategies/StrategyRegistry.js';
import { StrategyRunner } from '../application/strategies/StrategyRunner.js';
import type { RiskLimits, RiskRule } from '../domain/risk.js';
import type { Strategy } from '../domain/strategy.js';
import { TradingEventBus } from '../events/TradingEventBus.js';
import type { Clock } from '../ports/Clock.js';
import type { DecisionAdvisorPort } from '../ports/DecisionAdvisorPort.js';
import type { MarketDataPort } from '../ports/MarketDataPort.js';
import type { PaperExecutionPort } from '../ports/PaperExecutionPort.js';
import type { PortfolioPort } from '../ports/PortfolioPort.js';
import type { ResearchRepository } from '../ports/ResearchRepository.js';
import { defaultRiskRules } from '../risk/rules/index.js';

export interface PipelineInput {
  readonly runId: string;
  readonly symbols: readonly string[];
  readonly strategies: readonly Strategy[];
  readonly limits: RiskLimits;
  readonly marketData: MarketDataPort;
  readonly portfolio: PortfolioPort;
  readonly execution: PaperExecutionPort;
  readonly clock: Clock;
  readonly repository: ResearchRepository;
  readonly advisor?: DecisionAdvisorPort;
  readonly rules?: readonly RiskRule[];
  readonly killSwitch?: () => string | null;
  readonly restored?: { session: SessionState | null; breaker?: BreakerSnapshot };
  readonly onCycleEnd?: (state: { session: SessionState | null; breaker: BreakerSnapshot }) => void;
}

export interface Pipeline {
  readonly orchestrator: TradingOrchestrator;
  readonly bus: TradingEventBus;
  readonly registry: StrategyRegistry;
  readonly breaker: CircuitBreaker;
  readonly session: SessionTracker;
}

/**
 * The single assembly of the decision pipeline. Paper trading and historical research both call it and differ only
 * in the ports they pass, which is what keeps a strategy's behaviour the same in both.
 */
export function buildPipeline(input: PipelineInput): Pipeline {
  if (input.execution.venue !== 'paper_exchange') throw new Error('the pipeline executes on paper_exchange only');
  const features = defaultFeatureRegistry();
  const registry = new StrategyRegistry(features);
  for (const strategy of input.strategies) registry.register(strategy);

  const bus = new TradingEventBus(input.runId);
  bus.subscribe((event) => input.repository.append(event));
  const session = new SessionTracker(input.restored?.session ?? null);
  const breaker = new CircuitBreaker(input.limits.maxDrawdownPct, input.restored?.breaker);

  const orchestrator = new TradingOrchestrator({
    symbols: input.symbols,
    limits: input.limits,
    marketData: input.marketData,
    portfolio: input.portfolio,
    session,
    breaker,
    runner: new StrategyRunner(registry, new FeatureEngine(features)),
    decisions: new DecisionBuilder(),
    risk: new RiskPipeline(input.rules ?? defaultRiskRules(), input.clock),
    orders: new PlacePaperOrderHandler(input.execution, input.clock),
    bus,
    clock: input.clock,
    ...(input.advisor ? { advisor: input.advisor } : {}),
    ...(input.killSwitch ? { killSwitch: input.killSwitch } : {}),
    ...(input.onCycleEnd ? { onCycleEnd: () => input.onCycleEnd?.({ session: session.serialize(), breaker: breaker.snapshot }) } : {}),
  });
  return { orchestrator, bus, registry, breaker, session };
}
