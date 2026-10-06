import { PaperExchangeClient, type PaperExchangePosition, type PaperExchangeAccountSnapshot } from '../binance/paperExchangeClient.js';
import { MiniCpmService } from './MiniCpmService.js';
import type { PromptInput } from './MiniCpmPrompt.js';
import type { Candle } from '../types.js';
import { loadMiniCpmState, saveMiniCpmPosition, removeMiniCpmPosition } from './MiniCpmStateStore.js';

export interface SymbolWorkerConfig {
  symbol: string;
  accountId: string;
  paperExchangeUrl: string;
  apiKey: string;
  marginPerPosition: number;
  leverage: number;
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
}

export class SymbolTraderWorker {
  private readonly client: PaperExchangeClient;
  private readonly llm: MiniCpmService;
  private status: WorkerStatus;
  private currentSl: number | null = null;
  private currentTp: number | null = null;
  private breakEvenMoved = false;

  constructor(
    private readonly config: SymbolWorkerConfig,
    llm: MiniCpmService,
  ) {
    this.llm = llm;
    this.client = new PaperExchangeClient(config.paperExchangeUrl, config.accountId, {
      apiKey: config.apiKey,
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
    };

    // Recover persisted state if available
    const saved = loadMiniCpmState().positions[config.symbol];
    if (saved) {
      this.currentSl = saved.stopLoss;
      this.currentTp = saved.takeProfit;
      this.breakEvenMoved = !!saved.breakEvenMoved;
      this.status.lastDecision = `Recovered: SL $${saved.stopLoss} | TP $${saved.takeProfit}`;
    }
  }

  getStatus(): WorkerStatus {
    return { ...this.status };
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

      const positions = await this.client.getPositions();
      const pos = positions.find((p) => p.symbol === this.config.symbol && p.netQuantity > 0);
      this.status.activePosition = pos ?? null;
      this.status.state = pos ? 'IN_POSITION' : 'IDLE';

      if (!pos && (this.currentSl !== null || this.currentTp !== null)) {
        this.currentSl = null;
        this.currentTp = null;
        this.breakEvenMoved = false;
        removeMiniCpmPosition(this.config.symbol);
      }

      this.updateStatusLevels(pos ? pos.currentPrice : null);
      this.status.lastUpdated = Date.now();
    } catch (err) {
      console.error(`[Worker ${this.config.symbol}] sync error:`, (err as Error).message);
    }
  }

  async onLiveTick(price: number): Promise<void> {
    if (this.status.activePosition) {
      this.status.activePosition.currentPrice = price;
      const isLong = this.status.activePosition.side === 'long';
      const pnl = isLong
        ? (price - this.status.activePosition.averagePrice) * this.status.activePosition.netQuantity
        : (this.status.activePosition.averagePrice - price) * this.status.activePosition.netQuantity;
      this.status.activePosition.unrealizedPnl = Number(pnl.toFixed(2));
      this.updateStatusLevels(price);
      await this.manageOpenPosition(price);
    }
  }

