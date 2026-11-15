import type { PaperExecutionPort, SlotView, VenueOrderAck } from '../../ports/PaperExecutionPort.js';

export type ExecutionLog = (line: { op: string; commandId: string; symbol: string; ms: number; outcome: string }) => void;

/**
 * Logs every venue call with its latency and outcome. It wraps a PaperExecutionPort and is one itself only by
 * delegation: it cannot execute anywhere its inner port cannot. It never retries. A failed submission is the order
 * handler's to reconcile, and a blind resend here could place a second order.
 */
export function withExecutionLogging(inner: PaperExecutionPort, log: ExecutionLog, now: () => number = () => performance.now()): PaperExecutionPort {
  const timed = async <T>(op: string, subject: { commandId: string; symbol: string }, describe: (value: T) => string, action: () => Promise<T>): Promise<T> => {
    const startedAt = now();
    try {
      const value = await action();
      log({ op, commandId: subject.commandId, symbol: subject.symbol, ms: now() - startedAt, outcome: describe(value) });
      return value;
    } catch (error) {
      log({ op, commandId: subject.commandId, symbol: subject.symbol, ms: now() - startedAt, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    }
  };
  const ackText = (ack: VenueOrderAck | null): string => (ack ? `${ack.status} ${ack.venueOrderId}` : 'not found');
  const slotText = (slot: SlotView): string => `slot ${slot.slotId ?? 'none'} quantity ${slot.quantity}`;
  return {
    venue: inner.venue,
    accountId: inner.accountId,
    submitOrder: (command) => timed('submitOrder', command, ackText, () => inner.submitOrder(command)),
    findOrder: (key) => timed('findOrder', { commandId: key, symbol: '-' }, ackText, () => inner.findOrder(key)),
    readSlot: (symbol) => timed('readSlot', { commandId: '-', symbol }, slotText, () => inner.readSlot(symbol)),
    protect: (command, owned) => timed('protect', command, () => 'attached', () => inner.protect(command, owned)),
    flatten: (owned, reason) => timed('flatten', { commandId: owned.episodeId, symbol: owned.symbol }, () => `flattened (${reason})`, () => inner.flatten(owned, reason)),
  };
}
