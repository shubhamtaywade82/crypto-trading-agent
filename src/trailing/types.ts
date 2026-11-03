import type { AgentId, Candle, Position, Side } from '../types.js';

/**
 * Trailing policy engine contracts (spec: docs/superpowers/specs/2026-11-03-crypto-futures-trailing-engine-design.md §5).
 * Repo types are reused rather than a parallel ontology:
 * - `Side` is the direction type (`s = +1 LONG / -1 SHORT` in the spec's directional model);
 * - candles are the repo's `Candle` (structural reuse, so `src/binance/indicators.ts` ATR applies directly);
 * - `tickSize` was added to PolicyContext because the swing buffer formula needs venue precision.
 */

/** Which published price produced a trigger. INDEX_PRICE is context-only (no venue trigger type). */
export type PriceReference = 'CONTRACT_PRICE' | 'MARK_PRICE' | 'INDEX_PRICE';
export type PriceDomain = 'CONTRACT' | 'MARK';

export type MethodId =
  | 'ATR_TRAIL' | 'CHANDELIER' | 'SUPERTREND' | 'PSAR' | 'MA_TRAIL' | 'ALMA_HMA'
  | 'SWING' | 'FRACTAL' | 'BOS_CHOCH' | 'DONCHIAN'
  | 'R_STAIRCASE' | 'GIVEBACK' | 'TIME_DECAY'
  | 'MARK_ATR' | 'MARK_CHANDELIER' | 'CONTRACT_MARK_HYBRID'
  | 'ORDER_FLOW' | 'REGIME_ADAPTIVE';

/** Layer 1 price protection, layer 2 profit protection, layer 3 context/microstructure. */
export type MethodLayer = 'PRICE' | 'PROFIT' | 'CONTEXT';

/** Priority P0 = phases 1–2, P1 = phase 3, P2 = phase 6 (order flow + collector). */
export type MethodPriority = 'P0' | 'P1' | 'P2';

export type PolicyDomain = 'CONTRACT' | 'MARK' | 'PROFIT' | 'ORDER_FLOW' | 'HYBRID';

export interface PolicyActivation {
  /** Gate controlling when a policy may first emit candidates; NEVER = registered but inactive. */
  type: 'IMMEDIATE' | 'MFE_R' | 'PEAK_PNL' | 'TP1_FILLED' | 'NEVER';
  /** Threshold in the activation's unit (R multiples, USDT, or unused). */
  threshold: number;
}

export interface TrailingPolicy {
  id: string;
  version: string;
  method: MethodId;
  layer: MethodLayer;
  priority: MethodPriority;
  domain: PolicyDomain;
  params: Record<string, number | string>;
  activation: PolicyActivation;
  /** Where its trigger is measured. */
  priceReference: PriceReference;
  enabled: boolean;
}

/** One pass of market context for a position. Phase 1 fills contract/mark/atr/candles; the other
 *  inputs stay null until their phase wires them (spec §6: policies no-op on unavailable inputs). */
export interface PolicyContext {
  position: Position;
  /** Directional sign from `Side`. */
  s: 1 | -1;
  tf: string;
  /** Contract price now (the traded market). */
  price: number;
  mark: { price: number; fundingRate: number; nextFundingAt: number };
  index: { price: number } | null;
  book: { bid: number; ask: number; bidDepthUsdt: number; askDepthUsdt: number; seq: number; stale: boolean } | null;
  flow: { obi: number; cvdZScore: number } | null;
  atr: { contract: number | null; mark: number | null };
  candles: Candle[];
  /** Venue tick size for tick-based buffers; null = priced buffers only. */
  tickSize: number | null;
  account: { fundingAccrued: number; feesAccrued: number; fundingSettledAt: number[] };
}

/** One policy output per pass. All candidates live in DIRECTIONAL coordinates:
 *  X = s·price, so a candidate is protective iff `levelZ < X` and tighter iff `levelZ > stopZ`. */
export interface StopCandidate {
  policyId: string;
  levelZ: number;
  priceReference: PriceReference;
  /** Short machine-readable reason, e.g. 'atr-trail-14-k2'. */
  reason: string;
  /** True for structural exits (CHoCH, supertrend flip): the engine turns these into EXIT decisions. */
  exit?: boolean;
}

export type TrailingAction = 'HOLD' | 'MOVE_STOP' | 'EXIT' | 'TIGHTEN';

export interface TrailingDecision {
  positionId: string;
  /** Every policy that ran this pass. */
  policyIds: string[];
  action: TrailingAction;
  /** Contract-price stop to place, post-ratchet (`stopPrice = s·stopZ`). */
  stopPrice?: number;
  stopZ?: number;
  /** Which reference breached first — attribution, never a fill source (I3). */
  triggerReference?: PriceReference;
  triggerDomain?: PolicyDomain;
  reasonCode: string;
  evidence: Record<string, number | string | boolean | null>;
  ts: number;
}

export type TrailingPhase =
  | 'INITIALIZING' | 'PROTECTED' | 'TRAILING_PENDING' | 'TRAILING_ACTIVE'
  | 'EXIT_PENDING' | 'EXIT_SUBMITTED' | 'PARTIAL' | 'CLOSED' | 'REJECTED' | 'RECONCILIATION';

/** Lifecycle events driving the FSM (spec §8). RECONCILE carries the destination phase because
 *  reconciliation outcomes are decided off-book (venue snapshot), not by this state machine. */
export type TrailingEvent =
  | { type: 'SL0_CONFIRMED' | 'ACTIVATION' | 'ACK' | 'REJECT' | 'BREACH' | 'ORDER_ACCEPTED'
    | 'PARTIAL_FILL' | 'FILL' | 'UNKNOWN_OUTCOME' | 'REMAINING_MANAGED' | 'POSITION_GONE' }
  | { type: 'RECONCILE'; to: Exclude<TrailingPhase, 'RECONCILIATION'> };

export interface TrailingState {
  key: string;
  symbol: string;
  strategy: AgentId;
  side: Side;
  entry: number;
  initialQty: number;
  reducedQty: number;
  phase: TrailingPhase;
  policyId: string;
  /** Current ratcheted stop in directional coordinates. */
  stopZ: number;
  /** Last stop ACKed by the executor — the only stop that survives a restart. */
  confirmedStop: number;
  /** Max X since entry; monotone union on restart, never reset (except position replacement). */
  favorableExtremeX: number;
  peakNetPnl: number | null;
  mfeX: number;
  maeX: number;
  fundingAccrued: number;
  feesAccrued: number;
  liquidationPrice: number | null;
  openedAt: number;
  updatedAt: number;
  lastBookSeq: number | null;
  lastAcceptedDecision: { ts: number; stopZ: number; policyId: string } | null;
}
