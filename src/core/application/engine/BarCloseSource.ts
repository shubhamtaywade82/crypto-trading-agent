import { barClosedEvent, TIMEFRAME_MS, type BarClosedEvent, type Timeframe } from '../../domain/market.js';
import type { Clock } from '../../ports/Clock.js';
import type { MarketDataPort } from '../../ports/MarketDataPort.js';

export interface BarCloseSourceOptions {
  readonly symbols: readonly string[];
  readonly timeframe: Timeframe;
  /** Wait after the bar boundary before reading the closed bar, so the venue has finalised it. */
  readonly settleMs: number;
  readonly marketData: MarketDataPort;
  readonly clock: Clock;
  readonly onEvent: (event: BarClosedEvent) => void;
  readonly onError: (error: unknown, symbol: string) => void;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Real-time event source: wakes just after each bar boundary and emits one `bar.closed` per symbol, read back from the
 * market-data port. It emits the same event type the replay produces, so nothing downstream can tell them apart.
 */
export class BarCloseSource {
  private timer: unknown = null;
  private running = false;

  constructor(private readonly options: BarCloseSourceOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) (this.options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer);
    this.timer = null;
  }

  /** Reads and emits the bar that closed at `boundary`. Exposed so a test can drive one tick. */
  async poll(boundary: number): Promise<void> {
    const { symbols, timeframe, marketData, onEvent, onError } = this.options;
    const expectedOpen = boundary - TIMEFRAME_MS[timeframe];
    await Promise.all(symbols.map(async (symbol) => {
      try {
        const snapshot = await marketData.getSnapshot({ symbol, timeframes: [timeframe], bars: 2, asOf: boundary });
        const bar = snapshot.candles[timeframe]?.at(-1);
        if (bar?.openTime !== expectedOpen) throw new Error(`expected the bar opened at ${expectedOpen}, the feed's latest closed bar is ${bar?.openTime ?? 'missing'}`);
        onEvent(barClosedEvent(symbol, timeframe, bar));
      } catch (error) {
        onError(error, symbol);
      }
    }));
  }

  private schedule(): void {
    const { timeframe, settleMs, clock } = this.options;
    const frame = TIMEFRAME_MS[timeframe];
    const boundary = (Math.floor(clock.now() / frame) + 1) * frame;
    const setTimer = this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = setTimer(() => {
      void this.poll(boundary).finally(() => {
        if (this.running) this.schedule();
      });
    }, boundary + settleMs - clock.now());
  }
}
