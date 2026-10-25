import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import stringWidth from 'string-width';
import { LiquidityEventTracker, type BucketSample } from '../src/microstructure/LiquidityEvents.js';
import { LocalOrderBook, type DepthDiff } from '../src/microstructure/LocalOrderBook.js';
import { DEFAULT_MICRO_OPTIONS, MicrostructureEngine, niceBucket, slippageBps } from '../src/microstructure/MicrostructureEngine.js';
import { MicrostructureFeed, microConfigFromEnv, type MicroSource, type StreamHandle } from '../src/microstructure/MicrostructureFeed.js';
import { TradeFlow } from '../src/microstructure/TradeFlow.js';
import { gauge, renderCell, renderLiquidityScreen } from '../src/ui/liquidityPanels.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const T0 = Date.UTC(2026, 9, 25, 6, 0);
const L = (pairs: Array<[number, number]>) => pairs.map(([p, q]) => [String(p), String(q)] as const);
const diff = (U: number, u: number, pu: number | undefined, b: Array<[number, number]>, a: Array<[number, number]> = [], E = T0): DepthDiff => ({ U, u, pu, E, b: L(b), a: L(a) });
const snapshot = (lastUpdateId: number, bids: Array<[number, number]>, asks: Array<[number, number]>) =>
  ({ lastUpdateId, bids: bids.map(([price, qty]) => ({ price, qty })), asks: asks.map(([price, qty]) => ({ price, qty })) });

// ---- local order book --------------------------------------------------------------------------------------------

test('the book buffers until the snapshot, drops stale diffs and requires the first diff to straddle it', () => {
  const book = new LocalOrderBook();
  assert.equal(book.onDiff(diff(90, 95, 89, [[100, 9]])), 'buffered');
  assert.equal(book.onDiff(diff(96, 104, 95, [[100, 2]])), 'buffered');
  assert.equal(book.loadSnapshot(snapshot(100, [[100, 1], [99, 5]], [[101, 3]])), 'applied');
  assert.equal(book.status, 'LIVE');
  assert.deepEqual(book.levels('bids'), [[100, 2], [99, 5]]); // 90..95 dropped, 96..104 straddles 100 and applies
  assert.equal(book.onDiff(diff(105, 106, 104, [[99, 0]], [[101.5, 4]])), 'applied');
  assert.deepEqual(book.levels('bids'), [[100, 2]]);
  assert.deepEqual([book.bestBid(), book.bestAsk(), book.mid()], [100, 101, 100.5]);
  assert.deepEqual(book.coverage, { bidFloor: 99, askCeil: 101 });
});

test('a pu gap, a non-straddling first diff, a crossed book or a malformed level forces a resync', () => {
  const gap = new LocalOrderBook();
  gap.loadSnapshot(snapshot(100, [[100, 1]], [[101, 1]]));
  gap.onDiff(diff(99, 101, 98, [[100, 2]]));
  assert.equal(gap.onDiff(diff(103, 104, 102, [[100, 3]])), 'gap');
  assert.equal(gap.status, 'RESYNC_REQUIRED');
  assert.match(gap.reason, /expected 101, got pu=102/);
  assert.equal(gap.onDiff(diff(105, 106, 104, [])), 'dropped');

  const late = new LocalOrderBook();
  late.loadSnapshot(snapshot(100, [[100, 1]], [[101, 1]]));
  assert.equal(late.onDiff(diff(102, 103, 101, [])), 'gap');
  assert.match(late.reason, /does not straddle snapshot 100/);

  const crossed = new LocalOrderBook();
  crossed.loadSnapshot(snapshot(100, [[100, 1]], [[101, 1]]));
  assert.equal(crossed.onDiff(diff(100, 101, 99, [[101.5, 1]])), 'gap');
  assert.match(crossed.reason, /crossed book/);

  const corrupt = new LocalOrderBook();
  corrupt.loadSnapshot(snapshot(100, [[100, 1]], [[101, 1]]));
  assert.equal(corrupt.onDiff({ U: 100, u: 101, pu: 99, E: T0, b: [['abc', '1']], a: [] }), 'gap');

  corrupt.reset('test');
  assert.equal(corrupt.status, 'SYNCING');
});

// ---- flow, events --------------------------------------------------------------------------------------------------

