import type { SocketConstructor } from '../KlineStreamFeed.js';
import { SpotPublicClient } from '../spot/SpotPublicClient.js';
import { applyStreamFrame, streamNames } from './frameHandlers.js';
import { SPOT_STREAM_ORIGIN, USDM_PUBLIC_STREAM_ORIGIN } from './endpointRegistry.js';
import { PublicQuoteStore } from './PublicQuoteStore.js';
import { PublicRestClient } from './PublicRestClient.js';
import { PublicStreamFeed } from './PublicStreamFeed.js';
import { UsdmPublicClient } from './UsdmPublicClient.js';
import type { PublicDataContext, UsdmFunding } from './types.js';

export interface PublicMarketFeedsOptions {
  readonly symbols: readonly string[];
  /** Spot reference feed: book and trade streams from data-stream.binance.vision. */
  readonly spot: boolean;
  /** USDⓈ-M extras: perp top-of-book from /public and funding-rate history over REST. */
  readonly usdmExtras: boolean;
  readonly staleMs: number;
  readonly fundingRefreshMs: number;
  readonly fundingLimit?: number;
  readonly log: (message: string, level: 'info' | 'warn') => void;
  readonly now?: () => number;
  readonly spotRest?: PublicRestClient;
  readonly usdmRest?: PublicRestClient;
  readonly WebSocketImpl?: SocketConstructor;
}

const DEFAULT_FUNDING_LIMIT = 8;
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const upper = (symbols: readonly string[]): string[] => symbols.map((s) => s.toUpperCase());

/**
 * The public market-data feeds behind the decision context. Each feed fails on its own: a spot outage does not stop
 * the USDⓈ-M funding refresh, and neither can throw into the trading loop. Everything here is read-only and keyless.
 */
export class PublicMarketFeeds {
  private readonly store: PublicQuoteStore;
  private readonly spotClient: SpotPublicClient;
  private readonly usdmClient: UsdmPublicClient;
  private readonly usdmRest: PublicRestClient;
  private readonly now: () => number;
  private readonly streams: PublicStreamFeed[] = [];
  private readonly funding = new Map<string, UsdmFunding>();
  private fundingTimer: ReturnType<typeof setInterval> | null = null;
  private usdmSymbols: string[] = [];
  private running = false;

  constructor(private readonly options: PublicMarketFeedsOptions) {
    this.now = options.now ?? Date.now;
    this.store = new PublicQuoteStore(options.staleMs);
    const spotRest = options.spotRest ?? new PublicRestClient({ now: this.now });
    this.usdmRest = options.usdmRest ?? new PublicRestClient({ now: this.now });
    this.spotClient = new SpotPublicClient(spotRest);
    this.usdmClient = new UsdmPublicClient(this.usdmRest);
  }

  /** Starts every enabled feed. Never throws: a feed that fails to start logs and stays down. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.options.spot) await this.guard('spot', () => this.startSpot());
    if (this.options.usdmExtras) await this.guard('usdm', () => this.startUsdm());
  }

  stop(): void {
    this.running = false;
    for (const feed of this.streams) feed.stop();
    this.streams.length = 0;
    if (this.fundingTimer) clearInterval(this.fundingTimer);
    this.fundingTimer = null;
  }

  /** The informational context for one cycle. Missing data is null; nothing here is ever zero by default. */
  snapshot(now: number = this.now()): PublicDataContext {
    // Every configured symbol is listed, even with no data yet (MISSING): an absent key would read as "not configured"
    const symbols = upper(this.options.symbols);
    const quotesOf = (venue: 'SPOT' | 'USDM') => Object.fromEntries(symbols.map((s) => [s, this.store.quote(venue, s, now)]));
    return {
      asOf: now,
      spot: this.options.spot ? quotesOf('SPOT') : {},
      usdm: this.options.usdmExtras ? quotesOf('USDM') : {},
      basisBps: Object.fromEntries(symbols.map((symbol) => [symbol, this.store.basisBps(symbol, now)])),
      funding: Object.fromEntries(this.funding),
    };
  }

  /** One funding-history refresh. Symbols are fetched one at a time, and the loop stops as soon as the venue backs off. */
  async refreshFunding(): Promise<void> {
    const limit = this.options.fundingLimit ?? DEFAULT_FUNDING_LIMIT;
    for (const symbol of this.usdmSymbols) {
      if (this.usdmRest.backoffRemainingMs() > 0) {
        this.options.log(`public usdm funding: venue backoff holds, skipping the rest of this refresh`, 'warn');
        return;
      }
      try {
        this.funding.set(symbol, await this.usdmClient.fundingHistory(symbol, limit, this.now()));
      } catch (err) {
        this.options.log(`public usdm funding ${symbol} failed: ${describe(err)}`, 'warn');
      }
    }
  }

  private async startSpot(): Promise<void> {
    let symbols = upper(this.options.symbols);
    try {
      const trading = await this.spotClient.tradingSymbols(symbols);
      const skipped = symbols.filter((s) => !trading.has(s));
      if (skipped.length > 0) this.options.log(`public spot: not TRADING on the venue, not subscribed: ${skipped.join(', ')}`, 'warn');
      symbols = symbols.filter((s) => trading.has(s));
    } catch (err) {
      // Without the symbol list the configured symbols are subscribed anyway; the stream itself reports what is live
      this.options.log(`public spot exchangeInfo failed (${describe(err)}); subscribing to the configured symbols`, 'warn');
    }
    // REST bootstrap, one symbol at a time, so the first cycles have a book before the first stream frame arrives
    for (const symbol of symbols) {
      try {
        const book = await this.spotClient.bookTicker(symbol);
        this.store.applyBook('SPOT', symbol, book.bid, book.ask, this.now());
      } catch (err) {
        this.options.log(`public spot bookTicker ${symbol} failed: ${describe(err)}`, 'warn');
      }
    }
    if (symbols.length === 0) return;
    this.streams.push(this.stream('public spot stream', `${SPOT_STREAM_ORIGIN}/stream?streams=${streamNames(symbols, ['bookTicker', 'trade']).join('/')}`, 'SPOT'));
    this.streams.at(-1)!.start();
  }

  private async startUsdm(): Promise<void> {
    this.usdmSymbols = upper(this.options.symbols);
    this.streams.push(this.stream('public usdm book stream', `${USDM_PUBLIC_STREAM_ORIGIN}/public/stream?streams=${streamNames(this.usdmSymbols, ['bookTicker']).join('/')}`, 'USDM'));
    this.streams.at(-1)!.start();
    await this.refreshFunding();
    this.fundingTimer = setInterval(() => { void this.refreshFunding(); }, this.options.fundingRefreshMs);
    this.fundingTimer.unref?.();
  }

  private stream(name: string, url: string, venue: 'SPOT' | 'USDM'): PublicStreamFeed {
    return new PublicStreamFeed({
      name,
      url,
      log: this.options.log,
      now: this.now,
      WebSocketImpl: this.options.WebSocketImpl,
      onFrame: (stream, data, receivedAt) => { applyStreamFrame(this.store, venue, stream, data, receivedAt); },
    });
  }

  private async guard(feed: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      this.options.log(`public ${feed} feed failed to start: ${describe(err)}`, 'warn');
    }
  }
}
