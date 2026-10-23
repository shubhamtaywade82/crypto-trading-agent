import path from 'node:path';
import { USDMClient, WebsocketClient, type FuturesPositionTrade, type OrderResult } from 'binance';
import { config } from '../config.js';
import { PaperEngine } from './paperEngine.js';
import { PaperExchangeClient, VenueUnavailableError } from './paperExchangeClient.js';
import { RemoteBroker, type VenueStatus } from './remoteBroker.js';
import type { FundingLine, FundingObservation } from './remoteFunding.js';
import { RemoteStore } from './remoteState.js';
import { roundPrice, roundQty, rulesFromExchangeInfo, setSymbolRules } from './symbolRules.js';
import type { AgentId, Candle, Position, Side, TradeRecord, WsStatus } from '../types.js';
import { MarketDataService } from '../market/MarketDataService.js';
import type { MarketDataSnapshot } from '../market/MarketDataTypes.js';
import { LiveBook, LiveStateStore, type LiveManagerMode, type LiveOrderPort } from './liveBook.js';
import { LiveEntryTracker, LIVE_ENTRY_POLL_MS, liveEntryClientOrderId, orderSideOf, venueRejected, type LiveEntryPort } from './liveEntry.js';
import {
  ENTRY_ORDER_PREFIX, isAlreadyIsolated, isEntryOrder, isVenueRejection, parseOrderTradeUpdate, planStartupReconciliation,
  protectionClientOrderId, protectionOf, type OpenOrderView, type OrderUpdateView, type PositionProtection, type VenuePositionView,
} from './liveProtection.js';
import { LiveJournal, LiveOwners, type FillView, type FundingView } from './liveJournal.js';
import { roundStopPrice } from './symbolRules.js';
import { REPLAY_MAINTENANCE_TIERS, type MaintenanceTier } from '../risk/liquidation.js';

const KLINE_INTERVAL = '15m';
const KLINE_LIMIT = 300;
/** A journal sync older than this stops counting: the daily-loss and streak governors then refuse entries. */
const JOURNAL_MAX_AGE_MS = 3 * 60_000;
const JOURNAL_SYNC_MS = 60_000;
const GUARD_REFRESH_MS = 60_000;
const BRACKET_MAX_AGE_MS = 60 * 60_000;
const PROTECTION_ATTEMPTS = 3;
const NO_LEVEL = '—';
/** Binance's answer to a client order id it already holds: the earlier request did land. */
const DUPLICATE_CLIENT_ORDER_ID = -4116;
const UNPROTECTED_REASON = 'UNPROTECTED';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const errorCode = (err: unknown): unknown => (err as { code?: unknown })?.code;

/** The venue's open order, reduced to the fields this code reads. */
const toOpenOrderView = (o: OrderResult): OpenOrderView => ({
  symbol: o.symbol, orderId: o.orderId, clientOrderId: o.clientOrderId, type: o.type, side: o.side as 'BUY' | 'SELL',
  reduceOnly: o.reduceOnly, closePosition: o.closePosition, stopPrice: Number(o.stopPrice), status: o.status,
});

const toFillView = (t: FuturesPositionTrade): FillView => ({
  id: t.id, symbol: t.symbol, orderId: t.orderId, side: t.side as 'BUY' | 'SELL', price: Number(t.price), qty: Number(t.qty),
  realizedPnl: Number(t.realizedPnl), commission: Number(t.commission), commissionAsset: t.commissionAsset, time: t.time,
});

const silentLogger = { silly: () => {}, verbose: () => {}, info: () => {}, warning: () => {}, error: () => {} };

type OpenPositionParams = {
  symbol: string; side: 'BUY' | 'SELL'; qty: number; leverage: number;
  strategy: AgentId; stopLoss?: number; takeProfit?: number; reduceOnly?: boolean; entryPrice?: number;
  decisionId?: string;
};

const REMOTE_STATE_FILE = 'data/remote-state.json';
const REMOTE_INITIAL_MARGIN = 1_150;

function remoteBrokerFromConfig(): RemoteBroker | null {
  const remote = config.paperExchange;
  if (config.mode !== 'paper' || !remote) return null;
  return new RemoteBroker({
    api: new PaperExchangeClient(remote.url, remote.accountId, { apiKey: remote.apiKey }),
    store: new RemoteStore(REMOTE_STATE_FILE, remote.accountId),
    accountId: remote.accountId,
    symbols: config.symbols,
    initialMargin: REMOTE_INITIAL_MARGIN,
    venueName: 'paper_exchange',
  });
}

// Live Binance is not a broker: BinanceService talks to USD-M directly. Only the paper exchange goes through a RemoteBroker.
function brokerFromConfig(): RemoteBroker | null {
  return remoteBrokerFromConfig();
}

