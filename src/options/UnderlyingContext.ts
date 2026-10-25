import type { BinanceClient } from '@nemesis-oss/binance-sdk';
import { MarketStateBuilder } from '../market/MarketStateBuilder.js';
import type { MarketState } from '../market/types.js';
import type { Candle } from '../types.js';

export interface UnderlyingContext {
  marketState: MarketState;
  candles1h: Candle[];
  /** Close time of the newest closed 15m candle. */
  lastClosedAt: number;
}

export interface UnderlyingContextSource {
  context(underlying: string): Promise<UnderlyingContext>;
}

type Frame = '15m' | '1h' | '4h';
const FRAME_MS: Record<Frame, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const LIMITS: Record<Frame, number> = { '15m': 300, '1h': 300, '4h': 200 };

/** The SDK call this source needs (`client.futures.market.klines`), narrowed so tests can fake it. */
export interface KlineReader {
  klines(symbol: string, interval: Frame, options: { limit: number }): Promise<ReadonlyArray<{
    openTime: number; open: number; high: number; low: number; close: number; volume: number;
  }>>;
}

export const sdkKlineReader = (client: BinanceClient): KlineReader => ({
  klines: (symbol, interval, options) => client.futures.market.klines(symbol, interval, options),
});

export class StaleContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleContextError';
  }
}

/**
 * Builds the deterministic MarketState for an option underlying from Binance USD-M klines read through binance-sdk.
 * Only closed candles are used (a bar still forming is dropped), and a feed whose newest closed 15m bar is more than
 * two bars old is refused rather than traded on.
 */
export class SdkUnderlyingContextSource implements UnderlyingContextSource {
  constructor(
    private readonly reader: KlineReader,
    private readonly builder: MarketStateBuilder = new MarketStateBuilder(),
    private readonly now: () => number = Date.now,
  ) {}

  async context(underlying: string): Promise<UnderlyingContext> {
    const [c15, c1h, c4h] = await Promise.all((['15m', '1h', '4h'] as const).map((f) => this.closed(underlying, f)));
    const last = c15.at(-1);
    if (!last || c15.length < 50) throw new StaleContextError(`${underlying}: ${c15.length} closed 15m candles (need 50)`);
    const lastClosedAt = last.openTime + FRAME_MS['15m'];
    if (this.now() - lastClosedAt > 2 * FRAME_MS['15m']) {
      throw new StaleContextError(`${underlying}: newest closed 15m candle closed ${Math.round((this.now() - lastClosedAt) / 60_000)} min ago`);
    }
    const marketState = this.builder.build({
      symbol: underlying,
      candles: c15,
      candlesByTimeframe: { '15m': c15, '1h': c1h, '4h': c4h },
      mark: last.close,
      fundingRate: 0,
    });
    return { marketState, candles1h: c1h, lastClosedAt };
  }

  private async closed(symbol: string, frame: Frame): Promise<Candle[]> {
    const now = this.now();
    const rows = await this.reader.klines(symbol, frame, { limit: LIMITS[frame] });
    return rows
      .filter((k) => k.openTime + FRAME_MS[frame] <= now)
      .map((k) => ({ openTime: k.openTime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
  }
}
