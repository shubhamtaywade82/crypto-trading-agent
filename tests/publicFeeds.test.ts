import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SocketLike } from '../src/market/KlineStreamFeed.js';
import { PublicOnlyViolation } from '../src/market/public/endpointRegistry.js';
import { PublicMarketFeeds } from '../src/market/public/PublicMarketFeeds.js';
import { PublicRestClient } from '../src/market/public/PublicRestClient.js';
import { PublicStreamFeed } from '../src/market/public/PublicStreamFeed.js';

const T0 = 1_800_000_000_000;

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  static reset(): void { FakeSocket.instances = []; }
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  close(): void { this.closed = true; }
  open(): void { this.onopen?.(); }
  emit(payload: unknown): void { this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) }); }
  drop(): void { this.onclose?.(); }
}

const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// ---- stream feed ----

test('a stream feed refuses a URL outside the public routes before it dials anything', () => {
  FakeSocket.reset();
  assert.throws(() => new PublicStreamFeed({
    name: 'x', url: 'wss://fstream.binance.com/private/ws?listenKey=abc', onFrame: () => {}, log: () => {}, WebSocketImpl: FakeSocket,
  }), PublicOnlyViolation);
  assert.equal(FakeSocket.instances.length, 0);
});

test('a stream feed parses combined frames, skips bad ones, and reports status', () => {
  FakeSocket.reset();
  const seen: { stream: string; data: unknown }[] = [];
  const feed = new PublicStreamFeed({
    name: 'spot', url: 'wss://data-stream.binance.vision/stream?streams=btcusdt@trade', WebSocketImpl: FakeSocket, log: () => {},
    onFrame: (stream, data) => { seen.push({ stream, data }); },
  });
  feed.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  socket.emit({ stream: 'btcusdt@trade', data: { e: 'trade', s: 'BTCUSDT', p: '1', T: T0 } });
  socket.emit('not json {');
  socket.emit({ no: 'envelope' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.stream, 'btcusdt@trade');
  assert.equal(feed.status().connected, true);
  assert.equal(feed.status().frames, 1);
  feed.stop();
});

test('a frame handler that throws is contained: the next frame still arrives', () => {
  FakeSocket.reset();
  const logs: string[] = [];
  let n = 0;
  const feed = new PublicStreamFeed({
    name: 'spot', url: 'wss://data-stream.binance.vision/stream?streams=btcusdt@trade', WebSocketImpl: FakeSocket,
    log: (m) => { logs.push(m); }, onFrame: () => { n += 1; if (n === 1) throw new Error('boom'); },
  });
  feed.start();
  const socket = FakeSocket.instances[0]!;
  socket.emit({ stream: 'btcusdt@trade', data: {} });
  socket.emit({ stream: 'btcusdt@trade', data: {} });
  assert.equal(n, 2);
  assert.ok(logs.some((m) => /frame handler failed: boom/.test(m)));
  feed.stop();
});

test('a dropped socket redials with capped backoff; a successful open resets the attempt counter', async () => {
  FakeSocket.reset();
  const feed = new PublicStreamFeed({
    name: 'spot', url: 'wss://data-stream.binance.vision/stream?streams=btcusdt@trade', WebSocketImpl: FakeSocket, log: () => {},
    onFrame: () => {}, reconnectBaseMs: 10, reconnectMaxMs: 40, jitter: 0, random: () => 0.5,
  });
  feed.start();
  FakeSocket.instances[0]!.open();
  FakeSocket.instances[0]!.drop();
  await tick(15);
  assert.equal(FakeSocket.instances.length, 2, 'first reconnect after ~10 ms');
  FakeSocket.instances[1]!.drop();
  await tick(15);
  assert.equal(FakeSocket.instances.length, 2, 'second reconnect waits ~20 ms, so not yet at 15 ms');
  await tick(20);
  assert.equal(FakeSocket.instances.length, 3);
  FakeSocket.instances[2]!.open();
  FakeSocket.instances[2]!.drop();
  await tick(15);
  assert.equal(FakeSocket.instances.length, 4, 'after a successful open the backoff restarts at the base delay');
  feed.stop();
});

test('stop closes the socket and nothing redials afterwards', async () => {
  FakeSocket.reset();
  const feed = new PublicStreamFeed({
    name: 'spot', url: 'wss://data-stream.binance.vision/stream?streams=btcusdt@trade', WebSocketImpl: FakeSocket, log: () => {},
    onFrame: () => {}, reconnectBaseMs: 5, jitter: 0,
  });
  feed.start();
  const socket = FakeSocket.instances[0]!;
  feed.stop();
  assert.equal(socket.closed, true);
  socket.drop();
  await tick(20);
  assert.equal(FakeSocket.instances.length, 1, 'a stopped feed never redials');
});

// ---- orchestration ----

const spotExchangeInfo = { symbols: [
  { symbol: 'BTCUSDT', status: 'TRADING' },
  { symbol: 'ETHUSDT', status: 'TRADING' },
] };

function spotRest(overrides: Partial<Record<string, () => Response>> = {}): PublicRestClient {
  return new PublicRestClient({
    now: () => T0,
    fetchImpl: (async (url: URL | string) => {
      const u = new URL(String(url));
      const key = u.pathname.endsWith('exchangeInfo') ? 'exchangeInfo' : 'bookTicker';
      const override = overrides[key];
      if (override) return override();
      if (key === 'exchangeInfo') return json(spotExchangeInfo);
      const symbol = u.searchParams.get('symbol')!;
      return json({ symbol, bidPrice: symbol === 'BTCUSDT' ? '100' : '2000', askPrice: symbol === 'BTCUSDT' ? '101' : '2001' });
    }) as typeof fetch,
  });
}

function usdmRest(fundingStatus = 200): PublicRestClient {
  return new PublicRestClient({
    now: () => T0,
    fetchImpl: (async () => fundingStatus === 200
      ? json([{ symbol: 'BTCUSDT', fundingRate: '0.0001', fundingTime: T0 - 1 }])
      : json({ code: -1003 }, fundingStatus, { 'Retry-After': '120' })) as typeof fetch,
  });
}

test('with both feeds on, the snapshot carries bootstrapped books, the stream frames, funding and basis', async () => {
  FakeSocket.reset();
  const logs: string[] = [];
  const feeds = new PublicMarketFeeds({
    symbols: ['BTCUSDT', 'ETHUSDT'], spot: true, usdmExtras: true, staleMs: 15_000, fundingRefreshMs: 1e9,
    now: () => T0, spotRest: spotRest(), usdmRest: usdmRest(), WebSocketImpl: FakeSocket,
    log: (m) => { logs.push(m); },
  });
  await feeds.start();
  const spotSocket = FakeSocket.instances.find((s) => s.url.startsWith('wss://data-stream.binance.vision'))!;
  const usdmSocket = FakeSocket.instances.find((s) => s.url.startsWith('wss://fstream.binance.com/public/stream'))!;
  assert.ok(spotSocket && usdmSocket, 'one socket per venue');
  assert.match(spotSocket.url, /streams=btcusdt@bookTicker\/btcusdt@trade\/ethusdt@bookTicker\/ethusdt@trade$/);
  spotSocket.open();
  usdmSocket.open();
  spotSocket.emit({ stream: 'btcusdt@bookTicker', data: { s: 'BTCUSDT', b: '100.5', a: '100.7' } });
  spotSocket.emit({ stream: 'btcusdt@trade', data: { e: 'trade', s: 'BTCUSDT', p: '100.6', T: T0 } });
  usdmSocket.emit({ stream: 'btcusdt@bookTicker', data: { e: 'bookTicker', s: 'BTCUSDT', b: '100.4', a: '100.6' } });

  const ctx = feeds.snapshot(T0 + 100);
  assert.equal(ctx.spot.BTCUSDT!.quality, 'LIVE');
  assert.equal(ctx.spot.BTCUSDT!.bid, 100.5, 'the stream frame replaces the bootstrap book');
  assert.equal(ctx.spot.BTCUSDT!.last, 100.6);
  assert.equal(ctx.spot.ETHUSDT!.quality, 'LIVE', 'the bootstrap alone makes a symbol LIVE');
  assert.equal(ctx.usdm.BTCUSDT!.mid, 100.5);
  assert.equal(ctx.funding.BTCUSDT!.lastRate, 0.0001);
  assert.ok(ctx.basisBps.BTCUSDT !== null && ctx.basisBps.BTCUSDT !== undefined, 'basis computed from two LIVE books');
  assert.equal(ctx.basisBps.ETHUSDT, null, 'no USDⓈ-M book for ETH: basis stays null');
  feeds.stop();
});

test('a spot bookTicker bootstrap failure does not stop the spot stream, and a 451 is logged not thrown', async () => {
  FakeSocket.reset();
  const logs: string[] = [];
  const feeds = new PublicMarketFeeds({
    symbols: ['BTCUSDT'], spot: true, usdmExtras: false, staleMs: 15_000, fundingRefreshMs: 1e9,
    now: () => T0, WebSocketImpl: FakeSocket, log: (m) => { logs.push(m); },
    spotRest: spotRest({ bookTicker: () => json({ code: 0 }, 451) }),
  });
  await feeds.start();
  assert.equal(FakeSocket.instances.length, 1, 'the stream still dials');
  assert.ok(logs.some((m) => /bookTicker BTCUSDT failed: .*HTTP 451/.test(m)));
  assert.equal(feeds.snapshot(T0).spot.BTCUSDT!.quality, 'MISSING', 'no book yet, so MISSING, never a zero');
  feeds.stop();
});

test('a symbol the venue does not list as TRADING is left out of the subscription, with a warning', async () => {
  FakeSocket.reset();
  const logs: string[] = [];
  const feeds = new PublicMarketFeeds({
    symbols: ['BTCUSDT', 'ETHUSDT'], spot: true, usdmExtras: false, staleMs: 15_000, fundingRefreshMs: 1e9,
    now: () => T0, WebSocketImpl: FakeSocket, log: (m) => { logs.push(m); },
    spotRest: spotRest({ exchangeInfo: () => json({ symbols: [{ symbol: 'BTCUSDT', status: 'TRADING' }, { symbol: 'ETHUSDT', status: 'BREAK' }] }) }),
  });
  await feeds.start();
  assert.ok(!FakeSocket.instances[0]!.url.includes('ethusdt'));
  assert.ok(logs.some((m) => /not TRADING on the venue, not subscribed: ETHUSDT/.test(m)));
  feeds.stop();
});

test('an exchangeInfo failure still subscribes the configured symbols, and says so', async () => {
  FakeSocket.reset();
  const logs: string[] = [];
  const feeds = new PublicMarketFeeds({
    symbols: ['BTCUSDT'], spot: true, usdmExtras: false, staleMs: 15_000, fundingRefreshMs: 1e9,
    now: () => T0, WebSocketImpl: FakeSocket, log: (m) => { logs.push(m); },
    spotRest: spotRest({ exchangeInfo: () => json({ code: -1 }, 500) }),
  });
  await feeds.start();
  assert.equal(FakeSocket.instances.length, 1);
  assert.ok(logs.some((m) => /exchangeInfo failed/.test(m)));
  feeds.stop();
});

test('a USDⓈ-M funding 429 stops the refresh at once, so the venue is not hammered symbol by symbol', async () => {
  FakeSocket.reset();
  let fundingCalls = 0;
  const rest = new PublicRestClient({
    now: () => T0,
    fetchImpl: (async () => { fundingCalls += 1; return json({ code: -1003 }, 429, { 'Retry-After': '60' }); }) as typeof fetch,
  });
  const feeds = new PublicMarketFeeds({
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], spot: false, usdmExtras: true, staleMs: 15_000, fundingRefreshMs: 1e9,
    now: () => T0, usdmRest: rest, WebSocketImpl: FakeSocket, log: () => {},
  });
  await feeds.start();
  assert.equal(fundingCalls, 1, 'one request, then the backoff holds for the other symbols');
  feeds.stop();
});

