import type { EntryFriction, FrictionStatus, MicrostructureEngine } from './MicrostructureEngine.js';

/**
 * on:     a BLOCK verdict refuses the entry.
 * shadow: the verdict is computed and logged, nothing is refused.
 * off:    no measurement.
 */
export type FrictionGateMode = 'off' | 'shadow' | 'on';

export interface FrictionVerdict {
  /** False only when the gate is on and the verdict is BLOCK. */
  allowed: boolean;
  mode: FrictionGateMode;
  status: FrictionStatus | 'UNMEASURED';
  reason: string;
  spreadBps: number | null;
  slipBps: number | null;
}

/** `engine(symbol)` of the live MicrostructureFeed; null when the feed never started. */
export interface FrictionSource {
  engine(symbol: string): Pick<MicrostructureEngine, 'entryFriction'> | undefined;
}

/**
 * Pre-trade execution-cost gate for one entry: the entry's own side and notional walked through the live local book,
 * graded against MICRO_MAX_SPREAD_BPS and MICRO_MAX_SLIP_BPS. It fails closed: with the gate on, an entry is refused
 * when the book is not live, the feed is missing, or the known book cannot fill the order. It measures cost, never
 * direction, and is only ever asked about entries; exits are not gated.
 */
export function frictionVerdict(params: {
  mode: FrictionGateMode;
  source: FrictionSource | null;
  symbol: string;
  side: 'buy' | 'sell';
  notional: number;
  now: number;
}): FrictionVerdict {
  const { mode, source, symbol, side, notional, now } = params;
  if (mode === 'off') return { allowed: true, mode, status: 'UNMEASURED', reason: 'friction gate off', spreadBps: null, slipBps: null };
  const engine = source?.engine(symbol);
  const friction: EntryFriction = engine
    ? engine.entryFriction(side, notional, now)
    : { status: 'BLOCK', reasons: [source ? `no order book tracked for ${symbol}` : 'microstructure feed not running'], spreadBps: null, slipBps: null, bookStatus: 'SYNCING', bookAgeMs: null };
  const blocked = friction.status === 'BLOCK';
  return {
    allowed: !(blocked && mode === 'on'),
    mode,
    status: friction.status,
    reason: friction.reasons.join('; ') || 'within limits',
    spreadBps: friction.spreadBps,
    slipBps: friction.slipBps,
  };
}

/** Entry side of a signal type, as the executor places it. */
export const entrySide = (type: string): 'buy' | 'sell' =>
  (type === 'OPEN_SHORT' || type === 'OPEN_HEDGE' || type === 'OPEN_FUNDING_SHORT' ? 'sell' : 'buy');