test('trade flow signs aggressors by notional and keeps a running CVD', () => {
  const flow = new TradeFlow();
  flow.add({ time: T0 - 20_000, price: 100, qty: 3, buyerIsMaker: false });
  flow.add({ time: T0 - 2_000, price: 100, qty: 1, buyerIsMaker: true });
  flow.add({ time: T0 - 1_000, price: 0, qty: 5, buyerIsMaker: false }); // ignored
  const w30 = flow.window(T0, 30_000);
  assert.deepEqual([w30.buyNotional, w30.sellNotional, w30.trades, w30.delta], [300, 100, 2, 0.5]);
  assert.equal(flow.window(T0, 5_000).delta, -1);
  assert.equal(flow.window(T0, 1_000).delta, null);
  assert.equal(flow.cvd, 2);
});

const sample = (t: number, mid: number, bids: Record<number, number>, asks: Record<number, number>, sells: Record<number, number> = {}, buys: Record<number, number> = {}): BucketSample => ({
  t, mid, bucketSize: 1,
  bids: new Map(Object.entries(bids).map(([k, v]) => [Number(k), v])),
  asks: new Map(Object.entries(asks).map(([k, v]) => [Number(k), v])),
  sellsIntoBids: new Map(Object.entries(sells).map(([k, v]) => [Number(k), v])),
  buysIntoAsks: new Map(Object.entries(buys).map(([k, v]) => [Number(k), v])),
});
const normalBids = { 99: 10, 98: 10, 97: 10, 96: 10 };
const asks = { 101: 10, 102: 10, 103: 10 };

test('a wall is announced only after it persists, and is classified as pulled, consumed or absorbing', () => {
  const pulled = new LiquidityEventTracker();
  assert.deepEqual(pulled.update(sample(T0, 100.5, { ...normalBids, 95: 100 }, asks)), []);
  assert.deepEqual(pulled.update(sample(T0 + 3_000, 100.5, { ...normalBids, 95: 100 }, asks)).map((e) => e.kind), ['CONCENTRATION']);
  assert.deepEqual(pulled.update(sample(T0 + 4_000, 100.5, { ...normalBids, 95: 10 }, asks)).map((e) => e.kind), ['PULLED']);

  const flicker = new LiquidityEventTracker();
  flicker.update(sample(T0, 100.5, { ...normalBids, 95: 100 }, asks));
  assert.deepEqual(flicker.update(sample(T0 + 1_000, 100.5, normalBids, asks)), []); // never announced, never reported

  const eaten = new LiquidityEventTracker();
  eaten.update(sample(T0, 100.5, { ...normalBids, 95: 100 }, asks));
  eaten.update(sample(T0 + 3_000, 100.5, { ...normalBids, 95: 100 }, asks));
  const consumed = eaten.update(sample(T0 + 4_000, 94.5, { ...normalBids, 95: 20 }, asks, { 95: 70 }));
  assert.deepEqual(consumed.map((e) => [e.kind, e.priceThrough, e.executedQty]), [['CONSUMED', true, 70]]);

  const held = new LiquidityEventTracker();
  held.update(sample(T0, 100.5, { ...normalBids, 95: 100 }, asks));
  held.update(sample(T0 + 3_000, 100.5, { ...normalBids, 95: 100 }, asks));
  held.update(sample(T0 + 4_000, 96, { ...normalBids, 95: 90 }, asks, { 95: 60 }));
  const absorbed = held.update(sample(T0 + 5_000, 96, { ...normalBids, 95: 95 }, asks, { 95: 50 }));
  assert.deepEqual(absorbed.map((e) => [e.kind, e.side, e.executedQty]), [['ABSORPTION', 'bid', 110]]);
  assert.equal(held.update(sample(T0 + 6_000, 96, { ...normalBids, 95: 95 }, asks, { 95: 200 })).length, 0); // once per 30 s
});

// ---- engine ------------------------------------------------------------------------------------------------------

