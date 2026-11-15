import type { PlaceOrderCommand } from '../../domain/execution.js';
import type { PaperExecutionPort, VenueOrderAck } from '../../ports/PaperExecutionPort.js';

export type ExecutionLog = (line: { op: string; commandId: string; symbol: string; ms: number; outcome: string }) => void;

/**
 * Logs every venue call with its latency and outcome. It wraps a PaperExecutionPort and is one itself only by
 * delegation: it cannot execute anywhere its inner port cannot. It never retries. A failed submission is the order
 * handler's to reconcile, and a blind resend here could place a second order.
 */
export function withExecutionLogging(inner: PaperExecutionPort, log: ExecutionLog, now: () => number = () => performance.now()): PaperExecutionPort {
  const timed = async <T>(op: string, command: PlaceOrderCommand | { commandId: string; symbol: string }, describe: (value: T) => string, action: () => Promise<T>): Promise<T> => {
    const startedAt = now();
    try {
      const value = await action();
      log({ op, commandId: command.commandId, symbol: command.symbol, ms: now() - startedAt, outcome: describe(value) });
      return value;
    } catch (error) {
      log({ op, commandId: command.commandId, symbol: command.symbol, ms: now() - startedAt, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    }
  };
  const ackText = (ack: VenueOrderAck | null): string => (ack ? `${ack.status} ${ack.venueOrderId}` : 'not found');
  return {
    venue: inner.venue,
    submitOrder: (command) => timed('submitOrder', command, ackText, () => inner.submitOrder(command)),
    findOrder: (key) => timed('findOrder', { commandId: key, symbol: '-' }, ackText, () => inner.findOrder(key)),
    protect: (command) => timed('protect', command, () => 'attached', () => inner.protect(command)),
    flatten: (command, reason) => timed('flatten', command, () => `flattened (${reason})`, () => inner.flatten(command, reason)),
  };
}
