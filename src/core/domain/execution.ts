import { createHash } from 'node:crypto';
import { isApprovedTrade, type ApprovedTrade } from './risk.js';

/** An order request as immutable data. It knows nothing about the venue that will execute it. */
export interface PlaceOrderCommand {
  readonly commandId: string;
  /** Sent to the venue as the client order id; a retried submission with it replays the original order. */
  readonly idempotencyKey: string;
  readonly decisionId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: number;
  readonly orderType: 'MARKET';
  readonly leverage: number;
  /** The mark the decision was sized on. A reference, not a promised fill. */
  readonly referencePrice: number;
  /** Mandatory: an entry without a stop is not representable. */
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly createdAt: number;
}

export type OrderState =
  | 'CREATED'
  | 'VALIDATED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  /** The venue did not answer and reconciliation could not find the order. Terminal for the engine; an operator resolves it. */
  | 'UNKNOWN';

const TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  CREATED: ['VALIDATED', 'REJECTED'],
  VALIDATED: ['SUBMITTED', 'REJECTED'],
  SUBMITTED: ['ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'UNKNOWN'],
  ACKNOWLEDGED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED'],
  FILLED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
  UNKNOWN: [],
};

export const isTerminal = (state: OrderState): boolean => TRANSITIONS[state].length === 0;
export const canTransition = (from: OrderState, to: OrderState): boolean => TRANSITIONS[from].includes(to);

export class IllegalOrderTransitionError extends Error {
  constructor(readonly commandId: string, readonly from: OrderState, readonly to: OrderState) {
    super(`order ${commandId}: illegal transition ${from} -> ${to}`);
    this.name = 'IllegalOrderTransitionError';
  }
}

export interface OrderTransition {
  readonly from: OrderState;
  readonly to: OrderState;
  readonly at: number;
  readonly note?: string;
}

/** The only object allowed to change an order's state. Every change goes through the transition table. */
export class OrderLifecycle {
  private current: OrderState = 'CREATED';
  private readonly log: OrderTransition[] = [];

  constructor(readonly commandId: string) {}

  get state(): OrderState {
    return this.current;
  }

  get history(): readonly OrderTransition[] {
    return this.log;
  }

  transition(to: OrderState, at: number, note?: string): void {
    if (!canTransition(this.current, to)) throw new IllegalOrderTransitionError(this.commandId, this.current, to);
    this.log.push({ from: this.current, to, at, ...(note === undefined ? {} : { note }) });
    this.current = to;
  }
}

export interface OrderResult {
  readonly commandId: string;
  readonly state: OrderState;
  readonly venueOrderId: string | null;
  readonly filledQuantity: number;
  /** Null when the venue has not reported a fill price (a queued replay order fills at the next bar's open). */
  readonly averagePrice: number | null;
  readonly protection: 'ATTACHED' | 'PENDING_FILL' | 'FAILED' | 'NONE';
  readonly detail: string;
  readonly transitions: readonly OrderTransition[];
}

const shortHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 20);

/**
 * The only way to obtain a command. It needs the pipeline's approval token, so "every executed command has an accepted
 * risk decision" holds by construction. Ids are derived from the decision: building twice yields the same command.
 */
export function buildPlaceOrderCommand(approved: ApprovedTrade, createdAt: number): PlaceOrderCommand {
  if (!isApprovedTrade(approved)) throw new Error('refusing to build an order command without a risk-pipeline approval');
  const { proposal } = approved;
  const commandId = `cmd_${shortHash(proposal.decisionId)}`;
  return Object.freeze({
    commandId,
    idempotencyKey: `pc-${shortHash(`order:${proposal.decisionId}`)}`,
    decisionId: proposal.decisionId,
    strategyId: proposal.signal.strategyId,
    strategyVersion: proposal.signal.strategyVersion,
    symbol: proposal.symbol,
    side: proposal.direction === 'LONG' ? 'BUY' : 'SELL',
    quantity: proposal.quantity,
    orderType: 'MARKET',
    leverage: proposal.leverage,
    referencePrice: proposal.entry,
    stopLoss: proposal.stopLoss,
    takeProfit: proposal.takeProfit,
    createdAt,
  } satisfies PlaceOrderCommand);
}
