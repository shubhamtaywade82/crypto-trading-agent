import { WebsocketClient, type USDMClient } from 'binance';
import { BinanceClient } from '@nemesis-oss/binance-sdk';
import { config } from '../config.js';
import { rulesFromExchangeInfo, setSymbolRules } from './symbolRules.js';
import type { Candle, WsStatus } from '../types.js';
import type { OhlcvInput } from '../market/rejection/types.js';
import { MarketDataService, DEFAULT_MARKET_DATA_OPTIONS, type PollSink } from '../market/MarketDataService.js';
import type { DepthSource } from '../market/OrderBookDepthSource.js';
import { SdkFuturesMarketClient } from '../market/SdkFuturesMarketClient.js';
import type { MarketDataSnapshot } from '../market/MarketDataTypes.js';
import { KlineStreamCache, DEFAULT_KLINE_MAX_SILENCE_MS } from '../market/KlineStreamCache.js';
import { KlineStreamFeed } from '../market/KlineStreamFeed.js';
import { KLINE_INTERVALS } from '../market/klineIntervals.js';
import { sharedRestGuard } from '../core/adapters/binance/restGuard.js';
import { usdmTradeWsUrl, usdmWsRouteBases } from './wsRoutes.js';

const KLINE_INTERVAL = '15m';
const KLINE_LIMIT = 300;

/**
 * Binance USDⓈ-M market data: REST reads, the realtime trade and kline feeds, and the freshness the entry safety gate
 * reads. Read-only. It takes the order client's REST client so market and order calls draw on one weight budget.
 */
export class BinanceMarketData {
  private ws: WebsocketClient | null = null;
  private wsStatus: WsStatus = 'down';
  private readonly marketDataV2: MarketDataService;
  private readonly sdkMarket: SdkFuturesMarketClient;
  /** Closed candles kept current from the /market kline stream; the REST path serves whatever it does not cover. */
  private readonly klineCache: KlineStreamCache;
  private klineFeed: KlineStreamFeed | null = null;
  private readonly lastTickAt = new Map<string, number>();
  private readonly symbolStatus = new Map<string, string>();
  private markAt = 0;

  constructor(private readonly futures: USDMClient) {
    this.sdkMarket = new SdkFuturesMarketClient(new BinanceClient().futures);
    this.klineCache = new KlineStreamCache({ limit: DEFAULT_MARKET_DATA_OPTIONS.klineLimit, maxSilenceMs: DEFAULT_KLINE_MAX_SILENCE_MS });
    this.marketDataV2 = new MarketDataService(this.sdkMarket, DEFAULT_MARKET_DATA_OPTIONS, this.klineCache);
  }

  setDepthSource(depthSource: DepthSource): void {
    this.marketDataV2.setDepthSource(depthSource);
  }

  setPollSink(pollSink: PollSink | null): void {
    this.marketDataV2.setPollSink(pollSink);
  }

  startRealtimeStream(
    symbols: string[],
    onTick: (symbol: string, price: number) => void,
    log: (message: string, level: 'info' | 'warn') => void = () => undefined,
  ): () => void {
    const silent = { silly: () => {}, verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} };
    // Binance's 2026-04-23 base-URL split is per channel. bookTicker answers on /public, markPrice on
    // /market — but @trade still only streams on the legacy path (probed 2026-11-03): a /market/ws/…
    // subscription accepts the connection and then goes silent, which starves the entry safety gate
    // of ticks and blocks every entry. usdmTradeWsUrl tracks the probed truth; see its note.
    this.ws = new WebsocketClient({ wsUrl: usdmTradeWsUrl(), beautify: false }, silent as any);
    const setStatus = (s: WsStatus) => { this.wsStatus = s; };
    this.ws.on('open', () => setStatus('connected'));
    this.ws.on('reconnected', () => setStatus('connected'));
    this.ws.on('reconnecting', () => setStatus('reconnecting'));
    this.ws.on('close', () => setStatus('down'));
    this.ws.on('error', () => setStatus('down'));
    this.ws.on('message', (d: any) => {
      if (d?.e === 'trade' && d.s && Number(d.p) > 0) {
        this.lastTickAt.set(d.s, Date.now());
        onTick(d.s, Number(d.p));
      }
    });
    for (const sym of symbols) this.ws.subscribeTrades(sym, 'usdm');

    // Kline candles for the market-data layer, on the /market route the route probe measured for kline_* streams.
    this.klineFeed?.stop();
    this.klineFeed = new KlineStreamFeed({
      marketBase: usdmWsRouteBases().market,
      symbols,
      intervals: KLINE_INTERVALS,
      limit: DEFAULT_MARKET_DATA_OPTIONS.klineLimit,
      cache: this.klineCache,
      backfill: (symbol, interval, limit) => this.sdkMarket.getKlines({ symbol, interval, limit }),
      log,
    });
    this.klineFeed.start();

