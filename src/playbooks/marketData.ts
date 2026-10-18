import { BinanceClient } from '@nemesis-oss/binance-sdk';
import type { Candle } from '../types.js';
import type { SMCFrame } from '../strategies/smc-ml/types.js';
import { FRAME_MS } from './context.js';

/**
 * Historical candles from the Binance SDK for the playbook replay and context builder. Research uses a read-only client:
 * the SDK's own risk gateway refuses any order from it, so a data job can never trade.
 */

/** The SDK call this module needs (`client.futures.market.klines`), narrowed so tests can fake it. */
export interface KlineSource {
  klines(symbol: string, interval: SMCFrame, options: { startTime?: number; endTime?: number; limit?: number }): Promise<ReadonlyArray<{
    openTime: number; open: number; high: number; low: number; close: number; volume: number;
  }>>;
}

const PAGE = 1500;

/** Closed candles with openTime in [fromMs, toMs), oldest first, paginated. A bar still forming at `now` is dropped. */
export async function fetchSdkCandles(source: KlineSource, symbol: string, frame: SMCFrame, fromMs: number, toMs: number, now: number = Date.now()): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  let cursor = fromMs;
  // Each page advances by at least one bar, so this bound is never reached by a well-behaved venue
  const maxPages = Math.ceil((toMs - fromMs) / (FRAME_MS[frame] * PAGE)) + 2;
  for (let page = 0; page < maxPages && cursor < toMs; page += 1) {
    const batch = await source.klines(symbol, frame, { startTime: cursor, endTime: toMs - 1, limit: PAGE });
    if (batch.length === 0) break;
    for (const k of batch) {
      if (k.openTime < fromMs || k.openTime >= toMs || k.openTime + FRAME_MS[frame] > now) continue;
      out.set(k.openTime, { openTime: k.openTime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume });
    }
    const next = batch[batch.length - 1].openTime + FRAME_MS[frame];
    if (next <= cursor) throw new Error(`klines ${symbol} ${frame}: page did not advance past ${cursor}`);
    cursor = next;
    if (batch.length < PAGE) break;
  }
  return [...out.values()].sort((a, b) => a.openTime - b.openTime);
}

/** A client that can read market data and nothing else, with its clock synced to the venue's. */
export async function createReadOnlyMarketClient(symbols: readonly string[]): Promise<BinanceClient> {
  const client = new BinanceClient({ safety: { readOnly: true, allowedSymbols: [...symbols] } });
  await client.syncTime();
  return client;
}

/** Adapts the SDK client to `KlineSource`. */
export const sdkKlineSource = (client: BinanceClient): KlineSource => ({
  klines: (symbol, interval, options) => client.futures.market.klines(symbol, interval, options),
});
