import { BookTickerFrame, parsePositive, TradeFrame } from './parsers.js';
import type { PublicQuoteStore } from './PublicQuoteStore.js';
import type { PublicVenue } from './types.js';

/**
 * Routes one combined-stream frame into the store. Only `@bookTicker` and `@trade` streams are understood; anything
 * else, and any payload that fails validation, is ignored. Returns true when the frame changed the store.
 */
export function applyStreamFrame(store: PublicQuoteStore, venue: PublicVenue, stream: string, data: unknown, receivedAt: number): boolean {
  const name = stream.toLowerCase();
  if (name.endsWith('@bookticker')) {
    const frame = BookTickerFrame.safeParse(data);
    if (!frame.success) return false;
    return store.applyBook(venue, frame.data.s, parsePositive(frame.data.b), parsePositive(frame.data.a), receivedAt);
  }
  if (name.endsWith('@trade')) {
    const frame = TradeFrame.safeParse(data);
    if (!frame.success) return false;
    return store.applyTrade(venue, frame.data.s, parsePositive(frame.data.p), frame.data.T > 0 ? frame.data.T : receivedAt);
  }
  return false;
}

/** The combined-stream names for a set of symbols: one book and one trade stream each. */
export function streamNames(symbols: readonly string[], kinds: readonly ('bookTicker' | 'trade')[]): string[] {
  return symbols.flatMap((symbol) => kinds.map((kind) => `${symbol.toLowerCase()}@${kind}`));
}
