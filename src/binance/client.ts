import { USDMClient, WebsocketClient } from 'binance';
import { config } from '../config.js';
import { PaperEngine } from './paperEngine.js';
import { PaperExchangeClient } from './paperExchangeClient.js';
import { RemoteBroker, type VenueStatus } from './remoteBroker.js';
import type { FundingLine, FundingObservation } from './remoteFunding.js';
import { RemoteStore } from './remoteState.js';
import { roundPrice, roundQty, rulesFromExchangeInfo, setSymbolRules } from './symbolRules.js';
import type { AgentId, Candle, Position, TradeRecord, WsStatus } from '../types.js';
import { MarketDataService } from '../market/MarketDataService.js';
import type { MarketDataSnapshot } from '../market/MarketDataTypes.js';

const KLINE_INTERVAL = '15m';
const KLINE_LIMIT = 300;

type OpenPositionParams = {
  symbol: string; side: 'BUY' | 'SELL'; qty: number; leverage: number;
  strategy: AgentId; stopLoss?: number; takeProfit?: number; reduceOnly?: boolean; entryPrice?: number;
};

const REMOTE_STATE_FILE = 'data/remote-state.json';
const REMOTE_INITIAL_MARGIN = 1_150;

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
  private readonly marketDataV2: MarketDataService;
  private paperEngine?: PaperEngine;
  private liveStartEquity: number | null = null;

  constructor(private readonly broker: RemoteBroker | null = remoteBrokerFromConfig()) {
    this.futures = new USDMClient({ api_key: config.binance.apiKey, api_secret: config.binance.apiSecret });
    this.marketDataV2 = new MarketDataService(this.futures);
  }

  private get paper(): PaperEngine {
    return (this.paperEngine ??= new PaperEngine());
  }

  startRealtimeStream(symbols: string[], onTick: (symbol: string, price: number) => void): () => void {
    const silent = { silly: () => {}, verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} };
    this.ws = new WebsocketClient({ beautify: false }, silent as any);
    const setStatus = (s: WsStatus) => { this.wsStatus = s; };
    this.ws.on('open', () => setStatus('connected'));
    this.ws.on('reconnected', () => setStatus('connected'));
    this.ws.on('reconnecting', () => setStatus('reconnecting'));
    this.ws.on('close', () => setStatus('down'));
    this.ws.on('error', () => setStatus('down'));
    this.ws.on('message', (d: any) => {
      if (d?.e === 'trade' && d.s && Number(d.p) > 0) onTick(d.s, Number(d.p));
    });
    for (const sym of symbols) this.ws.subscribeTrades(sym, 'usdm');
    return () => { this.ws?.closeAll(); this.ws = null; this.wsStatus = 'down'; };
  }

  getWsStatus(): WsStatus {
    return this.wsStatus;
  }

  getApiWeight(): number {
    return this.futures.getRateLimitStates()['x-mbx-used-weight-1m'] ?? 0;
  }

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

  /**
   * Feature-gated native market data. It is read-only and internally TTL-cached;
   * failures in individual public endpoints leave successful cached components intact.
   */
  async getMarketDataV2(symbols: string[]): Promise<Record<string, MarketDataSnapshot>> {
    if (!config.marketDataV2.enabled) return {};
    return this.marketDataV2.snapshot(symbols);
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
    const tickers: Record<string, { price: number; changePct: number; high24h: number; low24h: number; volumeQuote: number }> = {};
    for (const t of rawTickers.filter((raw) => symSet.has(raw.symbol))) {
      tickers[t.symbol] = { price: Number(t.lastPrice), changePct: Number(t.priceChangePercent), high24h: Number(t.highPrice), low24h: Number(t.lowPrice), volumeQuote: Number(t.quoteVolume) };
    }
    return tickers;
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

  async getAccount(): Promise<{ equity: number; marginUsed: number; initialEquity: number }> {
    if (this.broker) return this.broker.getAccount();
    if (config.mode === 'paper') return this.paper.getAccount();
    const info = await this.futures.getAccountInformation();
    const equity = Number(info.totalWalletBalance);
    this.liveStartEquity ??= equity;
    return { equity, marginUsed: Number(info.totalInitialMargin), initialEquity: this.liveStartEquity };
  }

  getTrades(): TradeRecord[] {
    if (this.broker) return this.broker.getTrades();
    return config.mode === 'paper' ? this.paper.getTrades() : [];
  }

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
    await this.futures.setMarginType({ symbol: params.symbol, marginType: 'ISOLATED' }).catch(() => undefined);

    const order = await this.futures.submitNewOrder({
      symbol: params.symbol, side: params.side, type: 'MARKET',
      quantity: roundQty(params.symbol, params.qty),
      reduceOnly: params.reduceOnly ? 'true' : 'false',
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
    if (this.broker) return this.broker.close(pos, 'CLOSE');
    await this.openFuturesPosition({
      symbol: pos.symbol, side: pos.side === 'LONG' ? 'SELL' : 'BUY',
      qty: pos.qty, leverage: pos.leverage, strategy: pos.strategy, reduceOnly: true,
    });
    await this.cancelAll(pos.symbol);
  }

  updateStops(symbol: string, strategy: AgentId, stopLoss: number, takeProfit: number): void {
    if (this.broker) return this.broker.updateStops(symbol, strategy, stopLoss, takeProfit);
    if (config.mode !== 'paper') throw new Error('Dynamic stop updates are paper-only');
    this.paper.updateStops(symbol, strategy, stopLoss, takeProfit);
  }

  dropUnlistedPositions(symbols: string[]): string[] {
    if (config.mode !== 'paper' || this.broker) return [];
    return this.paper.dropUnlistedSymbols(symbols);
  }

  markAll(prices: Record<string, number>): string[] {
    if (this.broker) return this.broker.markAll(prices);
    return config.mode === 'paper' ? this.paper.markAll(prices) : [];
  }

  async initVenue(): Promise<void> {
    await this.broker?.init();
  }

  hasVenueData(): boolean {
    return this.broker?.hasData() ?? true;
  }

  getVenueStatus(): VenueStatus | null {
    return this.broker?.status() ?? null;
  }

  async settleFunding(market: FundingObservation): Promise<FundingLine[]> {
    return this.broker ? this.broker.observeFunding(market) : [];
  }

  private async placeServerProtectionOrders(params: OpenPositionParams): Promise<void> {
    const { symbol, side, qty, stopLoss, takeProfit } = params;
    const exitSide = side === 'BUY' ? 'SELL' : 'BUY';
    const levels = [{ type: 'STOP_MARKET', price: stopLoss }, { type: 'TAKE_PROFIT_MARKET', price: takeProfit }] as const;
    for (const { type, price } of levels) {
      if (!price) continue;
      await this.placeProtectionWithRetry(symbol, exitSide, type, price, qty);
    }
  }

  private async placeProtectionWithRetry(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
    price: number,
    qty: number
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.futures.submitNewOrder({ symbol, side, type, stopPrice: roundPrice(symbol, price), closePosition: 'true' });
        return;
      } catch (err: any) {
        if (attempt === 2) {
          // Emergency close: never leave a filled live position without stop-loss protection
          if (type === 'STOP_MARKET') {
            await this.futures.submitNewOrder({ symbol, side, type: 'MARKET', quantity: roundQty(symbol, qty), reduceOnly: 'true' }).catch(() => undefined);
          }
          throw new Error(`Protection order failed (${type} for ${symbol}): ${err.message}`);
        }
      }
    }
  }

  private mapPosition(p: any): Position {
    const qty = Math.abs(Number(p.positionAmt)), side = Number(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const entry = Number(p.entryPrice), mark = Number(p.markPrice), liqPrice = Number(p.liquidationPrice);
    return {
      id: `${p.symbol}_${side}`, symbol: p.symbol, side, strategy: 'EXECUTOR-ε',
      entry, qty, mark, upnl: Number(p.unRealizedProfit),
      upnlPct: entry ? ((mark - entry) / entry) * 100 : 0,
      leverage: Number(p.leverage), marginType: p.marginType === 'isolated' ? 'ISOLATED' : 'CROSS',
      liqDistancePct: liqPrice > 0 ? Math.abs((liqPrice - mark) / mark) * 100 : null,
      serverSl: 'server', serverTp: 'server',
    };
  }
}
