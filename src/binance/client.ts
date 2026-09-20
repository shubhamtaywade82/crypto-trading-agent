import { USDMClient, WebsocketClient } from 'binance';
import { config } from '../config.js';
import { PaperEngine } from './paperEngine.js';
import { PaperExchangeClient, type PaperExchangePosition } from './paperExchangeClient.js';
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

export class BinanceService {
  private futures: USDMClient;
  private ws: WebsocketClient | null = null;
  private wsStatus: WsStatus = 'down';
  private paper: PaperEngine;
  /** Non-null only in PAPER mode with PAPER_EXCHANGE_URL set — routes account/positions/orders to the Rails broker instead of `paper`. */
  private remotePaper: PaperExchangeClient | null;
  private liveStartEquity: number | null = null;

  constructor() {
    this.futures = new USDMClient({
      api_key: config.binance.apiKey,
      api_secret: config.binance.apiSecret,
    });
    this.paper = new PaperEngine();
    this.remotePaper = config.paperExchange
      ? new PaperExchangeClient(config.paperExchange.url, config.paperExchange.accountId)
      : null;
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
    for (const sym of symbols) {
      this.ws.subscribeTrades(sym, 'usdm');
    }
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
    for (const entry of info.symbols) {
      if (symbols.includes(entry.symbol)) setSymbolRules(entry.symbol, rulesFromExchangeInfo(entry));
    }
  }

