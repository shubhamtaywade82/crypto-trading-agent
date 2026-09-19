import { EventEmitter } from 'node:events';
import type { Signal, LogEntry, AppState, Position, StrategyMetrics, MarketPriceInfo, Candle } from '../types.js';
import type { MarketContext } from '../agents/BaseAgent.js';
import { BinanceService } from '../binance/client.js';
import { FundingArbAgent } from '../agents/FundingArbAgent.js';
import { PairsAgent } from '../agents/PairsAgent.js';
import { MomentumAgent } from '../agents/MomentumAgent.js';
import { RiskAgent } from '../agents/RiskAgent.js';
import { ExecutorAgent } from '../agents/ExecutorAgent.js';
import { OllamaAdvisor } from '../ollama/advisor.js';
import { atr, zscore, sparkline } from '../binance/indicators.js';
import { config } from '../config.js';

export class Orchestrator extends EventEmitter {
  private binance = new BinanceService();
  private agents = [
    new FundingArbAgent(this.binance),
    new PairsAgent(this.binance),
    new MomentumAgent(this.binance),
  ];
  private risk = new RiskAgent(this.binance);
  private executor = new ExecutorAgent(this.binance);
  private advisor = new OllamaAdvisor();
  private timer: NodeJS.Timeout | null = null;

  start() {
    this.log('SYSTEM', `Orchestrator started in ${config.mode.toUpperCase()} mode`, 'info');
    this.loop();
    this.timer = setInterval(() => this.loop(), 8000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
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
      const decision = this.risk.gate(signal, ctx);
      if (decision.approved) {
        const log = await this.executor.execute(signal, decision);
        this.log(log.agent, log.msg, log.level);
      } else {
        this.log('RISK-MGR-δ', `REJECTED ${signal.symbol}: ${decision.reason}`, 'warn');
      }
    }
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
    this.binance.markAll(market.marks);
    const account = await this.binance.getAccount();
    const positions = await this.binance.getPositions();
    const strategyMetrics = this.computeStrategyMetrics(market);

    return {
      candles: market.candles,
      funding: market.funding,
      marks: market.marks,
      spot: Object.fromEntries(Object.entries(market.tickers).map(([k, v]) => [k, v.price])),
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
      zscoreBtcEth: this.calcPairZScore(btcCandles, ethCandles),
      zscoreSolAvax: this.calcPairZScore(solCandles, avaxCandles),
      btcAtr: btcCandles.length ? atr(btcCandles, 14) : 0,
      avaxAtr: avaxCandles.length ? atr(avaxCandles, 14) : 0,
    };
  }

  private calcPairZScore(cA: Candle[], cB: Candle[]): number {
    const len = Math.min(cA.length, cB.length);
    if (len < 30) return 0;
    const ratios: number[] = [];
    for (let i = len - 30; i < len; i++) {
      ratios.push(cA[i].close / cB[i].close);
    }
    return zscore(ratios, 30);
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
      const info: MarketPriceInfo = {
        price: t.price,
        changePct: t.changePct,
        high24h: t.high24h,
        low24h: t.low24h,
        volumeQuote: t.volumeQuote,
        sparkline: spark,
      };
      spotPrices[short] = info;
      spotPrices[sym] = info;
    }

    this.emit('state', {
      mode: config.mode,
      equity: account.equity,
      marginUsed: account.marginUsed,
      positions,
      upnl: positions.reduce((s, p) => s + p.upnl, 0),
      funding: ctx.funding,
      spotPrices,
      strategyMetrics: ctx.strategyMetrics,
      serverTime: Date.now(),
    } satisfies Partial<AppState>);
  }

  private log(agent: any, msg: string, level: LogEntry['level']) {
    this.emit('log', { ts: Date.now(), agent, msg, level } satisfies LogEntry);
  }
}
