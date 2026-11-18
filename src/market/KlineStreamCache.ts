import type { Candle } from '../types.js';
import type { NativeTimeframe } from './MarketDataTypes.js';
import { NATIVE_TIMEFRAME_MS } from './klineIntervals.js';

/** A stream silent for longer than this is not served: the caller falls back to REST until frames resume. */
export const DEFAULT_KLINE_MAX_SILENCE_MS = 15_000;

export interface KlineFrame {
  symbol: string;
  interval: NativeTimeframe;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Binance's `k.x`: true once the candle is final, false while it still forms. */
  closed: boolean;
}

/**
 * Reads one kline event from a /market kline stream, raw or combined-stream form
 * (`{stream, data: {e: 'kline', k: {...}}}`). Null for anything that is not a kline of a known interval.
 */
export function parseKlineFrame(payload: unknown): KlineFrame | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const root = payload as { data?: unknown };
  const event = (root.data !== undefined ? root.data : payload) as { e?: unknown; s?: unknown; k?: unknown };
  if (event.e !== 'kline' || typeof event.s !== 'string' || typeof event.k !== 'object' || event.k === null) return null;

  const k = event.k as Record<string, unknown>;
  const interval = k.i;
  if (typeof interval !== 'string' || !Object.hasOwn(NATIVE_TIMEFRAME_MS, interval)) return null;

  const openTime = Number(k.t);
  const open = Number(k.o);
  const high = Number(k.h);
  const low = Number(k.l);
  const close = Number(k.c);
  const volume = Number(k.v);
  if (!Number.isSafeInteger(openTime) || openTime <= 0) return null;
  if (![open, high, low, close].every((price) => Number.isFinite(price) && price > 0)) return null;
  if (!Number.isFinite(volume) || volume < 0) return null;

  return {
    symbol: event.s.toUpperCase(),
    interval: interval as NativeTimeframe,
    openTime, open, high, low, close, volume,
    closed: k.x === true,
  };
}

export interface KlineCacheOptions {
  /** Closed candles kept per series. Must equal the REST limit this cache replaces. */
  limit: number;
  maxSilenceMs?: number;
  now?: () => number;
}

export type ApplyResult = 'applied' | 'buffered' | 'ignored' | 'gap';

interface Series {
  symbol: string;
  interval: NativeTimeframe;
  /** Closed candles, oldest first, at most `limit`. */
  candles: Candle[];
  seeded: boolean;
  seeding: boolean;
  needsSeed: boolean;
  /** Bumped on every invalidation. A seed started under an older generation is discarded when it lands. */
  generation: number;
  /** Closed frames received while a seed is in flight, merged when it lands. */
  buffer: Candle[];
  /** Last time the stream spoke for this series: a frame, or the backfill that opened the series. */
  lastFrameAt: number | null;
}

const keyOf = (symbol: string, interval: NativeTimeframe): string => `${symbol.toUpperCase()}:${interval}`;

function toCandle(frame: KlineFrame): Candle {
  return { openTime: frame.openTime, open: frame.open, high: frame.high, low: frame.low, close: frame.close, volume: frame.volume };
}

/**
 * Closed-candle series kept current from kline frames, so a timeframe needs one REST backfill, not one request per TTL.
 *
 * The cache serves a series only when every condition holds:
 *  - it is seeded and no invalidation is pending (a disconnect or a gap sets one);
 *  - a frame arrived within `maxSilenceMs`;
 *  - its newest closed candle is no more than one interval behind the last closed boundary. One candle of grace covers
 *    the close frame's latency. Two or more missing candles means the stream dropped data.
 *
 * Anything else returns null, and the caller reads REST. Correctness never depends on the stream being up.
 */
export class KlineStreamCache {
  private readonly series = new Map<string, Series>();
  private readonly limit: number;
  private readonly maxSilenceMs: number;
  private readonly now: () => number;

