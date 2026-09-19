import { EventEmitter } from 'node:events';
import type { Signal, LogEntry, AppState, Position, StrategyMetrics, MarketPriceInfo, Candle } from '../types.js';
import { DEFAULT_COOLDOWN_MS, type BaseAgent, type MarketContext } from '../agents/BaseAgent.js';
import { BinanceService } from '../binance/client.js';
import { FundingArbAgent } from '../agents/FundingArbAgent.js';
import { MomentumAgent } from '../agents/MomentumAgent.js';
import { AdaptiveSuperTrendAgent } from '../agents/AdaptiveSuperTrendAgent.js';
import { RiskAgent } from '../agents/RiskAgent.js';
import { ExecutorAgent } from '../agents/ExecutorAgent.js';
import { OllamaAdvisor } from '../ollama/advisor.js';
import { atr, pairZScore, sparkline } from '../binance/indicators.js';
import { formatPrice } from '../binance/symbolRules.js';
import { config } from '../config.js';

export class Orchestrator extends EventEmitter {
  private binance = new BinanceService();
  private adaptive = new AdaptiveSuperTrendAgent(this.binance);
  private agents: BaseAgent[] = [
    new FundingArbAgent(this.binance),
    // PairsAgent disabled: it signals a BTC/ETH ratio, which is not an exchange symbol; re-enable once it emits two legs
    new MomentumAgent(this.binance),
    // Live one-way mode nets opposite same-symbol positions, so per-strategy dynamic stops are paper-only for now
    ...(config.mode === 'paper' ? [this.adaptive] : []),
  ];
  private risk = new RiskAgent(this.binance);
  private executor = new ExecutorAgent(this.binance);
  private advisor = new OllamaAdvisor();
  private timer: NodeJS.Timeout | null = null;
  private livePrices: Record<string, number> = {};
  private liveTickers: Record<string, MarketPriceInfo> = {};
  private stopWs: (() => void) | null = null;
  private pendingTickFlush = false;
  private lastFilledAt = new Map<string, number>();

