import { EventEmitter } from 'node:events';
import type { Signal, LogEntry, AppState, Position, MarketPriceInfo, Candle, AgentId } from '../types.js';
import { DEFAULT_COOLDOWN_MS, startsCooldown, type BaseAgent, type MarketContext } from '../agents/BaseAgent.js';
import { BinanceService } from '../binance/client.js';
import { FundingArbAgent } from '../agents/FundingArbAgent.js';
import { MomentumAgent } from '../agents/MomentumAgent.js';
import { AdaptiveSuperTrendAgent } from '../agents/AdaptiveSuperTrendAgent.js';
import { StructureTrendAgent } from '../agents/StructureTrendAgent.js';
import { StructureLiquidityAgent } from '../agents/StructureLiquidityAgent.js';
import { MeanReversionAgent } from '../agents/MeanReversionAgent.js';
import { CrowdingAgent } from '../agents/CrowdingAgent.js';
import { RiskAgent } from '../agents/RiskAgent.js';
import { ExecutorAgent } from '../agents/ExecutorAgent.js';
import { OllamaAdvisor } from '../ollama/advisor.js';
import { errorText, isRefusal } from '../binance/remoteOrders.js';
import { sparkline } from '../binance/indicators.js';
import { accountFields, buildTelemetry, fleetRuntimes, singleFlight, venueInfo, type SessionCounters, type Telemetry, type TelemetryInput } from './telemetry.js';
import { formatPrice, roundPrice } from '../binance/symbolRules.js';
import { nextStops } from '../agents/TrailingStopManager.js';
import { KillSwitch } from '../ops/killSwitch.js';
import { EquityHwmStore } from '../risk/equityHwm.js';
import { announceStartup, buildOps, refreshPortfolio, RiskOps, toggleKillSwitch as flipKillSwitch } from './opsHooks.js';
import { config, LOOP_INTERVAL_MS } from '../config.js';
import type { AdaptiveSuperTrendBar } from '../binance/adaptiveSuperTrend.js';
import { MarketStateBuilder } from '../market/MarketStateBuilder.js';
import { runCandidateFlow, decisionEvidence, buildDecisionRecord } from '../decision/CandidateFlow.js';
import { tunedStructureLiquidityOptions, DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS } from '../decision/StructureLiquidityStrategy.js';
import { DecisionJournal } from '../decision/DecisionJournal.js';
import { evaluateExecutionQuality } from '../execution/ExecutionQuality.js';
import { AgentLedger } from '../learning/AgentLedger.js';
import { confidenceMultiplier } from '../learning/ConfidenceAdjuster.js';
import { TradeOutcomeRecorder } from '../learning/TradeOutcomeRecorder.js';
import { buildSetupMap } from '../decision/SetupEngine.js';
import { SetupLedger } from '../decision/SetupLedger.js';
import { loadRrProfile } from '../risk/rrProfile.js';
import { RefusalSuppressor } from './refusalSuppressor.js';
import { buildCouncilSignal, COUNCIL_SIGNAL_TTL_MS } from '../decision/CouncilSignal.js';
import { TradingCouncil } from '../llm/TradingCouncil.js';

type CycleContext = MarketContext & { tickers: Record<string, MarketPriceInfo>; nextFundingTime: number };

// Debounce tick flushes to 4 Hz to keep live prices responsive without triggering terminal flicker
const TICK_FLUSH_INTERVAL_MS = 250;

