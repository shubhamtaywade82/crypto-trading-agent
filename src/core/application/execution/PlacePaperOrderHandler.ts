import { OrderLifecycle, type AccountScope, type OrderResult, type OrderState, type PlaceOrderCommand } from '../../domain/execution.js';
import { ownershipFromEvidence, type SlotView } from '../../domain/ownership.js';
import type { Clock } from '../../ports/Clock.js';
import { VenueRejectedError, VenueUnavailableError, type OwnedPosition, type PaperExecutionPort, type VenueOrderAck } from '../../ports/PaperExecutionPort.js';
import type { OwnershipLedger } from '../ownership/OwnershipLedger.js';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const ACK_STATE: Readonly<Record<VenueOrderAck['status'], OrderState>> = {
  FILLED: 'FILLED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  QUEUED: 'ACKNOWLEDGED',
};

/**
 * Executes order commands against the paper venue, for one account.
 *
 * - Bound to one account: a command for any other account is refused, and so is a port bound to another account.
 * - Idempotent: a command id is submitted at most once per process; a repeat returns the first outcome.
 * - Ownership first: the slot must be empty before submission. An INTENT is journaled before anything is sent, so a crash
 *   after submission is recoverable. The episode becomes OWNED only when the venue shows our fill in an empty-then-open slot.
 * - Protection and flattening act only on an OWNED position, named by slot id and episode, never by symbol.
 * - A lost answer is reconciled by idempotency key before anything is sent again, and is sent again at most once with the
 *   same key. If the outcome is still unknown the order ends UNKNOWN, the intent stays open, and the caller halts trading.
 */
export class PlacePaperOrderHandler {
  private readonly outcomes = new Map<string, Promise<OrderResult>>();

  constructor(
    private readonly execution: PaperExecutionPort,
    private readonly clock: Clock,
    private readonly ownership: OwnershipLedger,
    private readonly scope: AccountScope,
  ) {
    if (execution.accountId !== scope.accountId) throw new Error(`the execution port is bound to ${execution.accountId}, not ${scope.accountId}`);
    if (ownership.accountId !== scope.accountId) throw new Error(`the ownership ledger belongs to ${ownership.accountId}, not ${scope.accountId}`);
  }

  handle(command: PlaceOrderCommand): Promise<OrderResult> {
    const existing = this.outcomes.get(command.commandId);
    if (existing) return existing;
    const outcome = this.execute(command);
    this.outcomes.set(command.commandId, outcome);
    return outcome;
  }