  start() {
    this.log('SYSTEM', `Orchestrator started in ${config.mode.toUpperCase()} mode`, 'info');
    const dropped = this.binance.dropUnlistedPositions(config.symbols);
    if (dropped.length) this.log('SYSTEM', `Dropped ${dropped.length} saved position(s) outside SYMBOLS: ${dropped.join(', ')}`, 'warn');
    if (config.mode === 'live') this.log('SYSTEM', `${this.adaptive.id} disabled: dynamic exits are paper-only`, 'warn');
    this.binance.loadSymbolRules(config.symbols)
      .catch((err: Error) => this.log('SYSTEM', `Symbol precision load failed (${err.message}); using 2dp defaults`, 'warn'))
      .finally(() => this.loop());
    this.timer = setInterval(() => this.loop(), 8000);
    this.stopWs = this.binance.startRealtimeStream(config.symbols, (sym, price) => {
      this.handleRealtimeTick(sym, price);
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.stopWs) {
      this.stopWs();
      this.stopWs = null;
    }
  }

  private handleRealtimeTick(sym: string, price: number): void {
    this.livePrices[sym] = price;
    const short = sym.replace('USDT', '');
    const current = this.liveTickers[short] ?? this.liveTickers[sym];
    if (current) {
      current.price = price;
      this.liveTickers[short] = current;
      this.liveTickers[sym] = current;
    } else {
      const info: MarketPriceInfo = { price, changePct: 0 };
      this.liveTickers[short] = info;
      this.liveTickers[sym] = info;
    }

    if (this.pendingTickFlush) return;
    this.pendingTickFlush = true;
    setTimeout(async () => {
      this.pendingTickFlush = false;
      await this.flushRealtimeTick();
    }, 60);
  }

  private async flushRealtimeTick(): Promise<void> {
    this.logExits(this.binance.markAll(this.livePrices));
    const account = await this.binance.getAccount();
    const positions = await this.binance.getPositions();
    this.emit('state', {
      equity: account.equity,
      marginUsed: account.marginUsed,
      positions,
      upnl: positions.reduce((s, p) => s + p.upnl, 0),
      spotPrices: { ...this.liveTickers },
      serverTime: Date.now(),
    });
  }

  async closePosition(pos: Position) {
    this.log('SYSTEM', `Manual close ${pos.symbol} ${pos.side}`, 'warn');
    await this.binance.closePosition(pos);
  }

  async cancelAll() {
    for (const sym of config.symbols) await this.binance.cancelAll(sym);
    this.log('SYSTEM', 'All pending orders cancelled', 'warn');
  }

  pauseAgent(id: string) {
    const agent = [...this.agents, this.risk, this.executor].find(a => a.id === id);
    if (agent) {
      agent.status = agent.status === 'PAUSED' ? 'RUNNING' : 'PAUSED';
      this.log('SYSTEM', `${id} ${agent.status}`, 'info');
    }
  }

  async askAdvisor(question = 'Assess current portfolio risk and position exposures'): Promise<void> {
    const account = await this.binance.getAccount();
    const positions = await this.binance.getPositions();
    const entry = await this.advisor.ask(question, { positions, equity: account.equity });
    this.emit('log', entry);
  }

  private async loop() {
    try {
      this.emit('sync', true);
      const ctx = await this.gatherContext();

      const signals = await this.collectSignals(ctx);
      await this.processSignals(signals, ctx);
      // Fresh read: the ctx snapshot predates the awaited veto/execution, and updateStops matches by symbol+strategy only
      this.trailStops(await this.binance.getPositions());
      await this.consultAdvisor(signals, ctx.positions ?? []);
      await this.emitState(ctx);
    } catch (err: any) {
      this.log('SYSTEM', `Loop error: ${err.message}`, 'error');
    } finally {
      this.emit('sync', false);
    }
  }

  private async collectSignals(ctx: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    for (const agent of this.agents) {
      const out = await agent.run(ctx);
      signals.push(...out);
      for (const s of out) {
        this.log(s.agent, `${s.symbol}: ${s.reason} (conf ${(s.confidence * 100).toFixed(0)}%)`, 'info');
      }
    }
    return signals;
  }

  private async processSignals(signals: Signal[], ctx: MarketContext): Promise<void> {
    for (const signal of signals) {
      if (this.isCoolingDown(signal)) continue;

      const decision = this.risk.gate(signal, ctx);
      if (!decision.approved) {
        this.log('RISK-MGR-δ', `REJECTED ${signal.symbol}: ${decision.reason}`, 'warn');
        continue;
      }
      if (await this.isVetoed(signal, ctx)) continue;

      const log = await this.executor.execute(signal, decision);
      this.log(log.agent, log.msg, log.level);
      if (log.level === 'success') this.lastFilledAt.set(`${signal.symbol}:${signal.agent}`, Date.now());
    }
  }

  private isCoolingDown(signal: Signal): boolean {
    const cooldownMs = this.agents.find((a) => a.id === signal.agent)?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const lastFill = this.lastFilledAt.get(`${signal.symbol}:${signal.agent}`) ?? 0;
    return Date.now() - lastFill < cooldownMs;
  }

  private async isVetoed(signal: Signal, ctx: MarketContext): Promise<boolean> {
    const snapshot = this.adaptive.vetoSnapshot(signal, ctx);
    if (!snapshot) return false;
    const { verdict, reason } = await this.advisor.veto(snapshot);
    if (verdict === 'VETO') this.log(signal.agent, `VETOED ${signal.type} ${signal.symbol}: ${reason}`, 'warn');
    if (verdict === 'PROCEED' && reason.startsWith('advisor')) this.log(signal.agent, `veto skipped for ${signal.symbol}: ${reason}`, 'warn');
    return verdict === 'VETO';
  }

  private trailStops(positions: Position[]): void {
    // Must stay synchronous: an await between reading positions and applying stops would reopen the stale-snapshot race
    for (const update of this.adaptive.stopUpdates(positions)) {
      this.binance.updateStops(update.symbol, update.strategy, update.stopLoss, update.takeProfit);
      const { symbol, stopLoss, takeProfit } = update;
      this.log(update.strategy, `TRAIL ${symbol} SL ${formatPrice(symbol, stopLoss)} TP ${formatPrice(symbol, takeProfit)}`, 'info');
    }
  }

  private logExits(exits: string[]): void {
    for (const msg of exits) this.log('SYSTEM', msg, 'warn');
  }

  private async consultAdvisor(signals: Signal[], positions: Position[]): Promise<void> {
    if (signals.length === 0) return;
    const advice = await this.advisor.advise(
      positions,
      signals.map(s => s.reason)
    );
    if (advice) {
      this.log(advice.agent, advice.msg, advice.level);
    }
  }

  private async gatherContext(): Promise<MarketContext & {
    tickers: Record<string, { price: number; changePct: number }>;
    strategyMetrics: StrategyMetrics;
  }> {
    const market = await this.binance.getMarketOverview(config.symbols);
    // REST marks refresh every loop so SL/TP still trigger if the websocket stalls; ticks override in between
    Object.assign(this.livePrices, market.marks);
    this.logExits(this.binance.markAll(this.livePrices));
    const account = await this.binance.getAccount();
    const positions = await this.binance.getPositions();
    const strategyMetrics = this.computeStrategyMetrics(market);

    return {
      candles: market.candles,
      funding: market.funding,
      marks: market.marks,
      spot: this.livePrices,
      tickers: market.tickers,
      strategyMetrics,
      equity: account.equity,
      positions,
    };
  }

  private computeStrategyMetrics(market: {
    candles: Record<string, Candle[]>;
    funding: Record<string, number>;
    nextFundingTime: number;
  }): StrategyMetrics {
    const ethFund = market.funding['ETHUSDT'] ?? 0;
    const solFund = market.funding['SOLUSDT'] ?? 0;
    const btcCandles = market.candles['BTCUSDT'] ?? [];
    const ethCandles = market.candles['ETHUSDT'] ?? [];
    const solCandles = market.candles['SOLUSDT'] ?? [];
    const avaxCandles = market.candles['AVAXUSDT'] ?? [];

    const diff = Math.max(0, market.nextFundingTime - Date.now());
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);

    return {
      fundingEthRate: ethFund,
      fundingEthApr: ethFund * 3 * 365 * 100,
      fundingSolRate: solFund,
      fundingSolApr: solFund * 3 * 365 * 100,
      nextFundingCountdown: `${hours}h${mins}m`,
      zscoreBtcEth: pairZScore(btcCandles, ethCandles),
      zscoreSolAvax: pairZScore(solCandles, avaxCandles),
      btcAtr: btcCandles.length ? atr(btcCandles, 14) : 0,
      avaxAtr: avaxCandles.length ? atr(avaxCandles, 14) : 0,
    };
  }

