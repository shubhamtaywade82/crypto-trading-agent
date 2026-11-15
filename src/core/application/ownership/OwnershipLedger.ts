import { applyOwnershipEvent, reduceOwnership, type Episode, type OwnershipEvent } from '../../domain/ownership.js';
import type { OwnershipJournalPort } from '../../ports/OwnershipJournalPort.js';

/**
 * The episode map for one account, backed by its journal. Every change is validated against the transition table, then
 * appended and synced, then applied. An event the table refuses never reaches the journal, so a bug cannot write history
 * that recovery would later have to interpret.
 */
export class OwnershipLedger {
  private episodes: Map<string, Episode>;

  constructor(private readonly journal: OwnershipJournalPort, readonly accountId: string) {
    if (!accountId.trim()) throw new Error('an ownership ledger needs an account');
    this.episodes = reduceOwnership(journal.load());
    for (const episode of this.episodes.values()) {
      if (episode.accountId !== accountId) {
        throw new Error(`the ownership journal holds episodes for account ${episode.accountId}, not ${accountId}; one journal per account`);
      }
    }
  }

  snapshot(): ReadonlyMap<string, Episode> {
    return this.episodes;
  }

  get(episodeId: string): Episode | undefined {
    return this.episodes.get(episodeId);
  }

  openIntents(): Episode[] {
    return [...this.episodes.values()].filter((episode) => episode.state === 'INTENT');
  }

  ownedEpisodes(): Episode[] {
    return [...this.episodes.values()].filter((episode) => episode.state === 'OWNED');
  }

  record(event: OwnershipEvent): void {
    const next = new Map(this.episodes);
    applyOwnershipEvent(next, event);
    this.journal.append(event);
    this.episodes = next;
  }

  recordIntent(input: {
    readonly episodeId: string;
    readonly decisionId: string;
    readonly symbol: string;
    readonly idempotencyKey: string;
    readonly slotQuantityBefore: number;
    readonly at: number;
  }): void {
    this.record({ type: 'intent', at: input.at, episodeId: input.episodeId, accountId: this.accountId, symbol: input.symbol, decisionId: input.decisionId, idempotencyKey: input.idempotencyKey, slotQuantityBefore: input.slotQuantityBefore });
  }

  recordOwned(episodeId: string, slotId: number, at: number): void {
    this.record({ type: 'owned', at, episodeId, slotId });
  }

  recordAbandoned(episodeId: string, reason: string, at: number): void {
    this.record({ type: 'abandoned', at, episodeId, reason });
  }

  recordClosed(episodeId: string, reason: string, at: number): void {
    this.record({ type: 'closed', at, episodeId, reason });
  }
}
