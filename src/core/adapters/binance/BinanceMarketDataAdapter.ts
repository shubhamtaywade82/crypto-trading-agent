import { BinanceClient } from '@nemesis-oss/binance-sdk';
import { candleDefect, TIMEFRAME_MS, type Candle, type MarketSnapshot, type Timeframe } from '../../domain/market.js';
import type { MarkQuote, MarkSourcePort } from '../../ports/MarkFeedPort.js';
import { MarketDataError, type HistoricalDataPort, type MarketDataPort, type SnapshotRequest } from '../../ports/MarketDataPort.js';

/** The four public SDK calls this adapter makes, narrowed so tests can fake them without a socket. */
export interface BinancePublicSource {
  klines(symbol: string, interval: Timeframe, options: { startTime?: number; endTime?: number; limit?: number }): Promise<ReadonlyArray<{
    openTime: number; open: number; high: number; low: number; close: number; volume: number;
  }>>;
  premiumIndex(symbol: string): Promise<{ markPrice: number; lastFundingRate: number; nextFundingTime: number; time: number }>;
  openInterest(symbol: string): Promise<{ openInterest: number }>;
}

/**
 * A market-data client that cannot trade: it is built without credentials, so no signed request can be formed, and
 * with the SDK's read-only policy, which refuses every mutating request before it leaves the process.
 */
export function createReadOnlyBinanceClient(symbols: readonly string[]): BinanceClient {
  return new BinanceClient({ safety: { readOnly: true, allowedSymbols: [...symbols] } });
}

export const binancePublicSource = (client: BinanceClient): BinancePublicSource => ({
  klines: (symbol, interval, options) => client.futures.market.klines(symbol, interval, options),
  premiumIndex: (symbol) => client.futures.data.premiumIndex(symbol),
  openInterest: (symbol) => client.futures.data.openInterest(symbol),
});

const PAGE = 1500;
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const toCandle = (k: { openTime: number; open: number; high: number; low: number; close: number; volume: number }): Candle =>
  ({ openTime: k.openTime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume });

/** Translates Binance USD-M public market data into the core's canonical snapshot. Read-only by construction. */
export class BinanceMarketDataAdapter implements MarketDataPort, HistoricalDataPort, MarkSourcePort {
  constructor(private readonly source: BinancePublicSource) {}

  async getSnapshot(request: SnapshotRequest): Promise<MarketSnapshot> {
    const { symbol, timeframes, bars, asOf } = request;
    try {
      const [candleSets, premium, openInterest] = await Promise.all([
        Promise.all(timeframes.map((timeframe) => this.closedCandles(symbol, timeframe, bars, asOf))),
        this.source.premiumIndex(symbol),
        // Open interest is context, not a requirement: its absence must not stop a decision
        this.source.openInterest(symbol).then((oi) => oi.openInterest, () => null),
      ]);
      if (!Number.isFinite(premium.markPrice) || premium.markPrice <= 0) throw new MarketDataError(`${symbol}: mark price ${premium.markPrice} is not usable`);
      return {
        symbol,
        asOf,
        candles: Object.fromEntries(timeframes.map((timeframe, i) => [timeframe, candleSets[i]])),
        markPrice: premium.markPrice,
        markAt: premium.time,
        fundingRate: Number.isFinite(premium.lastFundingRate) ? premium.lastFundingRate : null,
        openInterest: openInterest !== null && Number.isFinite(openInterest) ? openInterest : null,
      };
    } catch (error) {
      if (error instanceof MarketDataError) throw error;
      throw new MarketDataError(`${symbol}: market data unavailable: ${describe(error)}`, { cause: error });
    }
  }

  async getCandles(symbol: string, timeframe: Timeframe, fromMs: number, toMs: number): Promise<readonly Candle[]> {
    const frame = TIMEFRAME_MS[timeframe];
    const out = new Map<number, Candle>();
    let cursor = fromMs;
    while (cursor < toMs) {
      const batch = await this.source.klines(symbol, timeframe, { startTime: cursor, endTime: toMs - 1, limit: PAGE });
      if (batch.length === 0) break;
      for (const k of batch) if (k.openTime >= fromMs && k.openTime < toMs) out.set(k.openTime, this.checked(symbol, timeframe, toCandle(k)));
      const next = batch[batch.length - 1].openTime + frame;
      if (next <= cursor) throw new MarketDataError(`${symbol} ${timeframe}: klines page did not advance past ${cursor}`);
      cursor = next;
      if (batch.length < PAGE) break;
    }
    return [...out.values()].sort((a, b) => a.openTime - b.openTime);
  }

  async getMarks(symbols: readonly string[]): Promise<readonly MarkQuote[]> {
    const settled = await Promise.allSettled(symbols.map((symbol) => this.source.premiumIndex(symbol)));
    return settled.flatMap((result, i) => result.status === 'fulfilled'
      ? [{ symbol: symbols[i], markPrice: result.value.markPrice, fundingRate: result.value.lastFundingRate, nextFundingTime: result.value.nextFundingTime, observedAt: result.value.time }]
      : []);
  }

  /** The last `bars` candles that had fully closed at `asOf`, checked for gaps and malformed values. */
  private async closedCandles(symbol: string, timeframe: Timeframe, bars: number, asOf: number): Promise<readonly Candle[]> {
    const frame = TIMEFRAME_MS[timeframe];
    // One extra row: the venue's newest row may be the bar still forming
    const raw = await this.source.klines(symbol, timeframe, { endTime: asOf - 1, limit: Math.min(PAGE, bars + 1) });
    const closed = raw.filter((k) => k.openTime + frame <= asOf).map((k) => this.checked(symbol, timeframe, toCandle(k))).sort((a, b) => a.openTime - b.openTime).slice(-bars);
    for (let i = 1; i < closed.length; i += 1) {
      if (closed[i].openTime - closed[i - 1].openTime !== frame) throw new MarketDataError(`${symbol} ${timeframe}: gap between bars ${closed[i - 1].openTime} and ${closed[i].openTime}`);
    }
    return closed;
  }

  private checked(symbol: string, timeframe: Timeframe, candle: Candle): Candle {
    const defect = candleDefect(candle);
    if (defect) throw new MarketDataError(`${symbol} ${timeframe} bar ${candle.openTime}: ${defect}`);
    return candle;
  }
}
