import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Trade-plan ledger: one row per trade the operator was told about (or that the system entered on its own),
 * kept current through its lifecycle so "what did this card turn into?" has a durable answer.
 *
 *   ANNOUNCED ──fill──▶ FILLED ──close──▶ CLOSED
 *       │                  │
 *       │                  └─partial─▶ (stays FILLED, partial recorded)
 *       ├──close (fill missed by us, realized exit observed)──▶ CLOSED
 *       └──notFilled──▶ NOT_FILLED
 *
 * Every transition appends a full snapshot of the plan (JSONL); on load the last snapshot per planId wins, so a
 * restart replays to the same state. Transitions out of order are refused, never applied. Writes never throw:
 * the in-memory state is updated either way and `lastError` records a failed append.
 */

export type PlanSource = 'SIGNAL' | 'FLEET' | 'SNIPER';
export type PlanSide = 'LONG' | 'SHORT';
export type PlanStatus = 'ANNOUNCED' | 'FILLED' | 'NOT_FILLED' | 'CLOSED';
/**
 * What ended the position. UNOBSERVED: the position was superseded by a newer fill while nothing recorded its exit,
 * so its real outcome is unknown and must not be read as a win or a loss.
 */
export type PlanResult = 'TP' | 'SL' | 'BREAK_EVEN' | 'TIME_STOP' | 'CLOSE' | 'FLIP' | 'LIQUIDATED' | 'UNOBSERVED';
/**
 * Whether the card reached the chat. SUPPRESSED: our own subscription or dedupe dropped it. NOT_ATTEMPTED: alerts off,
 * or no card was built. A dry-run send counts as SENT, since the sender reports success.
 */
export type NotifyStatus = 'NOT_ATTEMPTED' | 'SENT' | 'FAILED' | 'SUPPRESSED';
/** `announce`: the card that opened the plan. `close`: the card that reported its exit. */
export type NotifySlot = 'announce' | 'close';

export interface PlanLevels { readonly entry: number; readonly stopLoss: number; readonly takeProfit: number }
export interface PartialExit { readonly at: number; readonly exitPrice: number; readonly pnl: number }
export type PlanMeta = Readonly<Record<string, string | number>>;

export interface TradePlan {
  readonly planId: string;
  readonly source: PlanSource;
  readonly symbol: string;
  readonly side: PlanSide;
  readonly strategy: string;
  readonly status: PlanStatus;
  readonly announcedAt: number;
  /** The levels the operator was shown. The R unit is the distance from the planned entry to the planned stop. */
  readonly planned: PlanLevels;
  readonly announceNotify: NotifyStatus;
  readonly closeNotify: NotifyStatus;
  readonly filledAt: number | null;
  /** Realized average entry when the source reports one; null when unknown. */
  readonly entryPrice: number | null;
  readonly closedAt: number | null;
  readonly exitPrice: number | null;
  readonly result: PlanResult | null;
  /** Realized PnL in USD as the source reports it. */
  readonly pnl: number | null;
  /** Realized move in units of the planned risk: +2 is two R in the trade's favour. Null when the exit is unknown. */
  readonly rMultiple: number | null;
  readonly partials: readonly PartialExit[];
  readonly note: string | null;
  readonly meta: PlanMeta;
  readonly updatedAt: number;
}

export interface AnnounceInput {
  readonly planId: string;
  readonly source: PlanSource;
  readonly symbol: string;
  readonly side: PlanSide;
  readonly strategy: string;
  readonly at: number;
  readonly planned: PlanLevels;
  readonly meta?: PlanMeta;
}

export interface CloseInput {
  readonly at: number;
  readonly result: PlanResult;
  readonly exitPrice: number | null;
  readonly entryPrice?: number | null;
  readonly pnl: number | null;
}

export interface PartialInput { readonly at: number; readonly exitPrice: number; readonly pnl: number }

export type Transition =
  | { readonly applied: true; readonly plan: TradePlan }
  | { readonly applied: false; readonly reason: string };

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/** Signed move in units of the planned risk (|planned entry − planned stop|). Null when the risk or a price is unusable. */
export function rMultipleOf(side: PlanSide, planned: PlanLevels, entry: number, exit: number): number | null {
  const risk = Math.abs(planned.entry - planned.stopLoss);
  if (!(risk > 0) || !finite(entry) || !finite(exit)) return null;
  return ((side === 'LONG' ? 1 : -1) * (exit - entry)) / risk;
}