export class BinanceService {
  private futures: USDMClient;
  private ws: WebsocketClient | null = null;
  private wsStatus: WsStatus = 'down';
  private readonly marketDataV2: MarketDataService;
  private paperEngine?: PaperEngine;
  private liveStartEquity: number | null = null;
  private readonly lastTickAt = new Map<string, number>();
  private readonly symbolStatus = new Map<string, string>();
  private markAt = 0;
  private liveBook: LiveBook | null = null;
  private entries: LiveEntryTracker | null = null;
  private entryLog: (message: string, level: 'info' | 'warn' | 'error') => void = () => undefined;
  private journalStore: LiveJournal | null = null;
  private ownerStore: LiveOwners | null = null;
  private brackets: { at: number; tiers: Map<string, MaintenanceTier[]> } = { at: 0, tiers: new Map() };
  private journalSyncedAt = 0;
  private guardRefreshedAt = 0;
  private startupReconciled = false;
  /** Entries refused per symbol: an unprotected position, or a symbol whose protection is being repaired. */
  private readonly entryBlocks = new Map<string, string>();
  /** Hedge mode blocks entries on every symbol; the bot manages one-way positions only. */
  private hedgeBlock: string | null = null;
  private userStream: WebsocketClient | null = null;

  /**
   * `futures` is injectable so tests can exercise the venue logic without a network; `stateDir` holds the live journal
   * and the owner record (tests point it at a temp dir).
   */
  constructor(
    private readonly broker: RemoteBroker | null = brokerFromConfig(),
    futures?: USDMClient,
    private readonly stateDir = 'data',
  ) {
    this.futures = futures ?? new USDMClient({ api_key: config.binance.apiKey, api_secret: config.binance.apiSecret }, undefined, config.binance.testnet);
    this.marketDataV2 = new MarketDataService(this.futures);
  }

  private get paper(): PaperEngine {
    return (this.paperEngine ??= new PaperEngine());
  }

  private get journal(): LiveJournal {
    return (this.journalStore ??= new LiveJournal(path.join(this.stateDir, 'live-journal.json')));
  }

