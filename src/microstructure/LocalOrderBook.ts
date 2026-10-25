/** One USD-M `depthUpdate`: absolute quantities per price level, chained by update ids. */
export interface DepthDiff {
  /** First update id in this event. */
  U: number;
  /** Final update id in this event. */
  u: number;
  /** Final update id of the previous event (USD-M only); the chain this book verifies. */
  pu?: number;
  /** Event time (ms). */
  E: number;
  b: ReadonlyArray<readonly [string, string]>;
  a: ReadonlyArray<readonly [string, string]>;
}

export interface DepthSnapshot {
  lastUpdateId: number;
  bids: ReadonlyArray<{ price: number; qty: number }>;
  asks: ReadonlyArray<{ price: number; qty: number }>;
}

export type BookStatus = 'SYNCING' | 'LIVE' | 'RESYNC_REQUIRED';
export type DiffResult = 'buffered' | 'applied' | 'dropped' | 'gap';

/** Diffs held while the REST snapshot is in flight; a burst larger than this means the snapshot is too slow to use. */
const MAX_BUFFER = 5_000;

/**
 * Local USD-M order book, maintained by the documented procedure:
 *  1. buffer stream events, 2. take a REST snapshot, 3. drop events with u < lastUpdateId,
 *  4. the first applied event must straddle the snapshot (U <= lastUpdateId <= u),
 *  5. every later event's pu must equal the previous event's u, 6. a quantity of 0 removes the level.
 * Any break (gap, crossed book, buffer overflow) flips the book to RESYNC_REQUIRED; it is never patched or guessed.
 */
export class LocalOrderBook {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private buffer: DepthDiff[] = [];
  private lastU: number | null = null;
  private snapshotId: number | null = null;
  private statusValue: BookStatus = 'SYNCING';
  private reasonValue = 'awaiting snapshot';
  /** Event time of the last applied diff. */
  lastEventAt = 0;
  /** Price range the REST snapshot covered; levels outside it are only known if a diff touched them. */
  coverage: { bidFloor: number; askCeil: number } | null = null;

  get status(): BookStatus {
    return this.statusValue;
  }

  get reason(): string {
    return this.reasonValue;
  }

  /** Back to SYNCING with nothing held: the caller must fetch a fresh snapshot. */
  reset(reason: string): void {
    this.bids.clear();
    this.asks.clear();
    this.buffer = [];
    this.lastU = null;
    this.snapshotId = null;
    this.coverage = null;
    this.statusValue = 'SYNCING';
    this.reasonValue = reason;
  }

  onDiff(diff: DepthDiff): DiffResult {
    if (this.statusValue === 'RESYNC_REQUIRED') return 'dropped';
    if (this.snapshotId === null) {
      if (this.buffer.length >= MAX_BUFFER) return this.fail('diff buffer overflowed before the snapshot arrived');
      this.buffer.push(diff);
      return 'buffered';
    }
    return this.apply(diff);
  }

  /** Applies a REST snapshot and replays the buffer. 'gap' means the buffer does not join the snapshot: fetch another. */
  loadSnapshot(snapshot: DepthSnapshot): 'applied' | 'gap' {
    this.bids.clear();
    this.asks.clear();
    for (const { price, qty } of snapshot.bids) if (qty > 0) this.bids.set(price, qty);
    for (const { price, qty } of snapshot.asks) if (qty > 0) this.asks.set(price, qty);
    this.snapshotId = snapshot.lastUpdateId;
    this.lastU = null;
    const bidPrices = [...this.bids.keys()];
    const askPrices = [...this.asks.keys()];
    this.coverage = bidPrices.length && askPrices.length ? { bidFloor: Math.min(...bidPrices), askCeil: Math.max(...askPrices) } : null;
    const pending = this.buffer;
    this.buffer = [];
    this.statusValue = 'SYNCING';
    this.reasonValue = 'replaying buffered diffs';
    for (const diff of pending) {
      if (this.apply(diff) === 'gap') return 'gap';
    }
    // With nothing buffered past the snapshot, the next live event must straddle it; until then the book is not LIVE.
    return 'applied';
  }

  bestBid(): number | null {
    let best: number | null = null;
    for (const p of this.bids.keys()) if (best === null || p > best) best = p;
    return best;
  }

  bestAsk(): number | null {
    let best: number | null = null;
    for (const p of this.asks.keys()) if (best === null || p < best) best = p;
    return best;
  }

  mid(): number | null {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    return bid !== null && ask !== null ? (bid + ask) / 2 : null;
  }

  /** Levels best first, at most `limit`. */
  levels(side: 'bids' | 'asks', limit = Number.POSITIVE_INFINITY): Array<[number, number]> {
    const map = side === 'bids' ? this.bids : this.asks;
    const sorted = [...map].sort((x, y) => (side === 'bids' ? y[0] - x[0] : x[0] - y[0]));
    return Number.isFinite(limit) ? sorted.slice(0, limit) : sorted;
  }

  private apply(diff: DepthDiff): DiffResult {
    const snapshotId = this.snapshotId as number;
    if (diff.u < snapshotId) return 'dropped';
    if (this.lastU === null) {
      if (!(diff.U <= snapshotId && diff.u >= snapshotId)) return this.fail(`first event ${diff.U}..${diff.u} does not straddle snapshot ${snapshotId}`);
    } else if (diff.pu !== undefined ? diff.pu !== this.lastU : diff.U !== this.lastU + 1) {
      return this.fail(`sequence gap: expected ${this.lastU}, got pu=${diff.pu ?? 'n/a'} U=${diff.U}`);
    }
    for (const [p, q] of diff.b) if (!this.setLevel(this.bids, Number(p), Number(q))) return this.fail(`malformed bid level ${p}@${q}`);
    for (const [p, q] of diff.a) if (!this.setLevel(this.asks, Number(p), Number(q))) return this.fail(`malformed ask level ${p}@${q}`);
    this.lastU = diff.u;
    this.lastEventAt = diff.E;
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (bid !== null && ask !== null && bid >= ask) return this.fail(`crossed book: bid ${bid} >= ask ${ask}`);
    this.statusValue = 'LIVE';
    this.reasonValue = '';
    return 'applied';
  }

  /** False for a level that cannot be a price/quantity: the event is corrupt and the book must resync. */
  private setLevel(map: Map<number, number>, price: number, qty: number): boolean {
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty < 0) return false;
    if (qty === 0) map.delete(price);
    else map.set(price, qty);
    return true;
  }

  private fail(reason: string): 'gap' {
    this.statusValue = 'RESYNC_REQUIRED';
    this.reasonValue = reason;
    return 'gap';
  }
}
