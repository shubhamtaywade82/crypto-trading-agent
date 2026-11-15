import type { Candle, Timeframe } from '../domain/market.js';
import type { Direction } from '../domain/strategy.js';

export interface ReplaySpec {
  readonly name: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly bars: readonly Candle[];
  readonly initialCapital: number;
  readonly leverage: number;
  readonly slippageBps: number;
  readonly lotSize: number;
  /** Stored with the run by the venue: what was tested, with which parameters. */
  readonly manifest: Record<string, unknown>;
}

export interface ReplayFill {
  readonly side: 'BUY' | 'SELL';
  readonly quantity: number;
  readonly price: number;
  readonly commission: number;
  readonly role: string | null;
  readonly reason: string | null;
}

export interface ReplayStep {
  /** The bar the venue just revealed. Nothing after it is visible. */
  readonly bar: Candle;
  readonly equity: number;
  /** Fills booked at this bar, including orders queued on the previous one. */
  readonly fills: readonly ReplayFill[];
  readonly finished: boolean;
}

export interface ReplayTrade {
  readonly direction: Direction;
  readonly quantity: number;
  readonly entryAt: number;
  readonly entryPrice: number;
  readonly exitAt: number;
  readonly exitPrice: number;
  readonly netPnl: number;
  readonly commission: number;
  readonly barsHeld: number;
  readonly exitReason: string | null;
}

export interface ReplaySummary {
  readonly runId: string;
  readonly barsProcessed: number;
  readonly trades: readonly ReplayTrade[];
  readonly equity: ReadonlyArray<{ at: number; equity: number }>;
  /** The venue's own metrics for the run, kept verbatim for cross-checking. */
  readonly venueMetrics: Record<string, unknown> | null;
}

/** A venue-driven historical replay: the venue owns the clock and reveals one bar per `advance`. */
export interface ReplaySessionPort {
  open(spec: ReplaySpec): Promise<void>;
  /** Null when no bar is left. */
  advance(): Promise<ReplayStep | null>;
  finish(): Promise<ReplaySummary>;
}
