import path from 'node:path';
import { TickLogWriter } from './TickLogWriter.js';
import type { TickHealth, TickMeta, TickSink } from './types.js';

export interface TickLogSinkOptions {
  dir: string;
  symbols: string[];
  compress?: boolean;
  maxBytesPerDay?: number;
  minFreeBytes?: number;
  onError?: (err: Error) => void;
}

/** A `TickSink` backed by one `TickLogWriter` per symbol, opened lazily on the first `meta`. */
export class TickLogSink implements TickSink {
  private readonly writers = new Map<string, TickLogWriter>();
  private readonly counts = new Map<string, Record<string, number>>();
  private readonly startedAt = Date.now();

  constructor(private readonly options: TickLogSinkOptions) {}

  async start(metaFactory: (symbol: string) => TickMeta): Promise<void> {
    await Promise.all(this.options.symbols.map(async (symbol) => {
      const writer = new TickLogWriter({
        dir: this.options.dir,
        symbol,
        compress: this.options.compress,
        maxBytesPerDay: this.options.maxBytesPerDay,
        minFreeBytes: this.options.minFreeBytes,
        onError: this.options.onError,
      });
      await writer.open(metaFactory(symbol));
      this.writers.set(symbol, writer);
      this.counts.set(symbol, {});
    }));
  }

  meta(symbol: string, data: TickMeta): void {
    this.writer(symbol)?.append('meta', data);
  }

  ws(symbol: string, stream: string, data: unknown, recvNs?: string): void {
    const writer = this.writer(symbol);
    writer?.append('ws', data, stream, recvNs);
    this.bump(symbol, stream);
  }

  snapshot(symbol: string, data: unknown): void {
    this.writer(symbol)?.append('snapshot', data);
  }

  poll(symbol: string, source: string, data: unknown): void {
    this.writer(symbol)?.append('poll', data, source);
  }

  health(symbol: string, data: TickHealth): void {
    const writer = this.writer(symbol);
    const counts = this.counts.get(symbol);
    writer?.append('health', { ...data, counts });
  }

  async close(): Promise<void> {
    await Promise.all([...this.writers.values()].map((writer) => writer.close()));
    this.writers.clear();
  }

  failed(): Error | null {
    for (const writer of this.writers.values()) if (writer.failed) return writer.failed;
    return null;
  }

  pendingBytes(): number {
    let total = 0;
    for (const writer of this.writers.values()) total += writer.pendingBytes();
    return total;
  }

  private writer(symbol: string): TickLogWriter | undefined {
    return this.writers.get(symbol);
  }

  private bump(symbol: string, stream: string): void {
    const counts = this.counts.get(symbol) ?? {};
    counts[stream] = (counts[stream] ?? 0) + 1;
    this.counts.set(symbol, counts);
  }
}

export function tickLogDirFromEnv(env: Record<string, string | undefined>): string {
  return path.resolve(env.TICK_DIR ?? 'data/ticks');
}
