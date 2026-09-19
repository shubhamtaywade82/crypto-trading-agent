import { EventEmitter } from 'node:events';
import type { Signal, Position } from '../types.js';
import type { BinanceService } from '../binance/client.js';

export interface MarketContext {
  candles: Record<string, any[]>;
  funding: Record<string, number>;
  marks: Record<string, number>;
  spot: Record<string, number>;
  equity: number;
  positions?: Position[];
}

// Momentum re-fires every 8s tick while the forming 15m candle stays across EMA50
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;

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
