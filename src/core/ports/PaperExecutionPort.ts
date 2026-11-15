import type { PlaceOrderCommand } from '../domain/execution.js';

export interface VenueOrderAck {
  readonly venueOrderId: string;
  /** FILLED: executed now. QUEUED: accepted, executes later (historical replay fills at the next bar's open). */
  readonly status: 'FILLED' | 'PARTIALLY_FILLED' | 'QUEUED';
  readonly filledQuantity: number;
  readonly averagePrice: number | null;
  /** True when the venue took the stop and target with the order itself, so no separate protection call is needed. */
  readonly protectionCarried: boolean;
}

/** What the venue shows for one (account, symbol) slot. Quantity 0 with a null slot id means nothing is open. */
export interface SlotView {
  readonly symbol: string;
  readonly slotId: number | null;
  readonly quantity: number;
}

/**
 * A position this process owns, named by the venue's slot id and by the episode that opened it. Protection and flattening
 * take this, never a symbol: a symbol alone does not say which position is meant.
 */
export interface OwnedPosition {
  readonly accountId: string;
  readonly symbol: string;
  readonly slotId: number;
  readonly episodeId: string;
}

/**
 * Paper execution, and nothing else. The name is deliberate: there is no generic "ExecutionPort" a live venue could be
 * registered behind. tests/core.architecture.test.ts fails if anything outside adapters/paper-exchange implements it.
 *
 * A port is bound to one account. Every command and owned position it receives must name that account, or it is refused.
 */
export interface PaperExecutionPort {
  readonly venue: 'paper_exchange';
  readonly accountId: string;
  /** Throws VenueRejectedError when the venue refuses, VenueUnavailableError when the outcome is unknown. */
  submitOrder(command: PlaceOrderCommand): Promise<VenueOrderAck>;
  /** Looks an earlier submission up by its idempotency key. Null means the venue has no such order. */
  findOrder(idempotencyKey: string): Promise<VenueOrderAck | null>;
  /** The open state of the account's slot for one symbol. */
  readSlot(symbol: string): Promise<SlotView>;
  /** Attaches the command's stop-loss and take-profit to the owned position. Refused when the slot no longer matches. */
  protect(command: PlaceOrderCommand, owned: OwnedPosition): Promise<void>;
  /** Reduce-only market exit of the owned position. Used when protection could not be attached. */
  flatten(owned: OwnedPosition, reason: string): Promise<void>;
}

/** The venue understood the request and refused it. Retrying the same request cannot succeed. */
export class VenueRejectedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VenueRejectedError';
  }
}

/** No answer, or a server error: the request may or may not have been applied. Reconcile before anything else. */
export class VenueUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VenueUnavailableError';
  }
}
