import { EventEmitter } from 'node:events';
import type { Signal, LogEntry, AppState, Position, MarketPriceInfo, Candle, AgentId } from '../types.js';
import { DEFAULT_COOLDOWN_MS, startsCooldown, type BaseAgent, type MarketContext } from '../agents/BaseAgent.js';
import { BinanceService } from '../binance/client.js';
import { FundingArbAgent } from '../agents/FundingArbAgent.js';
import { MomentumAgent } from '../agents/MomentumAgent.js';
import { AdaptiveSuperTrendAgent } from '../agents/AdaptiveSuperTrendAgent.js';
import { StructureTrendAgent } from '../agents/StructureTrendAgent.js';
import { MeanReversionAgent } from '../agents/MeanReversionAgent.js';
import { CrowdingAgent } from '../agents/CrowdingAgent.js';
import { RiskAgent } from '../agents/RiskAgent.js';
import { ExecutorAgent } from '../agents/ExecutorAgent.js';
import { OllamaAdvisor } from '../ollama/advisor.js';
import { errorText, isRefusal } from '../binance/remoteOrders.js';
import { sparkline } from '../binance/indicators.js';
import { accountFields, buildTelemetry, fleetRuntimes, singleFlight, venueInfo, type SessionCounters, type Telemetry, type TelemetryInput } from './telemetry.js';
import { formatPrice } from '../binance/symbolRules.js';
import { KillSwitch } from '../ops/killSwitch.js';
import { announceStartup, buildOps, refreshPortfolio, RiskOps, toggleKillSwitch as flipKillSwitch } from './opsHooks.js';
import { config, LOOP_INTERVAL_MS } from '../config.js';
import type { AdaptiveSuperTrendBar } from '../binance/adaptiveSuperTrend.js';
import { MarketStateBuilder } from '../market/MarketStateBuilder.js';
import { fuseSignals } from '../decision/SignalFusion.js';
import { evaluateExecutionQuality } from '../execution/ExecutionQuality.js';
import { applyRouter } from '../decision/StrategyRouter.js';
import { AgentLedger } from '../learning/AgentLedger.js';
import { confidenceMultiplier } from '../learning/ConfidenceAdjuster.js';
import { TradeOutcomeRecorder } from '../learning/TradeOutcomeRecorder.js';

type CycleContext = MarketContext & {
  tickers: Record<string, { price: number; changePct: number; high24h?: number; low24h?: number; volumeQuote?: number }>;
  nextFundingTime: number;
};

export class Orchestrator extends EventEmitter {
  private binance = new BinanceService();
  private marketStateBuilder = new MarketStateBuilder();
  private adaptive = new AdaptiveSuperTrendAgent(this.binance);
  private structureTrend = new StructureTrendAgent(this.binance);
  private meanRevert = new MeanReversionAgent(this.binance);
  private crowding = new CrowdingAgent(this.binance);
  private agents: BaseAgent[] = [
    new FundingArbAgent(this.binance),
    new MomentumAgent(this.binance),
    ...(config.mode === 'paper' ? [this.adaptive] : []),
    this.structureTrend, this.meanRevert, this.crowding,
  ];
  private killSwitch = new KillSwitch();
  private risk = new RiskAgent(this.binance, { killSwitch: this.killSwitch });
  private hooks = buildOps({ log: (line) => this.log('SYSTEM', line, 'info'), seedTrades: this.binance.getTrades() });
  private ops = new RiskOps((message) => this.log('SYSTEM', message, 'warn'), { killSwitch: this.killSwitch, onCircuit: (from, to, snapshot) => this.hooks.onCircuit(from, to, snapshot) });
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
  private ledger = new AgentLedger('data/agent-ledger.json');
  private recorder = new TradeOutcomeRecorder(this.ledger);

