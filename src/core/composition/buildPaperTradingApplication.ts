import { existsSync } from 'node:fs';
import { CachingMarketData, MeteredMarketData, RetryingMarketData } from '../adapters/decorators/marketData.js';
import { withExecutionLogging } from '../adapters/decorators/execution.js';
import { BinanceMarketDataAdapter, binancePublicSource, createReadOnlyBinanceClient, type BinancePublicSource } from '../adapters/binance/BinanceMarketDataAdapter.js';
import { OllamaAdvisorAdapter, ollamaTextClient } from '../adapters/ollama/OllamaAdvisorAdapter.js';
import { PaperExchangeApi } from '../adapters/paper-exchange/PaperExchangeApi.js';
import { PaperExchangeExecutionAdapter } from '../adapters/paper-exchange/PaperExchangeExecutionAdapter.js';
import { PaperExchangePortfolioAdapter } from '../adapters/paper-exchange/PaperExchangePortfolioAdapter.js';
import { PaperExchangeReplayAdapter } from '../adapters/paper-exchange/PaperExchangeReplayAdapter.js';
import { InMemoryResearchRepository, JsonlResearchRepository } from '../adapters/persistence/JsonlResearchRepository.js';
import { JsonStateStore } from '../adapters/persistence/JsonStateStore.js';
import { BarCloseSource } from '../application/engine/BarCloseSource.js';
import { MarkPricePump } from '../application/engine/MarkPricePump.js';
import { createTradingApplication, type TradingApplication } from '../application/engine/TradingApplication.js';
import type { BreakerSnapshot } from '../application/risk/CircuitBreaker.js';
import type { SessionState } from '../application/risk/SessionTracker.js';
import type { Timeframe } from '../domain/market.js';
import type { TradingEvent } from '../events/TradingEvent.js';
import { systemClock, type Clock } from '../ports/Clock.js';
import { ExperimentRunner } from '../research/ExperimentRunner.js';
import { buildPipeline, type Pipeline } from './buildPipeline.js';
import { buildStrategies } from './strategyCatalog.js';
import { EXECUTION_MODE, type PaperCoreConfig } from './validatePaperOnlyConfig.js';

export interface PaperApplicationOverrides {
  /** Tests substitute the transport; production leaves these unset. */
  readonly fetchImpl?: typeof fetch;
  readonly binanceSource?: BinancePublicSource;
  readonly clock?: Clock;
  readonly log?: (line: string) => void;
}

export interface PaperApplication extends TradingApplication {
  readonly pipeline: Pipeline;
  readonly marketData: BinanceMarketDataAdapter;
  readonly experiments: ExperimentRunner;
  readonly metrics: MeteredMarketData['metrics'];
}

interface PersistedState {
  readonly session: SessionState | null;
  readonly breaker: BreakerSnapshot;
}

/**
 * The composition root: the only module that knows the concrete adapters. Execution is wired to PaperExchange and to
 * nothing else; Binance is wired as a credential-less, read-only market-data source.
 */
