import type { MarketContext } from '../agents/BaseAgent.js';
import { summarizePerformance } from '../binance/performance.js';
import type { VenueStatus } from '../binance/remoteBroker.js';
import { roundQty } from '../binance/symbolRules.js';
import type { PerformanceSnapshot } from '../risk/performanceEngine.js';
import type { ExitReason, LogEntry, Position, RiskDecision, Side, Signal, TradeRecord, WsStatus } from '../types.js';
import { makeAlert, type AlertClass, type AlertEvent, type AlertSeverity, type NotificationEngine } from './alerts.js';
import type { NotifySlot, NotifyStatus, PlanLevels, PlanResult, TradePlan, TradePlanLedger } from './tradePlans.js';
import { digestCard, signalCard, systemCard, tradeCard, type SignalCardInput, type SystemCardInput } from './cards.js';
import { buildSetupNotice } from './setupNotice.js';
import type { SetupMap } from '../decision/SetupEngine.js';
import type { AuditInput } from './eventStore.js';
import type { KillSwitchState } from './killSwitch.js';
import type { UnprotectedPosition } from '../risk/unprotected.js';

export interface OpsDeps {
  isAudit: boolean;
  isAlerts: boolean;
  store: { append(input: AuditInput): void };
  engine: Pick<NotificationEngine, 'submit' | 'release'>;
  send: (event: AlertEvent, html: string) => Promise<boolean>;
  /** The journal as it stood at start: those trades were already reported by an earlier run. */
  seedTrades?: readonly TradeRecord[];
  now?: () => number;
  /** Leave scenarios the quality gate rejected (NO_TRADE) out of setup cards. */
  hideNoTradeSetups?: boolean;
  refusalReannounceMs?: number;
  /** Durable record of each trade plan announced and what became of it. Absent in unit tests. */
  plans?: TradePlanLedger;
  /** TELEGRAM_DRY_RUN is on: a card that "succeeds" was only logged, so it is recorded as DRY_RUN. */
  dryRun?: boolean;
}

export interface DigestRequest {
  trades: readonly TradeRecord[];
  initialEquity: number;
  /** The scheduled instant; a timer that wakes a millisecond early must not label the wrong day. */
  at?: number;
}

export interface OpsHooks {
  onSignal(signal: Signal): void;
  onSetup(setup: SetupMap): void;
  /** `decisionId` is the lineage key of this gate evaluation; it names the trade plan when present. */
  onGate(signal: Signal, decision: RiskDecision, decisionId?: string): void;
  onVeto(signal: Signal, reason: string): void;
  onOrder(signal: Signal, decision: RiskDecision, log: LogEntry, ctx: Pick<MarketContext, 'positions' | 'marks'>, decisionId?: string): void;
  onRefusal(signal: Signal, reason: string): void;
  onExit(trades: readonly TradeRecord[]): void;
  onVenueState(venue: VenueStatus | null, ws: WsStatus): void;
  onCircuit(from: string, to: string, snapshot: PerformanceSnapshot): void;
  onLoopCrash(err: unknown): void;
  onKillSwitch(state: KillSwitchState): void;
  onUnprotected(positions: readonly UnprotectedPosition[], equity: number): void;
  digest(request: DigestRequest): void;
  /** Each cycle, with the venue's open positions: a fill the plan never saw is attributed to its plan. */
  onPositions(positions: readonly Position[]): void;
}

interface Notice {
  cls: AlertClass;
  severity: AlertSeverity;
  fingerprint: string;
  html: string;
  symbol?: string;
  stateTo?: string;
}

const DAY_MS = 86_400_000;
const REASON_KEY_CHARS = 80;
// A risk block is a standing state, not an event: say it once, then again only if the reason changes or after this long
const REFUSAL_REANNOUNCE_MS = 4 * 60 * 60_000;
// An unprotected position is a standing danger: say so when it appears or changes, then remind rarely
const UNPROTECTED_REMIND_MS = 6 * 60 * 60_000;

