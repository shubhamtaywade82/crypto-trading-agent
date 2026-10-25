import { DEFAULT_EVENT_OPTIONS, LiquidityEventTracker, type EventOptions, type LiquidityEvent } from './LiquidityEvents.js';
import { LocalOrderBook, type DepthDiff, type DepthSnapshot } from './LocalOrderBook.js';
import { DEFAULT_BIAS_OPTIONS, MicroBias, type BiasOptions, type BiasState } from './MicroBias.js';
import { OfiTracker } from './Ofi.js';
import { TradeFlow, type AggTrade } from './TradeFlow.js';

export interface MicroOptions {
  /** Price bucket height of the pressure field, in bps of the first valid mid. */
  bucketBps: number;
  /** Buckets tracked on each side of mid (field height and wall search band). */
  bandBuckets: number;
  /** Rolling order-flow windows, shortest first. The 30 s window drives `phase`; the bias reads 30 s and 2 m. */
  flowWindowsMs: number[];
  flowWindowMs: number;
  shortFlowMs: number;
  /** Window the bias's backdrop rule reads (must be one of flowWindowsMs). */
  backdropWindowMs: number;
  /** |delta| at which one side's aggression counts as dominant. */
  flowActive: number;
  /** |mid change| over 30 s that counts as a price response; other windows scale it by sqrt(window / 30 s). */
  priceMoveBps: number;
  /** Fewer trades than this in a window is THIN: no phase is read from it. */
  minTrades: number;
  /** Order size the friction estimate walks the book for, in quote currency. */
  orderNotional: number;
  maxSpreadBps: number;
  maxSlipBps: number;
  /** A book with no diff for this long is STALE. */
  staleMs: number;
  events: EventOptions;
  bias: BiasOptions;
}

export const DEFAULT_MICRO_OPTIONS: MicroOptions = {
  bucketBps: 1, bandBuckets: 30, flowWindowsMs: [5_000, 30_000, 120_000, 300_000], flowWindowMs: 30_000, shortFlowMs: 5_000,
  backdropWindowMs: 120_000, flowActive: 0.2, priceMoveBps: 3, minTrades: 5, orderNotional: 5_000, maxSpreadBps: 5, maxSlipBps: 10,
  staleMs: 5_000, events: DEFAULT_EVENT_OPTIONS, bias: DEFAULT_BIAS_OPTIONS,
};

/** Field history tiers: column width and how long each is kept. A view picks the finest tier covering its span. */
const TIERS = [
  { resMs: 0, keepMs: 5 * 60_000 }, // one column per sample
  { resMs: 10_000, keepMs: 30 * 60_000 },
  { resMs: 60_000, keepMs: 2 * 3_600_000 },
] as const;

/** Field spans the view can show. */
export const FIELD_SPANS_MS = [2 * 60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000] as const;

export type FlowPhase = 'INITIATIVE_BUYING' | 'BUY_ABSORBED' | 'INITIATIVE_SELLING' | 'SELL_ABSORBED' | 'DRIFT_UP' | 'DRIFT_DOWN' | 'BALANCED' | 'THIN';
export type FrictionStatus = 'OK' | 'ELEVATED' | 'BLOCK';
export type Evidence = 'SUPPORTS_LONG' | 'SUPPORTS_SHORT' | 'MIXED' | 'NONE' | 'INVALID';
export type FeedBookStatus = 'LIVE' | 'SYNCING' | 'RESYNC' | 'STALE';