  async evaluate(
    markPrice: number,
    btcCandles15m: Candle[],
    btcCandles1h: Candle[],
    symbolCandles15m: Candle[],
    symbolCandles1h: Candle[],
  ): Promise<void> {
    await this.client.pushMarkPrices({ [this.config.symbol]: markPrice });
    await this.syncAccount();

    if (this.status.activePosition) {
      // If position exists but SL/TP wasn't persisted, establish default 1.5% SL and 5% TP
      if (this.currentSl === null || this.currentTp === null) {
        const isLong = this.status.activePosition.side === 'long';
        this.currentSl = isLong ? Number((markPrice * 0.985).toFixed(4)) : Number((markPrice * 1.015).toFixed(4));
        this.currentTp = isLong ? Number((markPrice * 1.01).toFixed(4)) : Number((markPrice * 0.99).toFixed(4));
        saveMiniCpmPosition({
          symbol: this.config.symbol,
          entryPrice: this.status.activePosition.averagePrice,
          stopLoss: this.currentSl,
          takeProfit: this.currentTp,
          breakEvenMoved: false,
          openedAt: Date.now(),
          reason: 'Auto-anchored recovery levels',
        });
      }
      await this.manageOpenPosition(markPrice);
      return;
    }

    const input = this.buildPromptInput(markPrice, btcCandles15m, btcCandles1h, symbolCandles15m, symbolCandles1h);
    if (!input) return;

    this.status.state = 'ANALYZING';
    const rec = await this.llm.analyze(input);
    if (!rec || rec.action === 'HOLD') {
      this.status.state = 'IDLE';
      this.status.lastDecision = rec ? `HOLD: ${rec.reason}` : 'No setup approved';
      return;
    }

    const effectiveMargin = this.config.marginPerPosition * 0.98;
    const notional = effectiveMargin * this.config.leverage;
    const quantity = Number((notional / markPrice).toFixed(4));
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
        clientOrderId: `minicpm-${this.config.symbol}-${Date.now()}`,
      });

      if (order.status === 'FILLED' || order.orderId > 0) {
        this.currentSl = rec.stopLoss;
        this.currentTp = rec.takeProfit;
        this.breakEvenMoved = false;
        this.status.state = 'IN_POSITION';
        saveMiniCpmPosition({
          symbol: this.config.symbol,
          entryPrice: markPrice,
          stopLoss: rec.stopLoss,
          takeProfit: rec.takeProfit,
          breakEvenMoved: false,
          openedAt: Date.now(),
          reason: rec.reason,
        });
        await this.syncAccount();
      }
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

    const isLong = pos.side === 'long';
    const entry = pos.averagePrice;

    // Trailing Break-Even rule: If gain >= 2.5% on capital (0.25% price gain), shift SL to entry price
    if (!this.breakEvenMoved) {
      const gainPct = isLong ? ((currentPrice - entry) / entry) * 100 : ((entry - currentPrice) / entry) * 100;
      if (gainPct >= 0.25) {
        this.currentSl = entry;
        this.breakEvenMoved = true;
        this.status.breakEvenMoved = true;
        this.status.lastDecision = `Moved SL to Break-Even ($${entry.toFixed(2)}) after +${(gainPct * 10).toFixed(1)}% profit move`;
        saveMiniCpmPosition({
          symbol: this.config.symbol,
          entryPrice: entry,
          stopLoss: this.currentSl,
          takeProfit: this.currentTp,
          breakEvenMoved: true,
          openedAt: Date.now(),
          reason: 'Shifted to Break-Even',
        });
      }
    }

    const hitSl = isLong ? currentPrice <= this.currentSl : currentPrice >= this.currentSl;
    const hitTp = isLong ? currentPrice >= this.currentTp : currentPrice <= this.currentTp;

    if (hitSl || hitTp) {
      const exitSide = isLong ? 'sell' : 'buy';
      const reason = hitSl ? (this.breakEvenMoved && this.currentSl === entry ? 'BREAK_EVEN' : 'STOP_LOSS') : 'TAKE_PROFIT';
      this.status.lastDecision = `CLOSING (${reason}) @ ${currentPrice}`;

      try {
        await this.client.submitOrder({
          symbol: this.config.symbol,
          side: exitSide,
          quantity: pos.netQuantity,
          leverage: this.config.leverage,
          marginType: 'isolated',
          reduceOnly: true,
          executionPrice: currentPrice,
          clientOrderId: `minicpm-close-${this.config.symbol}-${Date.now()}`,
        });
        this.currentSl = null;
        this.currentTp = null;
        this.breakEvenMoved = false;
        removeMiniCpmPosition(this.config.symbol);
        await this.syncAccount();
      } catch (err) {
        console.error(`[Worker ${this.config.symbol}] exit error:`, (err as Error).message);
      }
    }
  }

  private buildPromptInput(
    markPrice: number,
    btc15m: Candle[],
    btc1h: Candle[],
    sym15m: Candle[],
    sym1h: Candle[],
  ): PromptInput | null {
    if (btc15m.length < 20 || btc1h.length < 10 || sym15m.length < 20 || sym1h.length < 10) return null;

    const btcLast = btc15m.at(-1)!;
    const btcOpen24h = btc1h.length >= 24 ? btc1h.at(-24)!.open : btc1h[0]!.open;
    const btcChange24h = ((btcLast.close - btcOpen24h) / btcOpen24h) * 100;

    const symOpen24h = sym1h.length >= 24 ? sym1h.at(-24)!.open : sym1h[0]!.open;
    const symChange24h = ((markPrice - symOpen24h) / symOpen24h) * 100;

    const recentHigh = Math.max(...sym15m.slice(-20).map((c) => c.high));
    const recentLow = Math.min(...sym15m.slice(-20).map((c) => c.low));

    return {
      symbol: this.config.symbol,
      currentPrice: markPrice,
      btcContext: {
        price: btcLast.close,
        trend1h: this.detectTrend(btc1h),
        trend15m: this.detectTrend(btc15m),
        change24hPct: btcChange24h,
      },
      symbolContext: {
        price: markPrice,
        trend1h: this.detectTrend(sym1h),
        trend15m: this.detectTrend(sym15m),
        change24hPct: symChange24h,
        atr14: this.calculateAtr(sym15m, 14),
        support: recentLow,
        resistance: recentHigh,
        recentHigh,
        recentLow,
      },
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

  private calculateAtr(candles: Candle[], period = 14): number {
    if (candles.length < period + 1) return 1.0;
    let trSum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const high = candles[i]!.high;
      const low = candles[i]!.low;
      const prevClose = candles[i - 1]!.close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trSum += tr;
    }
    return trSum / period;
  }
}
