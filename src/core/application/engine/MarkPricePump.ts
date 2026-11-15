import type { Clock } from '../../ports/Clock.js';
import type { MarkSinkPort, MarkSourcePort } from '../../ports/MarkFeedPort.js';

export interface MarkPricePumpOptions {
  readonly symbols: readonly string[];
  readonly intervalMs: number;
  readonly source: MarkSourcePort;
  readonly sink: MarkSinkPort;
  readonly clock: Clock;
  readonly onError: (error: unknown) => void;
}

/**
 * Keeps the paper venue's marks current between bars. Without it a protective stop attached to a position would only
 * be checked when a bar closes. It also forwards each funding settlement once, when its time passes.
 */
export class MarkPricePump {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  /** The funding time each symbol was last seen waiting for, with the rate and mark observed just before it. */
  private readonly pendingFunding = new Map<string, { time: number; rate: number; mark: number }>();

  constructor(private readonly options: MarkPricePumpOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One push. A tick that finds the previous one still running is dropped rather than queued. */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const { symbols, source, sink, clock, onError } = this.options;
    try {
      const quotes = (await source.getMarks(symbols)).filter((q) => Number.isFinite(q.markPrice) && q.markPrice > 0);
      if (quotes.length === 0) return;
      await sink.pushMarks(Object.fromEntries(quotes.map((q) => [q.symbol, q.markPrice])));
      for (const quote of quotes) {
        const pending = this.pendingFunding.get(quote.symbol);
        if (pending && clock.now() >= pending.time && quote.nextFundingTime > pending.time) {
          await sink.pushFunding(quote.symbol, pending.rate, pending.mark, pending.time);
        }
        if (quote.nextFundingTime > 0) this.pendingFunding.set(quote.symbol, { time: quote.nextFundingTime, rate: quote.fundingRate, mark: quote.markPrice });
      }
    } catch (error) {
      onError(error);
    } finally {
      this.inFlight = false;
    }
  }
}