/** Order flow over one rolling window. */
export interface WindowFlow {
  ms: number;
  /** False until the feed has been live for the whole window: the figures cover less time than labelled. */
  complete: boolean;
  trades: number;
  buyNotional: number;
  sellNotional: number;
  /** (buy - sell) / (buy + sell) aggressor notional; null with no trades. */
  delta: number | null;
  /** Aggressive buy minus sell quantity (base asset): the window's CVD change. */
  signedQty: number;
  /** Top-of-book order-flow imbalance over the window, normalized by average touch depth; null with no book updates. */
  ofi: number | null;
  /** Mid change over the window; null when there is no mid that old. */
  priceBps: number | null;
  phase: FlowPhase;
}

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
  /** Every rolling window, shortest first. */
  windows: WindowFlow[];
  priceResponseBps30s: number | null;
  /** Phase of the 30 s window. */
  phase: FlowPhase;
  friction: { status: FrictionStatus; spreadBps: number | null; buySlipBps: number | null; sellSlipBps: number | null; orderNotional: number; reasons: string[] };
  events: LiquidityEvent[];
  /** This sample's descriptive alignment. It flickers by design; `bias` is the persisted version. */
  evidence: Evidence;
  evidenceReasons: string[];
  /** Persisted micro bias with confirmation and hysteresis. Not a probability; not wired to orders. */
  bias: BiasState;
}

/** Friction for one specific order: its side and notional walked through the live book. */
export interface EntryFriction {
  status: FrictionStatus;
  reasons: string[];
  spreadBps: number | null;
  /** Depth-walked VWAP slippage from mid for this order; null when the book is not live or cannot fill it. */
  slipBps: number | null;
  bookStatus: FeedBookStatus;
  bookAgeMs: number | null;
}

export interface FieldCell {
  /**
   * Displayed liquidity 0..1 on a log scale anchored to the visible window: the median cell reads about 0.2 and the
   * 99th percentile 1. A column wider than one sample shows the time-averaged depth, so the shade is persistence: a
   * wall shown for 2 s of a minute reads faint, one that stayed reads bright.
   */
  bid: number;
  ask: number;
  /** Aggressor volume executed in the cell, normalized the same way. */
  buy: number;
  sell: number;
  /** The mid passed through this bucket during the column. */
  path: boolean;
  /** Not measured: before history, outside the band tracked at that time, beyond the snapshot range, or an invalid book. */
  unknown: boolean;
}

export interface FieldView {
  rows: number;
  cols: number;
  /** Terminal cells each column takes, summing to the available width (columns are 1 or more cells, spread evenly). */
  cellWidths: number[];
  spanMs: number;
  /** Time each column covers. */
  resolutionMs: number;
  bucketSize: number;
  /** Lower edge price of each row, top row first. */
  rowPrices: number[];
  /** Row of the current mid. */
  midRow: number;
  /** Start time of each column, oldest first; null for columns before history began. */
  columnTimes: Array<number | null>;
  cells: FieldCell[][];
}

export interface MicroView {
  reading: MicrostructureReading;
  field: FieldView | null;
  /** CVD at the end of each field column, oldest first. */
  cvdSeries: number[];
  ladder: { bids: Array<[number, number]>; asks: Array<[number, number]> };
}

