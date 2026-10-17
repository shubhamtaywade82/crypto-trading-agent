import { randomBytes } from 'node:crypto';
import type { AgentId, Side } from '../types.js';
import type { EntryRecord } from './liveBook.js';
import { OrderInFlightError } from './remoteOrders.js';

/** How often a live entry is polled while it works. */
export const LIVE_ENTRY_POLL_MS = 1_000;

/**
 * Statuses that end an order. Anything else counts as still working, including a status this code has not seen: an order
 * that may still fill must keep its protection in step, and the entry stays blocked until it is known to be over.
 * EXPIRED_IN_MATCH is not in the typings this repo uses, but Binance reports it for self-trade prevention, so it ends the order too.
 * UNKNOWN_ORDER is not a Binance status: the port reports it when the venue has no such order, which means it never filled.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'UNKNOWN_ORDER']);
export const isWorking = (status: string): boolean => !TERMINAL_STATUSES.has(status);

/** The venue answered with an error code (its REST body carries a numeric `code`), so the order was refused and never placed. A timeout or dropped connection carries no code and proves nothing. */
export const venueRejected = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'number';

/** Binance caps newClientOrderId at 36 characters. Epoch milliseconds plus random bytes keep it unique across restarts. */
export function liveEntryClientOrderId(nowMs: number): string {
  return `e${nowMs.toString(36)}${randomBytes(6).toString('hex')}`;
}

/** Binance side of an entry: LONG buys, SHORT sells. */
export const orderSideOf = (side: Side): 'BUY' | 'SELL' => (side === 'LONG' ? 'BUY' : 'SELL');

export interface LiveEntryJob {
  symbol: string;
  side: Side;
  clientOrderId: string;
  strategy: AgentId;
  stopLoss: number;
  takeProfit: number | null;
  decisionId?: string;
  submittedAt: number;
}

export interface LegIds {
  stopOrderId?: number;
  tpOrderId?: number;
}

export interface EntryOrderState {
  status: string;
  executedQty: number;
}

/** What the tracker needs from the venue. BinanceService implements it against USD-M; tests use a fake. */
export interface LiveEntryPort {
  orderState(symbol: string, clientOrderId: string): Promise<EntryOrderState>;
  cancelOrder(symbol: string, clientOrderId: string): Promise<void>;
  /** Absolute size of the symbol's position on the venue; 0 when flat. */
  positionQty(symbol: string): Promise<number>;
  /** closePosition STOP_MARKET and TAKE_PROFIT_MARKET legs. `qty` is the position they protect; it is used only by the emergency close inside a failed STOP. */
  placeLegs(job: LiveEntryJob, qty: number): Promise<LegIds>;
  /** Cancels those of the legs that are still open on the venue; legs that already triggered are not an error. */
  cancelLegs(symbol: string, legs: LegIds): Promise<void>;
  /** Cancels every open order on the symbol, removing any leg that was placed and any entry still resting. */
  cancelAllOpen(symbol: string): Promise<void>;
  /** Reduce-only market close of `qty` on the side of the position. */
  flatten(symbol: string, side: Side, qty: number): Promise<void>;
  recordEntry(entry: EntryRecord): void;
}

export interface LiveEntryOptions {
  ttlMs: number;
  pollMs: number;
  log(message: string, level: 'info' | 'warn' | 'error'): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

interface EntryContext {
  /** The live legs, sized to `legsQty`. */
  legs: LegIds | null;
  /** Position size the live legs protect; 0 when there are none. */
  legsQty: number;
  /** Superseded or orphaned legs that still have to be cancelled. The entry is not resolved while any remain. */
  stale: LegIds[];
  cancelSent: boolean;
  overdueLogged: boolean;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Follows one live entry from submission to resolution.
 *
 * - Single-flight. A resting entry is exposure that the risk gate cannot see (it counts positions only), so a second
 *   entry is refused until the first resolves.
 * - Protection follows the venue position size. Whenever it changes, the legs are re-placed for the new size: new legs
 *   go up first and the old ones are cancelled after, so the position is never unprotected in between.
 * - Resolved only when the order is terminal, the legs match the final position, and no stale leg remains.
 * - A failed protection cancels every open order on the symbol and flattens the position. If that also fails, the
 *   tracker retries and stays busy, so no new entry starts while exposure may be unprotected.
 */
export class LiveEntryTracker {
  private holder: { symbol: string; clientOrderId?: string } | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly port: LiveEntryPort, private readonly options: LiveEntryOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get busy(): boolean {
    return this.holder !== null;
  }

  /** Claims the slot before any await, so two concurrent entries cannot both pass the check. */
  reserve(symbol: string): void {
    if (this.holder) throw new OrderInFlightError(`${this.holder.symbol} entry is still working: ${symbol} waits for it to resolve`);
    this.holder = { symbol };
  }

  /** Gives back a reservation whose order was never submitted. */
  release(symbol: string): void {
    if (this.holder?.symbol === symbol && this.holder.clientOrderId === undefined) this.holder = null;
  }

