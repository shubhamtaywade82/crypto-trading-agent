import { existsSync } from 'node:fs';
import { CachingMarketData, MeteredMarketData, RetryingMarketData } from '../adapters/decorators/marketData.js';
import { isRestRefusal } from '../adapters/binance/restGuard.js';
import { withExecutionLogging } from '../adapters/decorators/execution.js';
import { BinanceMarketDataAdapter, binancePublicSource, createReadOnlyBinanceClient, type BinancePublicSource } from '../adapters/binance/BinanceMarketDataAdapter.js';
import { OllamaAdvisorAdapter, ollamaTextClient } from '../adapters/ollama/OllamaAdvisorAdapter.js';
import { PaperExchangeApi } from '../adapters/paper-exchange/PaperExchangeApi.js';
import { PaperExchangeExecutionAdapter } from '../adapters/paper-exchange/PaperExchangeExecutionAdapter.js';
import { PaperExchangeLeaseAdapter } from '../adapters/paper-exchange/PaperExchangeLeaseAdapter.js';
import { PaperExchangeLeaseKeeper } from '../adapters/paper-exchange/PaperExchangeLeaseKeeper.js';
import { PaperExchangePortfolioAdapter } from '../adapters/paper-exchange/PaperExchangePortfolioAdapter.js';
import { PaperExchangeReplayAdapter } from '../adapters/paper-exchange/PaperExchangeReplayAdapter.js';
import { InMemoryResearchRepository, JsonlResearchRepository } from '../adapters/persistence/JsonlResearchRepository.js';
import { InMemoryOwnershipJournal, JsonlOwnershipJournal } from '../adapters/persistence/OwnershipJournals.js';
import { JsonStateStore } from '../adapters/persistence/JsonStateStore.js';
import { BarCloseSource } from '../application/engine/BarCloseSource.js';
import { MarkPricePump } from '../application/engine/MarkPricePump.js';
import { createTradingApplication, type TradingApplication } from '../application/engine/TradingApplication.js';
import { OwnershipLedger } from '../application/ownership/OwnershipLedger.js';
import { closeEmptiedEpisodes, resolveOpenIntents } from '../application/ownership/resolve.js';
import { CircuitBreaker, type BreakerSnapshot } from '../application/risk/CircuitBreaker.js';
import type { SessionState } from '../application/risk/SessionTracker.js';
import type { AccountScope } from '../domain/execution.js';
import type { Timeframe } from '../domain/market.js';
import { foreignSlots } from '../domain/ownership.js';
import type { TradingEvent } from '../events/TradingEvent.js';
import type { AccountLeasePort } from '../ports/AccountLeasePort.js';
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
  /** Tests substitute the lease; production uses the paper_exchange lease endpoints. */
  readonly lease?: AccountLeasePort;
}

export interface PaperApplication extends TradingApplication {
  readonly pipeline: Pipeline;
  readonly ownership: OwnershipLedger;
  /** Holds the trading account's lease. `start()` takes it and `stop()` gives it back; tests that trade without starting take it here. */
  readonly leaseKeeper: PaperExchangeLeaseKeeper;
  readonly marketData: BinanceMarketDataAdapter;
  readonly experiments: ExperimentRunner;
  readonly metrics: MeteredMarketData['metrics'];
}

interface PersistedState {
  readonly session: SessionState | null;
  readonly breaker: BreakerSnapshot;
}

/**
 * Operator reset of a latched breaker in the persisted state; returns the snapshot it replaced. Run it with the engine
 * stopped: a running engine rewrites this file every cycle and would undo the reset.
 */
export function resetPersistedBreaker(statePath: string, operator: string): BreakerSnapshot {
  const store = new JsonStateStore<PersistedState>(statePath);
  const state = store.load();
  if (!state) throw new Error(`no persisted state at ${statePath}; nothing to reset`);
  // The drawdown limit only matters to observe(); reset() ignores it
  const breaker = new CircuitBreaker(0, state.breaker);
  breaker.reset(operator);
  store.save({ ...state, breaker: breaker.snapshot });
  return state.breaker;
}

/**
 * The composition root: the only module that knows the concrete adapters. Execution is wired to PaperExchange and to
 * nothing else, bound to one account; Binance is wired as a credential-less, read-only market-data source.
 *
 * Starting acquires the account's lease, settles any intent a previous run left open, and refuses to start if the account
 * holds an open position this process does not own. Stopping releases the lease.
 */