export class Orchestrator extends EventEmitter {
  private binance = new BinanceService();
  private marketStateBuilder = new MarketStateBuilder();
  private adaptive = new AdaptiveSuperTrendAgent(this.binance);
  private structureTrend = new StructureTrendAgent(this.binance);
  private structLiq = new StructureLiquidityAgent(
    this.binance,
    tunedStructureLiquidityOptions({
      maxSweepAgeCandles: config.structLiq.maxSweepAgeCandles,
      minimumRewardRisk: config.structLiq.minimumRewardRisk,
    }),
  );
  private meanRevert = new MeanReversionAgent(this.binance);
  private crowding = new CrowdingAgent(this.binance);
  private agents: BaseAgent[] = [
    new FundingArbAgent(this.binance),
    new MomentumAgent(this.binance),
    ...(config.mode === 'paper' ? [this.adaptive] : []),
    this.structureTrend, this.meanRevert, this.crowding,
    ...(config.structLiq.enabled ? [this.structLiq] : []),
  ];
  private killSwitch = new KillSwitch();
  // Single authoritative equity high-water mark, shared by the risk agent and the
  // performance engine so both measure drawdown against the same persisted peak.
  private hwm = new EquityHwmStore();
  private risk = new RiskAgent(this.binance, { killSwitch: this.killSwitch, hwm: this.hwm.forMode(config.mode), rrProfile: loadRrProfile(config.rrProfilePath) });
  private hooks = buildOps({ log: (line) => this.log('SYSTEM', line, 'info'), seedTrades: this.binance.getTrades() });
  private ops = new RiskOps((message) => this.log('SYSTEM', message, 'warn'), { killSwitch: this.killSwitch, onCircuit: (from, to, snapshot) => this.hooks.onCircuit(from, to, snapshot), hwm: this.hwm.forMode(config.mode) });
  private executor = new ExecutorAgent(this.binance);
  private advisor = new OllamaAdvisor();
  private timer: NodeJS.Timeout | null = null;
  private livePrices: Record<string, number> = {};
  private liveTickers: Record<string, MarketPriceInfo> = {};
  private stopWs: (() => void) | null = null;
  private pendingTickFlush = false;
  private cooldownStartedAt = new Map<string, number>();
  private readonly setupLedger = new SetupLedger();
  private readonly refusalSuppressor = new RefusalSuppressor();
  private counters: SessionCounters = { decisions: 0, executed: 0, monitored: 0 };
  private lastVenueState: string | null = null;
  private lastInitError: string | null = null;
  private ledger = new AgentLedger('data/agent-ledger.json');
  private journal = new DecisionJournal(config.decisionsPath);
  private recorder = new TradeOutcomeRecorder(this.ledger, this.journal);
  /** Winning fusion intents of the current cycle, keyed by `${symbol}:${agent}`; feeds decision evidence. */
  private fusionIntents = new Map<string, import('../decision/SignalFusion.js').TradeIntent>();
  private council = new TradingCouncil(this.advisor, this.ledger);
  /** Council TRADE verdicts queued for the next cycle's risk gate — the council runs detached from the tick loop, so its result always lands after collectSignals() for the cycle that requested it. */
  private pendingCouncilSignals: Signal[] = [];

