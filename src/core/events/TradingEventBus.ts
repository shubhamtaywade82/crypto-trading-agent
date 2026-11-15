import type { TradingEvent, TradingEventBody } from './TradingEvent.js';

export type TradingEventListener = (event: TradingEvent) => void;

/**
 * Synchronous fan-out for secondary consumers (journal, metrics, analytics). The trading pipeline never waits on a
 * listener and never reads a listener's result, so subscribers cannot reorder or alter execution. A listener that
 * throws is isolated and counted.
 */
export class TradingEventBus {
  private readonly listeners = new Set<TradingEventListener>();
  private sequence = 0;
  private failures = 0;

  constructor(private readonly runId: string, private readonly onListenerError: (error: unknown, event: TradingEvent) => void = () => undefined) {}

  subscribe(listener: TradingEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(body: TradingEventBody, at: number, causeEventId: string): TradingEvent {
    this.sequence += 1;
    const event = Object.freeze({ ...body, sequence: this.sequence, at, causeEventId, runId: this.runId }) as TradingEvent;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.failures += 1;
        this.onListenerError(error, event);
      }
    }
    return event;
  }

  get listenerFailures(): number {
    return this.failures;
  }
}
