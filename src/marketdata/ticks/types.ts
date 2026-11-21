/** One append-only line in a raw tick log. `recvNs` is a decimal epoch-nanosecond string. */
export type TickKind = 'meta' | 'ws' | 'snapshot' | 'poll' | 'health' | 'fill';

export interface TickEvent<T = unknown> {
  seq: number;
  recvNs: string;
  kind: TickKind;
  stream?: string;
  data: T;
}

export interface TickSpec {
  tickSize: number;
  stepSize: number;
  minNotional: number;
}

export interface TickMeta {
  format: 1;
  symbol: string;
  startedAt: number;
  streams: string[];
  routes?: Record<string, string>;
  spec?: TickSpec | null;
  configHash?: string;
  sdkVersion?: string;
  node?: string;
}

export interface TickTop {
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
}

export interface TickHealth {
  sampleAt: number;
  lagMs: number | null;
  queue: number;
  resyncs: number;
  bookStatus: string;
  top: TickTop | null;
  counts?: Record<string, number>;
  parityHash?: string;
}

/** The capture seam: production writes to a TickLogSink, tests record calls in memory. */
export interface TickSink {
  meta(symbol: string, data: TickMeta): void;
  ws(symbol: string, stream: string, data: unknown, recvNs?: string): void;
  snapshot(symbol: string, data: unknown): void;
  poll(symbol: string, source: string, data: unknown): void;
  health(symbol: string, data: TickHealth): void;
  fill?(symbol: string, data: unknown): void;
}

/** Wall-clock epoch nanoseconds with microsecond precision, aligned with Date.now(). */
export function nowNs(nowMs: number = Date.now()): string {
  const ms = BigInt(nowMs);
  const frac = process.hrtime.bigint() % 1_000_000n;
  return (ms * 1_000_000n + frac).toString();
}

export function nsToMs(ns: string): number {
  return Number(BigInt(ns) / 1_000_000n);
}
