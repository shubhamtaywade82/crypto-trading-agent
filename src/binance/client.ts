import { USDMClient, WebsocketClient } from 'binance';
import { config } from '../config.js';
import { PaperEngine } from './paperEngine.js';
import { roundPrice, roundQty, rulesFromExchangeInfo, setSymbolRules } from './symbolRules.js';
import type { AgentId, Candle, Position } from '../types.js';

// 300 closed 15m candles cover the adaptive SuperTrend's ATR warm-up (10) + K-Means window (100) with margin
const KLINE_INTERVAL = '15m';
const KLINE_LIMIT = 300;

export class BinanceService {
  private futures: USDMClient;
  private ws: WebsocketClient | null = null;
  private paper: PaperEngine;

  constructor() {
    this.futures = new USDMClient({
      api_key: config.binance.apiKey,
      api_secret: config.binance.apiSecret,
    });
    this.paper = new PaperEngine();
  }

  startRealtimeStream(symbols: string[], onTick: (symbol: string, price: number) => void): () => void {
    const silent = { silly: () => {}, verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} };
    this.ws = new WebsocketClient({ beautify: false }, silent as any);
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
    };
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
    const tickers: Record<string, { price: number; changePct: number; high24h: number; low24h: number; volumeQuote: number }> = {};
    const marks: Record<string, number> = {};
    const funding: Record<string, number> = {};
    let nextFundingTime = 0;

    for (const t of (rawTickers as any[])) {
      if (symSet.has(t.symbol)) {
        tickers[t.symbol] = {
          price: Number(t.lastPrice),
          changePct: Number(t.priceChangePercent),
          high24h: Number(t.highPrice),
          low24h: Number(t.lowPrice),
          volumeQuote: Number(t.quoteVolume),
        };
      }
    }
    for (const m of (rawMarks as any[])) {
      if (symSet.has(m.symbol)) {
        marks[m.symbol] = Number(m.markPrice);
        funding[m.symbol] = Number(m.lastFundingRate);
        if (m.nextFundingTime) nextFundingTime = Number(m.nextFundingTime);
      }
    }
    const candles: Record<string, Candle[]> = {};
    symbols.forEach((s, i) => { candles[s] = rawKlines[i]; });
    return { tickers, funding, marks, nextFundingTime, candles };
  }


  async getAccount(): Promise<{ equity: number; marginUsed: number }> {
    if (config.mode === 'paper') return this.paper.getAccount();
    const info = await this.futures.getAccountInformation();
    return {
      equity: Number(info.totalWalletBalance),
      marginUsed: Number(info.totalInitialMargin),
    };
  }

  async getPositions(): Promise<Position[]> {
    if (config.mode === 'paper') return this.paper.getPositions();
    const info = await this.futures.getAccountInformation();
    return (info.positions as any[])
      .filter((p: any) => Number(p.positionAmt) !== 0)
      .map((p: any) => this.mapPosition(p));
  }

  async openFuturesPosition(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;
    leverage: number;
    strategy: AgentId;
    stopLoss?: number;
    takeProfit?: number;
    reduceOnly?: boolean;
    entryPrice?: number;
  }): Promise<{ orderId: number | string; status: string }> {
    if (!(params.qty > 0)) throw new Error(`Refusing ${params.side} ${params.symbol} with non-positive quantity ${params.qty}`);
    if (config.mode === 'paper') return this.paper.openPosition(params);

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

  /** Paper only: live mode keeps exchange-side protection orders (netting per symbol is unresolved). */
  updateStops(symbol: string, strategy: AgentId, stopLoss: number, takeProfit: number): void {
    if (config.mode !== 'paper') throw new Error('Dynamic stop updates are paper-only');
    this.paper.updateStops(symbol, strategy, stopLoss, takeProfit);
  }

  /** Paper only: purges saved positions for symbols that are no longer tradable; returns the dropped symbols. */
  dropUnlistedPositions(symbols: string[]): string[] {
    return config.mode === 'paper' ? this.paper.dropUnlistedSymbols(symbols) : [];
  }

  /** Paper only: marks to market and returns log lines for SL/TP/liquidation exits. */
  markAll(prices: Record<string, number>): string[] {
    return config.mode === 'paper' ? this.paper.markAll(prices) : [];
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