/** A live engine on a 100.00 / 100.02 book with 0.01 ticks and even depth. */
function liveEngine(options = DEFAULT_MICRO_OPTIONS) {
  const engine = new MicrostructureEngine('SOLUSDT', { ...options, bucketBps: 1 });
  const bids: Array<[number, number]> = [];
  const asks2: Array<[number, number]> = [];
  for (let i = 0; i < 300; i += 1) {
    bids.push([Number((100 - i * 0.01).toFixed(2)), 50]);
    asks2.push([Number((100.02 + i * 0.01).toFixed(2)), 50]);
  }
  engine.onSnapshot(snapshot(1_000, bids, asks2));
  engine.onDepth(diff(1_000, 1_001, 999, []), T0);
  return engine;
}

/** Moves the touch: the old best levels are removed and new ones added, chained on `u`. */
function moveBook(engine: MicrostructureEngine, u: number, bid: number, ask: number, t: number) {
  const b: Array<[number, number]> = [];
  const a: Array<[number, number]> = [];
  for (const [p] of engine.book.levels('bids')) if (p > bid) b.push([p, 0]);
  for (const [p] of engine.book.levels('asks')) if (p < ask) a.push([p, 0]);
  b.push([bid, 50]);
  a.push([ask, 50]);
  engine.onDepth(diff(u, u, u - 1, b, a), t);
}

test('reads initiative buying when buyers lift price, and selling absorbed when sells do not move it', () => {
  const up = liveEngine();
  up.sample(T0);
  for (let i = 1; i <= 30; i += 1) {
    up.onTrade({ time: T0 + i * 1_000, price: 100 + i * 0.002, qty: 5, buyerIsMaker: false });
    if (i === 30) moveBook(up, 1_002, 100.08, 100.1, T0 + i * 1_000);
    up.sample(T0 + i * 1_000);
  }
  const r = up.reading(T0 + 30_000);
  assert.equal(r.phase, 'INITIATIVE_BUYING');
  assert.ok(r.priceResponseBps30s! > 3);
  assert.equal(r.flow.delta30s, 1);
  assert.equal(r.evidence, 'SUPPORTS_LONG');

  const flat = liveEngine();
  flat.sample(T0);
  for (let i = 1; i <= 30; i += 1) {
    flat.onTrade({ time: T0 + i * 1_000, price: 100, qty: 5, buyerIsMaker: true });
    flat.onDepth(diff(1_001 + i, 1_001 + i, 1_000 + i, []), T0 + i * 1_000);
    flat.sample(T0 + i * 1_000);
  }
  const f = flat.reading(T0 + 30_000);
  assert.equal(f.phase, 'SELL_ABSORBED');
  assert.equal(f.evidence, 'NONE'); // absorption needs an absorbed wall, not just flat price
});

test('a quiet tape is THIN, an idle book goes STALE, and a broken book withholds everything', () => {
  const engine = liveEngine();
  engine.sample(T0);
  assert.equal(engine.reading(T0 + 1_000).phase, 'THIN');
  const stale = engine.reading(T0 + 6_000);
  assert.equal(stale.book.status, 'STALE');
  assert.equal(stale.friction.status, 'BLOCK');
  assert.equal(stale.evidence, 'INVALID');
  assert.equal(stale.mid, null);

  engine.invalidate('stream reconnecting');
  const r = engine.reading(T0 + 500);
  assert.deepEqual([r.book.status, r.book.reason, r.spreadBps, r.depthImbalance.bps25], ['SYNCING', 'stream reconnecting', null, null]);
});

test('depth imbalance, spread and slippage come from the local book; depth alone is never evidence', () => {
  const engine = liveEngine();
  engine.onDepth(diff(1_002, 1_002, 1_001, [[99.99, 5_000]]), T0); // 5,400 bid vs 500 ask within 10 bps
  const r = engine.reading(T0);
  assert.ok(Math.abs(r.spreadBps! - 2) < 1e-6);
  assert.ok(r.depthImbalance.bps10! > 0.5);
  assert.equal(r.evidence, 'NONE');
  assert.ok(r.evidenceReasons[0].startsWith('bid-heavy depth'));
  assert.equal(r.friction.status, 'OK');
  assert.ok(r.friction.buySlipBps! > 0 && r.friction.buySlipBps! < 2);

  const thin = new MicrostructureEngine('SOLUSDT', { ...DEFAULT_MICRO_OPTIONS, orderNotional: 1_000_000 });
  thin.onSnapshot(snapshot(1, [[100, 1]], [[100.02, 1]]));
  thin.onDepth(diff(1, 2, 0, []), T0);
  const t = thin.reading(T0);
  assert.equal(t.friction.status, 'BLOCK');
  assert.match(t.friction.reasons.join(), /known book too thin/);
});

