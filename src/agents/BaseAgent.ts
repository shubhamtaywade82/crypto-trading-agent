import { EventEmitter } from 'node:events';
import type { Signal, Position, LogEntry } from '../types.js';
import type { BinanceService } from '../binance/client.js';
import type { VenueState } from '../binance/remoteBroker.js';
import type { PerformanceSnapshot } from '../risk/performanceEngine.js';
import type { CircuitState } from '../risk/riskConfig.js';
import type { MarketState } from '../market/types.js';

export interface MarketContext {
  candles: Record<string, any[]>;
  funding: Record<string, number>;
  marks: Record<string, number>;
  spot: Record<string, number>;
  equity: number;
  positions?: Position[];
  /** Built by the Orchestrator when MARKET_STATE_V1 is on; read-only strategy context in this phase. */
  marketState?: Record<string, MarketState>;
  /** Built by the Orchestrator only when RISK_ENGINE is on; the risk engine fails closed without it. */
  performance?: { circuit: CircuitState; snapshot: PerformanceSnapshot };
}

// Momentum re-fires every 8s tick while the forming 15m candle stays across EMA50
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;

/**
 * A refusal starts the cooldown like a fill does: a refused signal that keeps firing must not warn again on every loop.
 * Not while the venue is failing: an outage refusal would otherwise blackhole the signal for the whole cooldown after recovery.
 */
export const startsCooldown = (level: LogEntry['level'], venueState?: VenueState): boolean =>
  level === 'success' || (level === 'warn' && (venueState === undefined || venueState === 'connected'));

export abstract class BaseAgent extends EventEmitter {
  abstract readonly id: string;
  /** Minimum gap between fills for one symbol; agents that dedupe per candle themselves set 0. */
  readonly cooldownMs: number = DEFAULT_COOLDOWN_MS;
  abstract readonly strategy: string;
  status: 'RUNNING' | 'PAUSED' | 'WATCHING' = 'RUNNING';

  constructor(protected binance: BinanceService) {
    super();
  }

  async run(ctx: MarketContext): Promise<Signal[]> {
    if (this.status !== 'RUNNING') return [];
    return this.analyze(ctx);
  }

  protected abstract analyze(ctx: MarketContext): Promise<Signal[]>;

  protected signal(partial: Omit<Signal, 'id' | 'ts' | 'agent'>): Signal {
    return {
      ...partial,
      id: Math.random().toString(36).slice(2, 9),
      agent: this.id as any,
      ts: Date.now(),
    };
  }
}
