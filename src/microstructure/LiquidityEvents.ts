export type LiquidityEventKind = 'CONCENTRATION' | 'ABSORPTION' | 'CONSUMED' | 'PULLED';

export interface LiquidityEvent {
  t: number;
  kind: LiquidityEventKind;
  side: 'bid' | 'ask';
  /** Lower edge of the price bucket the liquidity sits in. */
  price: number;
  /** Displayed quantity (base asset) at its peak. */
  peakQty: number;
  /** Aggressor volume executed into it (base asset). */
  executedQty: number;
  /** For CONSUMED: price traded through the level afterwards. */
  priceThrough?: boolean;
  lifetimeMs: number;
}

export interface EventOptions {
  /** A bucket counts as concentrated at this multiple of the side's median bucket. */
  wallMultiple: number;
  /** Concentrations shorter-lived than this are never announced (flicker and spoof filter). */
  persistMs: number;
  /** Absorption window and the executed/peak ratio that qualifies. */
  absorbWindowMs: number;
  absorbRatio: number;
  /** A wall still showing this fraction of its peak counts as held (replenished). */
  holdFraction: number;
  /** Below this fraction of its peak a wall is gone. */
  goneFraction: number;
}

export const DEFAULT_EVENT_OPTIONS: EventOptions = { wallMultiple: 4, persistMs: 3_000, absorbWindowMs: 10_000, absorbRatio: 1, holdFraction: 0.7, goneFraction: 0.5 };

interface Wall {
  side: 'bid' | 'ask';
  bucket: number;
  price: number;
  firstSeen: number;
  peakQty: number;
  qty: number;
  executed: number;
  recent: Array<{ t: number; qty: number }>;
  announced: boolean;
  absorbedAt: number;
}

export interface BucketSample {
  t: number;
  mid: number;
  bucketSize: number;
  /** Displayed quantity per bucket index, within the tracked band. */
  bids: ReadonlyMap<number, number>;
  asks: ReadonlyMap<number, number>;
  /** Aggressor volume this sample per bucket: sells hit bids, buys lift asks. */
  sellsIntoBids: ReadonlyMap<number, number>;
  buysIntoAsks: ReadonlyMap<number, number>;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Tracks concentrated displayed liquidity per price bucket and classifies what happens to it: announced once it has
 * persisted, ABSORPTION when aggressors trade into it and it holds while price stays on its side, CONSUMED when it
 * shrinks with matching executed volume, PULLED when it shrinks without trades (cancelled). These are descriptions of
 * what the book did; none of them is a prediction.
 */
export class LiquidityEventTracker {
  private walls = new Map<string, Wall>();
  private readonly log: LiquidityEvent[] = [];

  constructor(private readonly opts: EventOptions = DEFAULT_EVENT_OPTIONS, private readonly maxEvents = 50) {}

  events(): LiquidityEvent[] {
    return [...this.log];
  }

  /** Walls currently announced, for the renderer. */
  activeWalls(): Array<{ side: 'bid' | 'ask'; price: number; qty: number; since: number }> {
    return [...this.walls.values()].filter((w) => w.announced).map((w) => ({ side: w.side, price: w.price, qty: w.qty, since: w.firstSeen }));
  }