const noop = (): void => {};
const NOOP_HOOKS: OpsHooks = {
  onSignal: noop, onSetup: noop, onGate: noop, onVeto: noop, onOrder: noop, onRefusal: noop, onExit: noop, onVenueState: noop,
  onCircuit: noop, onLoopCrash: noop, onKillSwitch: noop, onUnprotected: noop, digest: noop, onPositions: noop,
};

const positionKey = (symbol: string, strategy: string): string => `${symbol}:${strategy}`;
const tradeKey = (t: TradeRecord): string => [t.closedAt, t.symbol, t.strategy, t.qty, t.exit, t.reason].join(':');
const sideOf = (signal: Signal): Side => (signal.type === 'OPEN_LONG' ? 'LONG' : 'SHORT');
const dayStartOf = (at: number): number => Math.floor(at / DAY_MS) * DAY_MS;
const sumPnl = (trades: readonly TradeRecord[]): number => trades.reduce((sum, t) => sum + t.pnl, 0);
const sumRefusals = (refusals: Record<string, number>): number => Object.values(refusals).reduce((sum, n) => sum + n, 0);

// Numbers are masked so "liq buffer 0.7x" and "liq buffer 0.9x" count and dedupe as one refusal
const reasonKey = (reason: string): string => reason.replace(/[\d.]+/g, '#').slice(0, REASON_KEY_CHARS);

// A funding hedge is short the perp
/** Thrown non-Errors (plain objects) stringify to "[object Object]"; keep their fields. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err !== 'object' || err === null) return String(err);
  try { return JSON.stringify(err); } catch { return Object.prototype.toString.call(err); }
}

function fillKind(signal: Signal, positions: MarketContext['positions']): 'OPEN' | 'SCALE_IN' | 'FLIP' {
  const held = positions?.find((p) => p.symbol === signal.symbol && p.strategy === signal.agent);
  if (!held) return 'OPEN';
  return held.side === sideOf(signal) ? 'SCALE_IN' : 'FLIP';
}

interface SignalNoticeInput { outcome: SignalCardInput['outcome']; signal: Signal; note: string; at: number; notionalUsdt?: number }

// A hedge has no entry/SL/TP to put on a signal card, so it is audited but not announced
function signalNotice({ outcome, signal, note, at, notionalUsdt }: SignalNoticeInput): Notice | undefined {
  const { entry, stopLoss, takeProfit } = signal;
  if (entry === undefined || stopLoss === undefined || takeProfit === undefined) return undefined;
  const html = signalCard({
    outcome, symbol: signal.symbol, side: sideOf(signal), entry, stopLoss, takeProfit, notionalUsdt,
    strategy: signal.agent, reason: signal.reason, note, at,
  });
  return {
    cls: 'SIGNAL', severity: outcome === 'ACCEPTED' ? 'SIGNAL' : 'WATCH', symbol: signal.symbol, stateTo: outcome, html,
    fingerprint: `SIGNAL:${signal.symbol}:${signal.agent}:${outcome}:${reasonKey(note)}`,
  };
}

function exitNotice(trade: TradeRecord): Notice {
  return {
    cls: 'TRADE', severity: trade.reason === 'LIQUIDATED' ? 'CRITICAL' : 'IMPORTANT', symbol: trade.symbol, stateTo: trade.reason,
    fingerprint: `TRADE:${trade.symbol}:${trade.closedAt}:exit`,
    html: tradeCard({ kind: 'EXIT', trade, initialRisk: trade.initialRisk }),
  };
}

function systemNotice(input: SystemCardInput, severity: AlertSeverity, fingerprint: string): Notice {
  return { cls: 'SYSTEM', severity, fingerprint, html: systemCard(input) };
}

/** The notification a card reports on, and which slot of the trade plan its delivery status belongs to. */
interface Delivery { readonly planId: string; readonly slot: NotifySlot }

/** A live position's identity: the signal that opened it (for the audit trail) and the plan that tracks its outcome. */
interface Lineage { readonly signalId: string; readonly planId: string }

