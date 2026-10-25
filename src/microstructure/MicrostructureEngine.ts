import { DEFAULT_EVENT_OPTIONS, LiquidityEventTracker, type EventOptions, type LiquidityEvent } from './LiquidityEvents.js';
import { LocalOrderBook, type DepthDiff, type DepthSnapshot } from './LocalOrderBook.js';
import { TradeFlow, type AggTrade } from './TradeFlow.js';

export interface MicroOptions {
  /** Price bucket height of the pressure field, in bps of the first valid mid. */
  bucketBps: number;
  /** Buckets tracked on each side of mid (field height and wall search band). */
  bandBuckets: number;
  /** Samples (columns) of history kept for the field. */
  historyColumns: number;
  flowWindowMs: number;
  shortFlowMs: number;
  /** |delta| at which one side's aggression counts as dominant. */
  flowActive: number;
  /** |mid change| over the flow window that counts as a price response. */
  priceMoveBps: number;
  /** Fewer trades than this in the flow window is THIN: no phase is read from it. */
  minTrades: number;
  /** Order size the friction estimate walks the book for, in quote currency. */
  orderNotional: number;
  maxSpreadBps: number;
  maxSlipBps: number;
  /** A book with no diff for this long is STALE. */
  staleMs: number;
  events: EventOptions;
}

export const DEFAULT_MICRO_OPTIONS: MicroOptions = {
  bucketBps: 1, bandBuckets: 30, historyColumns: 240, flowWindowMs: 30_000, shortFlowMs: 5_000, flowActive: 0.2,
  priceMoveBps: 3, minTrades: 5, orderNotional: 5_000, maxSpreadBps: 5, maxSlipBps: 10, staleMs: 5_000, events: DEFAULT_EVENT_OPTIONS,
};

export type FlowPhase = 'INITIATIVE_BUYING' | 'BUY_ABSORBED' | 'INITIATIVE_SELLING' | 'SELL_ABSORBED' | 'DRIFT_UP' | 'DRIFT_DOWN' | 'BALANCED' | 'THIN';
export type FrictionStatus = 'OK' | 'ELEVATED' | 'BLOCK';
export type Evidence = 'SUPPORTS_LONG' | 'SUPPORTS_SHORT' | 'MIXED' | 'NONE' | 'INVALID';
export type FeedBookStatus = 'LIVE' | 'SYNCING' | 'RESYNC' | 'STALE';

/** The structured outcome the cockpit renders and the recorder stores. Every number comes from the local book and trades. */
export interface MicrostructureReading {
  symbol: string;
  t: number;
  book: { status: FeedBookStatus; reason: string; ageMs: number | null };
  mid: number | null;
  spreadBps: number | null;
  /** (bid - ask) / (bid + ask) of displayed quantity within 10 and 25 bps of mid. */
  depthImbalance: { bps10: number | null; bps25: number | null };
  flow: { delta5s: number | null; delta30s: number | null; buyNotional30s: number; sellNotional30s: number; trades30s: number; cvd: number };
  priceResponseBps30s: number | null;
  phase: FlowPhase;
  friction: { status: FrictionStatus; spreadBps: number | null; buySlipBps: number | null; sellSlipBps: number | null; orderNotional: number; reasons: string[] };
  events: LiquidityEvent[];
  /** Descriptive alignment of the evidence above. It is not a probability and is not wired to orders. */
  evidence: Evidence;
  evidenceReasons: string[];
}

export interface FieldCell {
  /**
   * Displayed liquidity 0..1 on a log scale anchored to the visible window: the median cell reads about 0.2 and the
   * 99th percentile 1. Ordinary depth stays visible, concentrations stand out, and the scale follows the symbol's own
   * recent liquidity rather than a fixed size.
   */
  bid: number;
  ask: number;
  /** Aggressor volume executed in the cell, normalized the same way. */
  buy: number;
  sell: number;
  /** The mid sat in this bucket at this time. */
  path: boolean;
  /** Not measured: before history, outside the band tracked at that time, beyond the snapshot range, or an invalid book. */
  unknown: boolean;
}

