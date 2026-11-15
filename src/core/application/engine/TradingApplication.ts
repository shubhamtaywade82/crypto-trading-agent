import type { MarketEvent } from '../../domain/market.js';
import type { ExperimentConfig, ExperimentResult } from '../../research/ExperimentRunner.js';
import type { BarCloseSource } from './BarCloseSource.js';
import type { CycleOutcome, TradingOrchestrator } from './TradingOrchestrator.js';

/** The public surface of the paper trading subsystem. */
export interface TradingApplication {
  start(): Promise<void>;
  stop(): Promise<void>;
  processMarketEvent(event: MarketEvent): Promise<CycleOutcome>;
  runResearch(config: ExperimentConfig): Promise<ExperimentResult>;
}

export interface TradingApplicationParts {
  readonly orchestrator: TradingOrchestrator;
  /** Absent for an application that is only fed events (research, tests). */
  readonly source?: BarCloseSource;
  readonly runResearch: (config: ExperimentConfig) => Promise<ExperimentResult>;
}

/** A thin facade: it starts, stops and delegates. Every decision lives in the components behind it. */
export function createTradingApplication(parts: TradingApplicationParts): TradingApplication {
  return {
    start: async () => parts.source?.start(),
    stop: async () => {
      parts.source?.stop();
      await parts.orchestrator.idle();
    },
    processMarketEvent: (event) => parts.orchestrator.processMarketEvent(event),
    runResearch: (config) => parts.runResearch(config),
  };
}
