import type { MarketSnapshot } from '../../domain/market.js';
import { type MarketDataPort, type SnapshotRequest } from '../../ports/MarketDataPort.js';

const keyOf = (request: SnapshotRequest): string => [request.symbol, request.timeframes.join(','), request.bars, request.asOf].join('|');

/**
 * Serves a repeated request from memory. The key includes `asOf`, so a snapshot is only ever reused for the same
 * instant: within one bar's cycle several symbols' events ask for the same universe, and it is fetched once.
 */
export class CachingMarketData implements MarketDataPort {
  private readonly cache = new Map<string, Promise<MarketSnapshot>>();

  constructor(private readonly inner: MarketDataPort, private readonly maxEntries = 256) {}

  getSnapshot(request: SnapshotRequest): Promise<MarketSnapshot> {
    const key = keyOf(request);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.inner.getSnapshot(request);
    this.cache.set(key, pending);
    // A failure must not be remembered: the next request retries the venue
    pending.catch(() => this.cache.delete(key));
    if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value as string);
    return pending;
  }
}

/** Retries a failed read with exponential backoff. Reads are idempotent; this decorator exists for nothing else. */
export class RetryingMarketData implements MarketDataPort {
  constructor(
    private readonly inner: MarketDataPort,
    private readonly options: { attempts: number; backoffMs: number; sleep?: (ms: number) => Promise<void> },
  ) {
    if (options.attempts < 1) throw new Error('attempts must be at least 1');
  }

  async getSnapshot(request: SnapshotRequest): Promise<MarketSnapshot> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let lastError: unknown;
    for (let attempt = 0; attempt < this.options.attempts; attempt += 1) {
      if (attempt > 0) await sleep(this.options.backoffMs * 2 ** (attempt - 1));
      try {
        return await this.inner.getSnapshot(request);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

export interface CallMetrics {
  calls: number;
  failures: number;
  totalMs: number;
  maxMs: number;
}

/** Counts calls, failures and latency without touching the result. */
export class MeteredMarketData implements MarketDataPort {
  readonly metrics: CallMetrics = { calls: 0, failures: 0, totalMs: 0, maxMs: 0 };

  constructor(private readonly inner: MarketDataPort, private readonly now: () => number = () => performance.now()) {}

  async getSnapshot(request: SnapshotRequest): Promise<MarketSnapshot> {
    const startedAt = this.now();
    this.metrics.calls += 1;
    try {
      return await this.inner.getSnapshot(request);
    } catch (error) {
      this.metrics.failures += 1;
      throw error;
    } finally {
      const elapsed = this.now() - startedAt;
      this.metrics.totalMs += elapsed;
      this.metrics.maxMs = Math.max(this.metrics.maxMs, elapsed);
    }
  }
}
