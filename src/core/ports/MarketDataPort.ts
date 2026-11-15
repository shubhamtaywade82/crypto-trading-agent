import type { Candle, MarketSnapshot, Timeframe } from '../domain/market.js';

export interface SnapshotRequest {
  readonly symbol: string;
  readonly timeframes: readonly Timeframe[];
  /** Closed bars per timeframe. */
  readonly bars: number;
  /** Bars closing after this instant are excluded. */
  readonly asOf: number;
}

/** Read-only market data. An implementation of this port has no way to place an order. */
export interface MarketDataPort {
  getSnapshot(request: SnapshotRequest): Promise<MarketSnapshot>;
}

export interface HistoricalDataPort {
  /** Closed candles with openTime in [fromMs, toMs), oldest first. */
  getCandles(symbol: string, timeframe: Timeframe, fromMs: number, toMs: number): Promise<readonly Candle[]>;
}

/** The feed could not produce trustworthy data. The pipeline stops for that event; it never trades on a guess. */
export class MarketDataError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MarketDataError';
  }
}