interface Column {
  t: number;
  /** Time the column covers (sample interval for the finest tier). */
  durationMs: number;
  mid: number | null;
  valid: boolean;
  /** Displayed quantity per bucket: one sample, or the average over the samples that measured the bucket. */
  bids: Map<number, number>;
  asks: Map<number, number>;
  buys: Map<number, number>;
  sells: Map<number, number>;
  /** Bucket range this column measured; null when it measured nothing. */
  seen: [number, number] | null;
  /** Buckets inside `seen` that no merged sample measured. */
  unseen?: Set<number>;
  /** Mid bucket range the price covered. */
  path: [number, number] | null;
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
 * Merges consecutive columns into one: depth averaged over the columns that measured each bucket (so it reads as
 * persistence), executed volume summed, the price path as the range the mid covered, and the last mid and CVD.
 */
export function mergeColumns(cols: ReadonlyArray<Column>): Column {
  const last = cols[cols.length - 1];
  const valid = cols.filter((c) => c.valid && c.seen);
  const out: Column = {
    t: cols[0].t, durationMs: cols.reduce((s, c) => s + c.durationMs, 0), mid: [...cols].reverse().find((c) => c.mid !== null)?.mid ?? null,
    valid: valid.length > 0, bids: new Map(), asks: new Map(), buys: new Map(), sells: new Map(), seen: null, path: null, cvd: last.cvd,
  };
  for (const c of cols) {
    for (const [target, src] of [[out.buys, c.buys], [out.sells, c.sells]] as const) for (const [b, q] of src) target.set(b, (target.get(b) ?? 0) + q);
    if (c.path) out.path = out.path ? [Math.min(out.path[0], c.path[0]), Math.max(out.path[1], c.path[1])] : [...c.path];
  }
  if (valid.length === 0) return out;
  const lo = Math.min(...valid.map((c) => c.seen![0]));
  const hi = Math.max(...valid.map((c) => c.seen![1]));
  out.seen = [lo, hi];
  out.unseen = new Set();
  for (let b = lo; b <= hi; b += 1) {
    const measuring = valid.filter((c) => b >= c.seen![0] && b <= c.seen![1] && !c.unseen?.has(b));
    if (measuring.length === 0) { out.unseen.add(b); continue; }
    const weight = measuring.reduce((s, c) => s + c.durationMs, 0);
    let bid = 0;
    let ask = 0;
    for (const c of measuring) {
      bid += (c.bids.get(b) ?? 0) * c.durationMs;
      ask += (c.asks.get(b) ?? 0) * c.durationMs;
    }
    if (bid > 0) out.bids.set(b, bid / weight);
    if (ask > 0) out.asks.set(b, ask / weight);
  }
  return out;
}

/**
 * Per-symbol microstructure engine: a sequence-checked local book, top-of-book OFI, rolling aggressor flow over several
 * windows, a multi-resolution time x price history (the pressure field), liquidity events and a persisted bias.
 * Data arrives at stream cadence; `sample()` is called on a fixed cadence (1 s); `reading()` and `view()` are reads.
 * Only `entryFriction()` is consumed by trading (the entry gate); everything else is display and recording.
 */
export class MicrostructureEngine {
  readonly book = new LocalOrderBook();
  private readonly flow: TradeFlow;
  private readonly ofi: OfiTracker;
  private readonly events: LiquidityEventTracker;
  private readonly biasMachine: MicroBias;
  private bias: BiasState;
  /** Finished columns per tier, oldest first. */
  private tiers: Column[][] = TIERS.map(() => []);
  /** Fine columns of the tier period still in progress (coarser tiers only). */
  private pending: Column[][] = TIERS.map(() => []);
  private bucketSize: number | null = null;
  private lastSampleAt = 0;
  private lastDepthAt: number | null = null;
  /** First sample of the current unbroken live stretch: windows reaching further back are incomplete. */
  private liveSince: number | null = null;
  private resyncNote = '';

  constructor(readonly symbol: string, private readonly opts: MicroOptions = DEFAULT_MICRO_OPTIONS) {
    const longest = Math.max(...opts.flowWindowsMs, opts.flowWindowMs);
    this.flow = new TradeFlow(longest + 30_000);
    this.ofi = new OfiTracker(longest + 30_000);
    this.events = new LiquidityEventTracker(opts.events);
    this.biasMachine = new MicroBias(opts.bias);
    this.bias = this.biasMachine.current();
  }

  /** `receivedAt` is local time, so staleness never depends on the exchange clock. */
  onDepth(diff: DepthDiff, receivedAt: number): 'applied' | 'buffered' | 'dropped' | 'gap' {
    this.lastDepthAt = receivedAt;
    const result = this.book.onDiff(diff);
    if (result === 'applied') this.ofi.onTop(this.book.top(), receivedAt);
    else if (result === 'gap') this.ofi.reset();
    return result;
  }