test('slippage walks levels to a VWAP and refuses what the book cannot fill', () => {
  assert.ok(Math.abs(slippageBps([[101, 1], [102, 10]], 203, 100, 'buy')! - 150) < 1e-9);
  assert.equal(slippageBps([[101, 1]], 1_000, 100, 'buy'), null);
  assert.equal(niceBucket(101.5, 1), 0.02);
  assert.equal(niceBucket(80_000, 1), 10);
  assert.equal(niceBucket(1.31, 1), 0.0002);
});

test('the field is rows x cols, centers the mid, normalizes to 1 and marks what the book never showed', () => {
  const engine = liveEngine();
  for (let i = 0; i < 5; i += 1) {
    engine.onTrade({ time: T0 + i * 1_000 - 1, price: 100, qty: 10, buyerIsMaker: true });
    engine.onDepth(diff(1_002 + i, 1_002 + i, 1_001 + i, []), T0 + i * 1_000);
    engine.sample(T0 + i * 1_000);
  }
  const view = engine.view(T0 + 4_000, 21, 12);
  const field = view.field!;
  assert.deepEqual([field.rows, field.cols, field.cells.length, field.cells[0].length, field.midRow], [21, 12, 21, 12, 10]);
  assert.ok(field.cells[field.midRow].slice(-5).every((c) => c.path));
  assert.ok(field.cells[0].slice(0, 7).every((c) => c.unknown)); // before history began
  const all = field.cells.flat();
  assert.ok(all.every((c) => c.bid <= 1 && c.ask <= 1 && c.buy <= 1 && c.sell <= 1));
  assert.ok(all.some((c) => c.sell > 0));
  assert.equal(field.bucketSize, 0.02);
  assert.equal(view.cvdSeries.at(-1), -50);
  assert.equal(view.ladder.bids[0][0], 100);
});

// ---- feed --------------------------------------------------------------------------------------------------------

class ScriptedHandle implements StreamHandle {
  listeners: Record<string, Array<(x: any) => void>> = {};
  closed = false;
  on(event: string, listener: (x: any) => void) { (this.listeners[event] ??= []).push(listener); return this; }
  emit(event: string, payload: unknown) { for (const l of this.listeners[event] ?? []) l(payload); }
  close() { this.closed = true; }
}