  start() {
    this.log('SYSTEM', `Orchestrator started in ${config.mode.toUpperCase()} mode`, 'info');
    announceStartup({ killSwitch: this.killSwitch, hooks: this.hooks, warn: (message) => this.log('SYSTEM', message, 'warn') });
    const dropped = this.binance.dropUnlistedPositions(config.symbols);
    if (dropped.length) this.log('SYSTEM', `Dropped ${dropped.length} saved position(s) outside SYMBOLS: ${dropped.join(', ')}`, 'warn');
    if (config.mode === 'live') this.log('SYSTEM', `${this.adaptive.id} disabled: dynamic exits are paper-only`, 'warn');
    if (!config.structLiq.enabled) this.log('SYSTEM', `${this.structLiq.id} disabled by STRUCT_LIQ=off`, 'warn');
    else if (
      config.structLiq.maxSweepAgeCandles !== DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.maxSweepAgeCandles
      || config.structLiq.minimumRewardRisk !== DEFAULT_STRUCTURE_LIQUIDITY_OPTIONS.minimumRewardRisk
    ) this.log('SYSTEM', `${this.structLiq.id} tuned: maxSweepAgeCandles=${config.structLiq.maxSweepAgeCandles}, minimumRewardRisk=${config.structLiq.minimumRewardRisk}`, 'info');
    if (config.mode === 'paper' && config.paperExchange) this.log('SYSTEM', `Paper trading routed through ${config.paperExchange.url} (account ${config.paperExchange.accountId})`, 'info');
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
    setTimeout(() => {
      this.pendingTickFlush = false;
      this.flushRealtimeTick().catch((err: unknown) => this.logFailure('Tick flush failed', err));
    }, TICK_FLUSH_INTERVAL_MS);
  }
  private putTicker(sym: string, info: MarketPriceInfo): void { this.liveTickers[sym.replace('USDT', '')] = this.liveTickers[sym] = info; }
  private async flushRealtimeTick(): Promise<void> {
    this.logExits();
    if (config.mode !== 'paper' && !this.binance.hasVenueData()) return;
    const positions = await this.binance.getPositions(false);
    const account = await this.binance.getAccount();
    this.emit('state', { ...accountFields(account, positions), spotPrices: { ...this.liveTickers }, wsStatus: this.binance.getWsStatus() });
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
    await this.guardEmergencyDrawdown(ctx);
    for (const { message, isFailure } of await this.binance.settleFunding(ctx)) this.log('SYSTEM', message, isFailure ? 'error' : 'info');
    for (const resolved of this.ledger.resolvePredictions(ctx.marks)) {
      this.log('SYSTEM', 'LEARNING ' + resolved.actorId + ' ' + resolved.symbol + ': ' + (resolved.correct ? 'correct' : 'incorrect') + ' after ' + resolved.horizonMinutes + 'm (' + resolved.realizedReturnPct?.toFixed(2) + '%)', 'info');
    }
    for (const g of this.recorder.process(this.binance.getTrades())) this.logGrade(g);
    const signals = await this.collectSignals(ctx);
    await this.processSignals(signals, ctx);
    this.trailStops(await this.binance.getPositions(), ctx);
    await this.consultAdvisor(signals, ctx.positions ?? []);
    await this.emitState(ctx);
  }
  private async guardEmergencyDrawdown(ctx: CycleContext): Promise<void> {
    const maxLoss = ctx.equity * (config.risk.maxDrawdownPct / 100);
    for (const pos of ctx.positions ?? []) {
      if (pos.upnl < 0 && Math.abs(pos.upnl) >= maxLoss) {
        this.log('SYSTEM', `EMERGENCY CLOSE ${pos.symbol}: loss $${Math.abs(pos.upnl).toFixed(2)} exceeds ${config.risk.maxDrawdownPct}% drawdown`, 'error');
        await this.binance.closePosition(pos).catch((err: unknown) => this.logFailure(`Emergency close ${pos.symbol} failed`, err));
      }
    }
  }
  private async isVenueReady(): Promise<boolean> {
    if (!this.binance.hasVenueData()) await this.initVenue();
    return config.mode === 'paper' || this.binance.hasVenueData();
  }
  private async initVenue(): Promise<void> {
    try { await this.binance.initVenue(); this.lastInitError = null; }
    catch (err) { if (errorText(err) !== this.lastInitError) this.log('SYSTEM', `Venue init failed: ${errorText(err)}`, 'error'); this.lastInitError = errorText(err); }
  }
  private noteVenue(): void {
    const venue = this.binance.getVenueStatus();
    this.emit('state', { venue: venueInfo(venue, config.mode), wsStatus: this.binance.getWsStatus() } satisfies Partial<AppState>);
    this.hooks.onVenueState(venue, this.binance.getWsStatus());
    if (venue === null || venue.state === this.lastVenueState) return;
    this.lastVenueState = venue.state;
    this.log('SYSTEM', `${venue.name} ${venue.state}${venue.lastError ? `: ${venue.lastError}` : ''}`, venue.state === 'connected' ? 'info' : 'warn');
  }

