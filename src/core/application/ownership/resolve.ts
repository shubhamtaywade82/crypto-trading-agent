import { ownershipFromEvidence, type SlotView } from '../../domain/ownership.js';
import { VenueRejectedError, type PaperExecutionPort, type VenueOrderAck } from '../../ports/PaperExecutionPort.js';
import type { OwnershipLedger } from './OwnershipLedger.js';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface IntentResolution {
  /** Episodes whose fill the venue has confirmed as ours. */
  readonly owned: readonly string[];
  readonly abandoned: readonly string[];
  /** Orders the venue still queues (replay). Resolved on a later cycle. */
  readonly pending: readonly string[];
  /**
   * Intents the venue contradicts: an open order, an unreadable answer, or a filled order whose slot cannot be attributed.
   * Any hold stops trading, because an unattributed position may exist.
   */
  readonly held: ReadonlyArray<{ readonly episodeId: string; readonly reason: string }>;
}

/**
 * Settles every open INTENT against what the venue shows. Runs at startup, before any trading, and again while intents are
 * pending. Recovery is conservative: an intent is never confirmed from a timestamp or a guess. It is confirmed only when our
 * own order, matched by idempotency key, filled and the slot went from empty to open.
 */
export async function resolveOpenIntents(input: {
  readonly ledger: OwnershipLedger;
  readonly execution: PaperExecutionPort;
  readonly at: number;
}): Promise<IntentResolution> {
  const { ledger, execution, at } = input;
  const owned: string[] = [], abandoned: string[] = [], pending: string[] = [];
  const held: Array<{ episodeId: string; reason: string }> = [];

  for (const intent of ledger.openIntents()) {
    let ack: VenueOrderAck | null;
    try {
      ack = await execution.findOrder(intent.idempotencyKey);
    } catch (error) {
      if (error instanceof VenueRejectedError) {
        ledger.recordAbandoned(intent.episodeId, `the venue refused the order: ${message(error)}`, at);
        abandoned.push(intent.episodeId);
      } else {
        held.push({ episodeId: intent.episodeId, reason: `the venue order could not be read: ${message(error)}` });
      }
      continue;
    }

    if (ack === null) {
      ledger.recordAbandoned(intent.episodeId, 'no venue order carries the idempotency key', at);
      abandoned.push(intent.episodeId);
      continue;
    }
    if (ack.status === 'QUEUED') {
      pending.push(intent.episodeId);
      continue;
    }

    let slot: SlotView;
    try {
      slot = await execution.readSlot(intent.symbol);
    } catch (error) {
      held.push({ episodeId: intent.episodeId, reason: `the slot could not be read: ${message(error)}` });
      continue;
    }
    const verdict = ownershipFromEvidence({
      slotQuantityBefore: intent.slotQuantityBefore,
      orderFilled: ack.status === 'FILLED' || ack.status === 'PARTIALLY_FILLED',
      slotAfter: { slotId: slot.slotId, quantity: slot.quantity },
    });
    if (verdict.kind === 'OWNED') {
      ledger.recordOwned(intent.episodeId, verdict.slotId, at);
      owned.push(intent.episodeId);
    } else if (slot.quantity === 0) {
      ledger.recordAbandoned(intent.episodeId, 'filled and closed before this process resumed', at);
      abandoned.push(intent.episodeId);
    } else {
      held.push({ episodeId: intent.episodeId, reason: `${verdict.kind === 'AMBIGUOUS' ? verdict.reason : 'unattributed'}; the open slot cannot be attributed to this process` });
    }
  }
  return { owned, abandoned, pending, held };
}

/**
 * Closes every OWNED episode whose slot the venue no longer shows as open. The venue closes positions by itself (protections,
 * liquidations) and by reduce-only orders, so a closed slot must be recorded before anything can reuse it.
 */
export function closeEmptiedEpisodes(input: { readonly ledger: OwnershipLedger; readonly slots: readonly SlotView[]; readonly at: number }): string[] {
  const open = new Set(input.slots.filter((slot) => slot.quantity > 0 && slot.slotId !== null).map((slot) => `${slot.symbol}:${slot.slotId}`));
  const closed: string[] = [];
  for (const episode of input.ledger.ownedEpisodes()) {
    if (open.has(`${episode.symbol}:${episode.slotId}`)) continue;
    input.ledger.recordClosed(episode.episodeId, 'the slot is no longer open (closed by the venue or by a reduce-only order)', input.at);
    closed.push(episode.episodeId);
  }
  return closed;
}
