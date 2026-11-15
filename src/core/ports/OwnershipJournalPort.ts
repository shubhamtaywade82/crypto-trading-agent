import type { OwnershipEvent } from '../domain/ownership.js';

/**
 * Durable, append-only record of ownership events. `append` returns only after the event is on stable storage, so an
 * INTENT is never submitted to the venue before it can be recovered after a crash.
 */
export interface OwnershipJournalPort {
  append(event: OwnershipEvent): void;
  load(): readonly OwnershipEvent[];
}
