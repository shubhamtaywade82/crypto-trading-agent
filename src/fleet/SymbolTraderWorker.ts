import { PaperExchangeClient, type PaperExchangeLease, type PaperExchangePosition, type PaperExchangeAccountSnapshot } from '../binance/paperExchangeClient.js';
import { wilderAtr } from '../binance/indicators.js';
import { entryLimitPrice } from '../binance/remoteOrders.js';
import { FleetLlmService } from './FleetLlmService.js';
import type { LlmTradeRecommendation, PeerContext, PromptInput } from './FleetPrompt.js';
import type { Candle } from '../types.js';
import type { MarketState } from '../market/types.js';
import { loadFleetState, saveFleetPosition, removeFleetPosition } from './FleetStateStore.js';
import type { FleetTradeEvent } from './FleetTelegram.js';
import { createFleetEntryGate, type EntryGate } from './EntryGate.js';

export interface SymbolWorkerConfig {
  symbol: string;
  accountId: string;
  paperExchangeUrl: string;
  apiKey: string;
  marginPerPosition: number;
  leverage: number;
  /** Max loss at the stop as a % of `marginPerPosition`; caps quantity so a wide LLM stop cannot size a large loss. */
  riskPerTradePct: number;
  /** When false, no entry is submitted. Exits still run. */
  entriesEnabled: boolean;
  /** Ollama tag of the model driving this worker's decisions; recorded on every opened position for attribution. */
  modelTag: string;
  /** Optional trade-event sink: called on every entry fill, exit fill and break-even lock. Synchronous by design — async delivery (e.g. Telegram) is the sink's job, never the trading loop's. */
  onTradeEvent?: (event: FleetTradeEvent) => void;
  /**
   * The account's lease, taken by the caller before the worker first writes. Without one, writes go out unfenced and the
   * paper_exchange decides. The fleet always passes one.
   */
  lease?: PaperExchangeLease;
}

export interface WorkerStatus {
  symbol: string;
  accountId: string;
  state: 'IDLE' | 'ANALYZING' | 'IN_POSITION';
  activePosition: PaperExchangePosition | null;
  account: PaperExchangeAccountSnapshot | null;
  stopLoss: number | null;
  takeProfit: number | null;
  slDistancePct: number | null;
  tpDistancePct: number | null;
  breakEvenMoved: boolean;
  lastDecision: string;
  lastUpdated: number;
  /** Ollama tag of the model that produced the current decision path; shown on the dashboard. */
  modelTag: string;
}

export interface EvaluationParams {
  markPrice: number;
  btcCandles15m: Candle[];
  btcCandles1h: Candle[];
  symbolCandles15m: Candle[];
  symbolCandles1h: Candle[];
  marketState?: MarketState;
  /** 1h candles of the context-only alts, keyed by symbol. */
  peerCandles1h?: Record<string, Candle[]>;
}

export class SymbolTraderWorker {
  private readonly client: PaperExchangeClient;
  private readonly llm: FleetLlmService;
  private status: WorkerStatus;
  private currentSl: number | null = null;
  private currentTp: number | null = null;
  private breakEvenMoved = false;
  private readonly gate: EntryGate;
  /** Epoch ms of the last live trade tick the runner delivered. Recorded before any early return, so a flat worker counts as fed. */
  private lastLiveTickAt = 0;
  /** Open time of the 15m candle the model last answered for. */
  private lastAskedCandleOpen: number | null = null;