// A plan exists only when the signal card does: a hedge carries no entry, stop or target, so it is audited but not planned
const planLevelsOf = (signal: Signal): PlanLevels | undefined => {
  const { entry, stopLoss, takeProfit } = signal;
  return entry === undefined || stopLoss === undefined || takeProfit === undefined ? undefined : { entry, stopLoss, takeProfit };
};

const RESULT_OF_EXIT: Readonly<Record<ExitReason, PlanResult>> = {
  'TAKE PROFIT': 'TP', 'STOP LOSS': 'SL', LIQUIDATED: 'LIQUIDATED', FLIP: 'FLIP', CLOSE: 'CLOSE', 'PARTIAL TP': 'CLOSE',
};

// A partial take-profit leaves the position open. It is journaled with the partial flag; the reason is checked too, so a lost flag cannot close a plan early
const isPartialExit = (trade: TradeRecord): boolean => trade.partial === true || trade.reason === 'PARTIAL TP';

// A live entry rests as a limit until the venue fills it; the executor says so with a SUBMITTED message
const RESTING_ENTRY = /^SUBMITTED\b/;
// Journal exits are matched to plans within this window, so a flip's close and its new fill can land in either order
const RECONCILE_TOLERANCE_MS = 5_000;

class Ops implements OpsHooks {
  private readonly now: () => number;
  private readonly seen: Set<string>;
  private readonly startTime: number;
  private readonly openIds = new Map<string, Lineage>();
  private readonly flippedIds = new Map<string, Lineage>();
  private refusals: Record<string, number> = {};
  private readonly announcedRefusals = new Map<string, number>();
  private unprotectedKey = '';
  private unprotectedAt = 0;
  private unprotectedSeq = 0;
  private lastVenueState: string | null = null;
  private lastWsStatus: WsStatus | null = null;
  private wasWsUp = false;

  private readonly refusalReannounceMs: number;

  constructor(private readonly deps: OpsDeps) {
    this.now = deps.now ?? Date.now;
    this.refusalReannounceMs = deps.refusalReannounceMs ?? REFUSAL_REANNOUNCE_MS;
    this.seen = new Set((deps.seedTrades ?? []).map(tradeKey));
    this.startTime = this.now();
    this.reconcile(deps.seedTrades ?? []);
  }

  onSignal = (signal: Signal): void => this.safely(() => this.audit('signal', { ...signal }, signal));