  onSnapshot(snapshot: DepthSnapshot): 'applied' | 'gap' {
    this.ofi.reset();
    return this.book.loadSnapshot(snapshot);
  }

  onTrade(trade: AggTrade): void {
    this.flow.add(trade);
  }

  /** The book is unusable (gap, reconnect): drop it, every wall measured on it, and the OFI chain. */
  invalidate(reason: string): void {
    this.book.reset(reason);
    this.events.reset();
    this.ofi.reset();
    this.resyncNote = reason;
  }

  sample(now: number): LiquidityEvent[] {
    const from = this.lastSampleAt || now - 1_000;
    const durationMs = Math.max(1, now - from);
    this.lastSampleAt = now;
    const trades = this.flow.between(from, now);
    const status = this.bookStatus(now);
    const live = status.status === 'LIVE';
    if (!live) this.liveSince = null;
    else this.liveSince ??= now;
    const mid = live ? this.book.mid() : null;
    if (mid !== null && this.bucketSize === null) this.bucketSize = niceBucket(mid, this.opts.bucketBps);
    const size = this.bucketSize;
    const column: Column = { t: now, durationMs, mid, valid: mid !== null, bids: new Map(), asks: new Map(), buys: new Map(), sells: new Map(), seen: null, path: null, cvd: this.flow.cvd };
    let emitted: LiquidityEvent[] = [];
    if (size !== null) {
      for (const t of trades) {
        const bucket = Math.floor(t.price / size + 1e-9);
        const target = t.buyerIsMaker ? column.sells : column.buys;
        target.set(bucket, (target.get(bucket) ?? 0) + t.qty);
      }
      if (mid !== null) {
        const center = Math.floor(mid / size + 1e-9);
        column.path = [center, center];
        let lo = center - this.opts.bandBuckets;
        let hi = center + this.opts.bandBuckets;
        const cov = this.book.coverage;
        if (cov) {
          lo = Math.max(lo, Math.floor(cov.bidFloor / size + 1e-9));
          hi = Math.min(hi, Math.floor(cov.askCeil / size + 1e-9));
        }
        column.seen = [lo, hi];
        for (const [side, target] of [['bids', column.bids], ['asks', column.asks]] as const) {
          for (const [price, qty] of this.book.levels(side)) {
            const bucket = Math.floor(price / size + 1e-9);
            if (bucket < center - this.opts.bandBuckets || bucket > center + this.opts.bandBuckets) continue;
            target.set(bucket, (target.get(bucket) ?? 0) + qty);
          }
        }
        emitted = this.events.update({ t: now, mid, bucketSize: size, bids: column.bids, asks: column.asks, sellsIntoBids: column.sells, buysIntoAsks: column.buys });
      }
    }
    this.store(column);
    this.bias = this.biasMachine.update(this.biasInput(now, live), now);
    return emitted;
  }

  reading(now: number): MicrostructureReading {
    const book = this.bookStatus(now);
    const live = book.status === 'LIVE';
    const bid = live ? this.book.bestBid() : null;
    const ask = live ? this.book.bestAsk() : null;
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
    const spreadBps = mid !== null ? bps(ask as number, bid as number) : null;

    const windows = this.windows(now, mid);
    const w30 = this.windowFor(windows, this.opts.flowWindowMs) ?? this.windowFlow(now, mid, this.opts.flowWindowMs);
    const w5 = this.windowFor(windows, this.opts.shortFlowMs) ?? this.windowFlow(now, mid, this.opts.shortFlowMs);
    const friction = this.friction(book.status, mid, spreadBps);
    const events = this.events.events().slice(0, 8);
    const imbalance25 = this.imbalance(mid, 25);
    const { evidence, reasons } = this.evidence(book.status, w30.phase, imbalance25, events, now);
    return {
      symbol: this.symbol,
      t: now,
      book,
      mid,
      spreadBps,
      depthImbalance: { bps10: this.imbalance(mid, 10), bps25: imbalance25 },
      flow: { delta5s: w5.delta, delta30s: w30.delta, buyNotional30s: w30.buyNotional, sellNotional30s: w30.sellNotional, trades30s: w30.trades, cvd: this.flow.cvd },
      windows,
      priceResponseBps30s: w30.priceBps,
      phase: w30.phase,
      friction,
      events,
      evidence,
      evidenceReasons: reasons,
      bias: live ? this.bias : { ...this.bias, bias: 'NEUTRAL', candidate: null, reasons: [`book ${book.status.toLowerCase()}`] },
    };
  }

