/**
 * Position ownership, per account.
 *
 * PaperExchange keeps at most one perpetual row per (account, symbol), and a closed position keeps a zero-quantity row.
 * A slot is therefore stable across episodes: its id says where a position sits, not who opened it. Ownership is recorded
 * per episode instead. This process journals an INTENT before it submits an entry. The episode becomes OWNED only when the
 * venue shows that the order filled and that the slot went from empty to open. A slot with quantity > 0 and no OWNED
 * episode is FOREIGN: this process never protects, closes or trades around it.
 *
 * The lease in PaperExchange guarantees a single writer per account. Ownership answers a different question: which of the
 * open positions this process is allowed to act on.
 */

export type EpisodeState = 'INTENT' | 'OWNED' | 'CLOSED' | 'ABANDONED';

const EPISODE_TRANSITIONS: Readonly<Record<EpisodeState, readonly EpisodeState[]>> = {
  INTENT: ['OWNED', 'ABANDONED'],
  OWNED: ['CLOSED'],
  CLOSED: [],
  ABANDONED: [],
};

export const canEpisodeTransition = (from: EpisodeState, to: EpisodeState): boolean => EPISODE_TRANSITIONS[from].includes(to);

export interface Episode {
  /** The command id of the order that opened it. */
  readonly episodeId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly decisionId: string;
  readonly idempotencyKey: string;
  /** Quantity of the slot when the intent was journaled, before anything was submitted. */
  readonly slotQuantityBefore: number;
  readonly state: EpisodeState;
  /** The venue slot the fill landed in. Set when OWNED; null otherwise. */
  readonly slotId: number | null;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly reason: string | null;
}

/** One line of the ownership journal. The journal is the source of truth; the episode map is derived from it. */
export type OwnershipEvent =
  | {
      readonly type: 'intent';
      readonly at: number;
      readonly episodeId: string;
      readonly accountId: string;
      readonly symbol: string;
      readonly decisionId: string;
      readonly idempotencyKey: string;
      readonly slotQuantityBefore: number;
    }
  | { readonly type: 'owned'; readonly at: number; readonly episodeId: string; readonly slotId: number }
  | { readonly type: 'abandoned'; readonly at: number; readonly episodeId: string; readonly reason: string }
  | { readonly type: 'closed'; readonly at: number; readonly episodeId: string; readonly reason: string };

export class OwnershipViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipViolation';
  }
}

/** Applies one event to the episode map. Unknown episodes and illegal transitions throw; nothing is rewritten silently. */
export function applyOwnershipEvent(episodes: Map<string, Episode>, event: OwnershipEvent): void {
  if (event.type === 'intent') {
    if (episodes.has(event.episodeId)) throw new OwnershipViolation(`episode ${event.episodeId} already exists`);
    if (!event.symbol || !event.accountId) throw new OwnershipViolation(`episode ${event.episodeId} needs an account and a symbol`);
    if (!Number.isFinite(event.slotQuantityBefore) || event.slotQuantityBefore < 0) {
      throw new OwnershipViolation(`episode ${event.episodeId}: slotQuantityBefore must be a non-negative number`);
    }
    episodes.set(event.episodeId, {
      episodeId: event.episodeId, accountId: event.accountId, symbol: event.symbol, decisionId: event.decisionId,
      idempotencyKey: event.idempotencyKey, slotQuantityBefore: event.slotQuantityBefore, state: 'INTENT', slotId: null,
      openedAt: event.at, closedAt: null, reason: null,
    });
    return;
  }

  const current = episodes.get(event.episodeId);
  if (!current) throw new OwnershipViolation(`${event.type} for unknown episode ${event.episodeId}`);
  const to: EpisodeState = event.type === 'owned' ? 'OWNED' : event.type === 'abandoned' ? 'ABANDONED' : 'CLOSED';
  if (!canEpisodeTransition(current.state, to)) {
    throw new OwnershipViolation(`episode ${event.episodeId}: illegal transition ${current.state} -> ${to}`);
  }
  if (event.type === 'owned') {
    if (!Number.isInteger(event.slotId) || event.slotId < 0) throw new OwnershipViolation(`episode ${event.episodeId}: slotId must be a non-negative integer`);
    episodes.set(event.episodeId, { ...current, state: 'OWNED', slotId: event.slotId });
    return;
  }
  episodes.set(event.episodeId, { ...current, state: to, closedAt: event.at, reason: event.reason });
}

export function reduceOwnership(events: readonly OwnershipEvent[]): Map<string, Episode> {
  const episodes = new Map<string, Episode>();
  for (const event of events) applyOwnershipEvent(episodes, event);
  return episodes;
}

export interface SlotView {
  readonly symbol: string;
  readonly slotId: number | null;
  readonly quantity: number;
}

export type SlotOwnership =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'OWNED'; readonly episodeId: string }
  | { readonly kind: 'FOREIGN' };

/**
 * Who holds an open slot. A slot with no quantity belongs to no one. An open slot is ours only when an OWNED episode names
 * the same symbol and the same slot id. Everything else that is open is foreign, including positions this process opened
 * and then lost track of: those are reported, not managed.
 */
export function classifySlot(slot: SlotView, episodes: ReadonlyMap<string, Episode>): SlotOwnership {
  if (!(slot.quantity > 0)) return { kind: 'NONE' };
  if (slot.slotId !== null) {
    for (const episode of episodes.values()) {
      if (episode.state === 'OWNED' && episode.symbol === slot.symbol && episode.slotId === slot.slotId) {
        return { kind: 'OWNED', episodeId: episode.episodeId };
      }
    }
  }
  return { kind: 'FOREIGN' };
}

export interface OwnershipEvidence {
  readonly slotQuantityBefore: number;
  /** The venue reports our order (matched by idempotency key) as filled or partially filled. */
  readonly orderFilled: boolean;
  readonly slotAfter: { readonly slotId: number | null; readonly quantity: number };
}

export type OwnershipVerdict =
  | { readonly kind: 'OWNED'; readonly slotId: number }
  | { readonly kind: 'AMBIGUOUS'; readonly reason: string };

/**
 * What the venue must show before a fill counts as ours: our order filled, the slot was empty when we submitted, and the
 * slot is open afterwards. Anything else is ambiguous. An ambiguous position is treated as foreign.
 */
export function ownershipFromEvidence(evidence: OwnershipEvidence): OwnershipVerdict {
  if (!evidence.orderFilled) return { kind: 'AMBIGUOUS', reason: 'the order has not filled' };
  if (evidence.slotQuantityBefore > 0) return { kind: 'AMBIGUOUS', reason: 'the slot was already open before submission' };
  if (evidence.slotAfter.slotId === null || !(evidence.slotAfter.quantity > 0)) {
    return { kind: 'AMBIGUOUS', reason: 'no open position in the slot after the fill' };
  }
  return { kind: 'OWNED', slotId: evidence.slotAfter.slotId };
}

/** The open slots that no OWNED episode accounts for. Non-empty means the account is not wholly ours. */
export function foreignSlots(slots: readonly SlotView[], episodes: ReadonlyMap<string, Episode>): SlotView[] {
  return slots.filter((slot) => classifySlot(slot, episodes).kind === 'FOREIGN');
}
