import type { SocketConstructor, SocketLike } from '../KlineStreamFeed.js';
import { resolvePublicWs } from './endpointRegistry.js';
import { CombinedFrame } from './parsers.js';

export interface PublicStreamFeedOptions {
  readonly name: string;
  /** A combined-stream URL. Validated against the public route guard before the first dial. */
  readonly url: string;
  /** Called with each well-formed frame: the stream name and its payload. Throwing here is contained, not propagated. */
  readonly onFrame: (stream: string, data: unknown, receivedAt: number) => void;
  readonly log: (message: string, level: 'info' | 'warn') => void;
  readonly now?: () => number;
  readonly WebSocketImpl?: SocketConstructor;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  /** Jitter as a fraction of the delay (0.2 = ±20%). Applied so a fleet of feeds does not redial in lockstep. */
  readonly jitter?: number;
  readonly random?: () => number;
}

export interface PublicStreamStatus {
  readonly connected: boolean;
  readonly frames: number;
  readonly lastFrameAt: number | null;
  readonly reconnects: number;
}

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;

/**
 * One combined public stream with reconnect. A dropped socket redials with capped exponential backoff and jitter; a
 * successful open resets the backoff. Malformed frames are counted nowhere and skipped, so one bad payload cannot
 * stop the feed. The feed never throws into its caller.
 */
export class PublicStreamFeed {
  private socket: SocketLike | null = null;
  private running = false;
  private connected = false;
  private attempt = 0;
  private frames = 0;
  private reconnects = 0;
  private lastFrameAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: PublicStreamFeedOptions) {
    resolvePublicWs(options.url);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.running) return;
    const WebSocketImpl = this.options.WebSocketImpl ?? (globalThis as unknown as { WebSocket?: SocketConstructor }).WebSocket;
    if (!WebSocketImpl) throw new Error(`${this.options.name} needs a global WebSocket (Node 22 or later)`);
    this.running = true;
    this.connect(WebSocketImpl);
  }

  stop(): void {
    this.running = false;
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  status(): PublicStreamStatus {
    return { connected: this.connected, frames: this.frames, lastFrameAt: this.lastFrameAt, reconnects: this.reconnects };
  }

  private connect(WebSocketImpl: SocketConstructor): void {
    const socket = new WebSocketImpl(this.options.url);
    socket.onopen = () => {
      this.connected = true;
      this.attempt = 0;
      this.options.log(`${this.options.name} connected`, 'info');
    };
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.socket = null;
      this.scheduleReconnect(WebSocketImpl);
    };
    socket.onerror = () => undefined; // the close that follows drives the reconnect
    this.socket = socket;
  }

  private scheduleReconnect(WebSocketImpl: SocketConstructor): void {
    if (!this.running || this.reconnectTimer) return;
    this.attempt += 1;
    this.reconnects += 1;
    const base = this.options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    const max = this.options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    const capped = Math.min(max, base * 2 ** (this.attempt - 1));
    const spread = this.options.jitter ?? 0.2;
    const delay = Math.round(capped * (1 + spread * (2 * this.random() - 1)));
    this.options.log(`${this.options.name} closed; reconnecting in ${delay} ms (attempt ${this.attempt})`, 'warn');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.connect(WebSocketImpl);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onMessage(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    const envelope = CombinedFrame.safeParse(parsed);
    if (!envelope.success) return;
    const receivedAt = this.now();
    this.frames += 1;
    this.lastFrameAt = receivedAt;
    try {
      this.options.onFrame(envelope.data.stream, envelope.data.data, receivedAt);
    } catch (err) {
      this.options.log(`${this.options.name} frame handler failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
    }
  }
}