  start() {
    this.log('SYSTEM', `Orchestrator started in ${config.mode.toUpperCase()} mode`, 'info');
    announceStartup({ killSwitch: this.killSwitch, hooks: this.hooks, warn: (message) => this.log('SYSTEM', message, 'warn') });
    const dropped = this.binance.dropUnlistedPositions(config.symbols);
    if (dropped.length) this.log('SYSTEM', `Dropped ${dropped.length} saved position(s) outside SYMBOLS: ${dropped.join(', ')}`, 'warn');
    if (config.mode === 'live') this.log('SYSTEM', `${this.adaptive.id} disabled: dynamic exits are paper-only`, 'warn');
    const remote = config.mode === 'paper' ? config.paperExchange : null;
    if (remote) this.log('SYSTEM', `Paper trading routed through ${remote.url} (account ${remote.accountId})`, 'info');
    const runLoop = singleFlight(() => this.loop().catch((err: Error) => this.log('SYSTEM', `Loop crashed: ${err.message}`, 'error')));
    this.binance.loadSymbolRules(config.symbols)
      .catch((err: Error) => this.log('SYSTEM', `Symbol precision load failed (${err.message}); using 2dp defaults`, 'warn'))
      .then(() => this.initVenue()).finally(runLoop);
    this.timer = setInterval(runLoop, LOOP_INTERVAL_MS);
    this.stopWs = this.binance.startRealtimeStream(config.symbols, (sym, price) => this.handleRealtimeTick(sym, price));
    this.hooks.start(this.binance);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.stopWs?.(); this.stopWs = null; this.hooks.stop(); }
  flushOnShutdown(): void { this.binance.flushPaperEngine(); }
  toggleKillSwitch(): void { flipKillSwitch(this.killSwitch, this.hooks, (message) => this.log('SYSTEM', message, 'warn')); }

  private handleRealtimeTick(sym: string, price: number): void {
    this.livePrices[sym] = price;
    this.putTicker(sym, { ...(this.liveTickers[sym] ?? { changePct: 0 }), price });
    if (this.pendingTickFlush) return;
    this.pendingTickFlush = true;
    setTimeout(() => { this.pendingTickFlush = false; this.flushRealtimeTick().catch((err: unknown) => this.logFailure('Tick flush failed', err)); }, 60);
  }
  private putTicker(sym: string, info: MarketPriceInfo): void { this.liveTickers[sym.replace('USDT', '')] = this.liveTickers[sym] = info; }

