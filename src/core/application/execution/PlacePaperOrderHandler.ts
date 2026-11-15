import { OrderLifecycle, type OrderResult, type OrderState, type PlaceOrderCommand } from '../../domain/execution.js';
import type { Clock } from '../../ports/Clock.js';
import { VenueRejectedError, VenueUnavailableError, type PaperExecutionPort, type VenueOrderAck } from '../../ports/PaperExecutionPort.js';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const ACK_STATE: Readonly<Record<VenueOrderAck['status'], OrderState>> = {
  FILLED: 'FILLED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  QUEUED: 'ACKNOWLEDGED',
};

/**
 * Executes order commands against the paper venue.
 *
 * - Idempotent: a command id is submitted at most once per process; a repeat returns the first outcome.
 * - A lost answer is reconciled by idempotency key before anything is sent again, and is sent again at most once
 *   with the same key. If the outcome is still unknown the order ends UNKNOWN and the caller halts trading.
 * - A filled entry must end protected. If the stop cannot be attached the position is flattened.
 */
export class PlacePaperOrderHandler {
  private readonly outcomes = new Map<string, Promise<OrderResult>>();

  constructor(private readonly execution: PaperExecutionPort, private readonly clock: Clock) {}

  handle(command: PlaceOrderCommand): Promise<OrderResult> {
    const existing = this.outcomes.get(command.commandId);
    if (existing) return existing;
    const outcome = this.execute(command);
    this.outcomes.set(command.commandId, outcome);
    return outcome;
  }

  private async execute(command: PlaceOrderCommand): Promise<OrderResult> {
    const lifecycle = new OrderLifecycle(command.commandId);
    const result = (fields: Partial<OrderResult> & { detail: string }): OrderResult => ({
      commandId: command.commandId, state: lifecycle.state, venueOrderId: null, filledQuantity: 0, averagePrice: null,
      protection: 'NONE', transitions: [...lifecycle.history], ...fields,
    });

    const defect = commandDefect(command);
    if (defect) {
      lifecycle.transition('REJECTED', this.clock.now(), defect);
      return result({ detail: `invalid command: ${defect}` });
    }
    lifecycle.transition('VALIDATED', this.clock.now());
    lifecycle.transition('SUBMITTED', this.clock.now());

    let ack: VenueOrderAck;
    try {
      ack = await this.submitWithReconciliation(command);
    } catch (error) {
      const rejected = error instanceof VenueRejectedError;
      lifecycle.transition(rejected ? 'REJECTED' : 'UNKNOWN', this.clock.now(), message(error));
      return result({ detail: rejected ? `venue rejected: ${message(error)}` : `outcome unknown: ${message(error)}` });
    }

    lifecycle.transition(ACK_STATE[ack.status], this.clock.now());
    const filled = { venueOrderId: ack.venueOrderId, filledQuantity: ack.filledQuantity, averagePrice: ack.averagePrice };
    if (ack.protectionCarried) {
      return result({ ...filled, protection: ack.status === 'QUEUED' ? 'PENDING_FILL' : 'ATTACHED', detail: `${ack.status.toLowerCase()} with stop and target on the order` });
    }
    if (ack.status === 'QUEUED') return result({ ...filled, protection: 'NONE', detail: 'queued without protection' });

    try {
      await this.execution.protect(command);
      return result({ ...filled, protection: 'ATTACHED', detail: 'filled and protected' });
    } catch (protectError) {
      try {
        await this.execution.flatten(command, 'protection could not be attached');
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
