import type { Position } from '../types.js';
import type { TrailingEvent, TrailingPhase, TrailingState } from './types.js';

/**
 * Trailing lifecycle FSM (spec §8). Transitions are pure; the caller persists material changes
 * via the store so a crash never loses an exit intent. BREACH from TRAILING_PENDING is refused:
 * an un-ACKed candidate stop is not protection — the resting stop still governs the position.
 */

const EDGES: Record<TrailingPhase, Partial<Record<TrailingEvent['type'], TrailingPhase>>> = {
  INITIALIZING: { SL0_CONFIRMED: 'PROTECTED', POSITION_GONE: 'RECONCILIATION' },
  PROTECTED: { ACTIVATION: 'TRAILING_PENDING', BREACH: 'EXIT_PENDING', POSITION_GONE: 'RECONCILIATION' },
  TRAILING_PENDING: { ACK: 'TRAILING_ACTIVE', PARTIAL_FILL: 'PARTIAL', REJECT: 'REJECTED' },
  TRAILING_ACTIVE: { BREACH: 'EXIT_PENDING', POSITION_GONE: 'RECONCILIATION' },
  EXIT_PENDING: { ORDER_ACCEPTED: 'EXIT_SUBMITTED', PARTIAL_FILL: 'PARTIAL' },
  EXIT_SUBMITTED: { PARTIAL_FILL: 'PARTIAL', FILL: 'CLOSED', UNKNOWN_OUTCOME: 'RECONCILIATION' },
  PARTIAL: { REMAINING_MANAGED: 'TRAILING_ACTIVE', BREACH: 'EXIT_PENDING' },
  REJECTED: {},
  RECONCILIATION: {},
  CLOSED: {},
};

/** Applies one event; throws on any transition outside the §8 table (fail closed, never guess). */
export function reduce(phase: TrailingPhase, event: TrailingEvent): TrailingPhase {
  if (event.type === 'RECONCILE') {
    if (phase === 'CLOSED') throw new Error(`invalid transition CLOSED --RECONCILE--> ${event.to} (terminal)`);
    return event.to;
  }
  const next = EDGES[phase][event.type];
  if (next === undefined) throw new Error(`invalid transition ${phase} --${event.type}-->`);
  return next;
}

/** Builds the tracking book for a fresh fill. Returns null when the fill lacks a usable SL₀ or
 *  size — the caller falls back instead of tracking an unprotected position. */
export function initState(position: Position, now: number): TrailingState | null {
  const sl = Number(position.serverSl);
  const s: 1 | -1 = position.side === 'LONG' ? 1 : -1;
  if (!(sl > 0) || !(position.entry > 0) || !(position.qty > 0)) return null;
  const extremePx = position.mark > 0 ? position.mark : position.entry;
  const stopZ = s * sl;
  return {
    key: `${position.symbol}:${position.strategy}`,
    symbol: position.symbol,
    strategy: position.strategy,
    side: position.side,
    entry: position.entry,
    initialQty: position.qty,
    reducedQty: 0,
    // the entry path always persists SL₀ before tracking starts, so a new book lands PROTECTED
    phase: 'PROTECTED',
    policyId: '',
    stopZ,
    confirmedStop: stopZ,
    favorableExtremeX: s * extremePx,
    peakNetPnl: null,
    mfeX: 0,
    maeX: 0,
    fundingAccrued: 0,
    feesAccrued: 0,
    // Position carries liqDistancePct, never the level itself; wiring the level is phase 2
    liquidationPrice: null,
    openedAt: now,
    updatedAt: now,
    lastBookSeq: null,
    lastAcceptedDecision: null,
  };
}

/** The only writer of `lastAcceptedDecision`: an ACK fixes stopZ as the confirmed stop and
 *  attributes it to a policy, which is what breach attribution later keys off. */
export function confirmStop(state: TrailingState, policyId: string, ts: number): TrailingState {
  return {
    ...state,
    policyId,
    confirmedStop: state.stopZ,
    lastAcceptedDecision: { ts, stopZ: state.stopZ, policyId },
    updatedAt: ts,
  };
}

export interface TrailingVenueSnapshot {
  /** Latest contract price feeding the extreme union. */
  price: number;
  positionOpen: boolean;
  /** A protective stop for this position is working at the venue. */
  stopWorking: boolean;
}

/** Reconciles a persisted state with the venue after a process restart: the phase is re-derived
 *  from what the venue shows, the un-ACKed ratchet is rewound, and the extreme takes a monotone
 *  union with the venue price so favorable movement is never lost across the restart. */
export function recover(prev: TrailingState, venue: TrailingVenueSnapshot, now: number): TrailingState {
  const s: 1 | -1 = prev.side === 'LONG' ? 1 : -1;
  const open = venue.positionOpen && Number.isFinite(venue.price) && venue.price > 0;
  if (!open) return { ...prev, phase: 'CLOSED', updatedAt: now };
  // an un-ACKed engine stop never survives: only the confirmed stop is authoritative
  const phase = !venue.stopWorking
    ? 'TRAILING_PENDING' // an intent is outstanding; reconciliation continues from here
    : prev.lastAcceptedDecision ? 'TRAILING_ACTIVE' : 'PROTECTED';
  return {
    ...prev,
    phase,
    stopZ: prev.confirmedStop,
    favorableExtremeX: Math.max(prev.favorableExtremeX, s * venue.price),
    updatedAt: now,
  };
}