export function buildPaperTradingApplication(config: PaperCoreConfig, overrides: PaperApplicationOverrides = {}): PaperApplication {
  if (config.executionMode !== EXECUTION_MODE) throw new Error('buildPaperTradingApplication needs a config from validatePaperOnlyConfig');
  const clock = overrides.clock ?? systemClock;
  const log = overrides.log ?? ((line: string) => console.log(line));
  const apiFor = (accountId: string, options: { retries?: number } = {}) =>
    new PaperExchangeApi(config.paperExchange.url, accountId, { ...(config.paperExchange.apiKey ? { apiKey: config.paperExchange.apiKey } : {}), ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}), ...options });

  const strategies = buildStrategies(config.strategyIds, config.strategyParameters);
  const binance = new BinanceMarketDataAdapter(overrides.binanceSource ?? binancePublicSource(createReadOnlyBinanceClient(config.symbols)));
  const metered = new MeteredMarketData(new RetryingMarketData(binance, { attempts: 3, backoffMs: 250 }));
  const marketData = new CachingMarketData(metered);

  const api = apiFor(config.paperExchange.accountId);
  const venue = new PaperExchangeExecutionAdapter(api);
  const execution = withExecutionLogging(venue, (line) => log(`[venue] ${line.op} ${line.symbol} ${line.commandId} ${line.ms.toFixed(0)}ms ${line.outcome}`));

  const stateStore = new JsonStateStore<PersistedState>(config.statePath);
  const restored = stateStore.load();
  const pipeline = buildPipeline({
    runId: `paper_${config.paperExchange.accountId}`,
    symbols: config.symbols,
    strategies,
    limits: config.limits,
    marketData,
    portfolio: new PaperExchangePortfolioAdapter(api),
    execution,
    clock,
    repository: new JsonlResearchRepository(config.journalPath),
    ...(config.advisor ? { advisor: new OllamaAdvisorAdapter(ollamaTextClient(config.advisor), config.advisor) } : {}),
    killSwitch: () => (existsSync(config.killFile) ? `kill switch file ${config.killFile} is present` : null),
    ...(restored ? { restored } : {}),
    onCycleEnd: (state) => stateStore.save(state),
  });
  pipeline.bus.subscribe((event) => {
    const line = describeEvent(event);
    if (line) log(line);
  });

  const timeframes = [...new Set(strategies.map((s) => s.requirements.primaryTimeframe))] as Timeframe[];
  const sources = timeframes.map((timeframe) => new BarCloseSource({
    symbols: config.symbols, timeframe, settleMs: config.barSettleMs, marketData, clock,
    onEvent: (event) => void pipeline.orchestrator.processMarketEvent(event),
    onError: (error, symbol) => log(`[feed] ${symbol} ${timeframe}: ${error instanceof Error ? error.message : String(error)}`),
  }));
  const pump = new MarkPricePump({
    symbols: config.symbols, intervalMs: config.markPushMs, source: binance, sink: venue, clock,
    onError: (error) => log(`[marks] ${error instanceof Error ? error.message : String(error)}`),
  });

  const experiments = new ExperimentRunner(
    () => new PaperExchangeReplayAdapter(apiFor(config.paperExchange.accountId), (accountId, options) => apiFor(accountId, options)),
    ({ venue: replay, clock: replayClock, symbols, strategies: replayStrategies, limits, runId }) => {
      const repository = new InMemoryResearchRepository();
      const built = buildPipeline({ runId, symbols, strategies: replayStrategies, limits, marketData: replay, portfolio: replay, execution: replay, clock: replayClock, repository });
      return { orchestrator: built.orchestrator, events: repository.events };
    },
  );

  const facade = createTradingApplication({ orchestrator: pipeline.orchestrator, runResearch: (experiment) => experiments.run(experiment) });
  return {
    ...facade,
    start: async () => {
      log(`[paper-core] ${EXECUTION_MODE} on ${config.paperExchange.url} account ${config.paperExchange.accountId}; symbols ${config.symbols.join(',')}; strategies ${strategies.map((s) => `${s.id}@${s.version}`).join(', ')}; breaker ${pipeline.breaker.snapshot.state}`);
      await pump.tick();
      pump.start();
      for (const source of sources) source.start();
    },
    stop: async () => {
      for (const source of sources) source.stop();
      pump.stop();
      await facade.stop();
    },
    pipeline,
    marketData: binance,
    experiments,
    metrics: metered.metrics,
  };
}

function describeEvent(event: TradingEvent): string | null {
  switch (event.type) {
    case 'strategy.failed': return `[strategy] ${event.strategyId} failed: ${event.error}`;
    case 'decision.proposed': return `[decision] ${event.proposal.decisionId} ${event.proposal.direction} ${event.proposal.symbol} qty=${event.proposal.quantity} entry=${event.proposal.entry} stop=${event.proposal.stopLoss} target=${event.proposal.takeProfit} by ${event.proposal.signal.strategyId}`;
    case 'decision.none': return event.reason === 'no signals' ? null : `[decision] ${event.symbol}: none (${event.reason})`;
    case 'advisor.opinion': return `[advisor] ${event.decisionId} ${event.opinion.verdict}: ${event.opinion.reason}`;
    case 'risk.trade.rejected': return `[risk] ${event.decision.decisionId} REJECTED: ${event.decision.findings.filter((f) => f.severity === 'block').map((f) => `${f.code} (${f.message})`).join('; ')}`;
    case 'risk.trade.approved': return `[risk] ${event.decision.decisionId} APPROVED (${event.decision.evaluatedRules.length} rules)`;
    case 'order.state.changed': return `[order] ${event.commandId} ${event.result.state} protection=${event.result.protection}: ${event.result.detail}`;
    case 'engine.halted': return `[HALT] ${event.reason}`;
    case 'market.event.skipped': return `[skip] ${event.causeEventId}: ${event.reason}`;
    default: return null;
  }
}
