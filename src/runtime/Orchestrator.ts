import { EventEmitter } from 'node:events';
import type { Signal, LogEntry, AppState, Position, MarketPriceInfo, Candle, AgentId } from '../types.js';
import { DEFAULT_COOLDOWN_MS, startsCooldown, type BaseAgent, type MarketContext } from '../agents/BaseAgent.js';
import { BinanceService } from '../binance/client.js';
import { FundingArbAgent } from '../agents/FundingArbAgent.js';
import { MomentumAgent } from '../agents/MomentumAgent.js';
import { AdaptiveSuperTrendAgent } from '../agents/AdaptiveSuperTrendAgent.js';
import { RiskAgent } from '../agents/RiskAgent.js';
import { ExecutorAgent } from '../agents/ExecutorAgent.js';
import { OllamaAdvisor } from '../ollama/advisor.js';
import { errorText, isRefusal } from '../binance/remoteOrders.js';
import { sparkline } from '../binance/indicators.js';
import { buildTelemetry, fleetRuntimes, singleFlight, venueInfo, type SessionCounters, type Telemetry, type TelemetryInput } from './telemetry.js';
import { formatPrice } from '../binance/symbolRules.js';
import { config, LOOP_INTERVAL_MS } from '../config.js';
import type { AdaptiveSuperTrendBar } from '../binance/adaptiveSuperTrend.js';

type CycleContext = MarketContext & {
  tickers: Record<string, { price: number; changePct: number; high24h?: number; low24h?: number; volumeQuote?: number }>;
  nextFundingTime: number;
};

function accountFields(account: TelemetryInput['account'], positions: Position[]) {
  return { equity: account.equity, marginUsed: account.marginUsed, positions, upnl: positions.reduce((sum, p) => sum + p.upnl, 0) };
}

