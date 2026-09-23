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
const REMOTE_INITIAL_MARGIN = 1_150;

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
    return Object.fromEntries(rawTickers.filter((t) => symSet.has(t.symbol)).map((t) => [
      t.symbol, { price: Number(t.lastPrice), changePct: Number(t.priceChangePercent), high24h: Number(t.highPrice), low24h: Number(t.lowPrice), volumeQuote: Number(t.quoteVolume) },
    ]));
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

  private isRemoteActive(): boolean {
    return this.broker !== null && this.broker.hasData() && this.broker.status().state !== 'down';
  }

  /** Live PnL is measured from the first balance this session saw: the exchange keeps no baseline. */
  async getAccount(): Promise<{ equity: number; marginUsed: number; initialEquity: number }> {
    if (this.isRemoteActive()) return this.broker!.getAccount();
    if (config.mode === 'paper') return this.paper.getAccount();
    const info = await this.futures.getAccountInformation();
    const equity = Number(info.totalWalletBalance);
    this.liveStartEquity ??= equity;
    return { equity, marginUsed: Number(info.totalInitialMargin), initialEquity: this.liveStartEquity };
  }

  /** Empty in live mode: the exchange keeps no per-strategy journal. */
  getTrades(): TradeRecord[] {
    if (this.isRemoteActive()) return this.broker!.getTrades();
    return config.mode === 'paper' ? this.paper.getTrades() : [];
  }

  /** Serves remote when available; otherwise falls back to local paper engine. */
  async getPositions(fresh = true): Promise<Position[]> {
    if (this.broker) {
      if (fresh) await this.broker.sync().catch(() => undefined);
      if (this.isRemoteActive()) return this.broker.getPositions();
    }
    if (config.mode === 'paper') return this.paper.getPositions();
    const info = await this.futures.getAccountInformation();
    return (info.positions as any[])
      .filter((p: any) => Number(p.positionAmt) !== 0)
      .map((p: any) => this.mapPosition(p));
  }

  async openFuturesPosition(params: OpenPositionParams): Promise<{ orderId: number | string; status: string }> {
    if (!(params.qty > 0)) throw new Error(`Refusing ${params.side} ${params.symbol} with non-positive quantity ${params.qty}`);
    if (this.isRemoteActive()) {
      const entryPrice = params.entryPrice ?? (await this.getPremiumIndex(params.symbol)).markPrice;
      return this.broker!.open({ ...params, entryPrice });
    }
    if (config.mode === 'paper') return this.paper.openPosition(params);
    return this.submitLiveOrder(params);
  }

  private async submitLiveOrder(params: OpenPositionParams): Promise<{ orderId: number | string; status: string }> {
    await this.futures.setLeverage({ symbol: params.symbol, leverage: params.leverage });
    await this.futures.setMarginType({ symbol: params.symbol, marginType: 'ISOLATED' }).catch(() => undefined);
    const order = await this.futures.submitNewOrder({
      symbol: params.symbol, side: params.side, type: 'MARKET',
      quantity: roundQty(params.symbol, params.qty), reduceOnly: params.reduceOnly ? 'true' : 'false',
    });
    await this.placeServerProtectionOrders(params);
    return { orderId: order.orderId, status: order.status };
  }

  async cancelAll(symbol: string): Promise<void> {
    if (config.mode === 'paper') return;
    await this.futures.cancelAllOpenOrders({ symbol });
  }

  flushPaperEngine(): void {
    this.paperEngine?.flushSync();
  }

  async closePosition(pos: Position): Promise<void> {
    if (this.isRemoteActive()) return this.broker!.close(pos, 'CLOSE');
    if (config.mode === 'paper') {
      this.paper.openPosition({ symbol: pos.symbol, side: pos.side === 'LONG' ? 'SELL' : 'BUY', qty: pos.qty, leverage: pos.leverage, strategy: pos.strategy, reduceOnly: true });
      return;
    }
    await this.openFuturesPosition({ symbol: pos.symbol, side: pos.side === 'LONG' ? 'SELL' : 'BUY', qty: pos.qty, leverage: pos.leverage, strategy: pos.strategy, reduceOnly: true });
    await this.cancelAll(pos.symbol);
  }

  updateStops(symbol: string, strategy: AgentId, stopLoss: number, takeProfit: number): void {
    if (this.broker) this.broker.updateStops(symbol, strategy, stopLoss, takeProfit);
    if (config.mode === 'paper') this.paper.updateStops(symbol, strategy, stopLoss, takeProfit);
  }

  dropUnlistedPositions(symbols: string[]): string[] {
    if (config.mode !== 'paper' || this.isRemoteActive()) return [];
    return this.paper.dropUnlistedSymbols(symbols);
  }

  markAll(prices: Record<string, number>): string[] {
    if (this.isRemoteActive()) return this.broker!.markAll(prices);
    return config.mode === 'paper' ? this.paper.markAll(prices) : [];
  }

  /** Connects to remote venue and reconciles local positions when it becomes reachable. */
  async initVenue(): Promise<void> {
    if (!this.broker) return;
    await this.broker.init();
    await this.reconcilePaperToRemote();
  }

  private async reconcilePaperToRemote(): Promise<void> {
    if (!this.broker || !this.paperEngine) return;
    for (const pos of this.paper.getPositions()) {
      const held = this.broker.getPositions().find((p) => p.symbol === pos.symbol);
      if (!held) {
        await this.broker.open({
          symbol: pos.symbol, side: pos.side === 'LONG' ? 'BUY' : 'SELL', qty: pos.qty,
          leverage: pos.leverage, strategy: pos.strategy, entryPrice: pos.entry,
          stopLoss: pos.serverSl && pos.serverSl !== '—' ? Number(pos.serverSl) : undefined,
          takeProfit: pos.serverTp && pos.serverTp !== 'trail' ? Number(pos.serverTp) : undefined,
        }).catch(() => undefined);
      }
    }
    this.paper.dropUnlistedSymbols([]);
  }

  hasVenueData(): boolean {
    return this.broker?.hasData() ?? true;
  }

  getVenueStatus(): VenueStatus | null {
    return this.broker?.status() ?? null;
  }

  async settleFunding(market: FundingObservation): Promise<FundingLine[]> {
    return this.isRemoteActive() ? this.broker!.observeFunding(market) : [];
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
    const qty = Math.abs(Number(p.positionAmt)), side = Number(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const entry = Number(p.entryPrice), mark = Number(p.markPrice), liqPrice = Number(p.liquidationPrice);
    return {
      id: `${p.symbol}_${side}`, symbol: p.symbol, side, strategy: 'EXECUTOR-ε', entry, qty, mark,
      upnl: Number(p.unRealizedProfit), upnlPct: entry ? ((mark - entry) / entry) * 100 : 0, leverage: Number(p.leverage),
      marginType: p.marginType === 'isolated' ? 'ISOLATED' : 'CROSS',
      liqDistancePct: liqPrice > 0 ? Math.abs((liqPrice - mark) / mark) * 100 : null, serverSl: 'server', serverTp: 'server',
    };
  }
}