  onSetup = (setup: SetupMap): void => {
    this.safely(() => {
      const notice = buildSetupNotice(setup, { hideNoTrade: this.deps.hideNoTradeSetups ?? false });
      if (!notice) return;
      this.audit('setup', { state: setup.state, bias: setup.bias, scenarioIds: notice.scenarioKey }, { symbol: setup.symbol });
      this.notify(notice);
    });
  };
  onGate = (signal: Signal, decision: RiskDecision, decisionId?: string): void => {
    this.safely(() => {
      const { approved, reason, positionSizeUsdt: sizeUsdt, leverage } = decision;
      this.audit('gate', { approved, reason, sizeUsdt, leverage }, signal);
      if (!approved) return;
      // The plan is announced whether or not the card reaches Telegram: the position is real either way
      const delivery = this.announce(signal, decisionId ?? signal.id, { sizeUsdt, leverage, decisionId });
      this.notify(signalNotice({ outcome: 'ACCEPTED', signal, note: reason, at: this.now(), notionalUsdt: sizeUsdt }), delivery);
    });
  };
  onVeto = (signal: Signal, reason: string): void => {
    this.safely(() => {
      this.audit('veto', { reason }, signal);
      this.notify(signalNotice({ outcome: 'VETOED', signal, note: reason, at: this.now() }));
    });
  };
  onRefusal = (signal: Signal, reason: string): void => this.safely(() => this.refuse(signal, reason));
  onOrder = (signal: Signal, decision: RiskDecision, log: LogEntry, ctx: Pick<MarketContext, 'positions' | 'marks'>, decisionId?: string): void => {
    this.safely(() => {
      this.audit('order', { level: log.level, message: log.msg, sizeUsdt: decision.positionSizeUsdt, leverage: decision.leverage }, signal);
      const planId = decisionId ?? signal.id;
      if (log.level === 'warn') {
        this.refuse(signal, log.msg);
        this.deps.plans?.notFilled(planId, this.now(), log.msg);
      }
      if (log.level === 'success') this.filled(signal, decision, ctx, planId, RESTING_ENTRY.test(log.msg));
    });
  };
  // Detects closes from the journal rather than from log text, so exits the loop never logged (reconcile, liquidation) are still reported
  onExit = (trades: readonly TradeRecord[]): void => {
    this.safely(() => {
      for (const trade of trades) {
        const key = tradeKey(trade);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        // Trades closed before this session started were already reported by earlier runs
        if (trade.closedAt <= this.startTime) continue;
        this.recordExit(trade);
      }
    });
  };
  onVenueState = (venue: VenueStatus | null, ws: WsStatus): void => {
    this.safely(() => { this.noteVenue(venue); this.noteWs(ws); });
  };
  onCircuit = (from: string, to: string, snapshot: PerformanceSnapshot): void => {
    this.safely(() => {
      const { dailyLossPercent, drawdownPercent, lossStreak } = snapshot;
      this.audit('circuit', { from, to, dailyLossPercent, drawdownPercent, lossStreak });
      const severity = to === 'HALTED' || to === 'EMERGENCY' ? 'CRITICAL' : 'IMPORTANT';
      const input: SystemCardInput = { kind: 'CIRCUIT', from, to, dailyLossPercent, drawdownPercent, lossStreak, at: this.now() };
      this.notify(systemNotice(input, severity, `SYSTEM:circuit:${to}`));
    });
  };
  onLoopCrash = (err: unknown): void => {
    this.safely(() => {
      const error = describeError(err);
      this.audit('crash', { error });
      this.notify(systemNotice({ kind: 'LOOP_CRASH', error, at: this.now() }, 'CRITICAL', `SYSTEM:crash:${reasonKey(error)}`));
    });
  };
  onKillSwitch = (state: KillSwitchState): void => {
    this.safely(() => {
      this.audit('killswitch', { halted: state.halted, reason: state.reason });
      const input: SystemCardInput = { kind: 'KILL_SWITCH', halted: state.halted, reason: state.reason, at: this.now() };
      // Keyed on the toggle time: two manual toggles inside one cooldown are two distinct operator actions
      this.notify(systemNotice(input, 'CRITICAL', `SYSTEM:killswitch:${state.at}`));
    });
  };
  onUnprotected = (positions: readonly UnprotectedPosition[], equity: number): void => {
    this.safely(() => {
      if (positions.length === 0) { this.unprotectedKey = ''; return; }
      // Frequency is decided here, so each announcement gets its own fingerprint rather than fighting the engine's cooldown
      // Sizes drift with price; identity is the set of symbols and sides
      const key = positions.map((p) => `${p.symbol}:${p.side}`).sort().join(',');
      const now = this.now();
      if (key === this.unprotectedKey && now - this.unprotectedAt < UNPROTECTED_REMIND_MS) return;
      this.unprotectedKey = key;
      this.unprotectedAt = now;
      this.audit('unprotected', { positions: positions.map((p) => ({ ...p })), equity });
      this.notify(systemNotice({ kind: 'UNPROTECTED', positions, equity, at: now }, 'CRITICAL', `SYSTEM:unprotected:${key}:${this.unprotectedSeq++}`));
    });
  };
  // The digest covers the UTC day that just ended; its equity baseline is the wallet before that day's realized PnL
  digest = ({ trades, initialEquity, at = this.now() }: DigestRequest): void => {
    this.safely(() => {
      const end = dayStartOf(at);
      const day = trades.filter((t) => t.closedAt >= end - DAY_MS && t.closedAt < end);
      const startEquity = initialEquity + sumPnl(trades.filter((t) => t.closedAt < end - DAY_MS));
      const summary = summarizePerformance([...day], startEquity, startEquity + sumPnl(day), at);
      const period = `${new Date(end - DAY_MS).toISOString().slice(0, 10)} UTC`;
      const html = digestCard({ period, summary, trades: day, refusals: this.refusals, at });
      this.audit('digest', { period, trades: day.length, pnl: sumPnl(day), refusals: sumRefusals(this.refusals) });
      this.refusals = {};
      this.notify({ cls: 'RESEARCH', severity: 'WATCH', fingerprint: `RESEARCH:digest:${period}`, html });
    });
  };
  /**
   * A plan can be left ANNOUNCED while its position is open: a live limit fills without a fill event reaching us, or the
   * bot restarted while it rested. A venue position with no filled plan takes the newest announced plan for its symbol,
   * strategy and side. Recorded as a fill, so its exit is linked.
   */
  onPositions = (positions: readonly Position[]): void => {
    this.safely(() => {
      const plans = this.deps.plans;
      if (!plans) return;
      for (const position of positions) {
        const key = positionKey(position.symbol, position.strategy);
        const lineage = this.openIds.get(key);
        const linked = lineage ? plans.get(lineage.planId) : undefined;
        if (linked) {
          if (linked.status === 'ANNOUNCED') plans.fill(linked.planId, this.now());
          continue;
        }
        const candidate = plans.all()
          .filter((p) => p.source === 'SIGNAL' && p.status === 'ANNOUNCED'
            && p.symbol === position.symbol && p.strategy === position.strategy && p.side === position.side)
          .sort((a, b) => b.announcedAt - a.announcedAt)[0];
        if (!candidate) continue;
        if (plans.fill(candidate.planId, this.now()).applied) {
          const signalId = typeof candidate.meta.signalId === 'string' ? candidate.meta.signalId : candidate.planId;
          this.openIds.set(key, { signalId, planId: candidate.planId });
        }
      }
    });
  };