export class Orchestrator extends EventEmitter {
  private binance = new BinanceService();
  private adaptive = new AdaptiveSuperTrendAgent(this.binance);
  private agents: BaseAgent[] = [
    new FundingArbAgent(this.binance),
    // PairsAgent disabled: it signals a BTC/ETH ratio, which is not an exchange symbol; re-enable once it emits two legs
    new MomentumAgent(this.binance),
    // Live one-way mode nets opposite same-symbol positions, so per-strategy dynamic stops are paper-only
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
  private cooldownStartedAt = new Map<string, number>();
  private counters: SessionCounters = { decisions: 0, executed: 0, monitored: 0 };
  private lastVenueState: string | null = null;
  private lastInitError: string | null = null;

  start() {
    this.log('SYSTEM', `Orchestrator started in ${config.mode.toUpperCase()} mode`, 'info');
    const dropped = this.binance.dropUnlistedPositions(config.symbols);
    if (dropped.length) this.log('SYSTEM', `Dropped ${dropped.length} saved position(s) outside SYMBOLS: ${dropped.join(', ')}`, 'warn');
    if (config.mode === 'live') this.log('SYSTEM', `${this.adaptive.id} disabled: dynamic exits are paper-only`, 'warn');
    const remote = config.mode === 'paper' ? config.paperExchange : null;
    if (remote) this.log('SYSTEM', `Paper trading routed through ${remote.url} (account ${remote.accountId})`, 'info');
    const runLoop = singleFlight(() => this.loop().catch((err: Error) => this.log('SYSTEM', `Loop crashed: ${err.message}`, 'error')));
    this.binance.loadSymbolRules(config.symbols)
      .catch((err: Error) => this.log('SYSTEM', `Symbol precision load failed (${err.message}); using 2dp defaults`, 'warn'))
      .then(() => this.initVenue())
      .finally(runLoop);
    this.timer = setInterval(runLoop, LOOP_INTERVAL_MS);
    this.stopWs = this.binance.startRealtimeStream(config.symbols, (sym, price) => this.handleRealtimeTick(sym, price));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.stopWs?.();
    this.stopWs = null;
  }

  flushOnShutdown(): void { this.binance.flushPaperEngine(); }

  private handleRealtimeTick(sym: string, price: number): void {
    this.livePrices[sym] = price;
    const current = this.liveTickers[sym] ?? { price, changePct: 0 };
    this.putTicker(sym, { ...current, price });
    if (this.pendingTickFlush) return;
    this.pendingTickFlush = true;
    setTimeout(() => {
      this.pendingTickFlush = false;
      this.flushRealtimeTick().catch((err: unknown) => this.logFailure('Tick flush failed', err));
    }, 60);
  }

  private putTicker(sym: string, info: MarketPriceInfo): void {
    this.liveTickers[sym.replace('USDT', '')] = info;
    this.liveTickers[sym] = info;
  }

  private async flushRealtimeTick(): Promise<void> {
    this.logAll(this.binance.markAll(this.livePrices), 'warn');
    if (!this.binance.hasVenueData()) return;
    // Cached read: this runs on every price tick, and a remote venue must not be polled that often
    const positions = await this.binance.getPositions(false);
    const account = await this.binance.getAccount();
    this.emit('state', { ...accountFields(account, positions), spotPrices: { ...this.liveTickers }, serverTime: Date.now() });
  }

  async closePosition(pos: Position) {
    this.log('SYSTEM', `Manual close ${pos.symbol} ${pos.side}`, 'warn');
    await this.binance.closePosition(pos).catch((err: unknown) => this.logFailure(`Close ${pos.symbol} failed`, err));
  }

  async cancelAll() {
    for (const sym of config.symbols) await this.binance.cancelAll(sym);
    this.log('SYSTEM', 'All pending orders cancelled', 'warn');
  }

  pauseAgent(id: string) {
    const agent = [...this.agents, this.risk, this.executor].find(a => a.id === id);
    if (!agent) return;
    agent.status = agent.status === 'PAUSED' ? 'RUNNING' : 'PAUSED';
    this.log('SYSTEM', `${id} ${agent.status}`, 'info');
  }

  async askAdvisor(question = 'Assess current portfolio risk and position exposures'): Promise<void> {
    if (!this.binance.hasVenueData()) return this.log('SYSTEM', 'Advisor unavailable: the venue has not returned account data yet', 'warn');
    const positions = await this.binance.getPositions(false);
    const account = await this.binance.getAccount();
    const entry = await this.advisor.ask(question, { positions, equity: account.equity });
    this.emit('log', entry);
  }

  private async loop() {
    try {
      this.emit('sync', true);
      if (await this.isVenueReady()) await this.runCycle();
    } catch (err) {
      this.logFailure('Loop error', err);
    } finally {
      this.noteVenue();
      this.emit('sync', false);
    }
  }

  private async runCycle(): Promise<void> {
    const ctx = await this.gatherContext();
    for (const { message, isFailure } of await this.binance.settleFunding(ctx)) this.log('SYSTEM', message, isFailure ? 'error' : 'info');
    const signals = await this.collectSignals(ctx);
    await this.processSignals(signals, ctx);
    // Fresh read: the ctx snapshot predates the awaited veto/execution, and updateStops matches by symbol+strategy only
    if (config.mode === 'paper') this.trailStops(await this.binance.getPositions());
    await this.consultAdvisor(signals, ctx.positions ?? []);
    await this.emitState(ctx);
  }

  /** Without account data there is nothing to trade against: retry the venue setup and skip the cycle. */
  private async isVenueReady(): Promise<boolean> {
    if (!this.binance.hasVenueData()) await this.initVenue();
    return this.binance.hasVenueData();
  }

  /** Logged once per distinct failure: the loop retries this every cycle while the venue is down. */
  private async initVenue(): Promise<void> {
    try {
      await this.binance.initVenue();
      this.lastInitError = null;
    } catch (err) {
      if (errorText(err) !== this.lastInitError) this.log('SYSTEM', `Venue init failed: ${errorText(err)}`, 'error');
      this.lastInitError = errorText(err);
    }
  }

  /** Runs after every loop, including one that failed before emitting state, so the cockpit never keeps a stale venue state. */
  private noteVenue(): void {
    const venue = this.binance.getVenueStatus();
    this.emit('state', { venue: venueInfo(venue, config.mode) } satisfies Partial<AppState>);
    if (venue === null || venue.state === this.lastVenueState) return;
    this.lastVenueState = venue.state;
    this.log('SYSTEM', `${venue.name} ${venue.state}${venue.lastError ? `: ${venue.lastError}` : ''}`, venue.state === 'connected' ? 'info' : 'warn');
  }

  private async collectSignals(ctx: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    for (const agent of this.agents) {
      const out = await agent.run(ctx);
      signals.push(...out);
      for (const s of out) this.log(s.agent, `${s.symbol}: ${s.reason} (conf ${(s.confidence * 100).toFixed(0)}%)`, 'info');
    }
    return signals;
  }

  private async processSignals(signals: Signal[], ctx: MarketContext): Promise<void> {
    for (const signal of signals) {
      if (this.isCoolingDown(signal)) { this.counters.monitored += 1; continue; }
      this.counters.decisions += 1;
      const decision = this.risk.gate(signal, ctx);
      if (!decision.approved) {
        this.log('RISK-MGR-δ', `REJECTED ${signal.symbol}: ${decision.reason}`, 'warn');
        this.counters.monitored += 1;
        continue;
      }
      if (await this.isVetoed(signal, ctx)) { this.counters.monitored += 1; continue; }
      const log = await this.executor.execute(signal, decision);
      this.log(log.agent, log.msg, log.level);
      if (log.level === 'warn') this.counters.monitored += 1;
      if (startsCooldown(log.level, this.binance.getVenueStatus()?.state)) this.cooldownStartedAt.set(`${signal.symbol}:${signal.agent}`, Date.now());
      if (log.level === 'success') this.counters.executed += 1;
    }
  }

  private isCoolingDown(signal: Signal): boolean {
    const cooldownMs = this.agents.find((a) => a.id === signal.agent)?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const startedAt = this.cooldownStartedAt.get(`${signal.symbol}:${signal.agent}`) ?? 0;
    return Date.now() - startedAt < cooldownMs;
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
    for (const { symbol, strategy, stopLoss, takeProfit } of this.adaptive.stopUpdates(positions)) {
      this.binance.updateStops(symbol, strategy, stopLoss, takeProfit);
      this.log(strategy, `TRAIL ${symbol} SL ${formatPrice(symbol, stopLoss)} TP ${formatPrice(symbol, takeProfit)}`, 'info');
    }
  }

  private logAll(lines: string[], level: LogEntry['level']): void {
    for (const line of lines) this.log('SYSTEM', line, level);
  }

  private logFailure(what: string, err: unknown): void {
    this.log('SYSTEM', `${what}: ${errorText(err)}`, isRefusal(err) ? 'warn' : 'error');
  }

  private async consultAdvisor(signals: Signal[], positions: Position[]): Promise<void> {
    if (signals.length === 0) return;
    const advice = await this.advisor.advise(positions, signals.map((s) => s.reason));
    if (advice) this.log(advice.agent, advice.msg, advice.level);
  }

  private async gatherContext(): Promise<CycleContext> {
    const market = await this.binance.getMarketOverview(config.symbols);
    // REST marks refresh every loop so SL/TP still trigger if the websocket stalls; ticks override in between
    Object.assign(this.livePrices, market.marks);
    this.logAll(this.binance.markAll(this.livePrices), 'warn');
    // Positions first: in remote mode this syncs the venue, and the account must be read from the same snapshot
    const positions = await this.binance.getPositions();
    const account = await this.binance.getAccount();
    return { ...market, spot: this.livePrices, equity: account.equity, positions };
  }

  private telemetryFor(ctx: CycleContext, account: TelemetryInput['account'], positions: Position[]): Telemetry {
    const adaptive: Record<string, AdaptiveSuperTrendBar | undefined> = Object.fromEntries(config.symbols.map((s) => [s, this.adaptive.stateFor(s)]));
    const running = [...this.agents, this.risk, this.executor].map(({ id, status, strategy }) => ({ id: id as AgentId, status, strategy }));
    return buildTelemetry({
      account, positions, adaptive,
      trades: this.binance.getTrades(),
      candles: ctx.candles, funding: ctx.funding, nextFundingTime: ctx.nextFundingTime,
      agents: fleetRuntimes(running, this.agents.includes(this.adaptive)), counters: this.counters,
      apiWeight: this.binance.getApiWeight(), wsStatus: this.binance.getWsStatus(), now: Date.now(),
      attributable: config.mode !== 'live',
    });
  }

  private refreshLiveTickers(ctx: CycleContext): void {
    for (const [sym, t] of Object.entries(ctx.tickers)) {
      const closes = (ctx.candles[sym] ?? []).map((c: Candle) => c.close);
      this.putTicker(sym, { ...t, price: this.livePrices[sym] ?? t.price, sparkline: sparkline(closes, 12) });
    }
  }

  private async emitState(ctx: CycleContext): Promise<void> {
    const positions = await this.binance.getPositions(false);
    const account = await this.binance.getAccount();
    this.refreshLiveTickers(ctx);
    this.emit('state', {
      mode: config.mode,
      ...accountFields(account, positions),
      funding: ctx.funding,
      spotPrices: { ...this.liveTickers },
      ...this.telemetryFor(ctx, account, positions),
      serverTime: Date.now(),
    });
  }

  private log(agent: any, msg: string, level: LogEntry['level']) {
    this.emit('log', { ts: Date.now(), agent, msg, level } satisfies LogEntry);
  }
}