// A plan whose stop or target sits on the wrong side of its entry cannot be measured, so it is refused rather than recorded
const validLevels = (levels: PlanLevels, side: PlanSide): boolean => {
  if (![levels.entry, levels.stopLoss, levels.takeProfit].every((v) => finite(v) && v > 0)) return false;
  return side === 'LONG'
    ? levels.stopLoss < levels.entry && levels.takeProfit > levels.entry
    : levels.stopLoss > levels.entry && levels.takeProfit < levels.entry;
};

const reject = (reason: string): Transition => ({ applied: false, reason });

const isPlan = (value: unknown): value is TradePlan => {
  if (value === null || typeof value !== 'object') return false;
  const p = value as Partial<TradePlan>;
  return typeof p.planId === 'string' && typeof p.status === 'string' && typeof p.source === 'string'
    && p.planned !== undefined && p.planned !== null && Array.isArray(p.partials);
};

export class TradePlanLedger {
  lastError?: string;
  private readonly plans = new Map<string, TradePlan>();
  private needsLeadingNewline = false;

  /** `null` keeps the ledger in memory only (tests, dry runs). */
  constructor(private readonly filePath: string | null = null) {
    this.load();
  }

  get(planId: string): TradePlan | undefined { return this.plans.get(planId); }
  all(): TradePlan[] { return [...this.plans.values()]; }

  /** Plans for one source and symbol that still await their outcome, newest first. */
  openFor(source: PlanSource, symbol: string): TradePlan[] {
    return this.all()
      .filter((p) => p.source === source && p.symbol === symbol && (p.status === 'ANNOUNCED' || p.status === 'FILLED'))
      .sort((a, b) => b.announcedAt - a.announcedAt);
  }

  announce(input: AnnounceInput): Transition {
    if (this.plans.has(input.planId)) return reject(`duplicate plan ${input.planId}`);
    if (!validLevels(input.planned, input.side)) return reject(`invalid levels for ${input.planId}`);
    return this.commit({
      planId: input.planId, source: input.source, symbol: input.symbol, side: input.side, strategy: input.strategy,
      status: 'ANNOUNCED', announcedAt: input.at, planned: input.planned,
      announceNotify: 'NOT_ATTEMPTED', closeNotify: 'NOT_ATTEMPTED',
      filledAt: null, entryPrice: null, closedAt: null, exitPrice: null, result: null, pnl: null, rMultiple: null,
      partials: [], note: null, meta: input.meta ?? {}, updatedAt: input.at,
    });
  }

  /** Records whether a card reached the chat. Allowed in any state: a close card can land after the plan closed. */
  notify(planId: string, slot: NotifySlot, status: NotifyStatus, at: number): Transition {
    const plan = this.plans.get(planId);
    if (!plan) return reject(`unknown plan ${planId}`);
    return this.commit(slot === 'announce'
      ? { ...plan, announceNotify: status, updatedAt: at }
      : { ...plan, closeNotify: status, updatedAt: at });
  }

  fill(planId: string, at: number): Transition {
    const plan = this.plans.get(planId);
    if (!plan) return reject(`unknown plan ${planId}`);
    if (plan.status !== 'ANNOUNCED') return reject(`fill from ${plan.status}`);
    return this.commit({ ...plan, status: 'FILLED', filledAt: at, updatedAt: at });
  }

  notFilled(planId: string, at: number, note: string): Transition {
    const plan = this.plans.get(planId);
    if (!plan) return reject(`unknown plan ${planId}`);
    if (plan.status !== 'ANNOUNCED') return reject(`not-filled from ${plan.status}`);
    return this.commit({ ...plan, status: 'NOT_FILLED', note, updatedAt: at });
  }