  private async collectSignals(ctx: MarketContext): Promise<Signal[]> {
    const raw: Signal[] = [];
    for (const agent of this.agents) {
      const out = await agent.run(ctx);
      for (const s of out) {
        const mult = confidenceMultiplier(agent.id as any, this.ledger, s.symbol);
        const adjusted = { ...s, confidence: Math.min(1, s.confidence * mult) };
        raw.push(adjusted);
        this.log(s.agent, `${s.symbol}: ${s.reason} (conf ${(adjusted.confidence * 100).toFixed(0)}%${mult !== 1 ? ` adj×${mult.toFixed(2)}` : ''})`, 'info');
      }
    }
    for (const s of this.drainCouncilSignals()) {
      const mult = confidenceMultiplier(s.agent as any, this.ledger, s.symbol);
      const adjusted = { ...s, confidence: Math.min(1, s.confidence * mult) };
      raw.push(adjusted);
      this.log(s.agent, `${s.symbol}: ${s.reason} (conf ${(adjusted.confidence * 100).toFixed(0)}%${mult !== 1 ? ` adj×${mult.toFixed(2)}` : ''})`, 'info');
    }
    // The canonical candidate pipeline (routing + fusion) — shared with the replay engine
    const flow = runCandidateFlow(raw, ctx.marketState ?? {});
    for (const v of flow.routedOut) this.log(v.agent as any, `ROUTED OUT ${v.symbol}: ${v.agent} not allowed in ${v.regime}`, 'info');
    if (flow.fusionFiltered > 0) this.log('SYSTEM', `SignalFusion: ${flow.fusionFiltered} candidate(s) filtered by conflict resolution`, 'info');
    this.fusionIntents = flow.intents;
    return flow.signals;
  }

  private async processSignals(signals: Signal[], ctx: MarketContext): Promise<void> {
    for (const signal of signals) {
      if (this.isCoolingDown(signal)) { this.counters.monitored += 1; continue; }
      const portfolio = { equity: ctx.equity, positions: ctx.positions ?? [], circuit: ctx.performance?.circuit };
      // A capacity/circuit block cannot clear while the book is unchanged: skip the gate instead of re-refusing
      if (this.refusalSuppressor.shouldSkip(signal, portfolio)) { this.counters.monitored += 1; continue; }
      this.counters.decisions += 1;
      this.hooks.onSignal(signal);
      const decisionId = `${signal.id}-${Date.now()}`;
      const decision = this.risk.gate(signal, ctx);
      this.hooks.onGate(signal, decision);
      // Decision lineage: what the market looked like, what was proposed, and what risk said — persisted before anything else happens
      const record = this.buildDecisionRecord(decisionId, signal, ctx, decision);
      if (decision.approved) this.refusalSuppressor.noteApproval(signal);
      else this.refusalSuppressor.noteRefusal(signal, decision.reason, portfolio);
      if (!decision.approved) {
        this.journal.record(record);
        this.log('RISK-MGR-δ', `REJECTED ${signal.symbol}: ${decision.reason}`, 'warn');
        this.hooks.onRefusal(signal, decision.reason);
        this.counters.monitored += 1;
        continue;
      }
      if (await this.isVetoed(signal, ctx)) {
        this.journal.record({ ...record, status: 'VETOED', rejectionReason: 'advisor veto' });
        this.counters.monitored += 1;
        continue;
      }
      const derivatives = ctx.marketDataV2?.[signal.symbol]?.derivatives ?? null;
      const eq = evaluateExecutionQuality({ symbol: signal.symbol, side: signal.type.includes('SHORT') ? 'SHORT' : 'LONG', sourceAgent: signal.agent, evidenceScore: Math.round(signal.confidence * 100), entry: signal.entry ?? 0, stopLoss: signal.stopLoss ?? 0, takeProfit: signal.takeProfit ?? 0, reasons: [signal.reason] }, derivatives, decision.positionSizeUsdt);
      if (!eq.approved) {
        this.journal.record({ ...record, status: 'EQ_REJECTED', rejectionReason: eq.reason });
        this.log(signal.agent, `EQ BLOCK ${signal.symbol}: ${eq.reason}`, 'warn');
        this.counters.monitored += 1;
        continue;
      }
      const log = await this.executor.execute(signal, decision, decisionId);
      const executed: import('../decision/DecisionJournal.js').DecisionRecord = {
        ...record,
        execution: { ts: Date.now(), spreadBps: eq.spreadBps, slippageBps: eq.estimatedSlippageBps, effectiveCostBps: eq.effectiveCostBps },
        ...(log.level === 'success' ? { status: 'EXECUTED' as const } : {
          status: log.level === 'warn' ? 'EXECUTION_REFUSED' as const : 'EXECUTION_FAILED' as const,
          rejectionReason: log.msg,
        }),
      };
      this.journal.record(executed);
      this.log(log.agent, log.msg, log.level);
      this.hooks.onOrder(signal, decision, log, ctx);
      if (log.level === 'warn') this.counters.monitored += 1;
      if (startsCooldown(log.level, this.binance.getVenueStatus()?.state)) this.cooldownStartedAt.set(`${signal.symbol}:${signal.agent}`, Date.now());
      if (log.level === 'success') { this.counters.executed += 1; ctx = await refreshPortfolio(ctx, this.binance); }
    }
  }