export function buildPaperTradingApplication(config: PaperCoreConfig, overrides: PaperApplicationOverrides = {}): PaperApplication {
  if (config.executionMode !== EXECUTION_MODE) throw new Error('buildPaperTradingApplication needs a config from validatePaperOnlyConfig');
  const clock = overrides.clock ?? systemClock;
  const log = overrides.log ?? ((line: string) => console.log(line));
  const apiKey = config.paperExchange.apiKey;
  const apiFor = (accountId: string, options: { retries?: number; lease?: PaperExchangeLeaseKeeper } = {}) =>
    new PaperExchangeApi(config.paperExchange.url, accountId, { ...(apiKey ? { apiKey } : {}), ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}), ...options });

  const strategies = buildStrategies(config.strategyIds, config.strategyParameters);
  const binance = new BinanceMarketDataAdapter(overrides.binanceSource ?? binancePublicSource(createReadOnlyBinanceClient(config.symbols)));
  // A rate limit or a local REST backoff is not retried: each retry is a request the venue is already refusing.
  const metered = new MeteredMarketData(new RetryingMarketData(binance, {
    attempts: 3,
    backoffMs: 250,
    shouldRetry: (error) => !isRestRefusal(error),
  }));
  const marketData = new CachingMarketData(metered);

  const accountId = config.paperExchange.accountId;
  const scope: AccountScope = { venue: 'paper_exchange', accountId };
  const lease: AccountLeasePort = overrides.lease ?? new PaperExchangeLeaseAdapter({
    baseUrl: config.paperExchange.url,
    ...(apiKey ? { apiKey } : {}),
    ttlSeconds: config.leaseTtlSeconds,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  // The one keeper for this process: every trading write presents its lease, and it refuses writes once the lease is lost.
  const leaseKeeper = new PaperExchangeLeaseKeeper({
    lease,
    accountId,
    label: `paper-core pid ${process.pid}`,
    ttlSeconds: config.leaseTtlSeconds,
    log,
    onLost: (reason) => {
      log(`[paper-core] the lease on ${accountId} was lost (${reason}); trading is halted until this process restarts`);
      for (const source of sources) source.stop();
      pump.stop();
    },
  });
  const api = apiFor(accountId, { lease: leaseKeeper });
  const venue = new PaperExchangeExecutionAdapter(api, accountId);
  const execution = withExecutionLogging(venue, (line) => log(`[venue] ${line.op} ${line.symbol} ${line.commandId} ${line.ms.toFixed(0)}ms ${line.outcome}`));
  const portfolio = new PaperExchangePortfolioAdapter(api);
  const ownership = new OwnershipLedger(new JsonlOwnershipJournal(config.ownershipPath), accountId);

  const stateStore = new JsonStateStore<PersistedState>(config.statePath);
  const restored = stateStore.load();
  const pipeline = buildPipeline({
    runId: `paper_${accountId}`,
    symbols: config.symbols,
    strategies,
    limits: config.limits,
    marketData,
    portfolio,
    execution,
    scope,
    ownership,
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

  // Research replays run on the research account, never on the trading account
  const experiments = new ExperimentRunner(
    () => new PaperExchangeReplayAdapter(apiFor(config.researchAccountId), (id, options) => apiFor(id, options)),
    ({ venue: replay, clock: replayClock, symbols, strategies: replayStrategies, limits, runId, scope: replayScope }) => {
      const repository = new InMemoryResearchRepository();
      const built = buildPipeline({
        runId, symbols, strategies: replayStrategies, limits, marketData: replay, portfolio: replay, execution: replay,
        scope: replayScope, ownership: new OwnershipLedger(new InMemoryOwnershipJournal(), replayScope.accountId),
        clock: replayClock, repository,
      });
      return { orchestrator: built.orchestrator, events: repository.events };
    },
  );

  const facade = createTradingApplication({ orchestrator: pipeline.orchestrator, runResearch: (experiment) => experiments.run(experiment) });
  return {
    ...facade,
    start: async () => {
      // Another process holding the account refuses startup here, before anything is written.
      await leaseKeeper.start();
      try {
        const now = clock.now();
        const settled = await resolveOpenIntents({ ledger: ownership, execution, at: now });
        if (settled.held.length > 0) {
          throw new Error(`refusing to start: ${settled.held.map((hold) => `${hold.episodeId}: ${hold.reason}`).join('; ')}`);
        }
        const account = await portfolio.getAccount(now);
        const slots = account.positions.map((p) => ({ symbol: p.symbol, slotId: p.slotId, quantity: p.quantity }));
        closeEmptiedEpisodes({ ledger: ownership, slots, at: now });
        const foreign = foreignSlots(slots, ownership.snapshot());
        if (foreign.length > 0) {
          throw new Error(`refusing to start: account ${accountId} holds positions this process does not own (${foreign.map((s) => s.symbol).join(', ')}); close them or use a dedicated account`);
        }
        log(`[paper-core] ${EXECUTION_MODE} on ${config.paperExchange.url} account ${accountId}; lease fence ${leaseKeeper.fence}; symbols ${config.symbols.join(',')}; strategies ${strategies.map((s) => `${s.id}@${s.version}`).join(', ')}; breaker ${pipeline.breaker.snapshot.state}`);
        await pump.tick();
        pump.start();
        for (const source of sources) source.start();
      } catch (error) {
        await leaseKeeper.stop();
        throw error;
      }
    },
    stop: async () => {
      for (const source of sources) source.stop();
      pump.stop();
      await facade.stop();
      await leaseKeeper.stop();
    },
    pipeline,
    ownership,
    leaseKeeper,
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