  private async flushRealtimeTick(): Promise<void> {
    this.logExits();
    if (!this.binance.hasVenueData()) return;
    const positions = await this.binance.getPositions(false);
    const account = await this.binance.getAccount();
    this.emit('state', { ...accountFields(account, positions), spotPrices: { ...this.liveTickers }, serverTime: Date.now() });
  }
  async closePosition(pos: Position) {
    this.log('SYSTEM', `Manual close ${pos.symbol} ${pos.side}`, 'warn');
    await this.binance.closePosition(pos).catch((err: unknown) => this.logFailure(`Close ${pos.symbol} failed`, err));
  }
  async cancelAll() { for (const sym of config.symbols) await this.binance.cancelAll(sym); this.log('SYSTEM', 'All pending orders cancelled', 'warn'); }
  pauseAgent(id: string) {
    const agent = [...this.agents, this.risk, this.executor].find((a) => a.id === id);
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
      if (!isRefusal(err)) this.hooks.onLoopCrash(err);
    } finally {
      this.noteVenue();
      this.emit('sync', false);
    }
  }

  private async runCycle(): Promise<void> {
    const ctx = await this.gatherContext();
    for (const { message, isFailure } of await this.binance.settleFunding(ctx)) this.log('SYSTEM', message, isFailure ? 'error' : 'info');
    for (const g of this.recorder.process(this.binance.getTrades())) this.logGrade(g);
    const signals = await this.collectSignals(ctx);
    await this.processSignals(signals, ctx);
    if (config.mode === 'paper') this.trailStops(await this.binance.getPositions());
    await this.consultAdvisor(signals, ctx.positions ?? []);
    await this.emitState(ctx);
  }

  private async isVenueReady(): Promise<boolean> {
    if (!this.binance.hasVenueData()) await this.initVenue();
    return this.binance.hasVenueData();
  }
  private async initVenue(): Promise<void> {
    try { await this.binance.initVenue(); this.lastInitError = null; }
    catch (err) { if (errorText(err) !== this.lastInitError) this.log('SYSTEM', `Venue init failed: ${errorText(err)}`, 'error'); this.lastInitError = errorText(err); }
  }

  private noteVenue(): void {
    const venue = this.binance.getVenueStatus();
    this.emit('state', { venue: venueInfo(venue, config.mode) } satisfies Partial<AppState>);
    this.hooks.onVenueState(venue, this.binance.getWsStatus());
    if (venue === null || venue.state === this.lastVenueState) return;
    this.lastVenueState = venue.state;
    this.log('SYSTEM', `${venue.name} ${venue.state}${venue.lastError ? `: ${venue.lastError}` : ''}`, venue.state === 'connected' ? 'info' : 'warn');
  }

  private async collectSignals(ctx: MarketContext): Promise<Signal[]> {
    const raw: Signal[] = [];
    for (const agent of this.agents) {
      const out = await agent.run(ctx);
      const mult = confidenceMultiplier(agent.id as any, this.ledger);
      for (const s of out) {
        const adjusted = { ...s, confidence: Math.min(1, s.confidence * mult) };
        raw.push(adjusted);
        this.log(s.agent, `${s.symbol}: ${s.reason} (conf ${(adjusted.confidence * 100).toFixed(0)}%${mult !== 1 ? ` adj×${mult.toFixed(2)}` : ''})`, 'info');
      }
    }
    // Regime routing: block strategies in markets they are not designed for
    const states = ctx.marketState ?? {};
    const { passed, vetoed } = applyRouter(raw, states);
    for (const v of vetoed) this.log(v.agent as any, `ROUTED OUT ${v.symbol}: ${v.agent} not allowed in ${v.regime}`, 'info');
    // New multi-strategy agents participate in signal fusion; legacy agents bypass it.
    const FUSION_AGENTS = new Set<string>(['STRUCTURE-TREND-η', 'MEAN-REVERT-θ', 'CROWDING-ι']);
    const legacy = passed.filter((s) => !FUSION_AGENTS.has(s.agent));
    const candidates = passed.filter((s) => FUSION_AGENTS.has(s.agent));
    if (candidates.length === 0) return legacy;
    const intents = fuseSignals(candidates, states);
    const fused = intents.flatMap(({ symbol, sourceAgent }) => candidates.filter((s) => s.symbol === symbol && s.agent === sourceAgent));
    if (candidates.length !== fused.length) this.log('SYSTEM', `SignalFusion: ${candidates.length - fused.length} candidate(s) filtered by conflict resolution`, 'info');
    return [...legacy, ...fused];
  }

  private async processSignals(signals: Signal[], ctx: MarketContext): Promise<void> {
    for (const signal of signals) {
      if (this.isCoolingDown(signal)) { this.counters.monitored += 1; continue; }
      this.counters.decisions += 1;
      this.hooks.onSignal(signal);
      const decision = this.risk.gate(signal, ctx);
      this.hooks.onGate(signal, decision);
      if (!decision.approved) {
        this.log('RISK-MGR-δ', `REJECTED ${signal.symbol}: ${decision.reason}`, 'warn');
        this.hooks.onRefusal(signal, decision.reason);
        this.counters.monitored += 1;
        continue;
      }
      if (await this.isVetoed(signal, ctx)) { this.counters.monitored += 1; continue; }
      const derivatives = ctx.marketDataV2?.[signal.symbol]?.derivatives ?? null;
      const eq = evaluateExecutionQuality({ symbol: signal.symbol, side: signal.type.includes('SHORT') ? 'SHORT' : 'LONG', sourceAgent: signal.agent, evidenceScore: Math.round(signal.confidence * 100), entry: signal.entry ?? 0, stopLoss: signal.stopLoss ?? 0, takeProfit: signal.takeProfit ?? 0, reasons: [signal.reason] }, derivatives, decision.positionSizeUsdt);
      if (!eq.approved) { this.log(signal.agent, `EQ BLOCK ${signal.symbol}: ${eq.reason}`, 'warn'); this.counters.monitored += 1; continue; }
      const log = await this.executor.execute(signal, decision);
      this.log(log.agent, log.msg, log.level);
      this.hooks.onOrder(signal, decision, log, ctx);
      if (log.level === 'warn') this.counters.monitored += 1;
      if (startsCooldown(log.level, this.binance.getVenueStatus()?.state)) this.cooldownStartedAt.set(`${signal.symbol}:${signal.agent}`, Date.now());
      if (log.level === 'success') { this.counters.executed += 1; ctx = await refreshPortfolio(ctx, this.binance); }
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
    if (verdict === 'VETO') { this.log(signal.agent, `VETOED ${signal.type} ${signal.symbol}: ${reason}`, 'warn'); this.hooks.onVeto(signal, reason); }
    if (verdict === 'PROCEED' && reason.startsWith('advisor')) this.log(signal.agent, `veto skipped for ${signal.symbol}: ${reason}`, 'warn');
    return verdict === 'VETO';
  }
  private trailStops(positions: Position[]): void {
    for (const { symbol, strategy, stopLoss, takeProfit } of this.adaptive.stopUpdates(positions)) {
      this.binance.updateStops(symbol, strategy, stopLoss, takeProfit);
      this.log(strategy, `TRAIL ${symbol} SL ${formatPrice(symbol, stopLoss)} TP ${formatPrice(symbol, takeProfit)}`, 'info');
    }
  }
  private logExits(): void { for (const line of this.binance.markAll(this.livePrices)) this.log('SYSTEM', line, 'warn'); this.hooks.onExit(this.binance.getTrades()); }
  private logFailure(what: string, err: unknown): void { this.log('SYSTEM', `${what}: ${errorText(err)}`, isRefusal(err) ? 'warn' : 'error'); }
  private async consultAdvisor(signals: Signal[], positions: Position[]): Promise<void> {
    if (signals.length === 0) return;
    const advice = await this.advisor.advise(positions, signals.map((s) => s.reason));
    if (advice) this.log(advice.agent, advice.msg, advice.level);
  }

  private async gatherContext(): Promise<CycleContext> {
    const market = await this.binance.getMarketOverview(config.symbols);
    Object.assign(this.livePrices, market.marks);
    this.logExits();
    const [positions, account] = await Promise.all([this.binance.getPositions(), this.binance.getAccount()]);
    const marketState = this.marketStateBuilder.buildAll(config.symbols.map((symbol) => ({
      symbol, candles: market.candles[symbol] ?? [],
      candlesByTimeframe: market.marketDataV2?.[symbol]?.candles,
      derivatives: market.marketDataV2?.[symbol]?.derivatives,
      mark: market.marks[symbol] ?? this.livePrices[symbol] ?? 0,
      fundingRate: market.funding[symbol] ?? 0,
    })));
    return { ...market, spot: this.livePrices, equity: account.equity, positions, marketState, performance: this.ops.build(this.binance.getTrades(), account) };
  }

  private telemetryFor(ctx: CycleContext, account: TelemetryInput['account'], positions: Position[]): Telemetry {
    const adaptive: Record<string, AdaptiveSuperTrendBar | undefined> = Object.fromEntries(config.symbols.map((s) => [s, this.adaptive.stateFor(s)]));
    const running = [...this.agents, this.risk, this.executor].map(({ id, status, strategy }) => {
      const mult = confidenceMultiplier(id as any, this.ledger);
      return { id: id as AgentId, status, strategy, note: id === this.risk.id ? this.ops.note : undefined, edgeMultiplier: mult !== 1 ? mult : undefined };
    });
    return buildTelemetry({
      account, positions, adaptive, trades: this.binance.getTrades(),
      candles: ctx.candles, funding: ctx.funding, nextFundingTime: ctx.nextFundingTime,
      agents: fleetRuntimes(running, this.agents.includes(this.adaptive)), counters: this.counters,
      apiWeight: this.binance.getApiWeight(), wsStatus: this.binance.getWsStatus(), now: Date.now(),
      attributable: config.mode !== 'live', marketStates: ctx.marketState,
    });
  }

  private refreshLiveTickers(ctx: CycleContext): void {
    for (const [sym, t] of Object.entries(ctx.tickers)) {
      const closes = (ctx.candles[sym] ?? []).map((c: Candle) => c.close);
      this.putTicker(sym, { ...t, price: this.livePrices[sym] ?? t.price, sparkline: sparkline(closes, 12) });
    }
  }

  private async emitState(ctx: CycleContext): Promise<void> {
    const [positions, account] = await Promise.all([this.binance.getPositions(false), this.binance.getAccount()]);
    this.refreshLiveTickers(ctx);
    this.emit('state', {
      mode: config.mode, ...accountFields(account, positions), funding: ctx.funding,
      spotPrices: { ...this.liveTickers }, ...this.telemetryFor(ctx, account, positions), serverTime: Date.now(),
    });
  }

  private log(agent: any, msg: string, level: LogEntry['level']) { this.emit('log', { ts: Date.now(), agent, msg, level } satisfies LogEntry); }
  private logGrade(g: import('../learning/TradeOutcomeRecorder.js').GradedTrade): void {
    this.log(g.trade.strategy, `GRADE ${g.grade} ${g.trade.symbol} ${g.rMultiple > 0 ? '+' : ''}${g.rMultiple}R — ${g.commentary}`, g.trade.pnl >= 0 ? 'success' : 'warn');
  }
}
