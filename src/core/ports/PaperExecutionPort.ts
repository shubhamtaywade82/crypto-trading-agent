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

/**
 * Paper execution, and nothing else. The name is deliberate: there is no generic "ExecutionPort" a live venue could be
 * registered behind. tests/core.architecture.test.ts fails if anything outside adapters/paper-exchange implements it.
 */
export interface PaperExecutionPort {
  readonly venue: 'paper_exchange';
  /** Throws VenueRejectedError when the venue refuses, VenueUnavailableError when the outcome is unknown. */
  submitOrder(command: PlaceOrderCommand): Promise<VenueOrderAck>;
  /** Looks an earlier submission up by its idempotency key. Null means the venue has no such order. */
  findOrder(idempotencyKey: string): Promise<VenueOrderAck | null>;
  /** Attaches the command's stop-loss and take-profit to the filled position. */
  protect(command: PlaceOrderCommand): Promise<void>;
  /** Reduce-only market exit of the command's position. Used when protection could not be attached. */
  flatten(command: PlaceOrderCommand, reason: string): Promise<void>;
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
