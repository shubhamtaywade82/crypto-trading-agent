import type { Candle } from '../types.js';
import type { NativeTimeframe } from './MarketDataTypes.js';
import { KlineStreamCache, parseKlineFrame } from './KlineStreamCache.js';
import { parseCandles } from './MarketDataService.js';

export interface SocketLike {
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  close(): void;
}

export type SocketConstructor = new (url: string) => SocketLike;

export interface KlineFeedOptions {
  /** The /market route base from usdmWsRouteBases(). The route probe measured kline_* on /market, not on the legacy root. */
  marketBase: string;
  symbols: readonly string[];
  intervals: readonly NativeTimeframe[];
  /** Closed candles per series. Must equal the cache's limit. */
  limit: number;
  cache: KlineStreamCache;
  /** One REST backfill. The caller wraps it in the REST guard, so it is refused while a backoff holds. */
  backfill: (symbol: string, interval: NativeTimeframe, limit: number) => Promise<unknown[]>;
  log: (message: string, level: 'info' | 'warn') => void;
  now?: () => number;
  WebSocketImpl?: SocketConstructor;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  retryMs?: number;
}

export interface KlineFeedStatus {
  connected: boolean;
  frames: number;
  lastFrameAt: number | null;
  pendingSeeds: number;
}

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const DEFAULT_RETRY_MS = 15_000;

/**
 * Keeps the kline cache current from one combined /market stream. Backfills run one at a time, so a boot or a reconnect
 * never bursts REST. A failed backfill retries on a timer, not on every frame, so a refusing venue is not hammered.
 * A dropped socket reconnects with exponential backoff. The cache is invalidated on every reconnect.
 */
export class KlineStreamFeed {
  private socket: SocketLike | null = null;
  private running = false;
  private connected = false;
  private reseeding = false;
  private attempt = 0;
  private frames = 0;
  private lastFrameAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: KlineFeedOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The combined-stream URL for every symbol and interval this feed covers. */
  url(): string {
    const streams = this.options.symbols.flatMap((symbol) =>
      this.options.intervals.map((interval) => `${symbol.toLowerCase()}@kline_${interval}`));
    return `${this.options.marketBase}/stream?streams=${streams.join('/')}`;
  }

  start(): void {
    if (this.running) return;
    const WebSocketImpl = this.options.WebSocketImpl ?? (globalThis as unknown as { WebSocket?: SocketConstructor }).WebSocket;
    if (!WebSocketImpl) throw new Error('KlineStreamFeed needs a global WebSocket (Node 22 or later)');
    this.running = true;
    for (const symbol of this.options.symbols) {
      for (const interval of this.options.intervals) this.options.cache.register(symbol, interval);
    }
    this.connect(WebSocketImpl);
  }

  stop(): void {
    this.running = false;
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.reconnectTimer = null;
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  status(): KlineFeedStatus {
    return {
      connected: this.connected,
      frames: this.frames,
      lastFrameAt: this.lastFrameAt,
      pendingSeeds: this.options.cache.pendingSeeds().length,
    };
  }

  private connect(WebSocketImpl: SocketConstructor): void {
    const socket = new WebSocketImpl(this.url());
    socket.onopen = () => {
      this.connected = true;
      this.attempt = 0;
      this.options.log(`kline stream connected (${this.options.symbols.length} symbols x ${this.options.intervals.length} intervals)`, 'info');
      this.options.cache.markAllStale();
      this.kickReseed();
    };
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.socket = null;
      // Frames sent while the socket was down are gone: nothing served from the cache is trusted until a backfill lands.
      this.options.cache.markAllStale();
      this.scheduleReconnect(WebSocketImpl);
    };
    socket.onerror = () => undefined; // the close that follows drives the reconnect
    this.socket = socket;
  }

  private scheduleReconnect(WebSocketImpl: SocketConstructor): void {
    if (!this.running || this.reconnectTimer) return;
    this.attempt += 1;
    const base = this.options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    const max = this.options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    const delay = Math.min(max, base * 2 ** (this.attempt - 1));
    this.options.log(`kline stream closed; reconnecting in ${delay}ms (attempt ${this.attempt})`, 'warn');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.connect(WebSocketImpl);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onMessage(data: unknown): void {
    let payload: unknown;
    try {
      payload = JSON.parse(String(data));
    } catch {
      return;
    }
    const frame = parseKlineFrame(payload);
    if (!frame) return;
    const now = this.now();
    this.frames += 1;
    this.lastFrameAt = now;
    if (this.options.cache.apply(frame, now) === 'gap') {
      this.options.log(`kline gap on ${frame.symbol} ${frame.interval}; backfilling that series`, 'warn');
      this.kickReseed();
    }
  }

  /** Starts a backfill pass unless one runs or a retry is already scheduled. */
  private kickReseed(): void {
    if (this.reseeding || this.retryTimer) return;
    void this.reseedPending();
  }

  private async reseedPending(): Promise<void> {
    if (this.reseeding) return;
    this.reseeding = true;
    try {
      let pending = this.options.cache.pendingSeeds();
      while (pending.length > 0 && this.running) {
        for (const { symbol, interval } of pending) {
          if (!this.running) return;
          const token = this.options.cache.beginSeed(symbol, interval);
          if (token === null) continue;
          try {
            const raw = await this.options.backfill(symbol, interval, this.options.limit);
            const candles: Candle[] = parseCandles(raw as any[], interval, this.now(), this.options.limit);
            this.options.cache.seed(symbol, interval, token, candles, this.now());
          } catch (err) {
            this.options.cache.abortSeed(symbol, interval, token);
            this.scheduleRetry();
            this.options.log(`kline backfill ${symbol} ${interval} failed (${err instanceof Error ? err.message : String(err)}); retrying`, 'warn');
            return;
          }
        }
        pending = this.options.cache.pendingSeeds();
      }
    } finally {
      this.reseeding = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.running) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kickReseed();
    }, this.options.retryMs ?? DEFAULT_RETRY_MS);
    this.retryTimer.unref?.();
  }
}