  /** Delegates to the shared canonical builder so paper, live and replay produce identical records. */
  private buildDecisionRecord(decisionId: string, signal: Signal, ctx: MarketContext, decision: import('../types.js').RiskDecision): import('../decision/DecisionJournal.js').DecisionRecord {
    return buildDecisionRecord({
      decisionId,
      signal,
      state: ctx.marketState?.[signal.symbol],
      decision,
      evidence: decisionEvidence(signal, ctx.marketState?.[signal.symbol], this.fusionIntents.get(`${signal.symbol}:${signal.agent}`)),
      now: Date.now(),
    });
  }

  private isCoolingDown(signal: Signal): boolean {
    const cooldown = this.agents.find((a) => a.id === signal.agent)?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    return Date.now() - (this.cooldownStartedAt.get(`${signal.symbol}:${signal.agent}`) ?? 0) < cooldown;
  }

  private async isVetoed(signal: Signal, ctx: MarketContext): Promise<boolean> {
    const snapshot = this.adaptive.vetoSnapshot(signal, ctx);
    if (!snapshot) return false;
    const { verdict, reason } = await this.advisor.veto(snapshot);
    if (verdict === 'VETO') { this.log(signal.agent, `VETOED ${signal.type} ${signal.symbol}: ${reason}`, 'warn'); this.hooks.onVeto(signal, reason); }
    if (verdict === 'PROCEED' && reason.startsWith('advisor')) this.log(signal.agent, `veto skipped for ${signal.symbol}: ${reason}`, 'warn');
    return verdict === 'VETO';
  }
  private trailStops(positions: Position[], ctx: CycleContext): void {
    for (const pos of positions) {
      const adaptiveState = this.adaptive.stateFor(pos.symbol);
      const atr = adaptiveState?.assignedAtr ?? ctx.marketState?.[pos.symbol]?.timeframes?.['15m']?.atr14;
      if (!atr || atr <= 0) continue;
      const next = nextStops(pos, {
        assignedAtr: atr,
        regime: adaptiveState?.regime ?? (ctx.marketState?.[pos.symbol]?.regime?.volatility as 'LOW' | 'MEDIUM' | 'HIGH' | undefined),
        superTrend: pos.strategy === this.adaptive.id ? adaptiveState?.superTrend : undefined,
      });
      if (!next) continue;
      const stopLoss = roundPrice(pos.symbol, next.stopLoss);
      const takeProfit = roundPrice(pos.symbol, next.takeProfit);
      if (stopLoss === Number(pos.serverSl) && takeProfit === Number(pos.serverTp)) continue;
      this.binance.updateStops(pos.symbol, pos.strategy, stopLoss, takeProfit, pos.side);
      this.log(pos.strategy, `TRAIL ${pos.symbol} SL ${formatPrice(pos.symbol, stopLoss)} TP ${formatPrice(pos.symbol, takeProfit)}`, 'info');
    }
  }
  private logExits(): void { for (const line of this.binance.markAll(this.livePrices)) this.log('SYSTEM', line, 'warn'); this.hooks.onExit(this.binance.getTrades()); }
  private logFailure(what: string, err: unknown): void { this.log('SYSTEM', `${what}: ${errorText(err)}`, isRefusal(err) ? 'warn' : 'error'); }
  private async consultCouncil(state: import('../market/types.js').MarketState, setup: import('../decision/SetupTypes.js').SetupMap): Promise<void> {
    try {
      const result = await this.council.analyze(state, setup);
      if (!result) return;
      const votes = result.opinions.map((opinion) => opinion.persona + '=' + opinion.stance).join(' ');
      this.log('SYSTEM', 'AI-COUNCIL ' + state.symbol + ': ' + votes + ' | CHAIR=' + result.chair.action + '/' + result.chair.stance + ' ' + result.chair.rationale, 'info');
      if (!config.llmCouncil.autoTrade) return;
      const signal = buildCouncilSignal(state, setup, result, config.llmCouncil.minProbability);
      if (signal) {
        this.pendingCouncilSignals.push(signal);
        this.log('SYSTEM', `AI-COUNCIL queued ${signal.type} ${signal.symbol} for the next risk gate pass (${signal.reason})`, 'info');
      }
    } catch (err: unknown) {
      this.logFailure('AI council failed', err);
    }
  }