  private safely(run: () => void): void {
    try { run(); } catch { /* an ops failure must never reach the trading loop */ }
  }
  private audit(type: string, payload: Record<string, unknown>, ref?: { id?: string; symbol?: string }): void {
    if (!this.deps.isAudit) return;
    try {
      this.deps.store.append({ type, payload, decisionId: ref?.id, symbol: ref?.symbol, at: this.now() });
    } catch {
      // The audit trail is best effort; the trade it describes has already happened
    }
  }

  private notify(notice: Notice | undefined, delivery?: Delivery): void {
    if (!notice) return;
    if (!this.deps.isAlerts) { this.reportDelivery(delivery, 'NOT_ATTEMPTED'); return; }
    try {
      const event = makeAlert({
        class: notice.cls, severity: notice.severity, symbol: notice.symbol, title: notice.fingerprint, body: notice.html,
        fingerprint: notice.fingerprint, stateTo: notice.stateTo, at: this.now(),
      });
      if (this.deps.engine.submit(event).action !== 'emitted') { this.reportDelivery(delivery, 'SUPPRESSED'); return; }
      // Fire and forget: trading never waits on Telegram. The delivery result is recorded when it lands.
      // A failed delivery gives the dedupe slot back, so the next identical event still goes out
      const failed = (): void => { this.deps.engine.release(event); this.reportDelivery(delivery, 'FAILED'); };
      void this.deps.send(event, notice.html).then(
        (ok) => { if (ok) this.reportDelivery(delivery, this.deps.dryRun ? 'DRY_RUN' : 'SENT'); else failed(); },
        failed,
      );
    } catch {
      // A broken alert path must not cost the caller its own work
      this.reportDelivery(delivery, 'NOT_ATTEMPTED');
    }
  }

  private reportDelivery(delivery: Delivery | undefined, status: NotifyStatus): void {
    if (delivery) this.deps.plans?.notify(delivery.planId, delivery.slot, status, this.now());
  }