  update(sample: BucketSample): LiquidityEvent[] {
    const emitted: LiquidityEvent[] = [];
    for (const side of ['bid', 'ask'] as const) {
      const book = side === 'bid' ? sample.bids : sample.asks;
      const executed = side === 'bid' ? sample.sellsIntoBids : sample.buysIntoAsks;
      const baseline = median([...book.values()].filter((q) => q > 0));
      const isWall = (qty: number) => baseline > 0 && qty >= this.opts.wallMultiple * baseline;

      for (const [bucket, qty] of book) {
        const key = `${side}:${bucket}`;
        if (!this.walls.has(key) && isWall(qty)) {
          this.walls.set(key, { side, bucket, price: bucket * sample.bucketSize, firstSeen: sample.t, peakQty: qty, qty, executed: 0, recent: [], announced: false, absorbedAt: 0 });
        }
      }

      for (const [key, wall] of this.walls) {
        if (wall.side !== side) continue;
        const qty = book.get(wall.bucket) ?? 0;
        const hit = executed.get(wall.bucket) ?? 0;
        wall.qty = qty;
        if (hit > 0) {
          wall.executed += hit;
          wall.recent.push({ t: sample.t, qty: hit });
        }
        wall.recent = wall.recent.filter((r) => r.t > sample.t - this.opts.absorbWindowMs);
        if (qty > wall.peakQty) wall.peakQty = qty;

        if (qty < this.opts.goneFraction * wall.peakQty) {
          this.walls.delete(key);
          if (!wall.announced) continue;
          const dropped = wall.peakQty - qty;
          const through = side === 'bid' ? sample.mid < wall.price : sample.mid > wall.price + sample.bucketSize;
          const kind: LiquidityEventKind = wall.executed >= 0.5 * dropped ? 'CONSUMED' : 'PULLED';
          emitted.push(this.event(sample.t, kind, wall, kind === 'CONSUMED' ? { priceThrough: through } : {}));
          continue;
        }

        if (!wall.announced && sample.t - wall.firstSeen >= this.opts.persistMs) {
          wall.announced = true;
          emitted.push(this.event(sample.t, 'CONCENTRATION', wall));
        }

        const recentHit = wall.recent.reduce((s, r) => s + r.qty, 0);
        const held = qty >= this.opts.holdFraction * wall.peakQty;
        const priceHeld = side === 'bid' ? sample.mid >= wall.price : sample.mid <= wall.price + sample.bucketSize;
        if (wall.announced && held && priceHeld && recentHit >= this.opts.absorbRatio * wall.peakQty && sample.t - wall.absorbedAt >= this.opts.absorbWindowMs * 3) {
          wall.absorbedAt = sample.t;
          emitted.push(this.event(sample.t, 'ABSORPTION', wall, { executedQty: recentHit }));
        }
      }
    }
    for (const e of emitted) this.log.unshift(e);
    this.log.length = Math.min(this.log.length, this.maxEvents);
    return emitted;
  }

  /** Forget every wall: the book they were measured on is no longer valid. */
  reset(): void {
    this.walls.clear();
  }

  private event(t: number, kind: LiquidityEventKind, wall: Wall, extra: Partial<LiquidityEvent> = {}): LiquidityEvent {
    return { t, kind, side: wall.side, price: wall.price, peakQty: wall.peakQty, executedQty: wall.executed, lifetimeMs: t - wall.firstSeen, ...extra };
  }
}

export interface LiquidationOrder {
  time: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  notional: number;
}

export interface LiquidationReading {
  longNotional1m: number;
  shortNotional1m: number;
  longNotional5m: number;
  shortNotional5m: number;
  exhaustion: 'NONE' | 'LONG_EXHAUSTION' | 'SHORT_EXHAUSTION';
  recentCount: number;
}

export class LiquidationTracker {
  private readonly orders: LiquidationOrder[] = [];
  private readonly windowMs = 300_000;

  onLiquidation(order: LiquidationOrder): void {
    this.orders.push(order);
    this.prune(order.time);
  }

  reading(now: number, mid: number | null): LiquidationReading {
    this.prune(now);
    const m1 = now - 60_000;
    let long1m = 0;
    let short1m = 0;
    let long5m = 0;
    let short5m = 0;

    for (const o of this.orders) {
      if (o.side === 'SELL') {
        long5m += o.notional;
        if (o.time >= m1) long1m += o.notional;
      } else {
        short5m += o.notional;
        if (o.time >= m1) short1m += o.notional;
      }
    }

    let exhaustion: 'NONE' | 'LONG_EXHAUSTION' | 'SHORT_EXHAUSTION' = 'NONE';
    if (long1m >= 20_000 && mid !== null) {
      exhaustion = 'LONG_EXHAUSTION';
    } else if (short1m >= 20_000 && mid !== null) {
      exhaustion = 'SHORT_EXHAUSTION';
    }

    return { longNotional1m: long1m, shortNotional1m: short1m, longNotional5m: long5m, shortNotional5m: short5m, exhaustion, recentCount: this.orders.length };
  }

  reset(): void {
    this.orders.length = 0;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.orders.length > 0 && this.orders[0].time < cutoff) {
      this.orders.shift();
    }
  }
}

