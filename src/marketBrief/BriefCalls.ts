import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MarketBrief } from './types.js';

/**
 * Brief calls: each actionable brief (BUY_LONG or SELL_SHORT) is tracked as a hypothetical trade at its levels. No
 * position is opened; the call only records what would have happened. It is filled when the mark reaches its entry,
 * then resolves at its stop or target. A call that is not filled, or not resolved, by its horizon expires.
 *
 * Levels, from the brief's support and resistance bands ([low, high]):
 *   LONG:  entry at support's upper edge, stop below support's lower edge, target at resistance's lower edge.
 *   SHORT: entry at resistance's lower edge, stop above resistance's upper edge, target at support's upper edge.
 * The SHORT rule is the mirror of the LONG rule the operator chose; it was not separately specified.
 */

export const CALL_HORIZON_MS = 4 * 3_600_000;

export type CallDirection = 'LONG' | 'SHORT';
export type CallStatus = 'OPEN' | 'TP' | 'SL' | 'EXPIRED' | 'NOT_FILLED';

export interface BriefCall {
  readonly callId: string;
  readonly briefId: string;
  readonly symbol: string;
  readonly direction: CallDirection;
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  readonly filledAt: number | null;
  readonly status: CallStatus;
  readonly resolvedAt: number | null;
  readonly exitPrice: number | null;
  /** Realized move in units of the risk (entry to stop): +2 is two R in the call's favour. Null when not filled or not resolved. */
  readonly rMultiple: number | null;
  readonly lastMark: number | null;
  readonly lastMarkAt: number | null;
}

interface CallLevels { readonly direction: CallDirection; readonly entry: number; readonly stop: number; readonly target: number }

/** The levels a brief's action implies, or null when the bands are missing or do not form a valid trade. Pure. */
export function callLevelsOf(brief: MarketBrief): CallLevels | null {
  const { support, resistance } = brief.levels;
  if (brief.decision.action === 'BUY_LONG') {
    if (!support || !resistance) return null;
    const levels = { direction: 'LONG' as const, entry: support[1], stop: support[0], target: resistance[0] };
    return levels.stop < levels.entry && levels.entry < levels.target ? levels : null;
  }
  if (brief.decision.action === 'SELL_SHORT') {
    if (!support || !resistance) return null;
    const levels = { direction: 'SHORT' as const, entry: resistance[0], stop: resistance[1], target: support[1] };
    return levels.target < levels.entry && levels.entry < levels.stop ? levels : null;
  }
  return null;
}

const callIdOf = (symbol: string, direction: CallDirection, openedAt: number): string => `${symbol}:${direction}:${openedAt}`;

/** R multiple of a price against the call: positive when favourable. Null when the risk is zero. */
function rOf(call: Pick<BriefCall, 'direction' | 'entry' | 'stop'>, price: number): number | null {
  const risk = Math.abs(call.entry - call.stop);
  if (!(risk > 0)) return null;
  const sign = call.direction === 'LONG' ? 1 : -1;
  return (sign * (price - call.entry)) / risk;
}

/** Applies one observation (a mark at a time) to an open call. Returns the call unchanged when nothing happens. Pure. */
export function advanceCall(call: BriefCall, mark: number, at: number): BriefCall {
  if (call.status !== 'OPEN') return call;
  const next: BriefCall = { ...call, lastMark: mark, lastMarkAt: at };
  const long = call.direction === 'LONG';
  if (call.filledAt === null) {
    const filled = long ? mark <= call.entry : mark >= call.entry;
    if (filled) return { ...next, filledAt: at };
  } else {
    const stopped = long ? mark <= call.stop : mark >= call.stop;
    const reached = long ? mark >= call.target : mark <= call.target;
    if (stopped) return resolve(next, 'SL', call.stop, at);
    if (reached) return resolve(next, 'TP', call.target, at);
  }
  if (at >= call.expiresAt) {
    if (call.filledAt === null) return resolve(next, 'NOT_FILLED', null, at);
    return resolve(next, 'EXPIRED', mark, at);
  }
  return next;
}

