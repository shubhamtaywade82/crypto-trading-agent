import { USDMClient, WebsocketClient } from 'binance';
import { config } from '../config.js';
import { PaperEngine } from './paperEngine.js';
import { PaperExchangeClient } from './paperExchangeClient.js';
import { RemoteBroker, type VenueStatus } from './remoteBroker.js';
import type { FundingLine, FundingObservation } from './remoteFunding.js';
import { RemoteStore } from './remoteState.js';
import { roundPrice, roundQty, rulesFromExchangeInfo, setSymbolRules } from './symbolRules.js';
import type { AgentId, Candle, Position, TradeRecord, WsStatus } from '../types.js';

// 300 closed 15m candles cover the adaptive SuperTrend's ATR warm-up (10) + K-Means window (100) with margin
const KLINE_INTERVAL = '15m';
const KLINE_LIMIT = 300;

type OpenPositionParams = {
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  leverage: number;
  strategy: AgentId;
  stopLoss?: number;
  takeProfit?: number;
  reduceOnly?: boolean;
  entryPrice?: number;
};

const REMOTE_STATE_FILE = 'data/remote-state.json';
// Same starting equity as the local paper engine, so both paper venues share a baseline
const REMOTE_INITIAL_MARGIN = 100_000;

/** Non-null only in PAPER mode with PAPER_EXCHANGE_URL set. */
function remoteBrokerFromConfig(): RemoteBroker | null {
  const remote = config.paperExchange;
  if (config.mode !== 'paper' || !remote) return null;
  return new RemoteBroker({
    api: new PaperExchangeClient(remote.url, remote.accountId),
    store: new RemoteStore(REMOTE_STATE_FILE, remote.accountId),
    accountId: remote.accountId,
    symbols: config.symbols,
    initialMargin: REMOTE_INITIAL_MARGIN,
  });
}

export class BinanceService {
  private futures: USDMClient;
  private ws: WebsocketClient | null = null;
  private wsStatus: WsStatus = 'down';
  // Lazy so live and remote runs never load the local paper state file
  private paperEngine?: PaperEngine;
  private liveStartEquity: number | null = null;

  /** `broker` is the seam for tests; when it is set, every paper operation is routed to it. */
  constructor(private readonly broker: RemoteBroker | null = remoteBrokerFromConfig()) {
    this.futures = new USDMClient({ api_key: config.binance.apiKey, api_secret: config.binance.apiSecret });
  }

  private get paper(): PaperEngine {
    return (this.paperEngine ??= new PaperEngine());
  }