  constructor(
    private readonly config: SymbolWorkerConfig,
    llm: FleetLlmService,
    gate?: EntryGate,
  ) {
    this.llm = llm;
    this.gate = gate ?? createFleetEntryGate(config.symbol);
    this.client = new PaperExchangeClient(config.paperExchangeUrl, config.accountId, {
      apiKey: config.apiKey,
      ...(config.lease ? { lease: config.lease } : {}),
    });
    this.status = {
      symbol: config.symbol,
      accountId: config.accountId,
      state: 'IDLE',
      activePosition: null,
      account: null,
      stopLoss: null,
      takeProfit: null,
      slDistancePct: null,
      tpDistancePct: null,
      breakEvenMoved: false,
      lastDecision: 'Initialized',
      lastUpdated: Date.now(),
      modelTag: config.modelTag,
    };

    const saved = loadFleetState().positions[config.symbol];
    if (saved) {
      this.currentSl = saved.stopLoss;
      this.currentTp = saved.takeProfit;
      this.breakEvenMoved = !!saved.breakEvenMoved;
      // A position recovered from disk keeps the model attribution it was opened with; the
      // status shows the currently configured model because that is what new decisions use.
      const openedNote = saved.openedByModel && saved.openedByModel !== config.modelTag ? ` (opened by ${saved.openedByModel})` : '';
      this.status.lastDecision = `Recovered: SL $${saved.stopLoss} | TP $${saved.takeProfit}${openedNote}`;
    }
  }

  getStatus(): WorkerStatus {
    return { ...this.status };
  }

  /** Emits a trade event to the configured sink; a broken sink must never break trading. */
  private emitTradeEvent(event: Omit<FleetTradeEvent, 'at'>): void {
    try {
      this.config.onTradeEvent?.({ ...event, at: Date.now() });
    } catch {
      // notification sinks are best-effort: swallow and keep trading
    }
  }

  async syncAccount(): Promise<void> {
    try {
      const acct = await this.client.getAccount();
      if (!acct) {
        await this.client.createAccount(this.config.marginPerPosition);
        this.status.account = await this.client.getAccount();
      } else {
        this.status.account = acct;
      }
      if (this.status.account) this.gate.observeEquity(this.status.account.equity, Date.now());

      const positions = await this.client.getPositions();
      const pos = positions.find((p) => p.symbol === this.config.symbol && p.netQuantity > 0);
      this.status.activePosition = pos ?? null;
      this.status.state = pos ? 'IN_POSITION' : 'IDLE';

      if (!pos && (this.currentSl !== null || this.currentTp !== null)) {
        this.currentSl = null;
        this.currentTp = null;
        this.breakEvenMoved = false;
        removeFleetPosition(this.config.symbol);
      }

      this.updateStatusLevels(pos ? pos.currentPrice : null);
      this.status.lastUpdated = Date.now();
    } catch (err) {
      console.error(`[Worker ${this.config.symbol}] sync error:`, (err as Error).message);
    }
  }

  async onLiveTick(price: number): Promise<void> {
    this.lastLiveTickAt = Date.now();
    const pos = this.status.activePosition;
    if (!pos) return;

    pos.currentPrice = price;
    const isLong = pos.side === 'long';
    const delta = isLong ? price - pos.averagePrice : pos.averagePrice - price;
    pos.unrealizedPnl = Number((delta * pos.netQuantity).toFixed(2));
    this.updateStatusLevels(price);
    await this.manageOpenPosition(price);
  }

  async evaluate(params: EvaluationParams): Promise<void> {
    const { markPrice } = params;
    await this.client.pushMarkPrices({ [this.config.symbol]: markPrice });
    await this.syncAccount();

    if (this.status.activePosition) {
      this.ensureRecoveryLevels(markPrice);
      await this.manageOpenPosition(markPrice);
      return;
    }

    // Trends, ATR and structure in the prompt only change when a 15m candle closes. Asking again inside one candle
    // re-samples a non-deterministic model on the same setup until it says ENTER, and pays for every sample.
    const candleOpen = params.symbolCandles15m.at(-1)?.openTime ?? null;
    if (candleOpen === null || candleOpen === this.lastAskedCandleOpen) return;

    const input = this.buildPromptInput(params);
    if (!input) return;

    this.status.state = 'ANALYZING';
    const rec = await this.llm.analyze(input);
    // A failed call is retried on the next cycle; an answer stands until the next candle
    if (rec) this.lastAskedCandleOpen = candleOpen;
    if (!rec || rec.action === 'HOLD') {
      this.status.state = 'IDLE';
      this.status.lastDecision = rec ? `HOLD: ${rec.reason}` : 'No setup approved';
      return;
    }

    const levels = fleetLevels(rec.action, markPrice, input.symbolContext.atr14);
    if (!levels) {
      this.status.state = 'IDLE';
      this.status.lastDecision = `RISK REFUSED: no valid ATR (${input.symbolContext.atr14})`;
      return;
    }
    this.handleRecommendation({ ...rec, action: rec.action, ...levels }, markPrice);
  }

