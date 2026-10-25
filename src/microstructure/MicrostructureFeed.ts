import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BinanceClient } from '@nemesis-oss/binance-sdk';
import { z } from 'zod';
import type { LiquidityEvent } from './LiquidityEvents.js';
import { DEFAULT_MICRO_OPTIONS, MicrostructureEngine, type MicroOptions, type MicroView } from './MicrostructureEngine.js';
import type { DepthDiff, DepthSnapshot } from './LocalOrderBook.js';
import type { FrictionGateMode } from './FrictionGate.js';

const onOff = (fallback: 'on' | 'off') => z.enum(['off', 'on']).default(fallback);

export const MicroEnvSchema = z.object({
  MICROSTRUCTURE: onOff('on'),
  MICRO_BUCKET_BPS: z.coerce.number().positive().max(50).default(1),
  MICRO_ORDER_NOTIONAL: z.coerce.number().positive().default(5_000),
  MICRO_MAX_SPREAD_BPS: z.coerce.number().positive().default(5),
  MICRO_MAX_SLIP_BPS: z.coerce.number().positive().default(10),
  MICRO_SAMPLE_MS: z.coerce.number().int().min(250).max(10_000).default(1_000),
  /** Write one reading per symbol per sample to MICRO_RECORD_DIR, for validating the features offline. */
  MICRO_RECORD: onOff('off'),
  MICRO_RECORD_DIR: z.string().trim().default('data/microstructure'),
  /** Execution-friction gate on futures entries: on refuses BLOCK verdicts, shadow only logs them. Fails closed. */
  MICRO_ENTRY_GATE: z.enum(['off', 'shadow', 'on']).default('on'),
}).superRefine((env, ctx) => {
  if (env.MICRO_ENTRY_GATE !== 'off' && env.MICROSTRUCTURE === 'off') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MICRO_ENTRY_GATE'],
      message: `MICRO_ENTRY_GATE=${env.MICRO_ENTRY_GATE} needs the order-book feed: set MICROSTRUCTURE=on, or MICRO_ENTRY_GATE=off to trade without a pre-trade cost check`,
    });
  }
});

export interface MicroConfig {
  enabled: boolean;
  entryGate: FrictionGateMode;
  sampleMs: number;
  record: boolean;
  recordDir: string;
  options: MicroOptions;
}

export function microConfigFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): MicroConfig {
  const e = MicroEnvSchema.parse(env);
  return {
    enabled: e.MICROSTRUCTURE === 'on',
    entryGate: e.MICRO_ENTRY_GATE,
    sampleMs: e.MICRO_SAMPLE_MS,
    record: e.MICRO_RECORD === 'on',
    recordDir: e.MICRO_RECORD_DIR,
    options: { ...DEFAULT_MICRO_OPTIONS, bucketBps: e.MICRO_BUCKET_BPS, orderNotional: e.MICRO_ORDER_NOTIONAL, maxSpreadBps: e.MICRO_MAX_SPREAD_BPS, maxSlipBps: e.MICRO_MAX_SLIP_BPS },
  };
}

/** A live stream handle: parsed payloads on 'message', 'pending' | 'live' | 'closed' on 'state'. */
export interface StreamHandle {
  on(event: 'message', listener: (payload: any) => void): unknown;
  on(event: 'state', listener: (state: string) => void): unknown;
  close(): void;
}

/** The market-data calls the feed makes; binance-sdk in production, scripted in tests. */
export interface MicroSource {
  subscribe(stream: string): Promise<StreamHandle>;
  depthSnapshot(symbol: string): Promise<DepthSnapshot>;
}

/** USD-M streams over binance-sdk's pooled WS platform, snapshots from `/fapi/v1/depth?limit=1000`. */
export const sdkMicroSource = (client: BinanceClient): MicroSource => ({
  subscribe: (stream) => client.ws.usdm.subscribe(stream) as unknown as Promise<StreamHandle>,
  depthSnapshot: (symbol) => client.futures.market.depth(symbol, 1000),
});

export type FeedState = 'connecting' | 'live' | 'down';

/** What the cockpit holds: a fresh object each sample so the view re-renders, reading through to the live engines. */
export interface MicroFeedHandle {
  tick: number;
  state: FeedState;
  lastError: string | null;
  symbols: string[];
  view(symbol: string, rows: number, cols: number): MicroView | null;
}

export interface FeedDeps {
  source: MicroSource;
  config: MicroConfig;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  onSample?: (handle: MicroFeedHandle, events: Array<{ symbol: string; event: LiquidityEvent }>) => void;
  now?: () => number;
  /** Delay before the snapshot so diffs are already buffering when it is taken. */
  snapshotDelayMs?: number;
}

const RETRY_MS = 30_000;

/**
 * Keeps one MicrostructureEngine per symbol fed from `<sym>@depth@100ms` and `<sym>@aggTrade`. A sequence gap, a
 * reconnect or a crossed book drops the local book and rebuilds it from a fresh snapshot; until then the symbol reads
 * as SYNCING/RESYNC and every derived figure is withheld. A failed subscription (geo-block, network) is retried.
 */