  startRealtimeStream(symbols: string[], onTick: (symbol: string, price: number) => void): () => void {
    const silent = { silly: () => {}, verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} };
    this.ws = new WebsocketClient({ beautify: false }, silent as any);
    this.ws.on('open', () => { this.wsStatus = 'connected'; });
    this.ws.on('reconnected', () => { this.wsStatus = 'connected'; });
    this.ws.on('reconnecting', () => { this.wsStatus = 'reconnecting'; });
    this.ws.on('close', () => { this.wsStatus = 'down'; });
    // An EventEmitter throws on an unlistened 'error' event, which would kill the process
    this.ws.on('error', () => { this.wsStatus = 'down'; });
    this.ws.on('message', (data: any) => {
      if (data?.e === 'trade' && data.s && data.p) {
        const price = Number(data.p);
        if (price > 0) onTick(data.s, price);
      }
    });
    for (const sym of symbols) this.ws.subscribeTrades(sym, 'usdm');
    return () => {
      this.ws?.closeAll();
      this.ws = null;
      this.wsStatus = 'down';
    };
  }

  getWsStatus(): WsStatus {
    return this.wsStatus;
  }

  /** Used request weight over the last minute; 0 until the first REST response carries the header. */
  getApiWeight(): number {
    return this.futures.getRateLimitStates()['x-mbx-used-weight-1m'] ?? 0;
  }

  /** Loads per-symbol price/quantity precision so orders and the UI use each contract's own decimals. */
  async loadSymbolRules(symbols: string[]): Promise<void> {
    const info = await this.futures.getExchangeInfo();
    for (const entry of info.symbols.filter((e) => symbols.includes(e.symbol))) {
      setSymbolRules(entry.symbol, rulesFromExchangeInfo(entry));
    }
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
    const [rawTickers, rawMarks, ...rawKlines] = await Promise.all([
      this.futures.get24hrChangeStatistics(),
      this.futures.getMarkPrice(),
      ...symbols.map((s) => this.getKlines(s, KLINE_INTERVAL, KLINE_LIMIT)),
    ]);
    const candles: Record<string, Candle[]> = {};
    symbols.forEach((s, i) => { candles[s] = rawKlines[i]; });
    return { tickers: this.pickTickers(rawTickers as any[], symSet), ...this.pickMarks(rawMarks as any[], symSet), candles };
  }

  private pickTickers(rawTickers: any[], symSet: Set<string>) {
    const tickers: Record<string, { price: number; changePct: number; high24h: number; low24h: number; volumeQuote: number }> = {};
    for (const t of rawTickers.filter((raw) => symSet.has(raw.symbol))) {
      tickers[t.symbol] = { price: Number(t.lastPrice), changePct: Number(t.priceChangePercent), high24h: Number(t.highPrice), low24h: Number(t.lowPrice), volumeQuote: Number(t.quoteVolume) };
    }
    return tickers;
  }

  private pickMarks(rawMarks: any[], symSet: Set<string>) {
    const marks: Record<string, number> = {};
    const funding: Record<string, number> = {};
    let nextFundingTime = 0;
    for (const m of rawMarks.filter((raw) => symSet.has(raw.symbol))) {
      marks[m.symbol] = Number(m.markPrice);
      funding[m.symbol] = Number(m.lastFundingRate);
      if (m.nextFundingTime) nextFundingTime = Number(m.nextFundingTime);
    }
    return { marks, funding, nextFundingTime };
  }

  /** Live PnL is measured from the first balance this session saw: the exchange keeps no baseline. */
  async getAccount(): Promise<{ equity: number; marginUsed: number; initialEquity: number }> {
    if (this.broker) return this.broker.getAccount();
    if (config.mode === 'paper') return this.paper.getAccount();
    const info = await this.futures.getAccountInformation();
    const equity = Number(info.totalWalletBalance);
    this.liveStartEquity ??= equity;
    return { equity, marginUsed: Number(info.totalInitialMargin), initialEquity: this.liveStartEquity };
  }

  /** Empty in live mode: the exchange keeps no per-strategy journal. */
  getTrades(): TradeRecord[] {
    if (this.broker) return this.broker.getTrades();
    return config.mode === 'paper' ? this.paper.getTrades() : [];
  }

  /** `fresh: false` serves the broker's cache, for hot paths that must not hit the venue on every tick. */
  async getPositions(fresh = true): Promise<Position[]> {
    if (this.broker) {
      if (fresh) await this.broker.sync();
      return this.broker.getPositions();
    }
    if (config.mode === 'paper') return this.paper.getPositions();
    const info = await this.futures.getAccountInformation();
    return (info.positions as any[])
      .filter((p: any) => Number(p.positionAmt) !== 0)
      .map((p: any) => this.mapPosition(p));
  }

  async openFuturesPosition(params: OpenPositionParams): Promise<{ orderId: number | string; status: string }> {
    if (!(params.qty > 0)) throw new Error(`Refusing ${params.side} ${params.symbol} with non-positive quantity ${params.qty}`);
    if (this.broker) {
      const entryPrice = params.entryPrice ?? (await this.getPremiumIndex(params.symbol)).markPrice;
      return this.broker.open({ ...params, entryPrice });
    }
    if (config.mode === 'paper') return this.paper.openPosition(params);
    return this.submitLiveOrder(params);
  }

  private async submitLiveOrder(params: OpenPositionParams): Promise<{ orderId: number | string; status: string }> {
    await this.futures.setLeverage({ symbol: params.symbol, leverage: params.leverage });
    // Binance throws if margin type is already ISOLATED
    await this.futures.setMarginType({ symbol: params.symbol, marginType: 'ISOLATED' }).catch(() => undefined);

    const order = await this.futures.submitNewOrder({
      symbol: params.symbol,
      side: params.side,
      type: 'MARKET',
      quantity: roundQty(params.symbol, params.qty),
      reduceOnly: params.reduceOnly ? 'true' : 'false',
    });

    await this.placeServerProtectionOrders(params);
    return { orderId: order.orderId, status: order.status };
  }

  async cancelAll(symbol: string): Promise<void> {
    // Paper fills are instant, so there are never pending orders to cancel
    if (config.mode === 'paper') return;
    await this.futures.cancelAllOpenOrders({ symbol });
  }

  /** The local engine debounces its save by 250ms, which would drop the last state on SIGINT. */
  flushPaperEngine(): void {
    this.paperEngine?.flushSync();
  }

  async closePosition(pos: Position): Promise<void> {
    if (this.broker) return this.broker.close(pos, 'CLOSE');
    await this.openFuturesPosition({
      symbol: pos.symbol,
      side: pos.side === 'LONG' ? 'SELL' : 'BUY',
      qty: pos.qty,
      leverage: pos.leverage,
      strategy: pos.strategy,
      reduceOnly: true,
    });
    await this.cancelAll(pos.symbol);
  }

  /** Paper only: live keeps exchange-side protection orders, where netting per symbol is unresolved. */
  updateStops(symbol: string, strategy: AgentId, stopLoss: number, takeProfit: number): void {
    if (this.broker) return this.broker.updateStops(symbol, strategy, stopLoss, takeProfit);
    if (config.mode !== 'paper') throw new Error('Dynamic stop updates are paper-only');
    this.paper.updateStops(symbol, strategy, stopLoss, takeProfit);
  }

  /** Local paper only: the remote broker's positions are not scoped to this process's SYMBOLS list. */
  dropUnlistedPositions(symbols: string[]): string[] {
    if (config.mode !== 'paper' || this.broker) return [];
    return this.paper.dropUnlistedSymbols(symbols);
  }

  /** Paper only: marks to market and returns log lines for SL/TP/liquidation exits. */
  markAll(prices: Record<string, number>): string[] {
    if (this.broker) return this.broker.markAll(prices);
    return config.mode === 'paper' ? this.paper.markAll(prices) : [];
  }

  /** Creates the remote account if it is missing; a no-op for local paper and live. */
  async initVenue(): Promise<void> {
    await this.broker?.init();
  }

  /** False only for a remote venue that has never answered, when there is no account data to show. */
  hasVenueData(): boolean {
    return this.broker?.hasData() ?? true;
  }

  getVenueStatus(): VenueStatus | null {
    return this.broker?.status() ?? null;
  }

  /** Settles funding on the remote account when a boundary passed; returns log lines. */
  async settleFunding(market: FundingObservation): Promise<FundingLine[]> {
    return this.broker ? this.broker.observeFunding(market) : [];
  }

  private async placeServerProtectionOrders(params: OpenPositionParams): Promise<void> {
    const { symbol } = params;
    const exitSide = params.side === 'BUY' ? 'SELL' : 'BUY';
    const levels = [{ type: 'STOP_MARKET', price: params.stopLoss }, { type: 'TAKE_PROFIT_MARKET', price: params.takeProfit }] as const;
    for (const { type, price } of levels) {
      if (!price) continue;
      await this.futures.submitNewOrder({ symbol, side: exitSide, type, stopPrice: roundPrice(symbol, price), closePosition: 'true' });
    }
  }

  private mapPosition(p: any): Position {
    const qty = Math.abs(Number(p.positionAmt));
    const side = Number(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const entry = Number(p.entryPrice);
    const mark = Number(p.markPrice);
    const liqPrice = Number(p.liquidationPrice);
    return {
      id: `${p.symbol}_${side}`,
      symbol: p.symbol,
      side,
      strategy: 'EXECUTOR-ε',
      entry, qty, mark,
      upnl: Number(p.unRealizedProfit),
      upnlPct: entry ? ((mark - entry) / entry) * 100 : 0,
      leverage: Number(p.leverage),
      marginType: p.marginType === 'isolated' ? 'ISOLATED' : 'CROSS',
      liqDistancePct: liqPrice > 0 ? Math.abs((liqPrice - mark) / mark) * 100 : null,
      serverSl: 'server', serverTp: 'server',
    };
  }
}
