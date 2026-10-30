import { buildPrivateStreamUrl, maskListenKey, type UsdmWsEnvironment, USER_DATA_EVENTS } from './wsRoutes.js';

/**
 * The private USDⓈ-M user-data stream, connected per Binance's post-migration routing
 * (wss://fstream.binance.com/private/ws?listenKey=<key>&events=…) because the bundled
 * `binance` package still dials the retired /ws/<listenKey> path and the SDK's 3.5.0
 * user stream dials /public/ws — both dead since 2026-04-23.
 *
 * What this class owns — and nothing more:
 *   - listen-key lifecycle over the unchanged REST contract (POST/PUT/DELETE /fapi/v1/listenKey)
 *   - one WebSocket connection, its keepalive, expiry and reconnection
 *   - safe event delivery to the application
 * Everything else (order tracking, fills, positions) stays where it already lives: the entry
 * tracker polls REST as its source of truth, so this stream only makes reaction immediate.
 * Events missed while offline are recovered by the existing REST reconciliation (journal
 * cursors, entry-tracker polling, the startup plan) — the stream is not a write channel, so
 * reconnecting can never replay or duplicate an order.
 */

export type UserDataStreamState =
  | 'STOPPED'
  | 'STARTING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RENEWING'
  | 'RECONNECTING';

/** The listen-key REST operations. BinanceService implements them with the existing USDMClient. */
export interface ListenKeyPort {
  create(): Promise<string>;
  keepAlive(): Promise<void>;
  close(): Promise<void>;
}

/** The minimum socket surface this driver needs; the default factory uses the Node global WebSocket. */
export interface StreamSocket {
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: unknown) => void): void;
  onClose(handler: (code: number | null, reason: string) => void): void;
  onError(handler: (err: unknown) => void): void;
}

export type SocketFactory = (url: string) => StreamSocket;

export interface UserDataStreamOptions {
  environment: UsdmWsEnvironment;
  keys: ListenKeyPort;
  /** Called for every parsed user-data event (ORDER_TRADE_UPDATE, ACCOUNT_UPDATE, …). Must not throw. */
  onEvent: (event: { type: string; payload: unknown }) => void;
  log?: (message: string, level: 'info' | 'warn' | 'error') => void;
  /** Listen keys stay valid 60 minutes; renew well inside that window. */
  keepAliveIntervalMs?: number;
  /** First reconnect wait; doubles up to the max, with jitter. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  socketFactory?: SocketFactory;
}

const DEFAULT_KEEP_ALIVE_MS = 30 * 60_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
/** Key failures in a row after which the key is considered burnt and a fresh one is requested. */
const KEY_FAILURE_LIMIT = 3;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Node's global WebSocket (stable since Node 22; this repo requires >= 24) behind the socket surface used here. */
class NodeGlobalWebSocketAdapter implements StreamSocket {
  private openHandler?: () => void;
  private messageHandler?: (data: unknown) => void;
  private closeHandler?: (code: number | null, reason: string) => void;
  private errorHandler?: (err: unknown) => void;

  constructor(private readonly ws: WebSocket) {
    this.ws.addEventListener('open', () => this.openHandler?.());
    this.ws.addEventListener('message', (event) => this.messageHandler?.((event as { data?: unknown }).data));
    this.ws.addEventListener('close', (event) => {
      const close = event as { code?: number | null; reason?: unknown };
      this.closeHandler?.(close.code ?? null, String(close.reason ?? ''));
    });
    this.ws.addEventListener('error', () => this.errorHandler?.(new Error('websocket error')));
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closing or closed */ }
  }

  onOpen(handler: () => void): void { this.openHandler = handler; }
  onMessage(handler: (data: unknown) => void): void { this.messageHandler = handler; }
  onClose(handler: (code: number | null, reason: string) => void): void { this.closeHandler = handler; }
  onError(handler: (err: unknown) => void): void { this.errorHandler = handler; }
}

export class UserDataStream {
  private state: UserDataStreamState = 'STOPPED';
  private listenKey: string | null = null;
  private socket: StreamSocket | null = null;
  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Increments on every connect attempt and on stop; callbacks from retired attempts are ignored. */
  private generation = 0;
  private keyFailures = 0;
  private stopping = true;
  /** True while a reconnect loop owns the recovery, so a close event never starts a second one. */
  private reconnecting = false;
  private connectedAt: number | null = null;
  private lastEventAt: number | null = null;
  private readonly log: (message: string, level: 'info' | 'warn' | 'error') => void;
  private readonly socketFactory: SocketFactory;

  constructor(private readonly options: UserDataStreamOptions) {
    this.log = options.log ?? (() => undefined);
    this.socketFactory = options.socketFactory ?? ((url) => new NodeGlobalWebSocketAdapter(new WebSocket(url)));
  }

  get status(): { state: UserDataStreamState; connectedForMs: number | null; lastEventAt: number | null } {
    return {
      state: this.state,
      connectedForMs: this.connectedAt === null ? null : Date.now() - this.connectedAt,
      lastEventAt: this.lastEventAt,
    };
  }

  /**
   * Connects and keeps the stream alive until `stop()`. Resolves once the first connection is
   * open; a failing first attempt hands recovery to the background reconnect loop, so this
   * never rejects and never leaves the stream silently dead.
   */
  async start(): Promise<void> {
    if (!this.stopping) return;
    this.stopping = false;
    this.state = 'STARTING';
    const opened = await this.connect(this.listenKey === null);
    if (!opened && !this.stopping) void this.reconnect();
  }