  /** Grades one order: spread and the slippage of walking `notional` on its side, against the same limits as the view. */
  entryFriction(side: 'buy' | 'sell', notional: number, now: number): EntryFriction {
    const book = this.bookStatus(now);
    const base = { bookStatus: book.status, bookAgeMs: book.ageMs };
    const bid = book.status === 'LIVE' ? this.book.bestBid() : null;
    const ask = book.status === 'LIVE' ? this.book.bestAsk() : null;
    if (bid === null || ask === null) {
      return { ...base, status: 'BLOCK', reasons: [`book ${book.status.toLowerCase()}${book.reason ? `: ${book.reason}` : ''}`], spreadBps: null, slipBps: null };
    }
    const mid = (bid + ask) / 2;
    const spreadBps = bps(ask, bid);
    const slipBps = notional > 0 ? slippageBps(this.book.levels(side === 'buy' ? 'asks' : 'bids'), notional, mid, side) : 0;
    const { status, reasons } = this.grade([[spreadBps, this.opts.maxSpreadBps, 'spread'], [slipBps, this.opts.maxSlipBps, `${side} slippage`]]);
    return { ...base, status, reasons, spreadBps, slipBps };
  }

  /**
   * Render-ready field `rows` tall and at most `cols` cells wide covering `spanMs` (default: one sample per cell).
   * The finest history tier that covers the span is used; columns are merged further until they fit.
   */
  view(now: number, rows: number, cols: number, spanMs?: number, ladderLevels = 10): MicroView {
    const reading = this.reading(now);
    const ladder = reading.book.status === 'LIVE'
      ? { bids: this.book.levels('bids', ladderLevels), asks: this.book.levels('asks', ladderLevels) }
      : { bids: [], asks: [] };
    const { columns, resolutionMs, slots } = this.columnsFor(now, cols, spanMs);
    const field = this.field(columns, slots, rows, cols, resolutionMs, spanMs ?? slots * resolutionMs);
    return { reading, field, cvdSeries: columns.map((c) => c.cvd), ladder };
  }

  // ---- history ---------------------------------------------------------------------------------------------------

  private store(column: Column): void {
    TIERS.forEach((tier, i) => {
      if (tier.resMs === 0) {
        this.tiers[i].push(column);
      } else {
        const pending = this.pending[i];
        if (pending.length && Math.floor(pending[0].t / tier.resMs) !== Math.floor(column.t / tier.resMs)) {
          const merged = mergeColumns(pending);
          merged.t = Math.floor(pending[0].t / tier.resMs) * tier.resMs;
          this.tiers[i].push(merged);
          this.pending[i] = [];
        }
        this.pending[i].push(column);
      }
      const cutoff = column.t - tier.keepMs;
      const kept = this.tiers[i];
      let drop = 0;
      while (drop < kept.length && kept[drop].t < cutoff) drop += 1;
      if (drop) kept.splice(0, drop);
    });
  }