  private handleRecommendation(rec: TradePlan, markPrice: number): void {
    this.currentSl = rec.stopLoss;
    this.currentTp = rec.takeProfit;
    this.updateStatusLevels(markPrice);

    if (!this.config.entriesEnabled) {
      this.status.state = 'IDLE';
      this.status.lastDecision = `[SHADOW] ${rec.action} @ ${markPrice} | SL: ${rec.stopLoss} | TP: ${rec.takeProfit} (${rec.reason}) [R1: entries off]`;
      return;
    }

    const acct = this.status.account;
    if (acct && acct.availableBalance < this.config.marginPerPosition) {
      this.status.state = 'IDLE';
      this.status.lastDecision = `RISK REFUSED: insufficient margin ($${acct.availableBalance.toFixed(2)} < $${this.config.marginPerPosition})`;
      return;
    }

    // The entry gate: the repo's circuit breaker, the operator kill switch and feed freshness. Exits are never gated.
    const gate = this.gate.decide({
      now: Date.now(),
      equity: this.status.account?.equity ?? null,
      lastLiveTickAt: this.lastLiveTickAt,
    });
    if (!gate.allowed) {
      this.status.state = 'IDLE';
      this.status.lastDecision = `GOVERNOR REFUSED: ${gate.reasons.join('; ')}`;
      return;
    }

    void this.executeEntry(rec, markPrice, gate.riskMultiplier);
  }

  // Establishes default bounds when an exchange position exists without local stop levels
  private ensureRecoveryLevels(markPrice: number): void {
    if (this.currentSl !== null && this.currentTp !== null) return;
    const isLong = this.status.activePosition?.side === 'long';
    this.currentSl = isLong ? Number((markPrice * 0.985).toFixed(4)) : Number((markPrice * 1.015).toFixed(4));
    this.currentTp = isLong ? Number((markPrice * 1.01).toFixed(4)) : Number((markPrice * 0.99).toFixed(4));
    saveFleetPosition({
      symbol: this.config.symbol,
      entryPrice: this.status.activePosition?.averagePrice ?? markPrice,
      stopLoss: this.currentSl,
      takeProfit: this.currentTp,
      breakEvenMoved: false,
      openedAt: Date.now(),
      reason: 'Auto-anchored recovery levels',
      openedByModel: this.config.modelTag,
    });
  }

