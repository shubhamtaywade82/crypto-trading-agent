import type { PublicQuote, PublicVenue, QuoteQuality } from './types.js';

interface BookState { readonly bid: number; readonly ask: number; readonly at: number }
interface TradeState { readonly price: number; readonly at: number }

const keyOf = (venue: PublicVenue, symbol: string): string => `${venue}:${symbol.toUpperCase()}`;

/**
 * Latest top-of-book and last trade per venue and symbol. A frame that fails validation is dropped, not stored: a
 * crossed or zero book is a bad frame, never a quote. Freshness is judged from the book's receive time against
 * `staleMs`; a symbol that never produced a valid book reads MISSING with null fields, never zero.
 */
export class PublicQuoteStore {
  private readonly books = new Map<string, BookState>();
  private readonly trades = new Map<string, TradeState>();

  constructor(private readonly staleMs: number) {
    if (!(staleMs > 0)) throw new Error(`staleMs must be positive, got ${staleMs}`);
  }

  /** Returns false (and stores nothing) for a missing, non-positive, non-finite or crossed book. */
  applyBook(venue: PublicVenue, symbol: string, bid: number | null, ask: number | null, at: number): boolean {
    if (bid === null || ask === null || !Number.isFinite(at)) return false;
    if (!(bid > 0) || !(ask > 0) || bid >= ask) return false;
    this.books.set(keyOf(venue, symbol), { bid, ask, at });
    return true;
  }

  applyTrade(venue: PublicVenue, symbol: string, price: number | null, at: number): boolean {
    if (price === null || !(price > 0) || !Number.isFinite(at)) return false;
    this.trades.set(keyOf(venue, symbol), { price, at });
    return true;
  }

  quality(venue: PublicVenue, symbol: string, now: number): QuoteQuality {
    const book = this.books.get(keyOf(venue, symbol));
    if (!book) return 'MISSING';
    return now - book.at <= this.staleMs ? 'LIVE' : 'STALE';
  }

  quote(venue: PublicVenue, symbol: string, now: number): PublicQuote {
    const book = this.books.get(keyOf(venue, symbol));
    const trade = this.trades.get(keyOf(venue, symbol));
    return {
      venue,
      symbol: symbol.toUpperCase(),
      bid: book?.bid ?? null,
      ask: book?.ask ?? null,
      mid: book ? (book.bid + book.ask) / 2 : null,
      last: trade?.price ?? null,
      bookAt: book?.at ?? null,
      tradeAt: trade?.at ?? null,
      quality: this.quality(venue, symbol, now),
    };
  }

  /** Every symbol this store has seen on the venue, quoted as of `now`. */
  snapshot(venue: PublicVenue, now: number): Record<string, PublicQuote> {
    const symbols = new Set<string>();
    for (const key of [...this.books.keys(), ...this.trades.keys()]) {
      const [v, symbol] = key.split(':');
      if (v === venue && symbol) symbols.add(symbol);
    }
    return Object.fromEntries([...symbols].sort().map((symbol) => [symbol, this.quote(venue, symbol, now)]));
  }

  /** (spot mid − USDⓈ-M mid) / USDⓈ-M mid in basis points. Null unless both books are LIVE. */
  basisBps(symbol: string, now: number): number | null {
    const spot = this.quote('SPOT', symbol, now);
    const perp = this.quote('USDM', symbol, now);
    if (spot.quality !== 'LIVE' || perp.quality !== 'LIVE' || spot.mid === null || perp.mid === null) return null;
    return ((spot.mid - perp.mid) / perp.mid) * 10_000;
  }
}