class ScriptedSource implements MicroSource {
  handles = new Map<string, ScriptedHandle>();
  snapshots: Array<ReturnType<typeof snapshot>> = [];
  failSubscribe: Error | null = null;
  snapshotCalls = 0;
  async subscribe(stream: string) {
    if (this.failSubscribe) throw this.failSubscribe;
    const h = new ScriptedHandle();
    this.handles.set(stream, h);
    return h;
  }
  async depthSnapshot() {
    this.snapshotCalls += 1;
    return this.snapshots.shift() ?? snapshot(500, [[100, 1]], [[100.02, 1]]);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('the feed syncs from a snapshot, resyncs on a gap, and records readings', async () => {
  const source = new ScriptedSource();
  const dir = mkdtempSync(path.join(tmpdir(), 'micro-'));
  const logs: string[] = [];
  let now = T0;
  const feed = new MicrostructureFeed(['SOLUSDT'], { source, config: { ...microConfigFromEnv({}), record: true, recordDir: dir }, log: (_l, m) => logs.push(m), now: () => now, snapshotDelayMs: 5 });
  await feed.start();
  feed.stop(); // drive sampling by hand
  const depth = source.handles.get('solusdt@depth@100ms')!;
  const trades = source.handles.get('solusdt@aggTrade')!;
  depth.emit('message', { U: 499, u: 501, pu: 498, E: now, b: [['100', '2']], a: [] });
  source.snapshots.push(snapshot(500, [[100, 1]], [[100.02, 1]]));
  (feed as any).stopped = false;
  await settle();
  assert.equal(feed.engine('SOLUSDT')!.book.status, 'LIVE');
  assert.deepEqual(feed.engine('SOLUSDT')!.book.levels('bids'), [[100, 2]]);

  trades.emit('message', { T: now, p: 100.01, q: 3, m: false });
  now += 1_000;
  feed.sampleAll();
  const reading = feed.handle().view('SOLUSDT', 11, 10)!.reading;
  assert.equal(reading.book.status, 'LIVE');
  assert.equal(reading.flow.trades30s, 1);

  depth.emit('message', { U: 510, u: 511, pu: 509, E: now, b: [], a: [] });
  assert.ok(logs.some((m) => /SOLUSDT order book sequence gap: expected 501, got pu=509 U=510; resyncing/.test(m)));
  source.snapshots.push(snapshot(512, [[100, 4]], [[100.02, 4]]));
  depth.emit('message', { U: 512, u: 513, pu: 511, E: now, b: [], a: [] });
  await settle();
  depth.emit('message', { U: 513, u: 514, pu: 513, E: now, b: [], a: [] });
  assert.equal(feed.engine('SOLUSDT')!.book.status, 'LIVE');
  assert.deepEqual(feed.engine('SOLUSDT')!.book.levels('bids'), [[100, 4]]);

  depth.emit('state', 'pending');
  assert.equal(feed.engine('SOLUSDT')!.book.status, 'SYNCING');
  (feed as any).stopped = true;

  const recorded = readFileSync(path.join(dir, '2026-10-25', 'SOLUSDT.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].book.status, 'LIVE');
  assert.ok(!('events' in recorded[0]) && Array.isArray(recorded[0].emitted));
});

test('a feed that cannot subscribe reports itself down instead of throwing', async () => {
  const source = new ScriptedSource();
  source.failSubscribe = new Error('Unexpected server response: 451');
  const logs: string[] = [];
  const feed = new MicrostructureFeed(['SOLUSDT'], { source, config: microConfigFromEnv({}), log: (_l, m) => logs.push(m) });
  await feed.start();
  feed.stop();
  const handle = feed.handle();
  assert.deepEqual([handle.state, handle.lastError], ['down', 'Unexpected server response: 451']);
  assert.equal(logs.length, 1);
  assert.throws(() => microConfigFromEnv({ MICRO_BUCKET_BPS: '0' }));
  assert.equal(microConfigFromEnv({ MICROSTRUCTURE: 'off', MICRO_ENTRY_GATE: 'off' }).enabled, false); // the gate cannot be on without the feed
});

// ---- renderer ----------------------------------------------------------------------------------------------------

function renderedEngineHandle() {
  const engine = liveEngine();
  for (let i = 0; i < 40; i += 1) {
    engine.onTrade({ time: T0 + i * 1_000 - 1, price: 100, qty: 4, buyerIsMaker: i % 3 === 0 });
    engine.onDepth(diff(1_002 + i, 1_002 + i, 1_001 + i, []), T0 + i * 1_000);
    engine.sample(T0 + i * 1_000);
  }
  return { tick: 1, state: 'live' as const, lastError: null, symbols: ['BTCUSDT', 'SOLUSDT'], view: (_s: string, rows: number, cols: number, spanMs?: number) => engine.view(T0 + 39_000, rows, cols, spanMs) };
}

test('the liquidity screen fills the terminal exactly at every size and shows the derived reading', () => {
  for (const [w, h] of [[160, 53], [200, 60], [240, 80]] as const) {
    const lines = renderLiquidityScreen({ feed: renderedEngineHandle(), symbols: ['BTCUSDT', 'SOLUSDT'], selectedSymbol: 'SOLUSDT', showLadder: false, spanMs: 120_000, time: '06:00:39', totalWidth: w, totalHeight: h });
    assert.equal(lines.length, h - 1, `${w}x${h}`);
    for (const line of lines) assert.equal(stringWidth(strip(line)), w, `${w}x${h}: ${strip(line)}`);
    const text = lines.map(strip).join('\n');
    for (const label of ['LIQUIDITY PRESSURE FIELD', 'ORDER FLOW', 'OFI/depth', 'DISPLAYED DEPTH', 'AGGRESSOR FLOW', 'EXECUTION FRICTION', 'MICRO BIAS', 'LIQUIDITY EVENTS', 'BOOK LIVE', '━']) {
      assert.ok(text.includes(label), `${label} missing at ${w}x${h}`);
    }
  }
  const ladder = renderLiquidityScreen({ feed: renderedEngineHandle(), symbols: ['SOLUSDT'], selectedSymbol: 'SOLUSDT', showLadder: true, spanMs: 120_000, time: '', totalWidth: 160, totalHeight: 53 }).map(strip).join('\n');
  assert.match(ladder, /LADDER/);
  assert.match(ladder, /100\.02/);
});

test('the screen withholds the field while the book syncs, and says when the feed is down or off', () => {
  const engine = new MicrostructureEngine('SOLUSDT');
  engine.invalidate('initial sync');
  const syncing = { tick: 0, state: 'live' as const, lastError: null, symbols: ['SOLUSDT'], view: (_s: string, r: number, c: number, span?: number) => engine.view(T0, r, c, span) };
  const text = (feed: any) => renderLiquidityScreen({ feed, symbols: ['SOLUSDT'], selectedSymbol: 'SOLUSDT', showLadder: false, spanMs: 120_000, time: '', totalWidth: 160, totalHeight: 53 }).map(strip).join('\n');
  assert.match(text(syncing), /field withheld — book syncing: initial sync/);
  assert.match(text(syncing), /MICRO BIAS +NEUTRAL/);
  assert.match(text(syncing), /this second: invalid/);
  assert.match(text({ ...syncing, state: 'down', lastError: '451' }), /FEED DOWN +451/);
  assert.match(text(undefined), /MICROSTRUCTURE OFF/);
  assert.equal(strip(gauge(0.5, 10)), 'bid  ███│     ask +0.50'); // 2.5 cells rounds up
  assert.equal(strip(gauge(-1, 4)), 'bid  │██ask -1.00');
});

test('a snapshot that keeps failing is logged once, and its recovery once', async () => {
  const source = new ScriptedSource();
  let fails = 3;
  source.depthSnapshot = async () => {
    source.snapshotCalls += 1;
    if (fails-- > 0) throw new Error('Service unavailable from a restricted location');
    return snapshot(500, [[100, 1]], [[100.02, 1]]);
  };
  const logs: string[] = [];
  const feed = new MicrostructureFeed(['SOLUSDT'], { source, config: microConfigFromEnv({}), log: (_l, m) => logs.push(m), snapshotDelayMs: 1 });
  (feed as any).stopped = false;
  await feed.resync('SOLUSDT', 'test');
  assert.equal(source.snapshotCalls, 4);
  assert.deepEqual(logs, ['SOLUSDT depth snapshot failed, retrying with backoff: Service unavailable from a restricted location', 'SOLUSDT order book recovered']);
});

test('without truecolor, depth falls back to a density ramp; path and pulses keep their glyphs', () => {
  const cell = (o: Partial<Parameters<typeof renderCell>[0]>) => ({ bid: 0, ask: 0, buy: 0, sell: 0, path: false, unknown: false, ...o });
  assert.deepEqual([0.1, 0.3, 0.6, 1].map((bid) => strip(renderCell(cell({ bid }), 1))), ['░', '▒', '▓', '█']);
  assert.equal(strip(renderCell(cell({ ask: 0.9, path: true }), 1)), '━');
  assert.equal(strip(renderCell(cell({ bid: 0.9, sell: 0.8 }), 1)), '●');
  assert.equal(strip(renderCell(cell({ unknown: true }), 3)), '·');
  assert.equal(strip(renderCell(cell({}), 0)), ' ');
});

test('below truecolor the whole field uses the density ramp, never a downsampled background', async () => {
  const chalk = (await import('chalk')).default;
  const saved = chalk.level;
  chalk.level = 1;
  try {
    const lines = renderLiquidityScreen({ feed: renderedEngineHandle(), symbols: ['SOLUSDT'], selectedSymbol: 'SOLUSDT', showLadder: false, spanMs: 120_000, time: '', totalWidth: 160, totalHeight: 53 });
    // Each body line is │ field │ side panel │; keep only the field column
    const field = lines.slice(5, 20).map((l) => l.split('\x1b[36m│')[1] ?? '').join('');
    assert.ok(!/\x1b\[4[0-7]m/.test(field) && !/\x1b\[48;/.test(field), 'no background colours in the field');
    assert.ok((field.match(/[░▒▓█]/g) ?? []).length > 300, 'depth drawn as density glyphs across the field');
  } finally {
    chalk.level = saved;
  }
});