test('the spot outage and the USDⓈ-M funding outage are independent', async () => {
  FakeSocket.reset();
  const feeds = new PublicMarketFeeds({
    symbols: ['BTCUSDT'], spot: true, usdmExtras: true, staleMs: 15_000, fundingRefreshMs: 1e9,
    now: () => T0, WebSocketImpl: FakeSocket, log: () => {},
    spotRest: spotRest({ exchangeInfo: () => json({ code: 0 }, 451) }),
    usdmRest: usdmRest(500),
  });
  await feeds.start();
  assert.equal(FakeSocket.instances.length, 2, 'both streams dial even though both REST reads failed');
  feeds.stop();
});

test('with both flags off nothing dials and the snapshot is empty', async () => {
  FakeSocket.reset();
  const feeds = new PublicMarketFeeds({
    symbols: ['BTCUSDT'], spot: false, usdmExtras: false, staleMs: 15_000, fundingRefreshMs: 1e9,
    now: () => T0, WebSocketImpl: FakeSocket, log: () => {},
  });
  await feeds.start();
  assert.equal(FakeSocket.instances.length, 0);
  const ctx = feeds.snapshot(T0);
  assert.deepEqual(ctx.spot, {});
  assert.deepEqual(ctx.usdm, {});
  assert.deepEqual(ctx.funding, {});
  assert.equal(ctx.basisBps.BTCUSDT, null);
});

test('stop closes every socket and leaves no funding timer behind', async () => {
  FakeSocket.reset();
  const feeds = new PublicMarketFeeds({
    symbols: ['BTCUSDT'], spot: true, usdmExtras: true, staleMs: 15_000, fundingRefreshMs: 20,
    now: () => T0, spotRest: spotRest(), usdmRest: usdmRest(), WebSocketImpl: FakeSocket, log: () => {},
  });
  await feeds.start();
  feeds.stop();
  assert.ok(FakeSocket.instances.every((s) => s.closed));
  const before = FakeSocket.instances.length;
  await tick(60);
  assert.equal(FakeSocket.instances.length, before, 'no new sockets after stop');
});
