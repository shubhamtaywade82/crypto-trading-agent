import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BinanceClient } from '@nemesis-oss/binance-sdk';
import { z } from 'zod';
import { errorText } from '../binance/remoteOrders.js';
import type { LiquidityEvent } from './LiquidityEvents.js';
import { DEFAULT_MICRO_OPTIONS, MicrostructureEngine, type MicroOptions, type MicroView } from './MicrostructureEngine.js';
import type { DepthDiff, DepthSnapshot } from './LocalOrderBook.js';
import type { FrictionGateMode } from './FrictionGate.js';
import { nowNs, nsToMs, type TickSink } from '../marketdata/ticks/types.js';
import { FileTickSink } from '../marketdata/ticks/FileTickSink.js';
import { computeParityHash } from '../marketdata/ticks/parity.js';

const onOff = (fallback: 'on' | 'off') => z.enum(['off', 'on']).default(fallback);

export const MicroEnvSchema = z.object({
  MICROSTRUCTURE: onOff('on'),
  MICRO_BUCKET_BPS: z.coerce.number().positive().max(50).default(1),
  MICRO_ORDER_NOTIONAL: z.coerce.number().positive().default(5_000),
  MICRO_MAX_SPREAD_BPS: z.coerce.number().positive().default(5),
  MICRO_MAX_SLIP_BPS: z.coerce.number().positive().default(10),
  MICRO_SAMPLE_MS: z.coerce.number().int().min(250).max(10_000).default(1_000),
  MICRO_RECORD: onOff('on'),
  MICRO_RECORD_DIR: z.string().trim().default('data/microstructure'),
  TICK_RECORD: onOff('off'),
  TICK_RECORD_DIR: z.string().trim().default('data/ticks'),
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
  tickRecord: boolean;
  tickRecordDir: string;
  options: MicroOptions;
}

export function microConfigFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): MicroConfig {
  const e = MicroEnvSchema.parse(env);
  return {
    enabled: e.MICROSTRUCTURE === 'on', entryGate: e.MICRO_ENTRY_GATE, sampleMs: e.MICRO_SAMPLE_MS,
    record: e.MICRO_RECORD === 'on', recordDir: e.MICRO_RECORD_DIR,
    tickRecord: e.TICK_RECORD === 'on', tickRecordDir: e.TICK_RECORD_DIR,
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

/** Epoch ms an IP ban lasts until, parsed from Binance's 418/429 text; null when the error is not a ban. */
export function banExpiryMs(err: unknown): number | null {
  const match = /banned until (\d{10,})/.exec(errorText(err));
  return match ? Number(match[1]) : null;
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
  /** `spanMs` picks the field's time span (see FIELD_SPANS_MS); omitted, one sample per column. */
  view(symbol: string, rows: number, cols: number, spanMs?: number): MicroView | null;
}

export interface FeedDeps {
  source: MicroSource;
  config: MicroConfig;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  onSample?: (handle: MicroFeedHandle, events: Array<{ symbol: string; event: LiquidityEvent }>) => void;
  now?: () => number;
  /** Delay before the snapshot so diffs are already buffering when it is taken. */
  snapshotDelayMs?: number;
  tickSink?: TickSink;
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
  private readonly snapshotErrors = new Map<string, string>();
  private readonly viewCache = new Map<string, MicroView | null>();
  private readonly resyncCounts = new Map<string, number>();
  private readonly lastDepthAt = new Map<string, number>();
  private fileTickSink: FileTickSink | null = null;
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
    if (!deps.tickSink && deps.config.tickRecord) this.fileTickSink = new FileTickSink({ dir: deps.config.tickRecordDir, now: this.now });
  }

  private get sink(): TickSink | undefined { return this.deps.tickSink ?? this.fileTickSink ?? undefined; }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
    this.timer ??= setInterval(() => this.sampleAll(), this.deps.config.sampleMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    for (const h of this.handles.splice(0)) h.close();
    if (this.fileTickSink) void this.fileTickSink.close();
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
      view: (symbol, rows, cols, spanMs) => {
        const key = `${symbol}|${rows}|${cols}|${spanMs ?? ''}`;
        if (!this.viewCache.has(key)) this.viewCache.set(key, this.engines.get(symbol)?.view(this.now(), rows, cols, spanMs) ?? null);
        return this.viewCache.get(key) ?? null;
      },
    };
  }

  /** One sampling pass; public so tests drive it without timers. */
  sampleAll(): void {
    const now = this.now();
    this.viewCache.clear();
    const events: Array<{ symbol: string; event: LiquidityEvent }> = [];
    for (const [symbol, engine] of this.engines) {
      for (const event of engine.sample(now)) events.push({ symbol, event });
      const symEvents = events.filter((e) => e.symbol === symbol).map((e) => e.event);
      if (this.deps.config.record) this.record(symbol, engine, now, symEvents);
      const top = engine.book.top();
      const reading = engine.reading(now);
      const parityHash = computeParityHash(reading, symEvents, { buy: engine.entryFriction('buy', 5000, now), sell: engine.entryFriction('sell', 5000, now) });
      const lastDepth = this.lastDepthAt.get(symbol);
      this.sink?.health(symbol, {
        sampleAt: now, lagMs: lastDepth !== undefined ? now - lastDepth : null, queue: engine.book.bufferedCount,
        resyncs: this.resyncCounts.get(symbol) ?? 0, bookStatus: engine.book.status,
        top: top ? { bid: top.bid, ask: top.ask, bidQty: top.bidQty, askQty: top.askQty } : null, parityHash,
      });
    }
    this.tick += 1;
    this.deps.onSample?.(this.handle(), events);
  }

  // Retrying into a live ban makes Binance extend it, so every symbol waits the ban out together
  private bannedUntil = 0;
  private noteBan(err: unknown): void { this.bannedUntil = Math.max(this.bannedUntil, banExpiryMs(err) ?? 0); }
  private banRemainingMs(): number { return Math.max(0, this.bannedUntil - Date.now()); }

  /** Drops the symbol's book and rebuilds it from a snapshot taken while diffs buffer. Single-flight per symbol. */
  async resync(symbol: string, reason: string): Promise<void> {
    const engine = this.engines.get(symbol);
    if (!engine || this.resyncing.has(symbol)) return;
    this.resyncing.add(symbol);
    engine.invalidate(reason);
    try {
      for (let attempt = 1; !this.stopped; attempt += 1) {
        await new Promise((r) => setTimeout(r, Math.max(this.banRemainingMs(), attempt === 1 ? (this.deps.snapshotDelayMs ?? 250) : Math.min(30_000, 250 * 2 ** attempt))));
        try {
          const snap = await this.deps.source.depthSnapshot(symbol);
          this.sink?.snapshot(symbol, snap);
          if (engine.onSnapshot(snap) === 'applied' && engine.book.status !== 'RESYNC_REQUIRED') {
            this.resyncCounts.set(symbol, (this.resyncCounts.get(symbol) ?? 0) + 1);
            if (this.snapshotErrors.delete(symbol)) this.deps.log('info', `${symbol} order book recovered`);
            return;
          }
          engine.invalidate('snapshot did not join the diff stream');
        } catch (err) {
          const text = (err as Error).message;
          this.noteBan(err);
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
        this.sink?.meta(symbol, { format: 1, symbol, startedAt: this.now(), streams: [`${s}@depth@100ms`, `${s}@aggTrade`, `${s}@forceOrder`] });
        const depth = await this.deps.source.subscribe(`${s}@depth@100ms`);
        const trades = await this.deps.source.subscribe(`${s}@aggTrade`);
        this.handles.push(depth, trades);
        depth.on('message', (payload) => this.onDepth(symbol, payload));
        depth.on('state', (state) => {
          if (state === 'pending') this.engines.get(symbol)?.invalidate('stream reconnecting');
          if (state === 'live') void this.resync(symbol, 'stream reconnected');
        });
        trades.on('message', (p) => {
          this.sink?.ws(symbol, `${s}@aggTrade`, p);
          this.engines.get(symbol)?.onTrade({ time: Number(p.T), price: Number(p.p), qty: Number(p.q), buyerIsMaker: p.m === true });
        });
        try {
          const force = await this.deps.source.subscribe(`${s}@forceOrder`);
          this.handles.push(force);
          force.on('message', (p) => {
            this.sink?.ws(symbol, `${s}@forceOrder`, p);
            const o = p?.o;
            const price = Number(o?.ap || o?.p || 0), qty = Number(o?.q || o?.l || 0);
            if (price > 0 && qty > 0) {
              this.engines.get(symbol)?.onLiquidation({ time: Number(o?.T || p?.E || this.now()), symbol, side: o?.S === 'BUY' ? 'BUY' : 'SELL', price, qty, notional: price * qty });
            }
          });
        } catch {
          // Optional liquidation stream: mock/unsupported sources continue without error
        }
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
    const ns = nowNs(this.now());
    const now = nsToMs(ns);
    this.lastDepthAt.set(symbol, now);
    this.sink?.ws(symbol, `${symbol.toLowerCase()}@depth@100ms`, payload, ns);
    const diff: DepthDiff = { U: payload.U, u: payload.u, pu: payload.pu, E: payload.E, b: payload.b, a: payload.a };
    if (engine.onDepth(diff, now) === 'gap') {
      this.deps.log('warn', `${symbol} order book ${engine.book.reason}; resyncing`);
      void this.resync(symbol, engine.book.reason);
    }
  }

  private record(symbol: string, engine: MicrostructureEngine, now: number, emitted: LiquidityEvent[]): void {
    try {
      const dir = path.join(this.deps.config.recordDir, new Date(now).toISOString().slice(0, 10));
      mkdirSync(dir, { recursive: true });
      const { events: _recent, ...reading } = engine.reading(now);
      appendFileSync(path.join(dir, `${symbol}.jsonl`), `${JSON.stringify({ ...reading, emitted })}\n`);
    } catch (err) {
      this.deps.log('warn', `microstructure recorder: ${(err as Error).message}`);
    }
  }
}