  constructor(options: KlineCacheOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new Error(`KlineStreamCache limit must be a positive integer, got ${options.limit}`);
    }
    this.limit = options.limit;
    this.maxSilenceMs = options.maxSilenceMs ?? DEFAULT_KLINE_MAX_SILENCE_MS;
    this.now = options.now ?? Date.now;
  }

  /** Declares a series the feed must backfill. Idempotent. */
  register(symbol: string, interval: NativeTimeframe): void {
    const key = keyOf(symbol, interval);
    if (this.series.has(key)) return;
    this.series.set(key, {
      symbol: symbol.toUpperCase(), interval, candles: [], seeded: false, seeding: false, needsSeed: true,
      generation: 0, buffer: [], lastFrameAt: null,
    });
  }

  /** Series that need a REST backfill and have none in flight. */
  pendingSeeds(): Array<{ symbol: string; interval: NativeTimeframe }> {
    return [...this.series.values()]
      .filter((s) => s.needsSeed && !s.seeding)
      .map((s) => ({ symbol: s.symbol, interval: s.interval }));
  }

  /** Marks a backfill as in flight. Returns the token `seed` or `abortSeed` must present, or null for an unknown series. */
  beginSeed(symbol: string, interval: NativeTimeframe): number | null {
    const s = this.series.get(keyOf(symbol, interval));
    if (!s) return null;
    s.seeding = true;
    s.buffer = [];
    return s.generation;
  }

  /**
   * Installs a backfill. Closed frames buffered while it was in flight are merged in, so a candle that closed during the
   * request is not lost. A token from an older generation is discarded, and the series stays pending.
   */
  seed(symbol: string, interval: NativeTimeframe, token: number, candles: Candle[], now: number = this.now()): boolean {
    const s = this.series.get(keyOf(symbol, interval));
    if (!s) return false;
    const current = s.generation === token;
    const step = NATIVE_TIMEFRAME_MS[interval];
    s.seeding = false;
    if (!current) {
      s.buffer = [];
      s.needsSeed = true;
      return false;
    }
    const merged = new Map<number, Candle>();
    for (const candle of [...candles, ...s.buffer]) merged.set(candle.openTime, candle);
    s.candles = [...merged.values()]
      .filter((c) => Number.isFinite(c.openTime) && c.openTime + step <= now)
      .sort((a, b) => a.openTime - b.openTime)
      .slice(-this.limit);
    s.buffer = [];
    s.seeded = true;
    s.needsSeed = false;
    // A backfill on a connected socket is the stream's first sign of life for this series. Without it a quiet symbol
    // would read REST until its first frame, and the silence limit below still bounds how long a dead route is trusted.
    s.lastFrameAt = Math.max(s.lastFrameAt ?? 0, now);
    return true;
  }

  /** A backfill that failed: the series stays pending for the next attempt. */
  abortSeed(symbol: string, interval: NativeTimeframe, token: number): void {
    const s = this.series.get(keyOf(symbol, interval));
    if (!s) return;
    s.seeding = false;
    s.buffer = [];
    if (s.generation === token) s.needsSeed = true;
  }

  /** The stream dropped. Every series is invalid until it is backfilled, since frames may have been missed. */
  markAllStale(): void {
    for (const s of this.series.values()) {
      s.generation += 1;
      s.needsSeed = true;
    }
  }

  apply(frame: KlineFrame, now: number = this.now()): ApplyResult {
    const s = this.series.get(keyOf(frame.symbol, frame.interval));
    if (!s) return 'ignored';
    s.lastFrameAt = now;
    if (!frame.closed) return 'ignored';

    const candle = toCandle(frame);
    if (s.seeding) {
      s.buffer.push(candle);
      return 'buffered';
    }
    if (!s.seeded || s.needsSeed) return 'ignored';

    const last = s.candles.at(-1);
    if (last !== undefined && candle.openTime === last.openTime) {
      s.candles[s.candles.length - 1] = candle;
      return 'applied';
    }
    if (last !== undefined && candle.openTime < last.openTime) return 'ignored';
    if (last !== undefined && candle.openTime > last.openTime + NATIVE_TIMEFRAME_MS[frame.interval]) {
      s.needsSeed = true;
      return 'gap';
    }
    s.candles.push(candle);
    if (s.candles.length > this.limit) s.candles.splice(0, s.candles.length - this.limit);
    return 'applied';
  }

  /** Closed candles for a series, or null when the caller must read REST. */
  candles(symbol: string, interval: NativeTimeframe, now: number = this.now()): Candle[] | null {
    const s = this.series.get(keyOf(symbol, interval));
    if (!s || !s.seeded || s.needsSeed || s.seeding) return null;
    if (s.lastFrameAt === null || now - s.lastFrameAt > this.maxSilenceMs) return null;

    const step = NATIVE_TIMEFRAME_MS[interval];
    const latestClosedOpen = Math.floor(now / step) * step - step;
    const last = s.candles.at(-1);
    if (last === undefined || last.openTime < latestClosedOpen - step) return null;
    return s.candles.slice();
  }
}
