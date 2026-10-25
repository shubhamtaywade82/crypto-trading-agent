/** One aggregate trade. `buyerIsMaker` true means the seller crossed the spread (sell aggressor). */
export interface AggTrade {
  time: number;
  price: number;
  qty: number;
  buyerIsMaker: boolean;
}

export interface FlowWindow {
  buyQty: number;
  sellQty: number;
  buyNotional: number;
  sellNotional: number;
  trades: number;
  /** (buy - sell) / (buy + sell) by notional, in [-1, 1]; null with no trades. */
  delta: number | null;
}

/** Rolling signed aggressor flow and cumulative volume delta. Trades older than `retainMs` are dropped. */
export class TradeFlow {
  private trades: AggTrade[] = [];
  /** Signed base-asset volume since the feed started (buy +, sell -). */
  cvd = 0;

  constructor(private readonly retainMs = 120_000) {}

  add(trade: AggTrade): void {
    if (!(trade.qty > 0) || !(trade.price > 0) || !Number.isFinite(trade.time)) return;
    this.trades.push(trade);
    this.cvd += trade.buyerIsMaker ? -trade.qty : trade.qty;
  }

  window(now: number, ms: number): FlowWindow {
    this.prune(now);
    const out: FlowWindow = { buyQty: 0, sellQty: 0, buyNotional: 0, sellNotional: 0, trades: 0, delta: null };
    for (const t of this.trades) {
      if (t.time <= now - ms || t.time > now) continue;
      out.trades += 1;
      if (t.buyerIsMaker) { out.sellQty += t.qty; out.sellNotional += t.qty * t.price; }
      else { out.buyQty += t.qty; out.buyNotional += t.qty * t.price; }
    }
    const total = out.buyNotional + out.sellNotional;
    out.delta = total > 0 ? (out.buyNotional - out.sellNotional) / total : null;
    return out;
  }

  /** Trades in (from, to], oldest first. */
  between(from: number, to: number): AggTrade[] {
    return this.trades.filter((t) => t.time > from && t.time <= to);
  }

  private prune(now: number): void {
    const cutoff = now - this.retainMs;
    let i = 0;
    while (i < this.trades.length && this.trades[i].time < cutoff) i += 1;
    if (i > 0) this.trades = this.trades.slice(i);
  }
}