function resolve(call: BriefCall, status: CallStatus, exitPrice: number | null, at: number): BriefCall {
  const rMultiple = status === 'NOT_FILLED' || exitPrice === null ? null : rOf(call, exitPrice);
  return { ...call, status, resolvedAt: at, exitPrice, rMultiple };
}

export interface CallSummary {
  readonly total: number;
  readonly open: number;
  readonly filled: number;
  readonly tp: number;
  readonly sl: number;
  readonly expired: number;
  readonly notFilled: number;
  /** Mean R over filled calls that resolved with a defined R. Null when there are none. */
  readonly meanR: number | null;
}

/** Counts and mean R over a set of calls. Pure. */
export function summarizeCalls(calls: readonly BriefCall[]): CallSummary {
  const rs = calls.filter((c) => c.filledAt !== null && c.rMultiple !== null).map((c) => c.rMultiple as number);
  return {
    total: calls.length,
    open: calls.filter((c) => c.status === 'OPEN').length,
    filled: calls.filter((c) => c.filledAt !== null).length,
    tp: calls.filter((c) => c.status === 'TP').length,
    sl: calls.filter((c) => c.status === 'SL').length,
    expired: calls.filter((c) => c.status === 'EXPIRED').length,
    notFilled: calls.filter((c) => c.status === 'NOT_FILLED').length,
    meanR: rs.length === 0 ? null : rs.reduce((sum, r) => sum + r, 0) / rs.length,
  };
}

/** Holds the calls, observes each new brief, and writes one row per change (the last row per callId is the state). */
export class BriefCallLedger {
  lastError?: string;
  private readonly calls = new Map<string, BriefCall>();

  constructor(private readonly filePath: string | null = null) {
    this.load();
  }

  all(): BriefCall[] {
    return [...this.calls.values()];
  }

  get(callId: string): BriefCall | undefined {
    return this.calls.get(callId);
  }

  /** Opens a call for an actionable brief (one open call per symbol and direction), then advances the symbol's open calls. */
  observe(brief: MarketBrief): void {
    const at = brief.generatedAt;
    const mark = brief.market.markPrice ?? brief.market.lastPrice;
    const levels = callLevelsOf(brief);
    if (levels && !this.hasOpen(brief.symbol, levels.direction)) {
      const call: BriefCall = {
        callId: callIdOf(brief.symbol, levels.direction, at),
        briefId: brief.briefId,
        symbol: brief.symbol,
        direction: levels.direction,
        openedAt: at,
        expiresAt: at + CALL_HORIZON_MS,
        entry: levels.entry,
        stop: levels.stop,
        target: levels.target,
        filledAt: null,
        status: 'OPEN',
        resolvedAt: null,
        exitPrice: null,
        rMultiple: null,
        lastMark: null,
        lastMarkAt: null,
      };
      if (!this.calls.has(call.callId)) this.commit(call);
    }
    if (mark === null || mark === undefined || !(mark > 0)) return;
    for (const call of this.calls.values()) {
      if (call.symbol !== brief.symbol || call.status !== 'OPEN') continue;
      const next = advanceCall(call, mark, at);
      if (next !== call) this.commit(next);
    }
  }

  private hasOpen(symbol: string, direction: CallDirection): boolean {
    return [...this.calls.values()].some((c) => c.symbol === symbol && c.direction === direction && c.status === 'OPEN');
  }

  private commit(call: BriefCall): void {
    this.calls.set(call.callId, call);
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(call)}\n`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    for (const line of readFileSync(this.filePath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as BriefCall;
        if (typeof parsed.callId === 'string') this.calls.set(parsed.callId, parsed);
      } catch {
        // a torn line from a crash is skipped
      }
    }
  }
}