  /** Columns covering the span from the finest adequate tier (including the period in progress), merged to fit `cols`. */
  private columnsFor(now: number, cols: number, spanMs?: number): { columns: Column[]; resolutionMs: number; slots: number } {
    if (spanMs === undefined) {
      const fine = this.tiers[0].slice(-cols);
      return { columns: fine, resolutionMs: this.sampleInterval(), slots: cols };
    }
    const tierIndex = TIERS.findIndex((t) => t.keepMs >= spanMs);
    const i = tierIndex === -1 ? TIERS.length - 1 : tierIndex;
    const tier = TIERS[i];
    const base = tier.resMs === 0 ? this.sampleInterval() : tier.resMs;
    const inProgress = this.pending[i].length ? [Object.assign(mergeColumns(this.pending[i]), { t: Math.floor(this.pending[i][0].t / base) * base })] : [];
    const available = [...this.tiers[i], ...inProgress].filter((c) => c.t > now - spanMs);
    const slotsAtBase = Math.ceil(spanMs / base);
    const group = Math.max(1, Math.ceil(slotsAtBase / cols));
    const slots = Math.ceil(slotsAtBase / group);
    const resolutionMs = base * group;
    if (group === 1) return { columns: available, resolutionMs, slots };
    // Group by absolute time so a column never straddles two periods as the window slides.
    const groups = new Map<number, Column[]>();
    for (const c of available) {
      const key = Math.floor(c.t / resolutionMs);
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const columns = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([key, g]) => Object.assign(mergeColumns(g), { t: key * resolutionMs }));
    return { columns: columns.slice(-slots), resolutionMs, slots };
  }

  private sampleInterval(): number {
    const fine = this.tiers[0];
    return fine.length ? Math.max(1, Math.round(fine[fine.length - 1].durationMs)) : 1_000;
  }

  private field(recent: Column[], slots: number, rows: number, cols: number, resolutionMs: number, spanMs: number): FieldView | null {
    const size = this.bucketSize;
    const anchor = [...recent].reverse().find((c) => c.mid !== null)?.mid ?? null;
    if (size === null || anchor === null) return null;
    const half = Math.floor(rows / 2);
    const center = Math.floor(anchor / size + 1e-9);
    const top = center + half;
    const shown = recent.slice(-slots);
    const padded: Array<Column | null> = [...Array(Math.max(0, slots - shown.length)).fill(null), ...shown];

    const liq: number[] = [];
    const vol: number[] = [];
    for (const c of shown) {
      for (const [b, q] of c.bids) if (b <= top && b > top - rows) liq.push(q);
      for (const [b, q] of c.asks) if (b <= top && b > top - rows) liq.push(q);
      for (const [b, q] of c.buys) if (b <= top && b > top - rows) vol.push(q);
      for (const [b, q] of c.sells) if (b <= top && b > top - rows) vol.push(q);
    }
    const logScale = (values: number[]) => {
      const ref = percentile(values, 0.5);
      const hi = percentile(values, 0.99);
      return (q: number | undefined) => {
        if (!q || !(ref > 0)) return 0;
        // A flat distribution has nothing that stands out: draw it at the median's usual intensity, not as a wall.
        if (hi <= ref) return Math.min(1, 0.25 * (q / ref));
        return Math.max(0, Math.min(1, Math.log1p(q / ref) / Math.log1p(hi / ref)));
      };
    };
    const liqNorm = logScale(liq);
    const volNorm = logScale(vol);

    const cells: FieldCell[][] = [];
    for (let r = 0; r < rows; r += 1) {
      const bucket = top - r;
      cells.push(padded.map((c) => {
        if (!c) return { bid: 0, ask: 0, buy: 0, sell: 0, path: false, unknown: true };
        const measured = c.valid && c.seen !== null && bucket >= c.seen[0] && bucket <= c.seen[1] && !c.unseen?.has(bucket);
        return {
          bid: liqNorm(c.bids.get(bucket)),
          ask: liqNorm(c.asks.get(bucket)),
          buy: volNorm(c.buys.get(bucket)),
          sell: volNorm(c.sells.get(bucket)),
          path: c.path !== null && bucket >= c.path[0] && bucket <= c.path[1],
          unknown: !measured && !c.bids.has(bucket) && !c.asks.has(bucket),
        };
      }));
    }
    return {
      rows,
      cols: slots,
      cellWidths: Array.from({ length: slots }, (_, i) => Math.floor(((i + 1) * Math.max(cols, slots)) / slots) - Math.floor((i * Math.max(cols, slots)) / slots)),
      spanMs,
      resolutionMs,
      bucketSize: size,
      rowPrices: Array.from({ length: rows }, (_, r) => Number(((top - r) * size).toPrecision(10))),
      midRow: half,
      columnTimes: padded.map((c) => c?.t ?? null),
      cells,
    };
  }

