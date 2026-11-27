import type { TickHealth, TickMeta, TickSink } from './types.js';
import { TickLogWriter, type TickLogWriterOptions } from './TickLogWriter.js';

export interface FileTickSinkOptions {
  dir: string;
  compress?: boolean;
  maxBytesPerDay?: number;
  minFreeBytes?: number;
  now?: () => number;
  onError?: (err: Error) => void;
}

/** Distributes TickSink callbacks across per-symbol TickLogWriters. */
export class FileTickSink implements TickSink {
  private readonly writers = new Map<string, TickLogWriter>();
  private readonly opened = new Set<string>();

  constructor(private readonly options: FileTickSinkOptions) {}

  meta(symbol: string, data: TickMeta): void {
    if (this.opened.has(symbol)) {
      this.writers.get(symbol)?.append('meta', data);
      return;
    }
    const writer = this.writerFor(symbol);
    this.opened.add(symbol);
    void writer.open(data).catch((err: unknown) => {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  }

  ws(symbol: string, stream: string, data: unknown, recvNs?: string): void {
    this.ensureOpen(symbol);
    this.writers.get(symbol)?.append('ws', data, stream, recvNs);
  }

  snapshot(symbol: string, data: unknown): void {
    this.ensureOpen(symbol);
    this.writers.get(symbol)?.append('snapshot', data);
  }

  poll(symbol: string, source: string, data: unknown): void {
    this.ensureOpen(symbol);
    this.writers.get(symbol)?.append('poll', data, source);
  }

  health(symbol: string, data: TickHealth): void {
    this.ensureOpen(symbol);
    this.writers.get(symbol)?.append('health', data);
  }

  fill(symbol: string, data: unknown): void {
    this.ensureOpen(symbol);
    this.writers.get(symbol)?.append('fill', data);
  }

  async close(): Promise<void> {
    const all = [...this.writers.values()].map((w) => w.close());
    await Promise.all(all);
    this.writers.clear();
    this.opened.clear();
  }

  private writerFor(symbol: string): TickLogWriter {
    let writer = this.writers.get(symbol);
    if (!writer) {
      writer = new TickLogWriter({ ...this.options, symbol });
      this.writers.set(symbol, writer);
    }
    return writer;
  }

  private ensureOpen(symbol: string): void {
    if (this.opened.has(symbol)) return;
    this.opened.add(symbol);
    const now = this.options.now ? this.options.now() : Date.now();
    void this.writerFor(symbol).open({ format: 1, symbol, startedAt: now, streams: [] }).catch((err: unknown) => {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  }
}