  private async emitState(ctx: MarketContext & {
    tickers: Record<string, { price: number; changePct: number; high24h?: number; low24h?: number; volumeQuote?: number }>;
    strategyMetrics: StrategyMetrics;
  }): Promise<void> {
    const account = await this.binance.getAccount();
    const positions = await this.binance.getPositions();
    const spotPrices: Record<string, MarketPriceInfo> = {};
    for (const [sym, t] of Object.entries(ctx.tickers)) {
      const short = sym.replace('USDT', '');
      const candles = ctx.candles[sym] ?? [];
      const spark = sparkline(candles.map((c: Candle) => c.close), 12);
      const currentPrice = this.livePrices[sym] ?? t.price;
      const info: MarketPriceInfo = {
        price: currentPrice,
        changePct: t.changePct,
        high24h: t.high24h,
        low24h: t.low24h,
        volumeQuote: t.volumeQuote,
        sparkline: spark,
      };
      this.liveTickers[short] = info;
      this.liveTickers[sym] = info;
    }

    this.emit('state', {
      mode: config.mode,
      equity: account.equity,
      marginUsed: account.marginUsed,
      positions,
      upnl: positions.reduce((s, p) => s + p.upnl, 0),
      funding: ctx.funding,
      spotPrices: { ...this.liveTickers },
      strategyMetrics: ctx.strategyMetrics,
      serverTime: Date.now(),
    } satisfies Partial<AppState>);
  }

  private log(agent: any, msg: string, level: LogEntry['level']) {
    this.emit('log', { ts: Date.now(), agent, msg, level } satisfies LogEntry);
  }
}