  /** Shuts the stream down, releases the listen key and cancels every timer. Idempotent. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.generation++;
    this.clearKeepAlive();
    this.socket?.close(1000, 'shutdown');
    this.socket = null;
    this.state = 'STOPPED';
    this.connectedAt = null;
    const key = this.listenKey;
    this.listenKey = null;
    if (key !== null) {
      try {
        await this.options.keys.close();
      } catch (err) {
        this.log(`user stream: releasing the listen key failed after shutdown (${errorText(err)})`, 'warn');
      }
    }
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer !== null) clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  /**
   * One connection attempt. Resolves true when the socket opened, false when it failed first
   * (key refused, socket closed before opening). Never throws; never resolves twice.
   */
  private connect(freshKey: boolean): Promise<boolean> {
    const generation = ++this.generation;
    this.state = 'CONNECTING';
    let settled = false;
    return new Promise<boolean>((resolve) => {
      const settle = (opened: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(opened);
      };
      void (async () => {
        try {
          if (this.listenKey === null || freshKey) {
            this.listenKey = await this.options.keys.create();
            this.keyFailures = 0;
            this.log(`user stream: listen key ${maskListenKey(this.listenKey)} created`, 'info');
          }
        } catch (err) {
          if (this.stopping || generation !== this.generation) return settle(false);
          this.log(`user stream: listen key could not be created (${errorText(err)})`, 'warn');
          return settle(false);
        }
        if (this.stopping || generation !== this.generation) return settle(false);

        let opened = false;
        const url = buildPrivateStreamUrl(this.options.environment, this.listenKey!, USER_DATA_EVENTS);
        const socket = this.socketFactory(url);
        this.socket = socket;
        socket.onOpen(() => {
          if (generation !== this.generation) return settle(opened);
          opened = true;
          this.state = 'CONNECTED';
          this.connectedAt = Date.now();
          this.log('user data stream: connected (private route)', 'info');
          this.armKeepAlive();
          settle(true);
        });
        socket.onError((err) => {
          if (generation !== this.generation) return;
          this.log(`user stream: socket error (${errorText(err)})`, 'warn');
        });
        socket.onClose((code, reason) => {
          settle(opened); // a close before open settles the attempt as failed
          if (this.stopping || generation !== this.generation) return;
          if (opened) {
            this.connectedAt = null;
            this.clearKeepAlive();
            this.log(`user stream: connection lost (${code}${reason ? ` ${reason}` : ''}); reconnecting`, 'warn');
            void this.reconnect();
          }
        });
        socket.onMessage((data) => {
          if (generation !== this.generation) return;
          this.handleMessage(data);
        });
      })();
    });
  }

  private armKeepAlive(): void {
    this.clearKeepAlive();
    const interval = this.options.keepAliveIntervalMs ?? DEFAULT_KEEP_ALIVE_MS;
    this.keepAliveTimer = setTimeout(() => void this.renewKey(), interval);
  }

  private async renewKey(): Promise<void> {
    if (this.stopping || this.listenKey === null) return;
    this.state = 'RENEWING';
    try {
      await this.options.keys.keepAlive();
      this.keyFailures = 0;
      this.state = 'CONNECTED';
      this.log('user data stream: listen key renewed', 'info');
    } catch (err) {
      this.keyFailures++;
      this.state = 'CONNECTED';
      this.log(`user stream: keepalive ${this.keyFailures}/${KEY_FAILURE_LIMIT} failed (${errorText(err)})`, 'warn');
      if (this.keyFailures >= KEY_FAILURE_LIMIT) {
        // Repeated keepalive failures mean the key is expired or revoked: a fresh key is the recovery.
        this.log('user data stream: listen key assumed expired; requesting a fresh one and reconnecting', 'warn');
        this.listenKey = null;
        this.clearKeepAlive();
        this.socket?.close(4000, 'key expired');
        return;
      }
    }
    if (!this.stopping && this.state === 'CONNECTED') this.armKeepAlive();
  }

  private handleMessage(data: unknown): void {
    this.lastEventAt = Date.now();
    let parsed: { e?: unknown } | null = null;
    try {
      parsed = typeof data === 'string' ? (JSON.parse(data) as { e?: unknown }) : (data as { e?: unknown });
    } catch {
      this.log('user data stream: a message was not JSON; ignored', 'warn');
      return;
    }
    const type = typeof parsed?.e === 'string' ? parsed.e : '';
    if (type === '') return; // connection-level frame: nothing the application consumes
    if (type === 'listenKeyExpired') {
      this.log('user data stream: the venue expired the listen key; reconnecting with a fresh one', 'warn');
      this.listenKey = null;
      this.clearKeepAlive();
      this.socket?.close(4000, 'listenKeyExpired');
      return;
    }
    if (type === 'ORDER_TRADE_UPDATE' || type === 'ACCOUNT_UPDATE' || type === 'MARGIN_CALL' || type === 'ACCOUNT_CONFIG_UPDATE') {
      try {
        this.options.onEvent({ type, payload: parsed });
      } catch (err) {
        this.log(`user stream: an event handler failed (${errorText(err)})`, 'error');
      }
      return;
    }
    // A new upstream event type must never take the stream down; it is reported and skipped.
    this.log(`user stream: unhandled event type "${type}" ignored`, 'info');
  }

  /** Bounded exponential backoff with jitter, one loop at a time, until connected or stopped. */
  private async reconnect(): Promise<void> {
    if (this.stopping || this.reconnecting) return;
    this.reconnecting = true;
    try {
      const base = this.options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
      const max = this.options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
      for (let attempt = 0; !this.stopping; attempt++) {
        const delay = Math.round(Math.min(max, base * 2 ** attempt) * (0.5 + Math.random() / 2));
        this.state = 'RECONNECTING';
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (this.stopping) return;
        const opened = await this.connect(this.listenKey === null);
        if (opened || this.stopping) return;
      }
    } finally {
      this.reconnecting = false;
    }
  }
}