  /** Opens the plan for an approved entry. Returns the announce slot only when the plan was actually written. */
  private announce(signal: Signal, planId: string, sizing: { sizeUsdt: number; leverage: number; decisionId?: string }): Delivery | undefined {
    const plans = this.deps.plans;
    const planned = planLevelsOf(signal);
    if (!plans || !planned) return undefined;
    const meta: Record<string, string | number> = { signalId: signal.id, notionalUsdt: sizing.sizeUsdt, leverage: sizing.leverage };
    if (sizing.decisionId !== undefined) meta.decisionId = sizing.decisionId;
    const result = plans.announce({
      planId, source: 'SIGNAL', symbol: signal.symbol, side: sideOf(signal), strategy: signal.agent, at: this.now(), planned, meta,
    });
    return result.applied ? { planId, slot: 'announce' } : undefined;
  }

  private refuse(signal: Signal, reason: string): void {
    const key = reasonKey(reason);
    this.refusals[key] = (this.refusals[key] ?? 0) + 1;
    this.audit('refusal', { reason }, signal);
    const blockKey = `${signal.symbol}:${signal.agent}:${signal.type}:${key}`;
    const announcedAt = this.announcedRefusals.get(blockKey);
    if (announcedAt !== undefined && this.now() - announcedAt < this.refusalReannounceMs) return;
    this.announcedRefusals.set(blockKey, this.now());
    this.notify(signalNotice({ outcome: 'REFUSED', signal, note: reason, at: this.now() }));
  }

  private filled(signal: Signal, decision: RiskDecision, ctx: Pick<MarketContext, 'positions' | 'marks'>, planId: string, resting: boolean): void {
    const kind = fillKind(signal, ctx.positions);
    const key = positionKey(signal.symbol, signal.agent);
    const previous = this.openIds.get(key);
    if (kind === 'FLIP' && previous !== undefined) this.flippedIds.set(key, previous);
    this.openIds.set(key, { signalId: signal.id, planId });
    // A resting limit is not a position yet; its plan stays ANNOUNCED until a realized close shows it filled
    if (!resting) this.deps.plans?.fill(planId, this.now());
    const price = signal.entry ?? ctx.marks[signal.symbol];
    if (!price) return;
    const qty = roundQty(signal.symbol, decision.positionSizeUsdt / price);
    this.notify({
      cls: 'TRADE', severity: 'SIGNAL', symbol: signal.symbol, stateTo: kind, fingerprint: `TRADE:${signal.id}:fill`,
      html: tradeCard({ kind, symbol: signal.symbol, side: sideOf(signal), qty, price, strategy: signal.agent, leverage: decision.leverage, at: this.now() }),
    });
  }

  private recordExit(trade: TradeRecord): void {
    const key = positionKey(trade.symbol, trade.strategy);
    // The flip's exit can be journaled before onOrder files the old lineage away, so fall back to the open one
    const lineages = trade.reason === 'FLIP' && this.flippedIds.has(key) ? this.flippedIds : this.openIds;
    const lineage = lineages.get(key);
    const ref = { id: lineage?.signalId, symbol: trade.symbol };
    // A partial take-profit leaves the position open, so its lineage must survive for the final close
    if (!isPartialExit(trade)) lineages.delete(key);
    this.audit('exit', { reason: trade.reason, exit: trade.exit, pnl: trade.pnl }, ref);
    this.audit('journal', { ...trade }, ref);
    this.notify(exitNotice(trade), this.recordOutcome(trade, lineage?.planId));
  }

  /** Writes a close or partial into the plan. Returns the close slot only for a full exit, so a partial's card is not filed as the close. */
  private recordOutcome(trade: TradeRecord, planId: string | undefined): Delivery | undefined {
    const plans = this.deps.plans;
    if (!plans || planId === undefined) return undefined;
    if (isPartialExit(trade)) {
      plans.partial(planId, { at: trade.closedAt, exitPrice: trade.exit, pnl: trade.pnl });
      return undefined;
    }
    const result = RESULT_OF_EXIT[trade.reason] ?? 'CLOSE';
    const applied = plans.close(planId, { at: trade.closedAt, result, exitPrice: trade.exit, entryPrice: trade.entry, pnl: trade.pnl });
    return applied.applied ? { planId, slot: 'close' } : undefined;
  }