  /** Drains queued council signals, dropping anything the loop hasn't picked up within the TTL. */
  private drainCouncilSignals(): Signal[] {
    const now = Date.now();
    const [fresh, stale] = this.pendingCouncilSignals.reduce<[Signal[], Signal[]]>(
      ([keep, drop], s) => (now - s.ts <= COUNCIL_SIGNAL_TTL_MS ? [[...keep, s], drop] : [keep, [...drop, s]]),
      [[], []],
    );
    this.pendingCouncilSignals = [];
    for (const s of stale) this.log('SYSTEM', `AI-COUNCIL signal for ${s.symbol} expired unconsumed`, 'warn');
    return fresh;
  }

  private async consultAdvisor(signals: Signal[], positions: Position[]): Promise<void> {
    if (!signals.length) return;
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
    for (const state of Object.values(marketState)) {
      const { map: setup, transitions } = this.setupLedger.apply(buildSetupMap(state), state.timeframes['15m'].atr14 ?? 0);
      // Only material lifecycle events (created / advanced) are announced; re-derivations of the same setup are not
      if (transitions.some((t) => t.kind === 'CREATED' || t.kind === 'ADVANCED')) this.hooks.onSetup(setup);
      void this.consultCouncil(state, setup);
    }
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
      agents: fleetRuntimes(running, { adaptive: this.agents.includes(this.adaptive), structLiq: config.structLiq.enabled }), counters: this.counters,
      apiWeight: this.binance.getApiWeight(), wsStatus: this.binance.getWsStatus(), now: Date.now(),
      attributable: config.mode !== 'live', marketStates: ctx.marketState,
    });
  }

  private refreshLiveTickers(ctx: CycleContext): void {
    for (const [sym, t] of Object.entries(ctx.tickers)) {
      const closes = (ctx.candles[sym] ?? []).map((c: Candle) => c.close);
      const trend = this.adaptive.stateFor(sym)?.direction ?? ctx.marketState?.[sym]?.ltfStructure.trend;
      this.putTicker(sym, { ...t, price: this.livePrices[sym] ?? t.price, sparkline: sparkline(closes, 12), trend });
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
    const evidence = g.evidence ? ` ev ${Math.round(g.evidence.score)}` : '';
    this.log(g.trade.strategy, `GRADE ${g.grade} ${g.trade.symbol} ${g.rMultiple > 0 ? '+' : ''}${g.rMultiple}R${evidence} — ${g.commentary}`, g.trade.pnl >= 0 ? 'success' : 'warn');
  }
}