  private async executeEntry(rec: TradePlan, markPrice: number, riskMultiplier = 1): Promise<void> {
    // The only entry submission: refused while paused, even if evaluate() were ever changed to reach it
    if (!this.config.entriesEnabled) return;
    // The gate scales the risk budget down in CAUTION and REDUCED; the margin cap is unchanged
    const quantity = fleetEntryQuantity(
      { ...this.config, riskPerTradePct: this.config.riskPerTradePct * riskMultiplier },
      markPrice,
      Math.abs(markPrice - rec.stopLoss),
    );
    if (!(quantity > 0)) return;
    const side = rec.action === 'ENTER_LONG' ? 'buy' : 'sell';
    this.status.lastDecision = `${rec.action} @ ${markPrice} | SL: ${rec.stopLoss} | TP: ${rec.takeProfit} (${rec.reason})`;

    try {
      const order = await this.client.submitOrder({
        symbol: this.config.symbol,
        side,
        quantity,
        leverage: this.config.leverage,
        marginType: 'isolated',
        executionPrice: markPrice,
        limitPrice: entryLimitPrice(side, markPrice),
        clientOrderId: `fleet-${this.config.symbol}-${Date.now()}`,
      });

      // Only a fill opens a position: an IOC limit that missed comes back cancelled with an order id
      if (order.status !== 'filled') {
        this.status.lastDecision = `${rec.action} limit not filled (${order.status})`;
        return;
      }
      this.currentSl = rec.stopLoss;
      this.currentTp = rec.takeProfit;
      this.breakEvenMoved = false;
      // Reflect the confirmed fill immediately. state, the position view and the guarding levels
      // become consistent the moment the broker confirms, BEFORE the ENTRY event and before the
      // account sync: a live tick that lands between the fill and syncAccount()'s round-trips must
      // never see a position-less worker and silently skip break-even/SL/TP management.
      // syncAccount() afterwards only replaces this optimistic view with the broker's truth.
      this.status.activePosition = {
        id: Number(order.orderId) || 0,
        symbol: this.config.symbol,
        side: side === 'buy' ? 'long' : 'short',
        netQuantity: order.filledQuantity ?? quantity,
        averagePrice: markPrice,
        currentPrice: markPrice,
        leverage: this.config.leverage,
        marginType: 'isolated',
        liquidationPrice: null,
        unrealizedPnl: 0,
      };
      this.status.state = 'IN_POSITION';
      this.updateStatusLevels(markPrice);
      saveFleetPosition({
        symbol: this.config.symbol,
        entryPrice: markPrice,
        stopLoss: rec.stopLoss,
        takeProfit: rec.takeProfit,
        breakEvenMoved: false,
        openedAt: Date.now(),
        reason: rec.reason,
        openedByModel: this.config.modelTag,
      });
      this.emitTradeEvent({
        kind: 'ENTRY',
        symbol: this.config.symbol,
        side,
        model: this.config.modelTag,
        price: markPrice,
        quantity,
        leverage: this.config.leverage,
        action: rec.action,
        note: rec.reason,
        stopLoss: rec.stopLoss,
        takeProfit: rec.takeProfit,
        entryPrice: markPrice,
      });
      await this.syncAccount();
    } catch (err) {
      console.error(`[Worker ${this.config.symbol}] order error:`, (err as Error).message);
    }
  }

  private updateStatusLevels(currentPrice: number | null): void {
    this.status.stopLoss = this.currentSl;
    this.status.takeProfit = this.currentTp;
    this.status.breakEvenMoved = this.breakEvenMoved;

    if (currentPrice && this.currentSl !== null && this.currentTp !== null) {
      this.status.slDistancePct = Number((((this.currentSl - currentPrice) / currentPrice) * 100).toFixed(2));
      this.status.tpDistancePct = Number((((this.currentTp - currentPrice) / currentPrice) * 100).toFixed(2));
    } else {
      this.status.slDistancePct = null;
      this.status.tpDistancePct = null;
    }
  }

  private async manageOpenPosition(currentPrice: number): Promise<void> {
    const pos = this.status.activePosition;
    if (!pos || this.currentSl === null || this.currentTp === null) return;

    this.applyTrailingBreakEven(pos, currentPrice);

    const isLong = pos.side === 'long';
    const hitSl = isLong ? currentPrice <= this.currentSl : currentPrice >= this.currentSl;
    const hitTp = isLong ? currentPrice >= this.currentTp : currentPrice <= this.currentTp;
    if (!hitSl && !hitTp) return;

    const exitSide = isLong ? 'sell' : 'buy';
    const isBe = this.breakEvenMoved && this.currentSl === pos.averagePrice;
    const reason = hitSl ? (isBe ? 'BREAK_EVEN' : 'STOP_LOSS') : 'TAKE_PROFIT';
    await this.closePosition(pos, exitSide, reason, currentPrice);
  }