  async getKlines(symbol: string, interval = '15m', limit = 200): Promise<Candle[]> {
    const rawKlines = await this.futures.getKlines({
      symbol,
      interval: interval as any,
      limit,
    });
    return (rawKlines as any[]).map((k: any[]) => ({
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
  }

  async getPremiumIndex(symbol: string): Promise<{ markPrice: number; fundingRate: number }> {
    const res = await this.futures.getMarkPrice({ symbol });
    const single = Array.isArray(res) ? res[0] : res;
    return {
      markPrice: Number(single.markPrice),
      fundingRate: Number(single.lastFundingRate),
    };
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
    return {
      tickers: this.pickTickers(rawTickers as any[], symSet),
      ...this.pickMarks(rawMarks as any[], symSet),
      candles,
    };
  }

  private pickTickers(rawTickers: any[], symSet: Set<string>) {
    const tickers: Record<string, { price: number; changePct: number; high24h: number; low24h: number; volumeQuote: number }> = {};
    for (const t of rawTickers) {
      if (!symSet.has(t.symbol)) continue;
      tickers[t.symbol] = {
        price: Number(t.lastPrice),
        changePct: Number(t.priceChangePercent),
        high24h: Number(t.highPrice),
        low24h: Number(t.lowPrice),
        volumeQuote: Number(t.quoteVolume),
      };
    }
    return tickers;
  }

  private pickMarks(rawMarks: any[], symSet: Set<string>) {
    const marks: Record<string, number> = {};
    const funding: Record<string, number> = {};
    let nextFundingTime = 0;
    for (const m of rawMarks) {
      if (!symSet.has(m.symbol)) continue;
      marks[m.symbol] = Number(m.markPrice);
      funding[m.symbol] = Number(m.lastFundingRate);
      if (m.nextFundingTime) nextFundingTime = Number(m.nextFundingTime);
    }
    return { marks, funding, nextFundingTime };
  }


  async getAccount(): Promise<{ equity: number; marginUsed: number; initialEquity: number }> {
    if (config.mode === 'paper') {
      if (this.remotePaper) {
        const snapshot = await this.remotePaper.getAccount();
        return { equity: snapshot.equity, marginUsed: snapshot.lockedMargin, initialEquity: snapshot.margin };
      }
      return this.paper.getAccount();
    }
    const info = await this.futures.getAccountInformation();
    const equity = Number(info.totalWalletBalance);
    // The exchange keeps no PnL baseline, so live PnL is measured from the first balance this session saw
    this.liveStartEquity ??= equity;
    return { equity, marginUsed: Number(info.totalInitialMargin), initialEquity: this.liveStartEquity };
  }

  /**
   * Paper-engine journal; empty for live mode (no local journal) and for
   * remote-paper mode (paper_exchange's ledger isn't shaped like a
   * per-strategy trade journal — this is a known gap, not an oversight).
   */
  getTrades(): TradeRecord[] {
    return config.mode === 'paper' && !this.remotePaper ? this.paper.getTrades() : [];
  }

  async getPositions(): Promise<Position[]> {
    if (config.mode === 'paper') {
      if (this.remotePaper) return (await this.remotePaper.getPositions()).map((p) => this.mapRemotePosition(p));
      return this.paper.getPositions();
    }
    const info = await this.futures.getAccountInformation();
    return (info.positions as any[])
      .filter((p: any) => Number(p.positionAmt) !== 0)
      .map((p: any) => this.mapPosition(p));
  }

  async openFuturesPosition(params: OpenPositionParams): Promise<{ orderId: number | string; status: string }> {
    if (!(params.qty > 0)) throw new Error(`Refusing ${params.side} ${params.symbol} with non-positive quantity ${params.qty}`);
    if (config.mode === 'paper') {
      if (this.remotePaper) return this.submitRemoteOrder(params);
      return this.paper.openPosition(params);
    }
    return this.submitLiveOrder(params);
  }

  private async submitRemoteOrder(params: OpenPositionParams): Promise<{ orderId: number | string; status: string }> {
    const executionPrice = params.entryPrice ?? (await this.getPremiumIndex(params.symbol)).markPrice;
    // Issue #3: clientOrderId encodes symbol+strategy+timestamp+nonce so the
    // broker can attribute fills to a strategy even though paper_exchange's
    // positions table has no strategy column (issue #3 on the broker side
    // tracks this as a follow-up migration).
    const clientOrderId = `${params.symbol}-${params.strategy}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await this.remotePaper!.submitOrder({
      symbol: params.symbol,
      side: params.side.toLowerCase() as 'buy' | 'sell',
      quantity: params.qty,
      leverage: params.leverage,
      executionPrice,
      clientOrderId,
    });

    // Issue #1: previously SL/TP were silently dropped in remote-paper mode.
    // Now submit them as separate bounded/stop_loss orders so exits fire
    // server-side even when this agent is offline. Best-effort: a failure
    // here logs but doesn't fail the entry (the position is already open).
    if (!params.reduceOnly) {
      this.placeRemoteProtectionOrders(params, clientOrderId, executionPrice).catch((err: Error) => {
        console.error(`[paper_exchange] protection orders failed for ${params.symbol}: ${err.message}`);
      });
    }

    return { orderId: result.orderId, status: result.status.toUpperCase() };
  }

  /**
   * Submits SL (stop_loss) and TP (bounded) orders to the remote broker.
   * Naming convention: the SL/TP orders' clientOrderId derives from the
   * entry order's id so the agent can correlate them later — `<entry>-SL`
   * and `<entry>-TP`. The broker's OrderValidator accepts both kinds.
   */
  private async placeRemoteProtectionOrders(
    params: OpenPositionParams,
    entryClientOrderId: string,
    executionPrice: number,
  ): Promise<void> {
    const exitSide = params.side === 'BUY' ? 'sell' : 'buy';
    if (params.stopLoss) {
      await this.remotePaper!.submitProtectionOrder({
        symbol: params.symbol,
        side: exitSide,
        quantity: params.qty,
        triggerPrice: params.stopLoss,
        executionPrice,
        clientOrderId: `${entryClientOrderId}-SL`,
      });
    }
    if (params.takeProfit) {
      await this.remotePaper!.submitProtectionOrder({
        symbol: params.symbol,
        side: exitSide,
        quantity: params.qty,
        price: params.takeProfit,
        executionPrice,
        clientOrderId: `${entryClientOrderId}-TP`,
      });
    }
  }

  private async submitLiveOrder(params: OpenPositionParams): Promise<{ orderId: number | string; status: string }> {
    await this.futures.setLeverage({ symbol: params.symbol, leverage: params.leverage });
    try {
      await this.futures.setMarginType({ symbol: params.symbol, marginType: 'ISOLATED' });
    } catch {
      // Binance throws if margin type is already ISOLATED
    }

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

  /**
   * Issue #5: synchronous flush of the local PaperEngine's debounced state.
   * No-op in live or remote-paper mode. Called from Orchestrator.flushOnShutdown()
   * on SIGINT/SIGTERM so the 250ms debounce timer can't drop the last state.
   */
  flushPaperEngine(): void {
    if (config.mode === 'paper' && !this.remotePaper) {
      this.paper.flushSync();
    }
  }

  async closePosition(pos: Position): Promise<void> {
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

  /**
   * Paper only: live mode keeps exchange-side protection orders (netting per
   * symbol is unresolved). Remote-paper mode doesn't support this yet —
   * paper_exchange's positions carry no per-strategy attribution (same gap
   * live Binance has), so a dynamic per-strategy stop can't be matched to
   * one of its positions. Orchestrator disables AdaptiveSuperTrendAgent
   * (the only caller) whenever a remote broker is configured, so this
   * should never actually be reached in that mode — the guard is here so a
   * future caller fails loudly instead of silently doing nothing.
   */
  updateStops(symbol: string, strategy: AgentId, stopLoss: number, takeProfit: number): void {
    if (config.mode !== 'paper') throw new Error('Dynamic stop updates are paper-only');
    if (this.remotePaper) throw new Error('Dynamic stop updates are not supported against a remote paper_exchange broker');
    this.paper.updateStops(symbol, strategy, stopLoss, takeProfit);
  }

  /** Paper only: purges saved positions for symbols that are no longer tradable; returns the dropped symbols. Not meaningful for a remote broker, which isn't scoped to this process's SYMBOLS list. */
  dropUnlistedPositions(symbols: string[]): string[] {
    if (config.mode !== 'paper' || this.remotePaper) return [];
    return this.paper.dropUnlistedSymbols(symbols);
  }

  /**
   * Paper only: marks to market and returns log lines for SL/TP/liquidation
   * exits. Against a remote broker, exit detection happens server-side and
   * asynchronously (Risk::LiquidationEngine reacts to the pushed prices, off
   * this call), so there is nothing to report inline — this pushes the
   * prices in the background (fire-and-forget: a failed push logs and is
   * retried on the next call, never blocks or throws into this synchronous
   * call site) and always returns immediately.
   */
  markAll(prices: Record<string, number>): string[] {
    if (config.mode !== 'paper') return [];
    if (this.remotePaper) {
      this.remotePaper
        .pushMarkPrices(prices)
        .catch((err: Error) => console.error(`[paper_exchange] mark price push failed: ${err.message}`));
      return [];
    }
    return this.paper.markAll(prices);
  }

  /**
   * Reports a perpetual futures funding settlement to the remote broker
   * (no-op for local paper and live modes). Idempotent when `fundingTime`
   * is supplied — the broker dedupes on (paper_position_id, funding_time).
   * Orchestrator calls this once per actual Binance funding boundary.
   */
  async pushFundingEvent(
    symbol: string,
    fundingRate: number,
    markPrice?: number,
    fundingTime?: string | number,
  ): Promise<void> {
    if (config.mode !== 'paper' || !this.remotePaper) return;
    await this.remotePaper.pushFundingEvent(symbol, fundingRate, markPrice, fundingTime);
  }

  private mapRemotePosition(p: PaperExchangePosition): Position {
    const side: Position['side'] = p.side === 'long' ? 'LONG' : 'SHORT';
    const liq = p.liquidationPrice;
    return {
      id: `${p.symbol}_${side}`,
      symbol: p.symbol,
      side,
      // paper_exchange positions carry no per-strategy attribution — same
      // limitation as live Binance positions (see mapPosition below).
      strategy: 'EXECUTOR-ε',
      entry: p.averagePrice,
      qty: p.netQuantity,
      mark: p.currentPrice,
      upnl: p.unrealizedPnl,
      upnlPct: p.averagePrice ? ((p.currentPrice - p.averagePrice) / p.averagePrice) * 100 * (side === 'LONG' ? 1 : -1) : 0,
      leverage: p.leverage,
      marginType: p.marginType === 'isolated' ? 'ISOLATED' : 'CROSS',
      liqDistancePct: liq !== null && liq > 0 ? Math.abs((liq - p.currentPrice) / p.currentPrice) * 100 : null,
      serverSl: 'server',
      serverTp: 'server',
    };
  }

  private async placeServerProtectionOrders(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    stopLoss?: number;
    takeProfit?: number;
  }): Promise<void> {
    const exitSide = params.side === 'BUY' ? 'SELL' : 'BUY';
    if (params.stopLoss) {
      await this.futures.submitNewOrder({
        symbol: params.symbol,
        side: exitSide,
        type: 'STOP_MARKET',
        stopPrice: roundPrice(params.symbol, params.stopLoss),
        closePosition: 'true',
      });
    }
    if (params.takeProfit) {
      await this.futures.submitNewOrder({
        symbol: params.symbol,
        side: exitSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: roundPrice(params.symbol, params.takeProfit),
        closePosition: 'true',
      });
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
      entry,
      qty,
      mark,
      upnl: Number(p.unRealizedProfit),
      upnlPct: entry ? ((mark - entry) / entry) * 100 : 0,
      leverage: Number(p.leverage),
      marginType: p.marginType === 'isolated' ? 'ISOLATED' : 'CROSS',
      liqDistancePct: liqPrice > 0 ? Math.abs((liqPrice - mark) / mark) * 100 : null,
      serverSl: 'server',
      serverTp: 'server',
    };
  }
}