  // ---- flow ------------------------------------------------------------------------------------------------------

  private windows(now: number, mid: number | null): WindowFlow[] {
    return this.opts.flowWindowsMs.map((ms) => this.windowFlow(now, mid, ms));
  }

  private windowFor(windows: WindowFlow[], ms: number): WindowFlow | undefined {
    return windows.find((w) => w.ms === ms);
  }

  private windowFlow(now: number, mid: number | null, ms: number): WindowFlow {
    const w = this.flow.window(now, ms);
    const pastMid = this.midAt(now - ms);
    const priceBps = mid !== null && pastMid !== null ? bps(mid, pastMid) : null;
    const ofi = this.ofi.window(now, ms);
    return {
      ms,
      complete: this.liveSince !== null && now - this.liveSince >= ms,
      trades: w.trades,
      buyNotional: w.buyNotional,
      sellNotional: w.sellNotional,
      delta: w.delta,
      signedQty: w.buyQty - w.sellQty,
      ofi: ofi.normalized,
      priceBps,
      phase: this.phase(w.delta, w.trades, priceBps, ms),
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
    for (const tier of this.tiers) {
      if (tier.length === 0 || tier[0].t > t) continue;
      for (let i = tier.length - 1; i >= 0; i -= 1) if (tier[i].t <= t) return tier[i].mid;
    }
    return null;
  }

  private imbalance(mid: number | null, band: number): number | null {
    if (mid === null) return null;
    let b = 0;
    let a = 0;
    for (const [p, q] of this.book.levels('bids')) { if (bps(mid, p) > band) break; b += q; }
    for (const [p, q] of this.book.levels('asks')) { if (bps(p, mid) > band) break; a += q; }
    return b + a > 0 ? (b - a) / (b + a) : null;
  }

  /** The price-move threshold grows with sqrt(window), as a random walk's typical move does; 30 s keeps `priceMoveBps`. */
  private phase(delta: number | null, trades: number, response: number | null, ms: number = this.opts.flowWindowMs): FlowPhase {
    if (delta === null || response === null || trades < this.opts.minTrades) return 'THIN';
    const moved = Math.abs(response) >= this.opts.priceMoveBps * Math.sqrt(ms / 30_000);
    if (delta >= this.opts.flowActive) return moved && response > 0 ? 'INITIATIVE_BUYING' : 'BUY_ABSORBED';
    if (delta <= -this.opts.flowActive) return moved && response < 0 ? 'INITIATIVE_SELLING' : 'SELL_ABSORBED';
    if (moved) return response > 0 ? 'DRIFT_UP' : 'DRIFT_DOWN';
    return 'BALANCED';
  }

  /**
   * Entry is stricter than hold. Entering LONG needs a long case on the 30 s window (initiative buying, or selling
   * absorbed at a bid wall) AND a 2 m backdrop at least mildly buying (delta >= flowActive / 2). Holding LONG only needs
   * the 2 m backdrop not to be selling (delta > -flowActive / 2) and no initiative selling on 30 s. SHORT mirrors it.
   */
  private biasInput(now: number, live: boolean): import('./MicroBias.js').BiasInput {
    if (!live) return { valid: false, enter: null, holds: { LONG: false, SHORT: false }, reasons: [] };
    const mid = this.book.mid();
    const fast = this.windowFlow(now, mid, this.opts.flowWindowMs);
    const backdrop = this.windowFlow(now, mid, this.opts.backdropWindowMs);
    const half = this.opts.flowActive / 2;
    const absorbed = this.events.events().filter((e) => e.kind === 'ABSORPTION' && now - e.t <= this.opts.flowWindowMs);
    const longCase = fast.phase === 'INITIATIVE_BUYING' || (fast.phase === 'SELL_ABSORBED' && absorbed.some((e) => e.side === 'bid'));
    const shortCase = fast.phase === 'INITIATIVE_SELLING' || (fast.phase === 'BUY_ABSORBED' && absorbed.some((e) => e.side === 'ask'));
    const bd = backdrop.delta;
    const enterLong = longCase && bd !== null && bd >= half;
    const enterShort = shortCase && bd !== null && bd <= -half;
    const reasons: string[] = [];
    if (enterLong) reasons.push(`30s ${fast.phase.toLowerCase().replace('_', ' ')}, 2m flow ${bd!.toFixed(2)}`);
    if (enterShort) reasons.push(`30s ${fast.phase.toLowerCase().replace('_', ' ')}, 2m flow ${bd!.toFixed(2)}`);
    if (!enterLong && !enterShort && longCase && (bd === null || bd < half)) reasons.push(`30s long case, 2m backdrop ${bd === null ? 'n/a' : bd.toFixed(2)} disagrees`);
    if (!enterLong && !enterShort && shortCase && (bd === null || bd > -half)) reasons.push(`30s short case, 2m backdrop ${bd === null ? 'n/a' : bd.toFixed(2)} disagrees`);
    return {
      valid: true,
      enter: enterLong && !enterShort ? 'LONG' : enterShort && !enterLong ? 'SHORT' : null,
      holds: {
        LONG: bd !== null && bd > -half && fast.phase !== 'INITIATIVE_SELLING',
        SHORT: bd !== null && bd < half && fast.phase !== 'INITIATIVE_BUYING',
      },
      reasons,
    };
  }

  private friction(bookStatus: FeedBookStatus, mid: number | null, spreadBps: number | null): MicrostructureReading['friction'] {
    const base = { spreadBps, buySlipBps: null as number | null, sellSlipBps: null as number | null, orderNotional: this.opts.orderNotional };
    if (bookStatus !== 'LIVE' || mid === null || spreadBps === null) return { ...base, status: 'BLOCK', reasons: [`book ${bookStatus.toLowerCase()}`] };
    const buySlipBps = slippageBps(this.book.levels('asks'), this.opts.orderNotional, mid, 'buy');
    const sellSlipBps = slippageBps(this.book.levels('bids'), this.opts.orderNotional, mid, 'sell');
    const { status, reasons } = this.grade([[spreadBps, this.opts.maxSpreadBps, 'spread'], [buySlipBps, this.opts.maxSlipBps, 'buy slippage'], [sellSlipBps, this.opts.maxSlipBps, 'sell slippage']]);
    return { ...base, buySlipBps, sellSlipBps, status, reasons };
  }

  /** BLOCK above a limit or when the known book cannot fill; ELEVATED above half a limit; otherwise OK. Blockers are listed first. */
  private grade(checks: Array<[number | null, number, string]>): { status: FrictionStatus; reasons: string[] } {
    const blockers: string[] = [];
    const warnings: string[] = [];
    for (const [value, limit, label] of checks) {
      if (value === null) blockers.push(`${label}: known book too thin`);
      else if (value > limit) blockers.push(`${label} ${value.toFixed(1)}bps > ${limit}`);
      else if (value > limit / 2) warnings.push(`${label} ${value.toFixed(1)}bps`);
    }
    return { status: blockers.length ? 'BLOCK' : warnings.length ? 'ELEVATED' : 'OK', reasons: [...blockers, ...warnings] };
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
