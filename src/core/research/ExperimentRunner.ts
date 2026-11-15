import { createHash } from 'node:crypto';
import type { CycleStatus, TradingOrchestrator } from '../application/engine/TradingOrchestrator.js';
import { barClosedEvent, candleDefect, TIMEFRAME_MS, type Candle, type Timeframe } from '../domain/market.js';
import type { AccountScope } from '../domain/execution.js';
import type { RiskLimits } from '../domain/risk.js';
import type { Strategy } from '../domain/strategy.js';
import type { TradingEvent } from '../events/TradingEvent.js';
import type { Clock } from '../ports/Clock.js';
import type { MarketDataPort } from '../ports/MarketDataPort.js';
import type { PaperExecutionPort } from '../ports/PaperExecutionPort.js';
import type { PortfolioPort } from '../ports/PortfolioPort.js';
import type { ReplaySessionPort, ReplaySummary } from '../ports/ReplaySessionPort.js';
import { analyzePerformance, type PerformanceReport } from './PerformanceAnalyzer.js';

export interface ExperimentConfig {
  readonly name: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** Closed bars, oldest first, contiguous. */
  readonly bars: readonly Candle[];
  readonly strategies: readonly Strategy[];
  readonly limits: RiskLimits;
  readonly initialCapital: number;
  readonly slippageBps: number;
}

export interface ExperimentManifest {
  readonly name: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly bars: number;
  readonly firstBarAt: number;
  readonly lastBarAt: number;
  /** SHA-256 of the bars: two runs on the same hash saw the same market. */
  readonly dataHash: string;
  readonly strategies: ReadonlyArray<{ id: string; version: string; parameters: Readonly<Record<string, unknown>> }>;
  readonly limits: RiskLimits;
  readonly initialCapital: number;
  readonly slippageBps: number;
}

export interface ExperimentResult {
  readonly manifest: ExperimentManifest;
  readonly runId: string;
  readonly barsProcessed: number;
  readonly cycles: Readonly<Record<CycleStatus, number>>;
  readonly performance: PerformanceReport;
  readonly venueMetrics: Record<string, unknown> | null;
  /** SHA-256 over every proposal, risk verdict and order command, in order. Equal digests mean identical decisions. */
  readonly decisionDigest: string;
  readonly events: readonly TradingEvent[];
}

/** The replay venue seen through every port the pipeline uses. One object, so the run has one source of truth. */
export type ReplayVenue = ReplaySessionPort & MarketDataPort & PortfolioPort & PaperExecutionPort;

/** Wires the standard pipeline around a replay venue. Supplied by the composition root. */
export type ReplayPipelineFactory = (input: {
  venue: ReplayVenue; clock: Clock; symbols: readonly string[]; strategies: readonly Strategy[]; limits: RiskLimits; runId: string;
  /** The replay account the venue opened. Only available once the replay exists, so the pipeline is built after it. */
  scope: AccountScope;
}) => { orchestrator: TradingOrchestrator; events: readonly TradingEvent[] };

const DECISION_EVENTS = new Set(['decision.proposed', 'risk.trade.approved', 'risk.trade.rejected', 'order.command.created']);
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Refuses data a result could not be trusted on: malformed bars, wrong order, duplicates, gaps. */
export function barsDefect(bars: readonly Candle[], timeframe: Timeframe): string | null {
  if (bars.length === 0) return 'no bars';
  for (let i = 0; i < bars.length; i += 1) {
    const defect = candleDefect(bars[i]);
    if (defect) return `bar ${bars[i].openTime}: ${defect}`;
    if (i > 0 && bars[i].openTime - bars[i - 1].openTime !== TIMEFRAME_MS[timeframe]) return `bars ${bars[i - 1].openTime} and ${bars[i].openTime} are not consecutive ${timeframe} bars`;
  }
  return null;
}

export function manifestOf(config: ExperimentConfig): ExperimentManifest {
  return {
    name: config.name, symbol: config.symbol, timeframe: config.timeframe, bars: config.bars.length,
    firstBarAt: config.bars[0].openTime, lastBarAt: config.bars[config.bars.length - 1].openTime,
    dataHash: sha256(config.bars.map((b) => [b.openTime, b.open, b.high, b.low, b.close, b.volume].join(',')).join('\n')),
    strategies: [...config.strategies].sort((a, b) => a.id.localeCompare(b.id)).map((s) => ({ id: s.id, version: s.version, parameters: s.parameters })),
    limits: config.limits, initialCapital: config.initialCapital, slippageBps: config.slippageBps,
  };
}