export class MicrostructureFeed {
  private readonly engines = new Map<string, MicrostructureEngine>();
  private readonly handles: StreamHandle[] = [];
  private readonly resyncing = new Set<string>();
  /** Last snapshot error per symbol, so a retry loop logs a failure once, not on every attempt. */
  private readonly snapshotErrors = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private tick = 0;
  private state: FeedState = 'connecting';
  private lastError: string | null = null;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly symbols: string[], private readonly deps: FeedDeps) {
    this.now = deps.now ?? Date.now;
    for (const s of symbols) this.engines.set(s, new MicrostructureEngine(s, deps.config.options));
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
    this.timer ??= setInterval(() => this.sampleAll(), this.deps.config.sampleMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    for (const h of this.handles.splice(0)) h.close();
  }

  engine(symbol: string): MicrostructureEngine | undefined {
    return this.engines.get(symbol);
  }

  handle(): MicroFeedHandle {
    return {
      tick: this.tick,
      state: this.state,
      lastError: this.lastError,
      symbols: this.symbols,
      view: (symbol, rows, cols) => this.engines.get(symbol)?.view(this.now(), rows, cols) ?? null,
    };
  }

  /** One sampling pass; public so tests drive it without timers. */
  sampleAll(): void {
    const now = this.now();
    const events: Array<{ symbol: string; event: LiquidityEvent }> = [];
    for (const [symbol, engine] of this.engines) {
      for (const event of engine.sample(now)) events.push({ symbol, event });
      if (this.deps.config.record) this.record(symbol, engine, now, events.filter((e) => e.symbol === symbol).map((e) => e.event));
    }
    this.tick += 1;
    this.deps.onSample?.(this.handle(), events);
  }

  /** Drops the symbol's book and rebuilds it from a snapshot taken while diffs buffer. Single-flight per symbol. */
  async resync(symbol: string, reason: string): Promise<void> {
    const engine = this.engines.get(symbol);
    if (!engine || this.resyncing.has(symbol)) return;
    this.resyncing.add(symbol);
    engine.invalidate(reason);
    try {
      for (let attempt = 1; !this.stopped; attempt += 1) {
        await new Promise((r) => setTimeout(r, attempt === 1 ? (this.deps.snapshotDelayMs ?? 250) : Math.min(30_000, 250 * 2 ** attempt)));
        try {
          if (engine.onSnapshot(await this.deps.source.depthSnapshot(symbol)) === 'applied' && engine.book.status !== 'RESYNC_REQUIRED') {
            if (this.snapshotErrors.delete(symbol)) this.deps.log('info', `${symbol} order book recovered`);
            return;
          }
          engine.invalidate('snapshot did not join the diff stream');
        } catch (err) {
          const text = (err as Error).message;
          if (this.snapshotErrors.get(symbol) !== text) this.deps.log('warn', `${symbol} depth snapshot failed, retrying with backoff: ${text}`);
          this.snapshotErrors.set(symbol, text);
          engine.invalidate(`snapshot failed: ${text}`);
        }
      }
    } finally {
      this.resyncing.delete(symbol);
    }
  }

  private async connect(): Promise<void> {
    try {
      for (const symbol of this.symbols) {
        const s = symbol.toLowerCase();
        const depth = await this.deps.source.subscribe(`${s}@depth@100ms`);
        const trades = await this.deps.source.subscribe(`${s}@aggTrade`);
        this.handles.push(depth, trades);
        depth.on('message', (payload) => this.onDepth(symbol, payload));
        depth.on('state', (state) => {
          if (state === 'pending') this.engines.get(symbol)?.invalidate('stream reconnecting');
          if (state === 'live') void this.resync(symbol, 'stream reconnected');
        });
        trades.on('message', (p) => this.engines.get(symbol)?.onTrade({ time: Number(p.T), price: Number(p.p), qty: Number(p.q), buyerIsMaker: p.m === true }));
        void this.resync(symbol, 'initial sync');
      }
      this.state = 'live';
      this.lastError = null;
    } catch (err) {
      for (const h of this.handles.splice(0)) h.close();
      const text = (err as Error).message;
      if (text !== this.lastError) this.deps.log('error', `microstructure streams unavailable, retrying every ${RETRY_MS / 1000}s: ${text}`);
      this.state = 'down';
      this.lastError = text;
      if (!this.stopped) this.retryTimer = setTimeout(() => void this.connect(), RETRY_MS);
    }
  }

  private onDepth(symbol: string, payload: { U: number; u: number; pu?: number; E: number; b: Array<[string, string]>; a: Array<[string, string]> }): void {
    const engine = this.engines.get(symbol);
    if (!engine) return;
    const diff: DepthDiff = { U: payload.U, u: payload.u, pu: payload.pu, E: payload.E, b: payload.b, a: payload.a };
    if (engine.onDepth(diff, this.now()) === 'gap') {
      this.deps.log('warn', `${symbol} order book ${engine.book.reason}; resyncing`);
      void this.resync(symbol, engine.book.reason);
    }
  }

  private record(symbol: string, engine: MicrostructureEngine, now: number, emitted: LiquidityEvent[]): void {
    try {
      const day = new Date(now).toISOString().slice(0, 10);
      const dir = path.join(this.deps.config.recordDir, day);
      mkdirSync(dir, { recursive: true });
      const { events: _recent, ...reading } = engine.reading(now);
      appendFileSync(path.join(dir, `${symbol}.jsonl`), `${JSON.stringify({ ...reading, emitted })}\n`);
    } catch (err) {
      this.deps.log('warn', `microstructure recorder: ${(err as Error).message}`);
    }
  }
}