  // Locks profit once price moves at least 0.25% in favor (2.5% return on 10x margin)
  private applyTrailingBreakEven(pos: PaperExchangePosition, currentPrice: number): void {
    if (this.breakEvenMoved) return;
    const isLong = pos.side === 'long';
    const gainPct = isLong
      ? ((currentPrice - pos.averagePrice) / pos.averagePrice) * 100
      : ((pos.averagePrice - currentPrice) / pos.averagePrice) * 100;
    if (gainPct < 0.25) return;

    this.currentSl = pos.averagePrice;
    this.breakEvenMoved = true;
    this.status.breakEvenMoved = true;
    this.status.lastDecision = `Moved SL to Break-Even ($${pos.averagePrice.toFixed(2)}) after +${(gainPct * 10).toFixed(1)}% profit move`;
    saveFleetPosition({
      symbol: this.config.symbol,
      entryPrice: pos.averagePrice,
      stopLoss: this.currentSl,
      takeProfit: this.currentTp!,
      breakEvenMoved: true,
      openedAt: Date.now(),
      reason: 'Shifted to Break-Even',
      openedByModel: this.config.modelTag,
    });
    this.emitTradeEvent({
      kind: 'BREAK_EVEN',
      symbol: this.config.symbol,
      model: this.config.modelTag,
      price: currentPrice,
      action: 'BREAK_EVEN',
      note: `SL moved to entry after +${(gainPct * 10).toFixed(1)}% margin move`,
      stopLoss: pos.averagePrice,
      takeProfit: this.currentTp ?? undefined,
      entryPrice: pos.averagePrice,
    });
  }

  private async closePosition(
    pos: PaperExchangePosition,
    side: 'buy' | 'sell',
    reason: string,
    currentPrice: number,
  ): Promise<void> {
    this.status.lastDecision = `CLOSING (${reason}) @ ${currentPrice}`;
    // Capture the guarding levels before they are cleared: the exit card reports what triggered it.
    const slAtExit = this.currentSl;
    const tpAtExit = this.currentTp;
    const isLong = pos.side === 'long';
    const pnl = Number(((isLong ? currentPrice - pos.averagePrice : pos.averagePrice - currentPrice) * pos.netQuantity).toFixed(2));
    try {
      await this.client.submitOrder({
        symbol: this.config.symbol,
        side,
        quantity: pos.netQuantity,
        leverage: this.config.leverage,
        marginType: 'isolated',
        reduceOnly: true,
        executionPrice: currentPrice,
        clientOrderId: `fleet-close-${this.config.symbol}-${Date.now()}`,
      });
      this.emitTradeEvent({
        kind: 'EXIT',
        symbol: this.config.symbol,
        side,
        model: this.config.modelTag,
        price: currentPrice,
        quantity: pos.netQuantity,
        leverage: pos.leverage,
        action: reason,
        stopLoss: slAtExit ?? undefined,
        takeProfit: tpAtExit ?? undefined,
        entryPrice: pos.averagePrice,
        pnl,
      });
      this.gate.recordExit(pnl, Date.now());
      this.currentSl = null;
      this.currentTp = null;
      this.breakEvenMoved = false;
      // Same atomic-transition rule as the entry: a confirmed reduce-only exit means the position
      // is flat as of this instant. Do not leave a phantom IN_POSITION behind if the account sync
      // is slow or fails — the worker knows the broker truth it just acted on.
      this.status.activePosition = null;
      this.status.state = 'IDLE';
      this.updateStatusLevels(null);
      removeFleetPosition(this.config.symbol);
      await this.syncAccount();
    } catch (err) {
      console.error(`[Worker ${this.config.symbol}] exit error:`, (err as Error).message);
    }
  }

  private buildPromptInput(params: EvaluationParams): PromptInput | null {
    const { markPrice, btcCandles15m, btcCandles1h, symbolCandles15m, symbolCandles1h, marketState, peerCandles1h } = params;
    if (btcCandles15m.length < 20 || btcCandles1h.length < 10 || symbolCandles15m.length < 20 || symbolCandles1h.length < 10) {
      return null;
    }

    const atr14 = marketState?.timeframes['15m'].atr14 ?? (wilderAtr(symbolCandles15m, 14).at(-1) ?? 1.0);
    return {
      symbol: this.config.symbol,
      currentPrice: markPrice,
      btcContext: this.buildBtcContext(btcCandles15m, btcCandles1h),
      symbolContext: this.buildSymbolContext(markPrice, symbolCandles15m, symbolCandles1h, atr14),
      marketState,
      peers: this.buildPeers(peerCandles1h ?? {}),
    };
  }

