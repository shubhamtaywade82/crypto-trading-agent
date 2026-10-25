export interface TopOfBook {
  bid: number;
  bidQty: number;
  ask: number;
  askQty: number;
}

/**
 * Order-flow imbalance of one top-of-book change (Cont, Kukanov & Stoikov, 2014):
 *   e = q_b[n]·1{P_b[n] >= P_b[n-1]} - q_b[n-1]·1{P_b[n] <= P_b[n-1]}
 *     - q_a[n]·1{P_a[n] <= P_a[n-1]} + q_a[n-1]·1{P_a[n] >= P_a[n-1]}
 * Positive when bid size is added or ask size removed at the touch (buy pressure). It counts limit-order adds and
 * cancels as well as trades, which the trade-based delta cannot see.
 */
export function ofiIncrement(prev: TopOfBook, next: TopOfBook): number {
  let e = 0;
  if (next.bid >= prev.bid) e += next.bidQty;
  if (next.bid <= prev.bid) e -= prev.bidQty;
  if (next.ask <= prev.ask) e -= next.askQty;
  if (next.ask >= prev.ask) e += prev.askQty;
  return e;
}

export interface OfiWindow {
  /** Summed OFI in base-asset units. */
  ofi: number;
  /** OFI divided by the average touch depth ((bid qty + ask qty) / 2) over the window: comparable across symbols. */
  normalized: number | null;
  updates: number;
}

/** Rolling OFI from successive top-of-book states. `reset()` on any book invalidation: no increment spans a resync. */
export class OfiTracker {
  private prev: TopOfBook | null = null;
  private events: Array<{ t: number; e: number; depth: number }> = [];

  constructor(private readonly retainMs: number) {}

  onTop(top: TopOfBook | null, t: number): void {
    if (!top) { this.prev = null; return; }
    if (this.prev && (top.bid !== this.prev.bid || top.ask !== this.prev.ask || top.bidQty !== this.prev.bidQty || top.askQty !== this.prev.askQty)) {
      this.events.push({ t, e: ofiIncrement(this.prev, top), depth: (top.bidQty + top.askQty) / 2 });
      const cutoff = t - this.retainMs;
      let i = 0;
      while (i < this.events.length && this.events[i].t < cutoff) i += 1;
      if (i > 0) this.events = this.events.slice(i);
    }
    this.prev = top;
  }

  reset(): void {
    this.prev = null;
  }

  window(now: number, ms: number): OfiWindow {
    let ofi = 0;
    let depth = 0;
    let updates = 0;
    for (const ev of this.events) {
      if (ev.t <= now - ms || ev.t > now) continue;
      ofi += ev.e;
      depth += ev.depth;
      updates += 1;
    }
    return { ofi, normalized: updates > 0 && depth > 0 ? ofi / (depth / updates) : null, updates };
  }
}