  private async execute(command: PlaceOrderCommand): Promise<OrderResult> {
    const lifecycle = new OrderLifecycle(command.commandId);
    const now = () => this.clock.now();
    const result = (fields: Partial<OrderResult> & { detail: string }): OrderResult => ({
      commandId: command.commandId, state: lifecycle.state, venueOrderId: null, filledQuantity: 0, averagePrice: null,
      protection: 'NONE', transitions: [...lifecycle.history], ...fields,
    });

    const defect = commandDefect(command) ?? scopeDefect(command, this.scope);
    if (defect) {
      lifecycle.transition('REJECTED', now(), defect);
      return result({ detail: `invalid command: ${defect}` });
    }
    lifecycle.transition('VALIDATED', now());

    // Nothing is journaled or sent until the venue confirms the slot is empty
    let before: SlotView;
    try {
      before = await this.execution.readSlot(command.symbol);
    } catch (error) {
      lifecycle.transition('REJECTED', now(), 'slot unreadable');
      return result({ detail: `the slot could not be read, nothing was sent: ${message(error)}` });
    }
    if (before.quantity > 0) {
      lifecycle.transition('REJECTED', now(), 'slot is open');
      return result({ detail: `${command.symbol} is already open; this process does not add to a position it did not open` });
    }

    try {
      // An OWNED episode on this symbol whose slot is empty has ended; close it before a new one can be attributed
      for (const episode of this.ownership.ownedEpisodes()) {
        if (episode.symbol === command.symbol) this.ownership.recordClosed(episode.episodeId, 'the slot was empty before a new entry', now());
      }
      this.ownership.recordIntent({
        episodeId: command.commandId, decisionId: command.decisionId, symbol: command.symbol, idempotencyKey: command.idempotencyKey,
        slotQuantityBefore: before.quantity, at: now(),
      });
    } catch (error) {
      lifecycle.transition('REJECTED', now(), 'intent not journaled');
      return result({ detail: `the intent could not be journaled, nothing was sent: ${message(error)}` });
    }
    lifecycle.transition('SUBMITTED', now());

    let ack: VenueOrderAck;
    try {
      ack = await this.submitWithReconciliation(command);
    } catch (error) {
      const rejected = error instanceof VenueRejectedError;
      lifecycle.transition(rejected ? 'REJECTED' : 'UNKNOWN', now(), message(error));
      if (rejected) this.ownership.recordAbandoned(command.commandId, `venue rejected: ${message(error)}`, now());
      return result({
        detail: rejected
          ? `venue rejected: ${message(error)}`
          : `outcome unknown: ${message(error)}; the intent stays open until recovery resolves it`,
      });
    }

    lifecycle.transition(ACK_STATE[ack.status], now());
    const filled = { venueOrderId: ack.venueOrderId, filledQuantity: ack.filledQuantity, averagePrice: ack.averagePrice };
    if (ack.status === 'QUEUED') {
      // Replay: the fill comes at a later bar. Ownership is confirmed by resolveOpenIntents once the venue reports the fill.
      return result({
        ...filled,
        protection: ack.protectionCarried ? 'PENDING_FILL' : 'NONE',
        detail: 'queued; ownership is confirmed when the venue reports the fill',
      });
    }

    let after: SlotView;
    try {
      after = await this.execution.readSlot(command.symbol);
    } catch (error) {
      return result({ ...filled, protection: 'FAILED', detail: `UNOWNED POSITION: the fill could not be attributed because the slot could not be read (${message(error)}); nothing was attached` });
    }
    const verdict = ownershipFromEvidence({
      slotQuantityBefore: before.quantity,
      orderFilled: true,
      slotAfter: { slotId: after.slotId, quantity: after.quantity },
    });
    if (verdict.kind === 'AMBIGUOUS') {
      this.ownership.recordAbandoned(command.commandId, `ownership not established: ${verdict.reason}`, now());
      return result({ ...filled, protection: 'FAILED', detail: `UNOWNED POSITION: ${verdict.reason}; the slot is treated as foreign and nothing was attached` });
    }

    this.ownership.recordOwned(command.commandId, verdict.slotId, now());
    const owned: OwnedPosition = { accountId: this.scope.accountId, symbol: command.symbol, slotId: verdict.slotId, episodeId: command.commandId };

    try {
      await this.execution.protect(command, owned);
      return result({ ...filled, protection: 'ATTACHED', detail: 'filled, owned and protected' });
    } catch (protectError) {
      try {
        await this.execution.flatten(owned, 'protection could not be attached');
        const left = await this.execution.readSlot(command.symbol);
        if (left.quantity > 0) {
          return result({ ...filled, protection: 'FAILED', detail: `UNPROTECTED POSITION: protection failed (${message(protectError)}) and the flatten left ${left.quantity} open` });
        }
        this.ownership.recordClosed(command.commandId, 'flattened after protection failed', now());
        return result({ ...filled, protection: 'FAILED', detail: `protection failed (${message(protectError)}); position flattened` });
      } catch (flattenError) {
        return result({ ...filled, protection: 'FAILED', detail: `UNPROTECTED POSITION: protection failed (${message(protectError)}) and flatten failed (${message(flattenError)})` });
      }
    }
  }

  private async submitWithReconciliation(command: PlaceOrderCommand): Promise<VenueOrderAck> {
    try {
      return await this.execution.submitOrder(command);
    } catch (error) {
      if (!(error instanceof VenueUnavailableError)) throw error;
    }
    // The first submission may have landed. Ask before sending anything again.
    const found = await this.execution.findOrder(command.idempotencyKey);
    if (found) return found;
    // The venue has no such order, so one more attempt under the same key cannot duplicate it
    return this.execution.submitOrder(command);
  }
}

function commandDefect(command: PlaceOrderCommand): string | null {
  if (!(command.quantity > 0) || !Number.isFinite(command.quantity)) return 'quantity must be a positive finite number';
  if (![command.referencePrice, command.stopLoss, command.takeProfit].every((v) => Number.isFinite(v) && v > 0)) return 'reference price, stop and target must be positive finite numbers';
  const long = command.side === 'BUY';
  if (long ? command.stopLoss >= command.referencePrice : command.stopLoss <= command.referencePrice) return 'the stop is not beyond the reference price';
  if (!command.idempotencyKey) return 'missing idempotency key';
  return null;
}

function scopeDefect(command: PlaceOrderCommand, scope: AccountScope): string | null {
  if (command.venue !== scope.venue) return `the command targets ${command.venue}; this handler is bound to ${scope.venue}`;
  if (command.accountId !== scope.accountId) return `the command targets account ${command.accountId}; this handler is bound to ${scope.accountId}`;
  return null;
}