  /**
   * Plans filled before this process started. The journal says whether each position closed while we were down.
   * Plans for one position are ordered by fill: a newer fill proves the older position ended, so an older plan with no
   * journaled close is UNOBSERVED. The newest plan with no close is still open, and its lineage is re-adopted.
   */
  private reconcile(trades: readonly TradeRecord[]): void {
    const plans = this.deps.plans;
    if (!plans) return;
    const byPosition = new Map<string, TradePlan[]>();
    for (const plan of plans.all()) {
      if (plan.source !== 'SIGNAL' || plan.status !== 'FILLED' || plan.filledAt === null) continue;
      const key = positionKey(plan.symbol, plan.strategy);
      byPosition.set(key, [...(byPosition.get(key) ?? []), plan]);
    }
    for (const [key, list] of byPosition) {
      list.sort((a, b) => (a.filledAt ?? 0) - (b.filledAt ?? 0));
      list.forEach((plan, i) => {
        const next = list[i + 1];
        const since = plan.filledAt ?? 0;
        const until = next && next.filledAt !== null ? next.filledAt + RECONCILE_TOLERANCE_MS : Infinity;
        const mine = trades
          .filter((t) => t.symbol === plan.symbol && t.strategy === plan.strategy && t.closedAt >= since && t.closedAt <= until)
          .sort((a, b) => a.closedAt - b.closedAt);
        for (const t of mine) if (isPartialExit(t)) this.recordOutcome(t, plan.planId);
        const closing = mine.find((t) => !isPartialExit(t));
        if (closing) {
          this.recordOutcome(closing, plan.planId);
        } else if (next) {
          plans.close(plan.planId, { at: next.filledAt ?? since, result: 'UNOBSERVED', exitPrice: null, pnl: null });
        } else {
          const signalId = typeof plan.meta.signalId === 'string' ? plan.meta.signalId : plan.planId;
          this.openIds.set(key, { signalId, planId: plan.planId });
        }
      });
    }
  }

  private noteVenue(venue: VenueStatus | null): void {
    if (venue === null || venue.state === this.lastVenueState) return;
    const previous = this.lastVenueState;
    this.lastVenueState = venue.state;
    this.audit('venue', { venue: venue.name, state: venue.state, error: venue.lastError ?? undefined });
    const state = venue.state === 'connected' ? (previous === null ? undefined : 'recovered') : venue.state;
    if (state === undefined) return;
    const input: SystemCardInput = { kind: 'VENUE', state, venue: venue.name, account: venue.accountId, detail: venue.lastError ?? undefined, at: this.now() };
    this.notify(systemNotice(input, state === 'down' ? 'CRITICAL' : 'IMPORTANT', `SYSTEM:venue:${state}`));
  }

  // The socket starts down before it first opens; only a drop after it was up is news
  private noteWs(ws: WsStatus): void {
    if (ws === this.lastWsStatus) return;
    this.lastWsStatus = ws;
    const wasUp = this.wasWsUp;
    this.wasWsUp = this.wasWsUp || ws === 'connected';
    if (!wasUp) return;
    this.audit('venue', { ws });
    const severity = ws === 'reconnecting' ? 'WATCH' : 'IMPORTANT';
    this.notify(systemNotice({ kind: 'WS', status: ws, at: this.now() }, severity, `SYSTEM:ws:${ws}`));
  }
}

/** Audit-trail and alert hooks for the trading loop; with both flags off every hook is a no-op, and no hook can throw. */
export function createOps(deps: OpsDeps): OpsHooks {
  return deps.isAudit || deps.isAlerts ? new Ops(deps) : NOOP_HOOKS;
}
