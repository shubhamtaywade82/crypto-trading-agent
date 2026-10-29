import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Dual timestamp contract: distinguishes exchange event time from process visibility and feature legality. */
export interface TimestampContext {
  /** When the exchange formed the tick, candle or fill. */
  exchange_time: number;
  /** When our process received the payload over the wire. */
  received_at: number;
  /** Earliest moment features derived from this event could legally be queried (lookahead prevention). */
  available_at: number;
}

export type ResearchEventType =
  | 'market_observation'
  | 'feature_snapshot'
  | 'decision_snapshot'
  | 'order_fill'
  | 'funding_settlement'
  | 'trade_episode';

export interface BaseResearchEvent {
  id: string;
  seq: number;
  type: ResearchEventType;
  timestamps: TimestampContext;
}

export interface MarketObservationEvent extends BaseResearchEvent {
  type: 'market_observation';
  payload: {
    symbol: string;
    interval?: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    markPrice?: number;
    fundingRate?: number;
  };
}

export interface FeatureSnapshotEvent extends BaseResearchEvent {
  type: 'feature_snapshot';
  payload: {
    symbol: string;
    regime: string;
    volatilityPhase: string;
    features: Record<string, number>;
  };
}

export interface DecisionSnapshotEvent extends BaseResearchEvent {
  type: 'decision_snapshot';
  payload: {
    decisionId: string;
    symbol: string;
    strategy: string;
    action: 'LONG' | 'SHORT' | 'NO_TRADE';
    status: 'EXECUTED' | 'REJECTED' | 'SKIPPED';
    rejectionReason?: string;
    evidenceScore?: number;
    plannedEntry?: number;
    stopLoss?: number;
    takeProfit?: number;
    notional?: number;
  };
}

export interface OrderFillEvent extends BaseResearchEvent {
  type: 'order_fill';
  payload: {
    orderId: string;
    decisionId?: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    qty: number;
    price: number;
    fee: number;
    slippage: number;
    isReduceOnly: boolean;
  };
}

export interface FundingSettlementEvent extends BaseResearchEvent {
  type: 'funding_settlement';
  payload: {
    symbol: string;
    rate: number;
    markPrice: number;
    positionQty: number;
    payment: number;
  };
}

export interface TradeEpisodeEvent extends BaseResearchEvent {
  type: 'trade_episode';
  payload: {
    episodeId: string;
    decisionId?: string;
    symbol: string;
    strategy: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    exitPrice: number;
    qty: number;
    grossPnl: number;
    netPnl: number;
    realizedR: number;
    exitReason: string;
    mfeR: number;
    maeR: number;
    holdingMs: number;
  };
}

export type ResearchEvent =
  | MarketObservationEvent
  | FeatureSnapshotEvent
  | DecisionSnapshotEvent
  | OrderFillEvent
  | FundingSettlementEvent
  | TradeEpisodeEvent;

export interface ReconstructedPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  openedAt: number;
}

export interface ReconstructedPortfolio {
  cash: number;
  realizedPnl: number;
  totalFees: number;
  totalFunding: number;
  positions: Map<string, ReconstructedPosition>;
  closedCount: number;
}

/**
 * Pure portfolio reconstruction: replays order fills and funding events to build current state.
 * Guaranteed deterministic and independent of exchange memory.
 */
export function reconstructState(events: readonly ResearchEvent[], initialCash = 10_000): ReconstructedPortfolio {
  const state: ReconstructedPortfolio = {
    cash: initialCash,
    realizedPnl: 0,
    totalFees: 0,
    totalFunding: 0,
    positions: new Map(),
    closedCount: 0,
  };

  for (const event of events) {
    if (event.type === 'order_fill') {
      applyFill(state, event.payload);
    } else if (event.type === 'funding_settlement') {
      applyFunding(state, event.payload);
    }
  }

  return state;
}

function applyFill(state: ReconstructedPortfolio, fill: OrderFillEvent['payload']): void {
  state.cash -= fill.fee;
  state.totalFees += fill.fee;
  const current = state.positions.get(fill.symbol);

  if (!current || current.side === fill.side) {
    scaleInOrOpen(state, current, fill);
  } else {
    reduceOrFlip(state, current, fill);
  }
}

function scaleInOrOpen(
  state: ReconstructedPortfolio,
  current: ReconstructedPosition | undefined,
  fill: OrderFillEvent['payload'],
): void {
  if (!current) {
    if (fill.qty > 0) {
      state.positions.set(fill.symbol, {
        symbol: fill.symbol,
        side: fill.side,
        qty: fill.qty,
        entryPrice: fill.price,
        openedAt: 0,
      });
    }
    return;
  }
  const totalQty = current.qty + fill.qty;
  current.entryPrice = (current.entryPrice * current.qty + fill.price * fill.qty) / totalQty;
  current.qty = totalQty;
}

function reduceOrFlip(
  state: ReconstructedPortfolio,
  current: ReconstructedPosition,
  fill: OrderFillEvent['payload'],
): void {
  const closeQty = Math.min(current.qty, fill.qty);
  const sign = current.side === 'LONG' ? 1 : -1;
  const pnl = (fill.price - current.entryPrice) * closeQty * sign;
  state.realizedPnl += pnl;
  state.cash += pnl;
  current.qty -= closeQty;

  if (current.qty <= 1e-8) {
    state.positions.delete(fill.symbol);
    state.closedCount += 1;
  }
  if (fill.qty > closeQty) {
    state.positions.set(fill.symbol, {
      symbol: fill.symbol,
      side: fill.side,
      qty: fill.qty - closeQty,
      entryPrice: fill.price,
      openedAt: 0,
    });
  }
}

function applyFunding(state: ReconstructedPortfolio, funding: FundingSettlementEvent['payload']): void {
  state.cash -= funding.payment;
  state.totalFunding += funding.payment;
}

/**
 * Append-only durable research ledger.
 * Never compacts, never rotates out history, and guarantees audit trail preservation.
 */
export class DurableResearchLedger {
  private seq = 0;
  private readonly events: ResearchEvent[] = [];

  constructor(private readonly filePath: string | null = null) {
    if (this.filePath && existsSync(this.filePath)) {
      this.load();
    }
  }

  append(input: Omit<ResearchEvent, 'seq' | 'id'> & { id?: string }): ResearchEvent {
    this.seq += 1;
    const id = input.id ?? `evt_${Date.now()}_${this.seq}`;
    const event = { ...input, id, seq: this.seq } as ResearchEvent;
    this.events.push(event);

    if (this.filePath) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
        appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf8');
      } catch (err) {
        // Research logging failures must be captured for diagnostic transparency
        throw new Error(`Failed to persist research event seq=${this.seq}: ${err}`);
      }
    }

    return event;
  }

  all(): readonly ResearchEvent[] {
    return this.events;
  }

  reconstruct(initialCash = 10_000): ReconstructedPortfolio {
    return reconstructState(this.events, initialCash);
  }

  private load(): void {
    if (!this.filePath) return;
    const raw = readFileSync(this.filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ResearchEvent;
        this.events.push(parsed);
        if (parsed.seq > this.seq) this.seq = parsed.seq;
      } catch {
        // Skips torn trailing lines from process crashes while keeping prior audit trail
      }
    }
  }
}