  /** Follows a submitted entry until it resolves. Detached: the caller does not wait, and the promise never rejects. */
  track(job: LiveEntryJob): Promise<void> {
    this.holder = { symbol: job.symbol, clientOrderId: job.clientOrderId };
    return this.resolve(job)
      .catch((err: unknown) => this.options.log(`${job.symbol} entry ${job.clientOrderId}: tracking stopped: ${errorText(err)}`, 'error'))
      .finally(() => { this.holder = null; });
  }

  private async resolve(job: LiveEntryJob): Promise<void> {
    const ctx: EntryContext = { legs: null, legsQty: 0, stale: [], cancelSent: false, overdueLogged: false };
    for (;;) {
      try {
        if (await this.step(job, ctx)) return;
      } catch (err) {
        this.options.log(`${job.symbol} entry ${job.clientOrderId}: venue call failed, retrying: ${errorText(err)}`, 'warn');
      }
      await this.sleep(this.options.pollMs);
    }
  }

  /** One pass over the venue. Returns true once resolved. Any throw means "not resolved yet"; the caller retries. */
  private async step(job: LiveEntryJob, ctx: EntryContext): Promise<boolean> {
    const { symbol, clientOrderId } = job;
    const order = await this.port.orderState(symbol, clientOrderId);
    const held = await this.port.positionQty(symbol);
    if (held !== ctx.legsQty || (held === 0 && ctx.legs !== null)) await this.syncLegs(job, held, ctx);
    await this.cancelStale(symbol, ctx);

    if (!isWorking(order.status) && held === ctx.legsQty && ctx.stale.length === 0) {
      const protection = ctx.legsQty > 0 ? `protected ${ctx.legsQty}` : 'no position';
      this.options.log(`${symbol} entry ${clientOrderId} ${order.status}: executed ${order.executedQty}, ${protection}`, ctx.legsQty > 0 ? 'info' : 'warn');
      return true;
    }

    const deadline = job.submittedAt + this.options.ttlMs;
    if (isWorking(order.status) && !ctx.cancelSent && this.now() >= deadline) {
      try {
        await this.port.cancelOrder(symbol, clientOrderId);
        ctx.cancelSent = true;
        this.options.log(`${symbol} entry ${clientOrderId} not filled within ${this.options.ttlMs} ms: cancel sent`, 'info');
      } catch (err) {
        this.options.log(`${symbol} entry ${clientOrderId}: cancel failed, retrying: ${errorText(err)}`, 'warn');
      }
    }
    if (isWorking(order.status) && !ctx.overdueLogged && this.now() >= deadline + this.options.ttlMs) {
      ctx.overdueLogged = true;
      this.options.log(`${symbol} entry ${clientOrderId} still ${order.status} long after its TTL: new entries stay blocked`, 'error');
    }
    return false;
  }

  /** Brings the protective legs in line with the venue position size. Throws only when a flatten fails. */
  private async syncLegs(job: LiveEntryJob, held: number, ctx: EntryContext): Promise<void> {
    const { symbol } = job;
    if (held === 0) {
      if (ctx.legs) ctx.stale.push(ctx.legs);
      ctx.legs = null;
      ctx.legsQty = 0;
      return;
    }
    let next: LegIds;
    try {
      next = await this.port.placeLegs(job, held);
    } catch (err) {
      this.options.log(`${symbol} UNPROTECTED ${held}: protection failed (${errorText(err)}); cancelling open orders and flattening`, 'error');
      await this.port.cancelAllOpen(symbol);
      await this.port.flatten(symbol, job.side, held);
      // cancelAllOpen removed every leg on the symbol, so no stale entry is left to cancel
      ctx.legs = null;
      ctx.legsQty = 0;
      ctx.stale = [];
      this.options.log(`${symbol} flattened ${held} after failed protection: entry abandoned`, 'warn');
      return;
    }
    this.port.recordEntry({
      symbol,
      side: job.side,
      strategy: job.strategy,
      stopLoss: job.stopLoss,
      takeProfit: job.takeProfit,
      ...(next.stopOrderId === undefined ? {} : { stopOrderId: next.stopOrderId }),
      ...(next.tpOrderId === undefined ? {} : { tpOrderId: next.tpOrderId }),
      ...(job.decisionId === undefined ? {} : { decisionId: job.decisionId }),
    });
    if (ctx.legs) ctx.stale.push(ctx.legs);
    ctx.legs = next;
    ctx.legsQty = held;
    this.options.log(`${symbol} protected ${held}: stop ${job.stopLoss}${job.takeProfit === null ? '' : `, target ${job.takeProfit}`}`, 'info');
  }

  private async cancelStale(symbol: string, ctx: EntryContext): Promise<void> {
    for (const legs of [...ctx.stale]) {
      try {
        await this.port.cancelLegs(symbol, legs);
        ctx.stale = ctx.stale.filter((item) => item !== legs);
      } catch (err) {
        this.options.log(`${symbol}: could not cancel superseded protective legs, retrying: ${errorText(err)}`, 'warn');
      }
    }
  }
}