export interface FieldView {
  rows: number;
  cols: number;
  bucketSize: number;
  /** Lower edge price of each row, top row first. */
  rowPrices: number[];
  /** Row of the current mid. */
  midRow: number;
  /** Sample time of each column, oldest first; null for columns before history began. */
  columnTimes: Array<number | null>;
  cells: FieldCell[][];
}

export interface MicroView {
  reading: MicrostructureReading;
  field: FieldView | null;
  /** CVD at each sample, oldest first. */
  cvdSeries: number[];
  ladder: { bids: Array<[number, number]>; asks: Array<[number, number]> };
}

interface Column {
  t: number;
  mid: number | null;
  valid: boolean;
  bids: Map<number, number>;
  asks: Map<number, number>;
  buys: Map<number, number>;
  sells: Map<number, number>;
  bidFloorBucket: number | null;
  askCeilBucket: number | null;
  /** Bucket range the book was bucketed over for this column; null when nothing was. */
  band: [number, number] | null;
  cvd: number;
}

const bps = (a: number, b: number) => ((a - b) / b) * 10_000;

/** A round bucket size near `mid x bps`, so row labels read as clean prices. */
export function niceBucket(mid: number, bucketBps: number): number {
  const raw = (mid * bucketBps) / 10_000;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const steps = [1, 2, 2.5, 5, 10];
  const step = steps.find((s) => s * mag >= raw) ?? 10;
  return Number((step * mag).toPrecision(6));
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

/** Walks one side for `notional` of quote; null when the known book cannot fill it. */
export function slippageBps(levels: ReadonlyArray<[number, number]>, notional: number, mid: number, side: 'buy' | 'sell'): number | null {
  let left = notional;
  let qty = 0;
  let cost = 0;
  for (const [price, size] of levels) {
    const take = Math.min(size, left / price);
    qty += take;
    cost += take * price;
    left -= take * price;
    if (left <= 1e-9) break;
  }
  if (left > 1e-9 || qty <= 0) return null;
  const vwap = cost / qty;
  return side === 'buy' ? bps(vwap, mid) : bps(mid, vwap);
}

/**
 * Per-symbol microstructure engine: a sequence-checked local book, rolling aggressor flow, a bucketed time x price
 * history (the pressure field) and liquidity events. `sample()` is called on a fixed cadence; `reading()` and `view()`
 * are pure reads. Nothing here places or gates orders.
 */
export class MicrostructureEngine {
  readonly book = new LocalOrderBook();
  private readonly flow: TradeFlow;
  private readonly events: LiquidityEventTracker;
  private columns: Column[] = [];
  private bucketSize: number | null = null;
  private lastSampleAt = 0;
  private lastDepthAt: number | null = null;
  private resyncNote = '';

  constructor(readonly symbol: string, private readonly opts: MicroOptions = DEFAULT_MICRO_OPTIONS) {
    this.flow = new TradeFlow(Math.max(120_000, opts.flowWindowMs * 2));
    this.events = new LiquidityEventTracker(opts.events);
  }

  /** `receivedAt` is local time, so staleness never depends on the exchange clock. */
  onDepth(diff: DepthDiff, receivedAt: number): 'applied' | 'buffered' | 'dropped' | 'gap' {
    this.lastDepthAt = receivedAt;
    return this.book.onDiff(diff);
  }

  onSnapshot(snapshot: DepthSnapshot): 'applied' | 'gap' {
    return this.book.loadSnapshot(snapshot);
  }

  onTrade(trade: AggTrade): void {
    this.flow.add(trade);
  }

  /** The book is unusable (gap, reconnect): drop it and every wall measured on it. */
  invalidate(reason: string): void {
    this.book.reset(reason);
    this.events.reset();
    this.resyncNote = reason;
  }

  sample(now: number): LiquidityEvent[] {
    const from = this.lastSampleAt || now - 1_000;
    this.lastSampleAt = now;
    const trades = this.flow.between(from, now);
    const status = this.bookStatus(now);
    const mid = status.status === 'LIVE' ? this.book.mid() : null;
    if (mid !== null && this.bucketSize === null) this.bucketSize = niceBucket(mid, this.opts.bucketBps);
    const size = this.bucketSize;
    const column: Column = { t: now, mid, valid: mid !== null, bids: new Map(), asks: new Map(), buys: new Map(), sells: new Map(), bidFloorBucket: null, askCeilBucket: null, band: null, cvd: this.flow.cvd };
    let emitted: LiquidityEvent[] = [];
    if (size !== null) {
      for (const t of trades) {
        const bucket = Math.floor(t.price / size + 1e-9);
        const target = t.buyerIsMaker ? column.sells : column.buys;
        target.set(bucket, (target.get(bucket) ?? 0) + t.qty);
      }
      if (mid !== null) {
        const center = Math.floor(mid / size + 1e-9);
        const lo = center - this.opts.bandBuckets;
        const hi = center + this.opts.bandBuckets;
        column.band = [lo, hi];
        for (const [side, target] of [['bids', column.bids], ['asks', column.asks]] as const) {
          for (const [price, qty] of this.book.levels(side)) {
            const bucket = Math.floor(price / size + 1e-9);
            if (bucket < lo || bucket > hi) continue;
            target.set(bucket, (target.get(bucket) ?? 0) + qty);
          }
        }
        const cov = this.book.coverage;
        if (cov) {
          column.bidFloorBucket = Math.floor(cov.bidFloor / size + 1e-9);
          column.askCeilBucket = Math.floor(cov.askCeil / size + 1e-9);
        }
        emitted = this.events.update({ t: now, mid, bucketSize: size, bids: column.bids, asks: column.asks, sellsIntoBids: column.sells, buysIntoAsks: column.buys });
      }
    }
    this.columns.push(column);
    if (this.columns.length > this.opts.historyColumns) this.columns.splice(0, this.columns.length - this.opts.historyColumns);
    return emitted;
  }

  reading(now: number): MicrostructureReading {
    const book = this.bookStatus(now);
    const live = book.status === 'LIVE';
    const bid = live ? this.book.bestBid() : null;
    const ask = live ? this.book.bestAsk() : null;
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
    const spreadBps = mid !== null ? bps(ask as number, bid as number) : null;

    const w30 = this.flow.window(now, this.opts.flowWindowMs);
    const w5 = this.flow.window(now, this.opts.shortFlowMs);
    const pastMid = this.midAt(now - this.opts.flowWindowMs);
    const priceResponseBps30s = mid !== null && pastMid !== null ? bps(mid, pastMid) : null;
    const phase = this.phase(w30.delta, w30.trades, priceResponseBps30s);

    const imbalance = (band: number) => {
      if (mid === null) return null;
      let b = 0;
      let a = 0;
      for (const [p, q] of this.book.levels('bids')) { if (bps(mid, p) > band) break; b += q; }
      for (const [p, q] of this.book.levels('asks')) { if (bps(p, mid) > band) break; a += q; }
      return b + a > 0 ? (b - a) / (b + a) : null;
    };

    const friction = this.friction(book.status, mid, spreadBps);
    const events = this.events.events().slice(0, 8);
    const { evidence, reasons } = this.evidence(book.status, phase, imbalance(25), events, now);
    return {
      symbol: this.symbol,
      t: now,
      book,
      mid,
      spreadBps,
      depthImbalance: { bps10: imbalance(10), bps25: imbalance(25) },
      flow: { delta5s: w5.delta, delta30s: w30.delta, buyNotional30s: w30.buyNotional, sellNotional30s: w30.sellNotional, trades30s: w30.trades, cvd: this.flow.cvd },
      priceResponseBps30s,
      phase,
      friction,
      events,
      evidence,
      evidenceReasons: reasons,
    };
  }

  /** Render-ready field, `rows` tall (odd counts center the mid) and the last `cols` samples wide. */
  view(now: number, rows: number, cols: number, ladderLevels = 10): MicroView {
    const reading = this.reading(now);
    const ladder = reading.book.status === 'LIVE'
      ? { bids: this.book.levels('bids', ladderLevels), asks: this.book.levels('asks', ladderLevels) }
      : { bids: [], asks: [] };
    const recent = this.columns.slice(-cols);
    return { reading, field: this.field(recent, rows, cols), cvdSeries: recent.map((c) => c.cvd), ladder };
  }

  private field(recent: Column[], rows: number, cols: number): FieldView | null {
    const size = this.bucketSize;
    const anchor = [...recent].reverse().find((c) => c.mid !== null)?.mid ?? null;
    if (size === null || anchor === null) return null;
    const half = Math.floor(rows / 2);
    const center = Math.floor(anchor / size + 1e-9);
    const top = center + half;
    const padded: Array<Column | null> = [...Array(Math.max(0, cols - recent.length)).fill(null), ...recent];

    const liq: number[] = [];
    const vol: number[] = [];
    for (const c of recent) {
      for (const [b, q] of c.bids) if (b <= top && b > top - rows) liq.push(q);
      for (const [b, q] of c.asks) if (b <= top && b > top - rows) liq.push(q);
      for (const [b, q] of c.buys) if (b <= top && b > top - rows) vol.push(q);
      for (const [b, q] of c.sells) if (b <= top && b > top - rows) vol.push(q);
    }
    const logScale = (values: number[]) => {
      const ref = percentile(values, 0.5);
      const top = percentile(values, 0.99);
      return (q: number | undefined) => {
        if (!q || !(ref > 0)) return 0;
        if (top <= ref) return Math.min(1, q / ref);
        return Math.max(0, Math.min(1, Math.log1p(q / ref) / Math.log1p(top / ref)));
      };
    };
    const liqNorm = logScale(liq);
    const volNorm = logScale(vol);

    const cells: FieldCell[][] = [];
    for (let r = 0; r < rows; r += 1) {
      const bucket = top - r;
      cells.push(padded.map((c) => {
        if (!c) return { bid: 0, ask: 0, buy: 0, sell: 0, path: false, unknown: true };
        const beyond = (c.bidFloorBucket !== null && bucket < c.bidFloorBucket) || (c.askCeilBucket !== null && bucket > c.askCeilBucket)
          || c.band === null || bucket < c.band[0] || bucket > c.band[1];
        const midBucket = c.mid !== null ? Math.floor(c.mid / size + 1e-9) : null;
        return {
          bid: liqNorm(c.bids.get(bucket)),
          ask: liqNorm(c.asks.get(bucket)),
          buy: volNorm(c.buys.get(bucket)),
          sell: volNorm(c.sells.get(bucket)),
          path: midBucket === bucket,
          unknown: !c.valid || (beyond && !c.bids.has(bucket) && !c.asks.has(bucket)),
        };
      }));
    }
    return {
      rows,
      cols,
      bucketSize: size,
      rowPrices: Array.from({ length: rows }, (_, r) => Number(((top - r) * size).toPrecision(10))),
      midRow: half,
      columnTimes: padded.map((c) => c?.t ?? null),
      cells,
    };
  }

  private bookStatus(now: number): MicrostructureReading['book'] {
    const ageMs = this.lastDepthAt === null ? null : now - this.lastDepthAt;
    if (this.book.status === 'RESYNC_REQUIRED') return { status: 'RESYNC', reason: this.book.reason, ageMs };
    if (this.book.status === 'SYNCING') return { status: 'SYNCING', reason: this.book.reason || this.resyncNote, ageMs };
    if (ageMs === null || ageMs > this.opts.staleMs) return { status: 'STALE', reason: `no depth update for ${ageMs === null ? '—' : Math.round(ageMs / 1000)}s`, ageMs };
    return { status: 'LIVE', reason: '', ageMs };
  }

  private midAt(t: number): number | null {
    for (let i = this.columns.length - 1; i >= 0; i -= 1) {
      const c = this.columns[i];
      if (c.t <= t) return c.mid;
    }
    return null;
  }

  private phase(delta: number | null, trades: number, response: number | null): FlowPhase {
    if (delta === null || response === null || trades < this.opts.minTrades) return 'THIN';
    const moved = Math.abs(response) >= this.opts.priceMoveBps;
    if (delta >= this.opts.flowActive) return moved && response > 0 ? 'INITIATIVE_BUYING' : 'BUY_ABSORBED';
    if (delta <= -this.opts.flowActive) return moved && response < 0 ? 'INITIATIVE_SELLING' : 'SELL_ABSORBED';
    if (moved) return response > 0 ? 'DRIFT_UP' : 'DRIFT_DOWN';
    return 'BALANCED';
  }

  private friction(status: FeedBookStatus, mid: number | null, spreadBps: number | null): MicrostructureReading['friction'] {
    const base = { spreadBps, buySlipBps: null as number | null, sellSlipBps: null as number | null, orderNotional: this.opts.orderNotional };
    if (status !== 'LIVE' || mid === null || spreadBps === null) return { ...base, status: 'BLOCK', reasons: [`book ${status.toLowerCase()}`] };
    const buySlipBps = slippageBps(this.book.levels('asks'), this.opts.orderNotional, mid, 'buy');
    const sellSlipBps = slippageBps(this.book.levels('bids'), this.opts.orderNotional, mid, 'sell');
    const reasons: string[] = [];
    let status_: FrictionStatus = 'OK';
    const grade = (value: number | null, limit: number, label: string) => {
      if (value === null) { reasons.push(`${label}: known book too thin`); status_ = 'BLOCK'; return; }
      if (value > limit) { reasons.push(`${label} ${value.toFixed(1)}bps > ${limit}`); status_ = 'BLOCK'; return; }
      if (value > limit / 2 && status_ === 'OK') { reasons.push(`${label} ${value.toFixed(1)}bps`); status_ = 'ELEVATED'; }
    };
    grade(spreadBps, this.opts.maxSpreadBps, 'spread');
    grade(buySlipBps, this.opts.maxSlipBps, 'buy slippage');
    grade(sellSlipBps, this.opts.maxSlipBps, 'sell slippage');
    return { ...base, buySlipBps, sellSlipBps, status: status_, reasons };
  }

  private evidence(status: FeedBookStatus, phase: FlowPhase, imbalance25: number | null, events: LiquidityEvent[], now: number): { evidence: Evidence; reasons: string[] } {
    if (status !== 'LIVE') return { evidence: 'INVALID', reasons: [`book ${status.toLowerCase()}`] };
    type Reason = { text: string; depthOnly: boolean };
    const long: Reason[] = [];
    const short: Reason[] = [];
    if (phase === 'INITIATIVE_BUYING') long.push({ text: 'buyers lifting price', depthOnly: false });
    if (phase === 'INITIATIVE_SELLING') short.push({ text: 'sellers pressing price', depthOnly: false });
    const absorbed = events.filter((e) => e.kind === 'ABSORPTION' && now - e.t <= this.opts.flowWindowMs);
    if (phase === 'SELL_ABSORBED' && absorbed.some((e) => e.side === 'bid')) long.push({ text: 'selling absorbed at a bid wall', depthOnly: false });
    if (phase === 'BUY_ABSORBED' && absorbed.some((e) => e.side === 'ask')) short.push({ text: 'buying absorbed at an ask wall', depthOnly: false });
    if (imbalance25 !== null && imbalance25 >= 0.2) long.push({ text: `bid-heavy depth ${imbalance25.toFixed(2)}`, depthOnly: true });
    if (imbalance25 !== null && imbalance25 <= -0.2) short.push({ text: `ask-heavy depth ${imbalance25.toFixed(2)}`, depthOnly: true });
    // Displayed depth can be cancelled at no cost, so it supports a case but never makes one on its own.
    const hasCase = (reasons: Reason[]) => reasons.some((r) => !r.depthOnly);
    const texts = (reasons: Reason[]) => reasons.map((r) => r.text);
    if (hasCase(long) && hasCase(short)) return { evidence: 'MIXED', reasons: [...texts(long), ...texts(short)] };
    if (hasCase(long)) return { evidence: 'SUPPORTS_LONG', reasons: texts(long) };
    if (hasCase(short)) return { evidence: 'SUPPORTS_SHORT', reasons: texts(short) };
    return { evidence: 'NONE', reasons: [...texts(long), ...texts(short)] };
  }
}