  private get owners(): LiveOwners {
    return (this.ownerStore ??= new LiveOwners(path.join(this.stateDir, 'live-owners.json')));
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
      if (d?.e === 'trade' && d.s && Number(d.p) > 0) {
        this.lastTickAt.set(d.s, Date.now());
        onTick(d.s, Number(d.p));
      }
    });
    for (const sym of symbols) this.ws.subscribeTrades(sym, 'usdm');
    return () => { this.ws?.closeAll(); this.ws = null; this.wsStatus = 'down'; };
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
    for (const entry of info.symbols.filter((e) => symbols.includes(e.symbol))) {
      setSymbolRules(entry.symbol, rulesFromExchangeInfo(entry));
      this.symbolStatus.set(entry.symbol, String((entry as { status?: string }).status ?? 'TRADING'));
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

  /**
   * A configured broker is the only venue. Without data or while it is down this throws: falling back would trade
   * another venue (live: real Binance orders sized from Binance equity) or a local paper book the broker never sees.
   */
  private usableBroker(): RemoteBroker | null {
    if (!this.broker) return null;
    if (this.isVenueUp()) return this.broker;
    const status = this.broker.status();
    throw new VenueUnavailableError(`${status.name} unavailable (${status.lastError ?? 'no account data yet'})`);
  }

  /** False only while a configured broker has no data or is down. */
  isVenueUp(): boolean {
    return this.broker === null || (this.broker.hasData() && this.broker.status().state !== 'down');
  }

  /** Re-syncs a configured broker so an outage can recover; outages only flip its status. */
  async syncVenue(): Promise<void> {
    await this.broker?.sync();
  }

  /** Live PnL is measured from the first balance this session saw: the exchange keeps no baseline. */
  async getAccount(): Promise<{ equity: number; marginUsed: number; initialEquity: number; fxRate?: number }> {
    const broker = this.usableBroker();
    if (broker) return broker.getAccount();
    if (config.mode === 'paper') return this.paper.getAccount();
    const info = await this.futures.getAccountInformation();
    // Margin balance includes unrealized PnL; the wallet balance would hide open losses from the drawdown guard
    const equity = Number(info.totalMarginBalance);
    this.liveStartEquity ??= equity;
    return { equity, marginUsed: Number(info.totalInitialMargin), initialEquity: this.liveStartEquity };
  }

  /** Closed trades: the broker's journal, the paper book, or in live mode the bot's own journal of Binance fills. */
  getTrades(): TradeRecord[] {
    if (this.broker) return this.broker.getTrades();
    if (config.mode === 'paper') return this.paper.getTrades();
    return config.mode === 'live' ? this.journal.trades() : [];
  }

  /** False in live mode while the journal has not synced recently: the loss governors then have no data and entries wait. */
  journalReady(): boolean {
    if (this.broker || config.mode !== 'live') return true;
    return this.journal.isFresh(JOURNAL_MAX_AGE_MS);
  }

  async getPositions(fresh = true): Promise<Position[]> {
    if (this.broker) {
      if (fresh) await this.broker.sync();
      return this.usableBroker()!.getPositions();
    }
    if (config.mode === 'paper') return this.paper.getPositions();
    const info = await this.futures.getAccountInformation();
    const open = (info.positions as any[]).filter((p: any) => Number(p.positionAmt) !== 0);
    // A position's stop and target are its resting closePosition orders: the venue is the only place they live
    const orders = (await Promise.all(open.map((p: any) => this.futures.getAllOpenOrders({ symbol: p.symbol })))).flat().map(toOpenOrderView);
    return open.map((p: any) => this.mapPosition(p, protectionOf(orders, p.symbol, Number(p.positionAmt))));
  }

  /**
   * Maintenance tiers per configured symbol for the liquidation check. Live: the venue's brackets, empty until they load and
   * once they go stale, so an unreachable venue never leaves old tiers in force. Paper and remote paper have no brackets to
   * read, so they use the replay tiers (a flat 1% maintenance ratio).
   */
  maintenanceTiers(): Record<string, readonly MaintenanceTier[]> {
    if (config.mode !== 'live' || this.broker) return Object.fromEntries(config.symbols.map((symbol) => [symbol, REPLAY_MAINTENANCE_TIERS]));
    if (Date.now() - this.brackets.at >= BRACKET_MAX_AGE_MS) return {};
    return Object.fromEntries(this.brackets.tiers);
  }

  /** Why new entries are refused right now, or undefined. Live Binance only: the other venues have no such guards. */
  entryBlockReason(symbol: string): string | undefined {
    if (config.mode !== 'live' || this.broker || config.alertOnly) return undefined;
    if (this.hedgeBlock) return this.hedgeBlock;
    if (!this.startupReconciled) return 'startup reconciliation has not completed; entries wait for the venue state';
    if (!this.journalReady()) return 'the trade journal has not synced from Binance fills recently; the loss governors have no current data';
    return this.entryBlocks.get(symbol);
  }

  /** True while a live entry on `symbol` is still being followed: the tracker owns that symbol's protective legs until it resolves. */
  entryInFlight(symbol: string): boolean {
    return this.entries?.holds(symbol) ?? false;
  }

  async openFuturesPosition(params: OpenPositionParams): Promise<{ orderId: number | string; status: string }> {
    if (config.alertOnly) throw new Error(`Refusing order in ALERT_ONLY mode: ${params.side} ${params.symbol}`);
    if (!(params.qty > 0)) throw new Error(`Refusing ${params.side} ${params.symbol} with non-positive quantity ${params.qty}`);
    if (config.mode === 'live' && !params.reduceOnly && params.stopLoss === undefined) {
      throw new Error(`Refusing live ${params.side} ${params.symbol}: an entry must carry a stop-loss`);
    }
    const broker = this.usableBroker();
    if (broker) {
      const entryPrice = params.entryPrice ?? (await this.getPremiumIndex(params.symbol)).markPrice;
      return broker.open({ ...params, entryPrice });
    }
    if (config.mode === 'paper') return this.paper.openPosition(params);
    return this.submitLiveOrder(params);
  }

  private async submitLiveOrder(params: OpenPositionParams): Promise<{ orderId: number | string; status: string }> {
    if (!params.reduceOnly) return this.submitLiveEntry(params);
    await this.futures.setLeverage({ symbol: params.symbol, leverage: params.leverage });
    await this.ensureIsolated(params.symbol);
    const order = await this.futures.submitNewOrder({
      symbol: params.symbol, side: params.side, type: 'MARKET',
      quantity: roundQty(params.symbol, params.qty),
      reduceOnly: 'true',
    });
    return { orderId: order.orderId, status: order.status };
  }

  /**
   * A live entry rests as a GTC limit at the signal price and is cancelled after ENTRY_ORDER_TTL_MS. Nothing here assumes the
   * order filled: the entry tracker places protection once the venue shows a position, and resolves the entry.
   */
  private async submitLiveEntry(params: OpenPositionParams): Promise<{ orderId: number | string; status: string }> {
    if (params.stopLoss === undefined) throw new Error(`Refusing live ${params.side} ${params.symbol}: an entry must carry a stop-loss`);
    const block = this.entryBlockReason(params.symbol);
    if (block) throw new Error(`Refusing live ${params.side} ${params.symbol}: ${block}`);
    const tracker = this.entryTracker();
    tracker.reserve(params.symbol);
    try {
      await this.futures.setLeverage({ symbol: params.symbol, leverage: params.leverage });
      await this.ensureIsolated(params.symbol);
      const limitPrice = roundPrice(params.symbol, params.entryPrice ?? (await this.getPremiumIndex(params.symbol)).markPrice);
      const quantity = roundQty(params.symbol, params.qty);
      const clientOrderId = liveEntryClientOrderId(Date.now());
      const job = {
        symbol: params.symbol, side: params.side === 'BUY' ? 'LONG' as const : 'SHORT' as const, clientOrderId,
        strategy: params.strategy, stopLoss: params.stopLoss, takeProfit: params.takeProfit ?? null,
        ...(params.decisionId === undefined ? {} : { decisionId: params.decisionId }),
        submittedAt: Date.now(),
      };
      // The entry claims the symbol now, so a fill that arrives before the position is seen still resolves to this strategy
      this.owners.record({ symbol: job.symbol, side: job.side, strategy: job.strategy, submittedAt: job.submittedAt, clientOrderId });
      let order: { orderId: number; status: string };
      try {
        order = await this.futures.submitNewOrder({
          symbol: params.symbol, side: params.side, type: 'LIMIT', timeInForce: 'GTC',
          price: limitPrice, quantity, reduceOnly: 'false',
          newClientOrderId: clientOrderId, newOrderRespType: 'RESULT',
        });
      } catch (err) {
        // A refused order never reached the book. Anything else (timeout, dropped connection) may have, so it is tracked:
        // the tracker finds the order by its client id, or sees it is unknown to the venue and resolves.
        if (!venueRejected(err)) {
          tracker.track(job);
          this.entryLog(`${params.symbol} entry ${clientOrderId}: no answer to the submit; tracking it until the venue says what happened`, 'warn');
        }
        throw err;
      }
      tracker.track(job);
      this.entryLog(`${params.symbol} ${params.side} LIMIT ${quantity} @ ${limitPrice} submitted (clientOrderId ${clientOrderId}, TTL ${config.entryOrderTtlMs} ms)`, 'info');
      return { orderId: order.orderId, status: order.status };
    } catch (err) {
      tracker.release(params.symbol);
      throw err;
    }
  }

  /** Where live entry progress is reported (submitted, protected, cancelled, unresolved); the orchestrator sets it to its log. */
  setEntryLog(log: (message: string, level: 'info' | 'warn' | 'error') => void): void {
    this.entryLog = log;
  }

  private entryTracker(): LiveEntryTracker {
    return (this.entries ??= new LiveEntryTracker(this.liveEntryPort(), {
      ttlMs: config.entryOrderTtlMs,
      pollMs: LIVE_ENTRY_POLL_MS,
      log: (message, level) => this.entryLog(message, level),
    }));
  }

  private liveEntryPort(): LiveEntryPort {
    const futures = this.futures;
    return {
      orderState: async (symbol, clientOrderId) => {
        try {
          const order = await futures.getOrder({ symbol, origClientOrderId: clientOrderId });
          return { status: order.status, executedQty: Number(order.executedQty) };
        } catch (err) {
          // -2013: the venue has no such order, so the submit never reached it and nothing can fill
          if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === -2013) return { status: 'UNKNOWN_ORDER', executedQty: 0 };
          throw err;
        }
      },
      cancelOrder: async (symbol, clientOrderId) => { await futures.cancelOrder({ symbol, origClientOrderId: clientOrderId }); },
      positionQty: async (symbol) => {
        const row = (await futures.getPositionsV3()).find((p) => p.symbol === symbol && p.positionSide === 'BOTH');
        return row ? Math.abs(Number(row.positionAmt)) : 0;
      },
      placeLegs: (job, qty) => this.placeServerProtectionOrders({
        symbol: job.symbol, side: orderSideOf(job.side), qty, stopLoss: job.stopLoss, takeProfit: job.takeProfit ?? undefined,
      }),
      cancelLegs: async (symbol, legs) => {
        // A leg that already triggered closed the position and is no longer open: nothing to cancel, and not an error
        const open = new Set((await futures.getAllOpenOrders({ symbol })).map((o) => o.orderId));
        for (const orderId of [legs.stopOrderId, legs.tpOrderId]) {
          if (orderId !== undefined && open.has(orderId)) await futures.cancelOrder({ symbol, orderId });
        }
      },
      cancelAllOpen: async (symbol) => { await futures.cancelAllOpenOrders({ symbol }); },
      flatten: async (symbol, side, qty) => {
        await futures.submitNewOrder({ symbol, side: side === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: roundQty(symbol, qty), reduceOnly: 'true' });
      },
      recordEntry: (entry) => this.liveBook?.recordEntry(entry),
    };
  }

  /** Live position manager: builds the exchange adapter and the book that reconciles positions with their recorded entries. */
  createLiveBook(mode: LiveManagerMode, log: (message: string, level: 'info' | 'warn' | 'error') => void): LiveBook {
    this.liveBook = new LiveBook(this.livePort(), new LiveStateStore(), { mode, log });
    return this.liveBook;
  }

  private livePort(): LiveOrderPort {
    const futures = this.futures;
    return {
      fetchPositions: async () => {
        // getPositionsV3 has marks and liquidation prices; leverage and margin mode only exist on the account's positions
        const [risk, account] = await Promise.all([futures.getPositionsV3(), futures.getAccountInformation()]);
        const setup = new Map(account.positions.filter((p) => p.positionSide === 'BOTH').map((p) => [p.symbol, p]));
        return risk
          .filter((p) => p.positionSide === 'BOTH' && Number(p.positionAmt) !== 0) // one-way mode only
          .map((p) => ({
            symbol: p.symbol, positionAmt: Number(p.positionAmt), entryPrice: Number(p.entryPrice), markPrice: Number(p.markPrice),
            unrealizedProfit: Number(p.unRealizedProfit), liquidationPrice: Number(p.liquidationPrice),
            leverage: Number(setup.get(p.symbol)?.leverage ?? 1), isolated: setup.get(p.symbol)?.isolated ?? true,
          }));
      },
      openOrders: async (symbol) => (await futures.getAllOpenOrders({ symbol })).map((o) => ({
        orderId: o.orderId, type: o.type, side: o.side as 'BUY' | 'SELL', stopPrice: Number(o.stopPrice), closePosition: Boolean(o.closePosition),
      })),
      placeConditional: async ({ symbol, side, type, stopPrice }) => {
        // A stop rounds toward the market, so it never lands looser than the stop the risk gate sized
        const tick = type === 'STOP_MARKET' ? roundStopPrice(symbol, stopPrice, side) : roundPrice(symbol, stopPrice);
        const res = await futures.submitNewOrder({ symbol, side, type, stopPrice: tick, closePosition: 'true' });
        return { orderId: res.orderId };
      },
      cancel: async (symbol, orderId) => { await futures.cancelOrder({ symbol, orderId }); },
      marketReduce: async ({ symbol, side, quantity, clientOrderId }) => {
        // RESULT, not the default ACK, so the executed quantity of a partial fill is known
        const res = await futures.submitNewOrder({ symbol, side, type: 'MARKET', quantity, reduceOnly: 'true', newClientOrderId: clientOrderId, newOrderRespType: 'RESULT' });
        return { status: res.status, executedQty: Number(res.executedQty) };
      },
    };
  }

  /** Cancels resting Binance orders on one symbol; false when this venue has none to cancel (paper, alert-only, broker market orders). */
  async cancelAll(symbol: string): Promise<boolean> {
    if (config.alertOnly || config.mode === 'paper' || this.broker) return false;
    await this.futures.cancelAllOpenOrders({ symbol });
    return true;
  }

  /** Operator cancel-all: every symbol with a resting order on the account, protection included. Returns how many symbols were cleared. */
  async cancelAllResting(): Promise<number> {
    if (config.alertOnly || config.mode === 'paper' || this.broker) return 0;
    const symbols = [...new Set((await this.futures.getAllOpenOrders()).map((o) => o.symbol))];
    for (const symbol of symbols) await this.futures.cancelAllOpenOrders({ symbol });
    return symbols.length;
  }

  /** Cancels the bot's own resting entries and leaves protection alone: the kill-switch halts new risk, not the stops on it. */
  async cancelEntryOrders(): Promise<number> {
    if (config.alertOnly || config.mode !== 'live' || this.broker) return 0;
    const entries = (await this.futures.getAllOpenOrders()).map(toOpenOrderView).filter(isEntryOrder);
    let cancelled = 0;
    for (const order of entries) {
      try {
        await this.futures.cancelOrder({ symbol: order.symbol, orderId: order.orderId });
        cancelled += 1;
      } catch (err) {
        if (errorCode(err) !== -2011) throw err; // -2011: already gone, which is the outcome we wanted
      }
    }
    return cancelled;
  }

  /** The margin type is set to isolated before an entry. Only "already isolated" is ignored: any other refusal would leave the order in cross margin. */
  private async ensureIsolated(symbol: string): Promise<void> {
    try {
      await this.futures.setMarginType({ symbol, marginType: 'ISOLATED' });
    } catch (err) {
      if (!isAlreadyIsolated(err)) throw err;
    }
  }

  /**
   * Live-mode housekeeping, run each cycle: the journal sync, the venue's leverage brackets, the position mode and the
   * startup cleanup. Each step throws when the venue fails, and the blocks it leaves in place hold until it succeeds.
   */
  async refreshLiveState(symbols: readonly string[], now = Date.now()): Promise<void> {
    if (config.mode !== 'live' || config.alertOnly || this.broker) return;
    this.startUserStream();
    if (now - this.journalSyncedAt >= JOURNAL_SYNC_MS) {
      await this.syncJournal(symbols);
      this.journalSyncedAt = now;
    }
    await this.refreshBrackets(symbols, now);
    if (!this.startupReconciled || now - this.guardRefreshedAt >= GUARD_REFRESH_MS) {
      await this.reconcileLive();
      this.guardRefreshedAt = now;
    }
  }

  private async syncJournal(symbols: readonly string[]): Promise<void> {
    const source = {
      accountTrades: async (symbol: string, fromId: number | undefined, limit: number): Promise<FillView[]> =>
        (await this.futures.getAccountTrades({ symbol, fromId, limit })).map(toFillView),
      fundingFees: async (startTime: number, limit: number): Promise<FundingView[]> =>
        (await this.futures.getIncomeHistory({ incomeType: 'FUNDING_FEE', startTime, limit }))
          .map((i) => ({ symbol: i.symbol ?? '', amount: Number(i.income), time: i.time })),
    };
    const result = await this.journal.sync(source, symbols, (symbol, at) => this.owners.ownerAt(symbol, at));
    if (result.unpricedFees > 0) this.entryLog(`journal: ${result.unpricedFees.toFixed(4)} in non-USDT fees is not in the trade PnL`, 'warn');
  }

  private async refreshBrackets(symbols: readonly string[], now: number): Promise<void> {
    const fresh = now - this.brackets.at < BRACKET_MAX_AGE_MS && symbols.every((s) => this.brackets.tiers.has(s));
    if (fresh) return;
    const tiers = new Map<string, MaintenanceTier[]>();
    for (const symbol of symbols) {
      const row = (await this.futures.getNotionalAndLeverageBrackets({ symbol })).find((r) => r.symbol === symbol);
      if (!row) continue;
      tiers.set(symbol, row.brackets
        .map((b) => ({ notionalFloor: b.notionalFloor, notionalCap: b.notionalCap, maintMarginRatio: b.maintMarginRatio, cumMaintenance: b.cum, maxLeverage: b.initialLeverage }))
        .sort((a, b) => a.notionalFloor - b.notionalFloor));
    }
    this.brackets = { at: now, tiers };
  }

  /**
   * Reads the venue's position mode, open orders and positions. Hedge mode blocks entries on every symbol. At startup the
   * bot's own resting entries and orphaned protection are cancelled, because nothing tracks them any more. A position
   * with no stop resting at the venue blocks entries on its symbol until one exists.
   */
  private async reconcileLive(): Promise<void> {
    const mode = await this.futures.getCurrentPositionMode();
    this.hedgeBlock = mode.dualSidePosition
      ? 'hedge mode is on at Binance; set the account to One-way mode (the bot manages one-way positions only)'
      : null;
    const orders = (await this.futures.getAllOpenOrders()).map(toOpenOrderView);
    const positions: VenuePositionView[] = (await this.futures.getPositionsV3())
      .filter((p) => p.positionSide === 'BOTH')
      .map((p) => ({ symbol: p.symbol, amount: Number(p.positionAmt) }));
    const plan = planStartupReconciliation(orders, positions);
    if (!this.startupReconciled) {
      for (const order of plan.cancel) {
        const kind = isEntryOrder(order) ? 'resting entry' : 'orphaned protective order';
        try {
          await this.futures.cancelOrder({ symbol: order.symbol, orderId: order.orderId });
          this.entryLog(`startup: cancelled ${kind} ${order.clientOrderId} on ${order.symbol}`, 'warn');
        } catch (err) {
          if (errorCode(err) !== -2011) throw err;
        }
      }
      if (plan.unrecognised.length > 0) this.entryLog(`startup: ${plan.unrecognised.length} resting order(s) the bot did not place were left alone`, 'warn');
      this.startupReconciled = true;
    }
    for (const [symbol, reason] of [...this.entryBlocks]) {
      if (reason.startsWith(UNPROTECTED_REASON) && !plan.unprotected.includes(symbol)) this.entryBlocks.delete(symbol);
    }
    for (const symbol of plan.unprotected) {
      // A position the tracker is still protecting is not unprotected, it is mid-entry
      if (this.entries?.holds(symbol)) continue;
      this.entryBlocks.set(symbol, `${UNPROTECTED_REASON}: a position on ${symbol} has no stop resting at the venue; place a stop or close it before new entries`);
      this.entryLog(`${symbol} UNPROTECTED: a position has no stop resting at the venue; entries on it are blocked`, 'error');
    }
  }

  /**
   * Entry fills arrive on the user data stream. The tracker is woken on each one, so protection follows a fill within
   * milliseconds instead of at the next one-second poll.
   */
  private startUserStream(): void {
    if (this.userStream || config.alertOnly) return;
    const ws = new WebsocketClient({ beautify: false }, silentLogger as any);
    ws.on('message', (data: unknown) => {
      const update: OrderUpdateView | null = parseOrderTradeUpdate(data);
      if (update && update.clientOrderId.startsWith(ENTRY_ORDER_PREFIX)) this.entries?.wake();
    });
    ws.on('error', (err: unknown) => this.entryLog(`user data stream: ${errorText(err)}`, 'warn'));
    this.userStream = ws;
    ws.subscribeUsdFuturesUserDataStream(config.binance.testnet).catch((err: unknown) => {
      this.userStream = null;
      this.entryLog(`user data stream did not start: ${errorText(err)}; entries fall back to polling`, 'warn');
    });
  }

  flushPaperEngine(): void {
    this.paperEngine?.flushSync();
  }

  async closePosition(pos: Position): Promise<void> {
    if (config.alertOnly) return;
    const broker = this.usableBroker();
    if (broker) return broker.close(pos, 'CLOSE');
    if (config.mode === 'paper') {
      this.paper.openPosition({
        symbol: pos.symbol,
        side: pos.side === 'LONG' ? 'SELL' : 'BUY',
        qty: pos.qty,
        leverage: pos.leverage,
        strategy: pos.strategy,
        reduceOnly: true,
      });
      return;
    }
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

  /** Reduce-only partial take-profit. Paper and remote only: live keeps its server-side stops until the manager supports it. */
  async reducePosition(pos: Position, qty: number): Promise<void> {
    if (!(qty > 0) || qty >= pos.qty) throw new Error(`Refusing partial ${qty} of ${pos.qty} ${pos.symbol}`);
    const broker = this.usableBroker();
    if (broker) return broker.reduce(pos, qty);
    if (config.mode !== 'paper') throw new Error('Partial exits are not supported in live mode');
    this.paper.openPosition({
      symbol: pos.symbol, side: pos.side === 'LONG' ? 'SELL' : 'BUY', qty, leverage: pos.leverage,
      strategy: pos.strategy, reduceOnly: true, exitReason: 'PARTIAL TP',
    });
  }

  /**
   * Moves a live position's protection. The new legs rest before the old are cancelled, so the position is never without a
   * stop. If the new stop cannot be placed, the old one stays and the error is thrown for the caller to report.
   */
  async updateStops(symbol: string, strategy: AgentId, stopLoss: number, takeProfit: number | null, side?: Side): Promise<void> {
    // A broker's levels live in its sidecar; the Binance branch below would cancel and replace orders on the wrong venue
    if (this.broker) return this.broker.updateStops(symbol, strategy, stopLoss, takeProfit);
    if (config.mode === 'paper') return this.paper.updateStops(symbol, strategy, stopLoss, takeProfit);
    if (config.alertOnly || !side) return;
    const exitSide = side === 'LONG' ? 'SELL' : 'BUY';
    const current = protectionOf((await this.futures.getAllOpenOrders({ symbol })).map(toOpenOrderView), symbol, side === 'LONG' ? 1 : -1);
    const stopOrderId = await this.placeProtection(symbol, exitSide, 'STOP_MARKET', stopLoss);
    const tpOrderId = takeProfit === null ? undefined : await this.placeProtection(symbol, exitSide, 'TAKE_PROFIT_MARKET', takeProfit);
    const keep = new Set([stopOrderId, tpOrderId]);
    for (const orderId of [...current.stopOrderIds, ...current.takeProfitOrderIds]) {
      if (keep.has(orderId)) continue;
      try {
        await this.futures.cancelOrder({ symbol, orderId });
      } catch (err) {
        if (errorCode(err) !== -2011) throw err;
      }
    }
  }

  dropUnlistedPositions(symbols: string[]): string[] {
    if (config.mode !== 'paper' || this.broker) return [];
    return this.paper.dropUnlistedSymbols(symbols);
  }

  markAll(prices: Record<string, number>): string[] {
    // Even while down: queued exits retry from here
    if (this.broker) return this.broker.markAll(prices);
    return config.mode === 'paper' ? this.paper.markAll(prices) : [];
  }

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
    if (this.broker) return this.isVenueUp() ? this.broker.observeFunding(market) : [];
    // Live funding is settled by the venue and reaches the journal through its income history
    if (config.mode === 'paper') this.paper.accrueFunding(market.funding);
    return [];
  }

  private async placeServerProtectionOrders(params: { symbol: string; side: 'BUY' | 'SELL'; qty: number; stopLoss: number; takeProfit?: number }): Promise<{ stopOrderId?: number; tpOrderId?: number }> {
    const { symbol, side, qty, stopLoss, takeProfit } = params;
    const exitSide = side === 'BUY' ? 'SELL' : 'BUY';
    const stopOrderId = await this.placeProtection(symbol, exitSide, 'STOP_MARKET', stopLoss, { qty, emergencyClose: true });
    const tpOrderId = takeProfit === undefined ? undefined : await this.placeProtection(symbol, exitSide, 'TAKE_PROFIT_MARKET', takeProfit, { qty, emergencyClose: true });
    return { stopOrderId, tpOrderId };
  }

  /**
   * One protective leg. Its client id is fixed before the first send. A venue rejection is final: a refused order never
   * rests, so nothing is retried. An ambiguous failure (timeout, dropped connection) may have landed, so the venue is asked
   * by client id before the leg is sent again, and a duplicate-id answer means the earlier request did land.
   */
  private async placeProtection(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
    price: number,
    options: { qty?: number; emergencyClose?: boolean } = {},
  ): Promise<number> {
    const clientOrderId = protectionClientOrderId(Date.now());
    const stopPrice = type === 'STOP_MARKET' ? roundStopPrice(symbol, price, side) : roundPrice(symbol, price);
    let lastError: unknown;
    for (let attempt = 0; attempt < PROTECTION_ATTEMPTS; attempt++) {
      try {
        if (attempt > 0) {
          const resting = await this.restingOrder(symbol, clientOrderId);
          if (resting) return resting.orderId;
        }
        const placed = await this.futures.submitNewOrder({ symbol, side, type, stopPrice, closePosition: 'true', newClientOrderId: clientOrderId });
        return placed.orderId;
      } catch (err) {
        lastError = err;
        if (errorCode(err) === DUPLICATE_CLIENT_ORDER_ID) {
          const resting = await this.restingOrder(symbol, clientOrderId);
          if (resting) return resting.orderId;
        }
        if (isVenueRejection(err)) break;
      }
    }
    if (options.emergencyClose && type === 'STOP_MARKET') {
      // Never leave a filled live position without a stop: close it, and say so if that fails too
      const closeFailure = await this.emergencyClose(symbol, side, options.qty ?? 0);
      throw new Error(`Protection order failed (${type} for ${symbol}): ${errorText(lastError)}${closeFailure}`);
    }
    throw new Error(`Protection order failed (${type} for ${symbol}): ${errorText(lastError)}`);
  }

  /** A protective order by its client id, when it rests (not cancelled, rejected or expired). Undefined when the venue has no such order. */
  private async restingOrder(symbol: string, clientOrderId: string): Promise<{ orderId: number } | undefined> {
    try {
      const order = await this.futures.getOrder({ symbol, origClientOrderId: clientOrderId });
      return ['CANCELED', 'REJECTED', 'EXPIRED'].includes(order.status) ? undefined : { orderId: order.orderId };
    } catch (err) {
      if (errorCode(err) === -2013) return undefined;
      throw err;
    }
  }

  /** Returns '' once closed, or the failure text: the position is then open WITHOUT a stop and the caller must say so. */
  private async emergencyClose(symbol: string, side: 'BUY' | 'SELL', qty: number): Promise<string> {
    try {
      await this.futures.submitNewOrder({ symbol, side, type: 'MARKET', quantity: roundQty(symbol, qty), reduceOnly: 'true' });
      return '';
    } catch (err) {
      return `; EMERGENCY CLOSE FAILED, position open without a stop: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** A venue position, with its real protection levels (or the dash the rest of the code reads as "none") and its owner. */
  private mapPosition(p: any, protection: PositionProtection): Position {
    const qty = Math.abs(Number(p.positionAmt)), side = Number(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const entry = Number(p.entryPrice), mark = Number(p.markPrice), liqPrice = Number(p.liquidationPrice);
    return {
      id: `${p.symbol}_${side}`, symbol: p.symbol, side, strategy: this.owners.ownerAt(p.symbol, Date.now(), side),
      entry, qty, mark, upnl: Number(p.unRealizedProfit),
      upnlPct: entry ? ((mark - entry) / entry) * 100 * (side === 'LONG' ? 1 : -1) : 0,
      leverage: Number(p.leverage), marginType: p.marginType === 'isolated' ? 'ISOLATED' : 'CROSS',
      liqDistancePct: liqPrice > 0 ? Math.abs((liqPrice - mark) / mark) * 100 : null,
      serverSl: protection.stopPrice === null ? NO_LEVEL : String(protection.stopPrice),
      serverTp: protection.takeProfitPrice === null ? NO_LEVEL : String(protection.takeProfitPrice),
    };
  }
}