    return () => {
      this.klineFeed?.stop();
      this.klineFeed = null;
      this.ws?.closeAll();
      this.ws = null;
      this.wsStatus = 'down';
    };
  }

  /** Freshness of the feeds the safety gate reads; undefined timestamps mean never seen. */
  getFeedHealth(symbol: string): { lastTickAt: number | undefined; markAt: number | undefined; exchangeStatus: string | undefined } {
    return { lastTickAt: this.lastTickAt.get(symbol), markAt: this.markAt || undefined, exchangeStatus: this.symbolStatus.get(symbol) };
  }

  getWsStatus(): WsStatus {
    return this.wsStatus;
  }

  getApiWeight(): number {
    return this.futures.getRateLimitStates()['x-mbx-used-weight-1m'] ?? 0;
  }

  async loadSymbolRules(symbols: string[]): Promise<void> {
    const info = await this.futures.getExchangeInfo();
    sharedRestGuard.seedFromRateLimits((info as { rateLimits?: Array<{ rateLimitType?: unknown; interval?: unknown; limit?: unknown }> }).rateLimits ?? []);
    for (const entry of info.symbols.filter((e) => symbols.includes(e.symbol))) {
      setSymbolRules(entry.symbol, rulesFromExchangeInfo(entry));
      this.symbolStatus.set(entry.symbol, String((entry as { status?: string }).status ?? 'TRADING'));
    }
  }

  /**
   * Read-only klines with the fields the flow features need. getKlines keeps six columns and is unchanged. Each row is
   * [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBaseVolume, takerBuyQuoteVolume, ignore].
   */
  async getFlowKlines(symbol: string, interval: string, limit: number): Promise<OhlcvInput[]> {
    const rawKlines = await this.futures.getKlines({ symbol, interval: interval as any, limit });
    return (rawKlines as any[]).map((k: any[]) => {
      const [openTime, open, high, low, close, volume, , quoteVolume, trades, takerBuy] = k.map(Number);
      return {
        symbol,
        openTime: openTime as number,
        open: open as number,
        high: high as number,
        low: low as number,
        close: close as number,
        baseVolume: volume as number,
        quoteVolume: quoteVolume as number,
        trades: trades as number,
        takerBuyBaseVolume: takerBuy as number,
      };
    });
  }

  async getKlines(symbol: string, interval = '15m', limit = 200): Promise<Candle[]> {
    const rawKlines = await this.futures.getKlines({ symbol, interval: interval as any, limit });
    return (rawKlines as any[]).map((k: any[]) => {
      const [openTime, open, high, low, close, volume] = k.map(Number);
      return { openTime, open, high, low, close, volume };
    });
  }

  async getPremiumIndex(symbol: string): Promise<{ markPrice: number; fundingRate: number }> {
    const res = await this.futures.getMarkPrice({ symbol });
    const single = Array.isArray(res) ? res[0] : res;
    return { markPrice: Number(single.markPrice), fundingRate: Number(single.lastFundingRate) };
  }

  async getMarketOverview(symbols: string[]) {
    const symSet = new Set(symbols);
    const v2Promise = config.marketDataV2.enabled
      ? this.marketDataV2.snapshot(symbols)
      : Promise.resolve({} as Record<string, MarketDataSnapshot>);

    const [rawTickers, rawMarks, v2] = await Promise.all([
      this.futures.get24hrChangeStatistics(),
      this.futures.getMarkPrice(),
      v2Promise,
    ]);
    this.markAt = Date.now();

    const candles: Record<string, Candle[]> = {};
    for (const symbol of symbols) {
      const native15m = v2[symbol]?.candles['15m'];
      candles[symbol] = native15m && native15m.length > 0
        ? native15m
        : await this.getKlines(symbol, KLINE_INTERVAL, KLINE_LIMIT);
    }

    return {
      tickers: this.pickTickers(rawTickers as any[], symSet),
      ...this.pickMarks(rawMarks as any[], symSet),
      candles,
      marketDataV2: v2,
    };
  }

  private pickTickers(rawTickers: any[], symSet: Set<string>) {
    return Object.fromEntries(rawTickers.filter((t) => symSet.has(t.symbol)).map((t) => [
      t.symbol, { price: Number(t.lastPrice), changePct: Number(t.priceChangePercent), high24h: Number(t.highPrice), low24h: Number(t.lowPrice), volumeQuote: Number(t.quoteVolume) },
    ]));
  }

  private pickMarks(rawMarks: any[], symSet: Set<string>) {
    const marks: Record<string, number> = {}, funding: Record<string, number> = {};
    let nextFundingTime = 0;
    for (const m of rawMarks.filter((raw) => symSet.has(raw.symbol))) {
      marks[m.symbol] = Number(m.markPrice);
      funding[m.symbol] = Number(m.lastFundingRate);
      if (m.nextFundingTime) nextFundingTime = Number(m.nextFundingTime);
    }
    return { marks, funding, nextFundingTime };
  }
}