/**
 * Runs strategies over history through the same orchestrator, risk pipeline and order handler as paper trading. The
 * venue reveals one bar at a time and fills each order at the next bar's open, so a decision can only use bars that
 * had closed when it was made. Time is the replay's: the clock reads the close of the bar being processed.
 */
export class ExperimentRunner {
  constructor(private readonly venueFactory: () => ReplayVenue, private readonly pipelineFactory: ReplayPipelineFactory) {}

  async run(config: ExperimentConfig): Promise<ExperimentResult> {
    const defect = barsDefect(config.bars, config.timeframe);
    if (defect) throw new Error(`experiment "${config.name}": ${defect}`);
    if (config.strategies.length === 0) throw new Error(`experiment "${config.name}": no strategies`);
    const mismatched = config.strategies.filter((s) => s.requirements.primaryTimeframe !== config.timeframe).map((s) => s.id);
    if (mismatched.length > 0) throw new Error(`experiment "${config.name}": strategies not on ${config.timeframe}: ${mismatched.join(', ')}`);

    const manifest = manifestOf(config);
    const venue = this.venueFactory();
    let now = config.bars[0].openTime;
    const clock: Clock = { now: () => now };

    await venue.open({
      name: config.name, symbol: config.symbol, timeframe: config.timeframe, bars: config.bars, initialCapital: config.initialCapital,
      leverage: config.limits.maxLeverage, slippageBps: config.slippageBps, lotSize: config.limits.quantityStep,
      manifest: { ...manifest, limits: { ...manifest.limits } },
    });
    // The pipeline is bound to the replay account, which exists only now that the run is open
    const { orchestrator, events } = this.pipelineFactory({
      venue, clock, symbols: [config.symbol], strategies: config.strategies, limits: config.limits, runId: `exp_${manifest.dataHash.slice(0, 12)}`,
      scope: { venue: 'paper_exchange', accountId: venue.accountId },
    });

    const cycles: Record<CycleStatus, number> = { SKIPPED: 0, NO_SIGNAL: 0, NO_DECISION: 0, VETOED: 0, REJECTED: 0, EXECUTED: 0, FAILED: 0 };
    let summary: ReplaySummary;
    try {
      for (let step = await venue.advance(); step !== null; step = step.finished ? null : await venue.advance()) {
        const event = barClosedEvent(config.symbol, config.timeframe, step.bar);
        now = event.closedAt;
        // The last bar has no next open to fill on, so a decision made on it could never execute
        if (step.finished) break;
        const outcome = await orchestrator.processMarketEvent(event);
        cycles[outcome.status] += 1;
        if (outcome.status === 'FAILED') throw new Error(`cycle ${event.eventId} failed: ${outcome.detail}`);
      }
    } finally {
      summary = await venue.finish();
    }

    return {
      manifest,
      runId: summary.runId,
      barsProcessed: summary.barsProcessed,
      cycles,
      performance: analyzePerformance(summary.trades, summary.equity, config.initialCapital, config.timeframe),
      venueMetrics: summary.venueMetrics,
      decisionDigest: sha256(events.filter((e) => DECISION_EVENTS.has(e.type)).map((e) => JSON.stringify(e)).join('\n')),
      events,
    };
  }

  /**
   * Stability check: the same strategies and parameters over `folds` consecutive, non-overlapping periods, each run
   * from a fresh account. Nothing is fitted between folds, so this measures consistency across time, not tuning.
   */
  async runFolds(config: ExperimentConfig, folds: number): Promise<ExperimentResult[]> {
    const warmup = Math.max(...config.strategies.map((s) => s.requirements.warmupBars));
    const size = Math.floor(config.bars.length / folds);
    if (folds < 2 || size <= warmup) throw new Error(`cannot split ${config.bars.length} bars into ${folds} folds with a ${warmup}-bar warm-up`);
    const results: ExperimentResult[] = [];
    for (let fold = 0; fold < folds; fold += 1) {
      const end = fold === folds - 1 ? config.bars.length : (fold + 1) * size;
      results.push(await this.run({ ...config, name: `${config.name} fold ${fold + 1}/${folds}`, bars: config.bars.slice(fold * size, end) }));
    }
    return results;
  }
}