  /** A partial take-profit: the plan stays open. Replaying the same partial (same `at`) is a no-op. */
  partial(planId: string, input: PartialInput): Transition {
    const plan = this.plans.get(planId);
    if (!plan) return reject(`unknown plan ${planId}`);
    if (plan.status !== 'ANNOUNCED' && plan.status !== 'FILLED') return reject(`partial on ${plan.status}`);
    if (plan.partials.some((p) => p.at === input.at)) return reject(`duplicate partial at ${input.at}`);
    return this.commit({ ...plan, partials: [...plan.partials, input], updatedAt: input.at });
  }

  /**
   * The position ended. Allowed from ANNOUNCED as well as FILLED: a resting live limit fills without a fill event
   * reaching us, and the realized close is the authoritative record that it did.
   */
  close(planId: string, input: CloseInput): Transition {
    const plan = this.plans.get(planId);
    if (!plan) return reject(`unknown plan ${planId}`);
    if (plan.status !== 'ANNOUNCED' && plan.status !== 'FILLED') return reject(`close from ${plan.status}`);
    const entryPrice = finite(input.entryPrice) ? input.entryPrice : null;
    const measuredEntry = entryPrice ?? plan.planned.entry;
    const rMultiple = finite(input.exitPrice) ? rMultipleOf(plan.side, plan.planned, measuredEntry, input.exitPrice) : null;
    return this.commit({
      ...plan, status: 'CLOSED', result: input.result, closedAt: input.at, exitPrice: input.exitPrice,
      entryPrice, pnl: input.pnl, rMultiple, updatedAt: input.at,
    });
  }

  private commit(plan: TradePlan): Transition {
    this.plans.set(plan.planId, plan);
    this.persist(plan);
    return { applied: true, plan };
  }

  private persist(plan: TradePlan): void {
    if (!this.filePath) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      // A torn last line from a crash must not fuse with the first new row
      const prefix = this.needsLeadingNewline ? '\n' : '';
      appendFileSync(this.filePath, `${prefix}${JSON.stringify(plan)}\n`);
      this.needsLeadingNewline = false;
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    let text: string;
    try {
      text = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }
    this.needsLeadingNewline = text.length > 0 && !text.endsWith('\n');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isPlan(parsed)) this.plans.set(parsed.planId, parsed);
      } catch {
        // A torn line from a crash is skipped; the rest of the ledger is still usable
      }
    }
  }
}

export interface PlanSummary {
  readonly total: number;
  readonly open: number;
  /** Closed with a known outcome. UNOBSERVED plans are excluded: their result is unknown. */
  readonly closed: number;
  readonly unobserved: number;
  readonly notFilled: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number | null;
  /** Mean realized R over closed plans that carry an R multiple. */
  readonly meanR: number | null;
  /** Sum of realized PnL over closed plans that report one. */
  readonly totalPnl: number;
  /** Cards that were attempted and failed to reach the chat, on either slot. */
  readonly cardsFailed: number;
}

/** Aggregates plans for the report. Pure: the same plans always give the same summary. */
export function summarizeTradePlans(plans: readonly TradePlan[]): PlanSummary {
  const closedKnown = plans.filter((p) => p.status === 'CLOSED' && p.result !== 'UNOBSERVED');
  const withPnl = closedKnown.filter((p) => finite(p.pnl));
  const withR = closedKnown.filter((p) => finite(p.rMultiple));
  const wins = withPnl.filter((p) => (p.pnl ?? 0) > 0).length;
  const losses = withPnl.filter((p) => (p.pnl ?? 0) < 0).length;
  const meanR = withR.length > 0 ? withR.reduce((sum, p) => sum + (p.rMultiple ?? 0), 0) / withR.length : null;
  return {
    total: plans.length,
    open: plans.filter((p) => p.status === 'ANNOUNCED' || p.status === 'FILLED').length,
    closed: closedKnown.length,
    unobserved: plans.filter((p) => p.result === 'UNOBSERVED').length,
    notFilled: plans.filter((p) => p.status === 'NOT_FILLED').length,
    wins,
    losses,
    winRate: withPnl.length > 0 ? wins / withPnl.length : null,
    meanR,
    totalPnl: withPnl.reduce((sum, p) => sum + (p.pnl ?? 0), 0),
    cardsFailed: plans.filter((p) => p.announceNotify === 'FAILED' || p.closeNotify === 'FAILED').length,
  };
}
