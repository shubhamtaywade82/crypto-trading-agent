import { LocalOrderBook } from '../microstructure/LocalOrderBook.js';

export interface DepthMetrics {
  imbalance: number | null;
  spreadBps: number | null;
}

export interface DepthSource {
  depth(symbol: string, depth: number, now: number): DepthMetrics | null;
}

/** Computes top-of-book spread and depth imbalance from a LocalOrderBook. */
export function computeDepthMetrics(book: LocalOrderBook, depth: number): DepthMetrics {
  const bids = book.levels('bids', depth);
  const asks = book.levels('asks', depth);
  if (!bids.length || !asks.length) return { imbalance: null, spreadBps: null };

  let bidNotional = 0;
  for (const [p, q] of bids) bidNotional += p * q;
  let askNotional = 0;
  for (const [p, q] of asks) askNotional += p * q;

  const bestBid = book.bestBid();
  const bestAsk = book.bestAsk();
  const mid = book.mid();
  const spreadBps = mid !== null && mid > 0 && bestBid !== null && bestAsk !== null
    ? ((bestAsk - bestBid) / mid) * 10_000
    : null;
  const total = bidNotional + askNotional;
  return {
    imbalance: total > 0 ? (bidNotional - askNotional) / total : null,
    spreadBps,
  };
}

/** Serves depth metrics from local order books with fallback on stale or resyncing books. */
export class OrderBookDepthSource implements DepthSource {
  private readonly books = new Map<string, LocalOrderBook>();

  constructor(private readonly maxAgeMs = 15_000) {}

  register(symbol: string, book: LocalOrderBook): void {
    this.books.set(symbol, book);
  }

  depth(symbol: string, depth: number, now: number): DepthMetrics | null {
    const book = this.books.get(symbol);
    if (!book || book.status !== 'LIVE') return null;
    if (book.lastEventAt > 0 && now - book.lastEventAt > this.maxAgeMs) return null;
    return computeDepthMetrics(book, depth);
  }
}