  private buildPeers(peerCandles1h: Record<string, Candle[]>): PeerContext[] {
    return Object.entries(peerCandles1h)
      .filter(([, candles]) => candles.length >= 10)
      .map(([symbol, candles]) => {
        const last = candles.at(-1)!.close;
        const open24h = candles.length >= 24 ? candles.at(-24)!.open : candles[0]!.open;
        return { symbol, trend1h: this.detectTrend(candles), change24hPct: ((last - open24h) / open24h) * 100 };
      });
  }

  private buildBtcContext(btc15m: Candle[], btc1h: Candle[]) {
    const last = btc15m.at(-1)!;
    const open24h = btc1h.length >= 24 ? btc1h.at(-24)!.open : btc1h[0]!.open;
    return {
      price: last.close,
      trend1h: this.detectTrend(btc1h),
      trend15m: this.detectTrend(btc15m),
      change24hPct: ((last.close - open24h) / open24h) * 100,
    };
  }

  private buildSymbolContext(markPrice: number, sym15m: Candle[], sym1h: Candle[], atr14: number) {
    const open24h = sym1h.length >= 24 ? sym1h.at(-24)!.open : sym1h[0]!.open;
    const recentHigh = Math.max(...sym15m.slice(-20).map((c) => c.high));
    const recentLow = Math.min(...sym15m.slice(-20).map((c) => c.low));
    return {
      price: markPrice,
      trend1h: this.detectTrend(sym1h),
      trend15m: this.detectTrend(sym15m),
      change24hPct: ((markPrice - open24h) / open24h) * 100,
      atr14,
      support: recentLow,
      resistance: recentHigh,
      recentHigh,
      recentLow,
    };
  }

  private detectTrend(candles: Candle[]): 'BULLISH' | 'BEARISH' | 'SIDEWAYS' {
    if (candles.length < 5) return 'SIDEWAYS';
    const first = candles.at(-5)!.close;
    const last = candles.at(-1)!.close;
    const diffPct = ((last - first) / first) * 100;
    if (diffPct > 0.3) return 'BULLISH';
    if (diffPct < -0.3) return 'BEARISH';
    return 'SIDEWAYS';
  }
}

type TradePlan = LlmTradeRecommendation & { action: 'ENTER_LONG' | 'ENTER_SHORT'; stopLoss: number; takeProfit: number };

const STOP_ATR_MULTIPLE = 1.5;
const REWARD_RISK = 2;
// 0.5% is 5% on margin at 10x: a closer target is mostly eaten by fees and slippage
const MIN_TARGET_PCT = 0.005;

/** Deterministic stop/target for a direction: stop 1.5x ATR away, target 2R but at least 0.5% away. Null if ATR is unusable. */
export function fleetLevels(action: 'ENTER_LONG' | 'ENTER_SHORT', markPrice: number, atr14: number): { stopLoss: number; takeProfit: number } | null {
  if (!(markPrice > 0) || !(atr14 > 0)) return null;
  const risk = STOP_ATR_MULTIPLE * atr14;
  const reward = Math.max(REWARD_RISK * risk, markPrice * MIN_TARGET_PCT);
  const sign = action === 'ENTER_LONG' ? 1 : -1;
  const stopLoss = Number((markPrice - sign * risk).toPrecision(10));
  if (!(stopLoss > 0)) return null;
  return { stopLoss, takeProfit: Number((markPrice + sign * reward).toPrecision(10)) };
}

/**
 * Risk-capped size: the fixed-margin notional, cut down so a stop-out loses at most `riskPerTradePct` of the margin.
 * Without the cap a 10x position with a 1.5% stop loses ~15% of the account per trade.
 */
export function fleetEntryQuantity(config: Pick<SymbolWorkerConfig, 'marginPerPosition' | 'leverage' | 'riskPerTradePct'>, markPrice: number, stopDistance: number): number {
  if (!(markPrice > 0) || !(stopDistance > 0)) return 0;
  const notionalCap = (config.marginPerPosition * 0.98 * config.leverage) / markPrice;
  const riskCap = (config.marginPerPosition * config.riskPerTradePct) / 100 / stopDistance;
  return Number(Math.min(notionalCap, riskCap).toFixed(4));
}
