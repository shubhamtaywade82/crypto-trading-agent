/**
 * Standalone raw tick recorder: captures lossless USD-M depth@100ms, aggTrade, markPrice, forceOrder,
 * periodic derivatives polls, and depth snapshots to append-only hourly JSONL logs (zstd on rotation).
 *
 *   npx tsx scripts/record-ticks.ts [--symbols BTCUSDT] [--dir data/ticks] [--self-check 30]
 */
import { parseJsonLossless } from '@nemesis-oss/binance-sdk';
import { LocalOrderBook, type DepthDiff, type DepthSnapshot } from '../src/microstructure/LocalOrderBook.js';
import { MicrostructureEngine } from '../src/microstructure/MicrostructureEngine.js';
import { FileTickSink } from '../src/marketdata/ticks/FileTickSink.js';
import { computeParityHash } from '../src/marketdata/ticks/parity.js';
import { nowNs, nsToMs } from '../src/marketdata/ticks/types.js';

interface CliArgs {
  symbols: string[];
  dir: string;
  selfCheckSec: number;
  maxBytesPerDay: number;
}

function parseCli(): CliArgs {
  const get = (k: string, fb: string) => {
    const idx = process.argv.indexOf(`--${k}`);
    return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fb;
  };
  return {
    symbols: get('symbols', 'BTCUSDT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    dir: get('dir', 'data/ticks'),
    selfCheckSec: Number(get('self-check', '0')),
    maxBytesPerDay: Number(get('max-gb-per-day', '4')) * 1_000_000_000,
  };
}

const args = parseCli();
const sink = new FileTickSink({ dir: args.dir, maxBytesPerDay: args.maxBytesPerDay });
const books = new Map<string, LocalOrderBook>();
const engines = new Map<string, MicrostructureEngine>();
const resyncCounts = new Map<string, number>();
const lastDepthAt = new Map<string, number>();
const counts = { depth: 0, aggTrade: 0, markPrice: 0, forceOrder: 0, poll: 0, snapshot: 0 };
let stopping = false;

for (const s of args.symbols) {
  books.set(s, new LocalOrderBook());
  engines.set(s, new MicrostructureEngine(s));
}

class RawFeed {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private recycleTimer: NodeJS.Timeout | null = null;
  private lastMsg = Date.now();
  private backoff = 1000;

  constructor(readonly name: string, readonly url: string, private readonly onMsg: (payload: any) => void) {}

  start(): void {
    this.connect();
    this.timer = setInterval(() => {
      if (Date.now() - this.lastMsg > 30_000) {
        console.warn(`[${this.name}] 30s silence; reconnecting`);
        this.reconnect();
      }
    }, 10_000);
    this.recycleTimer = setInterval(() => this.reconnect(), 23 * 3600 * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.recycleTimer) clearInterval(this.recycleTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  private reconnect(): void {
    this.lastMsg = Date.now();
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  private connect(): void {
    if (stopping) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.backoff = 1000; this.lastMsg = Date.now(); console.log(`[${this.name}] connected`); };
    ws.onmessage = (e: MessageEvent) => {
      this.lastMsg = Date.now();
      try {
        const parsed = parseJsonLossless(String(e.data));
        this.onMsg(parsed);
      } catch (err) {
        console.warn(`[${this.name}] bad frame: ${(err as Error).message}`);
      }
    };
    ws.onclose = () => {
      if (stopping) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
  }
}

async function fetchSnapshot(symbol: string): Promise<DepthSnapshot> {
  const res = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=1000`);
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const raw = await res.json() as { lastUpdateId: number; bids: Array<[string, string]>; asks: Array<[string, string]> };
  return {
    lastUpdateId: raw.lastUpdateId,
    bids: raw.bids.map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
    asks: raw.asks.map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
  };
}

async function syncBook(symbol: string): Promise<void> {
  resyncCounts.set(symbol, (resyncCounts.get(symbol) ?? 0) + 1);
  try {
    const snap = await fetchSnapshot(symbol);
    counts.snapshot += 1;
    sink.snapshot(symbol, snap);
    books.get(symbol)?.loadSnapshot(snap);
    engines.get(symbol)?.onSnapshot(snap);
  } catch (err) {
    console.warn(`[${symbol}] snapshot error: ${(err as Error).message}`);
  }
}

function handleDepth(symbol: string, stream: string, data: any): void {
  counts.depth += 1;
  const ns = nowNs();
  const now = nsToMs(ns);
  lastDepthAt.set(symbol, now);
  sink.ws(symbol, stream, data, ns);
  const diff: DepthDiff = {
    U: Number(data.U), u: Number(data.u), pu: data.pu ? Number(data.pu) : undefined,
    E: Number(data.E), b: data.b ?? [], a: data.a ?? [],
  };
  const book = books.get(symbol);
  if (book && book.onDiff(diff) === 'gap') void syncBook(symbol);
  engines.get(symbol)?.onDepth(diff, now);
}

function handleMarketFrame(raw: any): void {
  const data = raw?.data ?? raw;
  const stream = String(raw?.stream ?? data?.e ?? '');
  const sym = String(data?.s ?? '').toUpperCase();
  if (stream.includes('@aggTrade')) {
    counts.aggTrade += 1;
    sink.ws(sym, stream, data);
    engines.get(sym)?.onTrade({ time: Number(data.T), price: Number(data.p), qty: Number(data.q), buyerIsMaker: data.m === true });
  } else if (stream.includes('@markPrice')) {
    counts.markPrice += 1;
    sink.ws(sym, stream, data);
  } else if (stream.includes('@forceOrder') || data?.e === 'forceOrder') {
    counts.forceOrder += 1;
    const targetSym = data.o?.s ?? sym;
    sink.ws(targetSym, stream, data);
  }
}

async function pollDerivatives(symbol: string): Promise<void> {
  try {
    const oiRes = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`);
    if (oiRes.ok) { counts.poll += 1; sink.poll(symbol, 'openInterest', await oiRes.json()); }
  } catch { /* backoff quietly */ }
}

async function pollRatios(symbol: string): Promise<void> {
  const routes = ['takerlongshortRatio', 'topLongShortAccountRatio', 'globalLongShortAccountRatio'];
  for (const r of routes) {
    try {
      const res = await fetch(`https://fapi.binance.com/futures/data/${r}?symbol=${symbol}&period=5m&limit=1`);
      if (res.ok) { counts.poll += 1; sink.poll(symbol, r, await res.json()); }
    } catch { /* backoff quietly */ }
  }
}

function sampleHealth(now: number): void {
  for (const s of args.symbols) {
    const book = books.get(s);
    const engine = engines.get(s);
    if (!book || !engine) continue;
    const emitted = engine.sample(now);
    const reading = engine.reading(now);
    const parityHash = computeParityHash(reading, emitted, { buy: engine.entryFriction('buy', 5000, now), sell: engine.entryFriction('sell', 5000, now) });
    const top = book.top();
    const lastDepth = lastDepthAt.get(s);
    sink.health(s, {
      sampleAt: now,
      lagMs: lastDepth ? now - lastDepth : null,
      queue: book.bufferedCount,
      resyncs: resyncCounts.get(s) ?? 0,
      bookStatus: book.status,
      top: top ? { bid: top.bid, ask: top.ask, bidQty: top.bidQty, askQty: top.askQty } : null,
      counts: { ...counts },
      parityHash,
    });
  }
}

const pubStreams = args.symbols.map((s) => `${s.toLowerCase()}@depth@100ms`).join('/');
const mktStreams = [...args.symbols.flatMap((s) => [`${s.toLowerCase()}@aggTrade`, `${s.toLowerCase()}@markPrice@1s`]), '!forceOrder@arr'].join('/');
const pubFeed = new RawFeed('public', `wss://fstream.binance.com/public/stream?streams=${pubStreams}`, (d) => {
  const s = String(d?.data?.s ?? d?.s ?? '').toUpperCase();
  handleDepth(s, String(d?.stream ?? `${s.toLowerCase()}@depth@100ms`), d?.data ?? d);
});
const mktFeed = new RawFeed('market', `wss://fstream.binance.com/market/stream?streams=${mktStreams}`, handleMarketFrame);

async function main(): Promise<void> {
  for (const s of args.symbols) {
    sink.meta(s, { format: 1, symbol: s, startedAt: Date.now(), streams: [`${s.toLowerCase()}@depth@100ms`, `${s.toLowerCase()}@aggTrade`, `${s.toLowerCase()}@markPrice@1s`, `${s.toLowerCase()}@forceOrder`] });
    void syncBook(s);
  }
  pubFeed.start();
  mktFeed.start();

  const healthInterval = setInterval(() => sampleHealth(Date.now()), 1000);
  const oiInterval = setInterval(() => args.symbols.forEach((s) => void pollDerivatives(s)), 5000);
  const ratioInterval = setInterval(() => args.symbols.forEach((s) => void pollRatios(s)), 60_000);

  const shutdown = async (code = 0) => {
    stopping = true;
    clearInterval(healthInterval); clearInterval(oiInterval); clearInterval(ratioInterval);
    pubFeed.stop(); mktFeed.stop();
    await sink.close();
    console.log(`recorder stopped. counts: ${JSON.stringify(counts)}`);
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  if (args.selfCheckSec > 0) {
    console.log(`running self-check for ${args.selfCheckSec}s...`);
    setTimeout(() => {
      const ok = counts.depth > 0 && counts.aggTrade > 0 && counts.markPrice > 0;
      console.log(`self-check result: ${ok ? 'PASSED' : 'FAILED'} (depth=${counts.depth}, aggTrade=${counts.aggTrade}, markPrice=${counts.markPrice})`);
      void shutdown(ok ? 0 : 1);
    }, args.selfCheckSec * 1000);
  }
}

void main();
