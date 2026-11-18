import type { NativeTimeframe } from './MarketDataTypes.js';

/** Length of each native kline timeframe the market-data layer reads. */
export const NATIVE_TIMEFRAME_MS: Readonly<Record<NativeTimeframe, number>> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

/** The kline series the market-data layer keeps current, in subscription order. */
export const KLINE_INTERVALS: readonly NativeTimeframe[] = ['1m', '5m', '15m', '1h', '4h'];
