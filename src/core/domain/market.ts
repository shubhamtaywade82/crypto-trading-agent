/** Canonical market types. Nothing here knows about Binance, PaperExchange or Ollama. */

export const TIMEFRAME_MS = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
} as const;

export type Timeframe = keyof typeof TIMEFRAME_MS;

export const isTimeframe = (value: string): value is Timeframe => Object.hasOwn(TIMEFRAME_MS, value);

export interface Candle {
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/**
 * What a strategy may see for one symbol at one instant. `candles` hold closed bars only, oldest first: a bar still
 * forming at `asOf` never appears, so the same code cannot look ahead in replay or in real time.
 */
export interface MarketSnapshot {
  readonly symbol: string;
  /** The instant this snapshot describes (the close of the bar that triggered it), in epoch ms. */
  readonly asOf: number;
  readonly candles: Readonly<Partial<Record<Timeframe, readonly Candle[]>>>;
  /** Reference price for sizing and risk. It is a mark, not an executable bid or ask. */
  readonly markPrice: number;
  /** When `markPrice` was observed, epoch ms. The freshness rule compares it with `asOf`. */
  readonly markAt: number;
  readonly fundingRate: number | null;
  readonly openInterest: number | null;
}

export interface BarClosedEvent {
  readonly type: 'bar.closed';
  /** Deterministic: the same bar always carries the same id, which is what makes handling idempotent. */
  readonly eventId: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly bar: Candle;
  /** bar.openTime + the timeframe length. */
  readonly closedAt: number;
}

export type MarketEvent = BarClosedEvent;

export const barClosedEvent = (symbol: string, timeframe: Timeframe, bar: Candle): BarClosedEvent => ({
  type: 'bar.closed',
  eventId: `${symbol}:${timeframe}:${bar.openTime}`,
  symbol,
  timeframe,
  bar,
  closedAt: bar.openTime + TIMEFRAME_MS[timeframe],
});

const PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const;

/** Why a candle cannot be trusted, or null. A bad bar must stop the pipeline rather than feed an indicator. */
export function candleDefect(candle: Candle): string | null {
  for (const field of PRICE_FIELDS) {
    if (!Number.isFinite(candle[field]) || candle[field] <= 0) return `${field} is not a positive finite number`;
  }
  if (!Number.isFinite(candle.volume) || candle.volume < 0) return 'volume is negative or not finite';
  if (!Number.isInteger(candle.openTime) || candle.openTime <= 0) return 'openTime is not a positive integer';
  if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) return 'high/low do not contain open/close';
  return null;
}
