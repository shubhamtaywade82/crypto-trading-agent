import type { OptionQuote, OptionRight } from './types.js';

export type OptionExitReason = 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT' | 'PRE_EXPIRY' | 'TIME_STOP' | 'THESIS_INVALIDATED' | 'MANUAL';

export interface ExitLimits {
  trailArmPct: number;
  trailPct: number;
  maxHoldMs: number;
  exitBeforeExpiryMs: number;
}

/** The position fields exit decisions read and update. */
export interface ManagedLeg {
  right: OptionRight;
  entryPrice: number;
  stopPremium: number;
  targetPremium: number;
  /** Highest executable bid seen since entry; drives the trailing stop. */
  peakBid: number;
  /** True once the trailing stop has raised `stopPremium` above the initial stop. */
  trailActive: boolean;
  openedAt: number;
  expiryMs: number;
}

export type ExitDecision =
  | { action: 'HOLD'; leg: ManagedLeg; note?: string }
  | { action: 'EXIT'; leg: ManagedLeg; reason: OptionExitReason; bid: number | null }
  | { action: 'STALE'; leg: ManagedLeg; ageMs: number };

/**
 * One deterministic exit pass, evaluated on the executable bid (what a sell would get), never the mark.
 * Time-based exits (pre-expiry, max hold) fire even when the quote is stale or the book is empty: they do not
 * depend on price, and holding into expiry is the larger risk. Price-based exits need a fresh bid.
 * The trailing stop only ever raises the stop.
 */
export function evaluateExit(params: {
  leg: ManagedLeg;
  quote: OptionQuote | null;
  now: number;
  staleMs: number;
  limits: ExitLimits;
  /** The current direction read for the underlying; an opposite read invalidates the thesis. */
  direction: OptionRight | null;
}): ExitDecision {
  const { quote, now, staleMs, limits, direction } = params;
  let leg = { ...params.leg };
  const bid = quote?.bids[0]?.[0] ?? null;

  if (now >= leg.expiryMs - limits.exitBeforeExpiryMs) return { action: 'EXIT', leg, reason: 'PRE_EXPIRY', bid };
  if (now - leg.openedAt >= limits.maxHoldMs) return { action: 'EXIT', leg, reason: 'TIME_STOP', bid };

  if (!quote || now - quote.receivedAt > staleMs) return { action: 'STALE', leg, ageMs: quote ? now - quote.receivedAt : Number.POSITIVE_INFINITY };
  if (bid === null) return { action: 'HOLD', leg, note: 'no bid' };

  if (bid > leg.peakBid) leg = { ...leg, peakBid: bid };
  if (leg.peakBid >= leg.entryPrice * (1 + limits.trailArmPct / 100)) {
    const trail = leg.peakBid * (1 - limits.trailPct / 100);
    if (trail > leg.stopPremium) leg = { ...leg, stopPremium: trail, trailActive: true };
  }

  if (bid <= leg.stopPremium) return { action: 'EXIT', leg, reason: leg.trailActive ? 'TRAILING_STOP' : 'STOP_LOSS', bid };
  if (bid >= leg.targetPremium) return { action: 'EXIT', leg, reason: 'TAKE_PROFIT', bid };
  if (direction !== null && direction !== leg.right) return { action: 'EXIT', leg, reason: 'THESIS_INVALIDATED', bid };
  return { action: 'HOLD', leg };
}
