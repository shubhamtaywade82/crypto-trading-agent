import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KlineStreamCache } from '../src/market/KlineStreamCache.js';
import { KlineStreamFeed, type SocketLike } from '../src/market/KlineStreamFeed.js';
import type { NativeTimeframe } from '../src/market/MarketDataTypes.js';

const MIN = 60_000;
const T0 = Math.floor(1_800_000_000_000 / MIN) * MIN;
const NOW = T0 + 5 * MIN + 10_000;

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  drop(): void {
    this.onclose?.();
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

/** REST kline rows, [openTime, open, high, low, close, volume], for closed candles T0 .. T0+4min. */
function restRows(): unknown[] {
  return [0, 1, 2, 3, 4].map((i) => [T0 + i * MIN, '100', '101', '99', '100', '5']);
}

function klineFrame(openTime: number, closed: boolean, symbol = 'BTCUSDT', interval: NativeTimeframe = '1m') {
  return {
    stream: `${symbol.toLowerCase()}@kline_${interval}`,
    data: {
      e: 'kline', E: openTime, s: symbol,
      k: { t: openTime, T: openTime + MIN - 1, s: symbol, i: interval, o: '100', c: '100', h: '101', l: '99', v: '5', x: closed },
    },
  };
}

function build(overrides: { backfill?: (s: string, i: NativeTimeframe, limit: number) => Promise<unknown[]>; retryMs?: number } = {}) {
  FakeSocket.instances = [];
  const cache = new KlineStreamCache({ limit: 5, now: () => NOW });
  const logs: Array<{ message: string; level: string }> = [];
  const backfillCalls: string[] = [];
  const feed = new KlineStreamFeed({
    marketBase: 'wss://fstream.binance.com/market',
    symbols: ['BTCUSDT'],
    intervals: ['1m'],
    limit: 5,
    cache,
    backfill: overrides.backfill ?? (async (symbol, interval) => {
      backfillCalls.push(`${symbol}:${interval}`);
      return restRows();
    }),
    log: (message, level) => logs.push({ message, level }),
    now: () => NOW,
    WebSocketImpl: FakeSocket,
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    retryMs: overrides.retryMs ?? 5,
  });
  return { feed, cache, logs, backfillCalls };
}

test('the URL is one combined /market stream covering every symbol and interval, lowercased', () => {
  const cache = new KlineStreamCache({ limit: 5, now: () => NOW });
  const feed = new KlineStreamFeed({
    marketBase: 'wss://fstream.binance.com/market',
    symbols: ['BTCUSDT', 'ETHUSDT'], intervals: ['1m', '5m'], limit: 5, cache,
    backfill: async () => [], log: () => undefined, WebSocketImpl: FakeSocket, now: () => NOW,
  });
  assert.equal(
    feed.url(),
    'wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1m/btcusdt@kline_5m/ethusdt@kline_1m/ethusdt@kline_5m',
  );
});

test('a connection backfills each series once, then keeps it current from frames', async () => {
  const { feed, cache, backfillCalls } = build();
  feed.start();
  assert.equal(FakeSocket.instances.length, 1);
  FakeSocket.instances[0]!.open();
  await flush();

  assert.deepEqual(backfillCalls, ['BTCUSDT:1m'], 'one REST call at boot, none per TTL');
  assert.equal(cache.candles('BTCUSDT', '1m', NOW)?.length, 5);

  FakeSocket.instances[0]!.emit(klineFrame(T0 + 5 * MIN, true));
  assert.equal(cache.candles('BTCUSDT', '1m', NOW)!.at(-1)!.openTime, T0 + 5 * MIN);
  assert.deepEqual(backfillCalls, ['BTCUSDT:1m'], 'a frame costs no REST call');
  feed.stop();
});

test('a dropped socket invalidates the cache at once, then reconnects and backfills again', async () => {
  const { feed, cache, backfillCalls } = build();
  feed.start();
  FakeSocket.instances[0]!.open();
  await flush();
  assert.notEqual(cache.candles('BTCUSDT', '1m', NOW), null);

  FakeSocket.instances[0]!.drop();
  assert.equal(cache.candles('BTCUSDT', '1m', NOW), null, 'frames missed during the drop make the cache untrusted immediately');

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(FakeSocket.instances.length, 2, 'a reconnect opened a new socket');
  FakeSocket.instances[1]!.open();
  await flush();
  assert.equal(backfillCalls.length, 2);
  assert.notEqual(cache.candles('BTCUSDT', '1m', NOW), null);
  feed.stop();
});

test('a failed backfill retries on a timer, not on every frame', async () => {
  let attempts = 0;
  const { feed, cache } = build({
    retryMs: 10,
    backfill: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('rest refused');
      return restRows();
    },
  });
  feed.start();
  FakeSocket.instances[0]!.open();
  await flush();
  assert.equal(attempts, 1);
  assert.equal(cache.candles('BTCUSDT', '1m', NOW), null);

  // A burst of frames while the retry is pending must not start backfills of their own.
  for (let i = 0; i < 5; i += 1) FakeSocket.instances[0]!.emit(klineFrame(T0 + 5 * MIN, false));
  assert.equal(attempts, 1, 'frames do not trigger extra REST calls during the retry wait');

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(attempts, 2, 'the retry ran once');
  assert.notEqual(cache.candles('BTCUSDT', '1m', NOW), null);
  feed.stop();
});

test('a gap in the closed candles triggers one backfill of that series', async () => {
  const { feed, cache, backfillCalls } = build();
  feed.start();
  FakeSocket.instances[0]!.open();
  await flush();

  FakeSocket.instances[0]!.emit(klineFrame(T0 + 8 * MIN, true));
  await flush();
  assert.equal(backfillCalls.length, 2, 'the gap led to a second REST backfill');
  assert.notEqual(cache.candles('BTCUSDT', '1m', NOW), null);
  feed.stop();
});

test('stop closes the socket and prevents any reconnect', async () => {
  const { feed } = build();
  feed.start();
  FakeSocket.instances[0]!.open();
  await flush();

  feed.stop();
  assert.equal(FakeSocket.instances[0]!.closed, true);
  FakeSocket.instances[0]!.drop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(FakeSocket.instances.length, 1, 'a stopped feed does not reconnect');
});

test('malformed frames are dropped without touching the cache', async () => {
  const { feed, cache } = build();
  feed.start();
  FakeSocket.instances[0]!.open();
  await flush();
  const before = feed.status().frames;

  FakeSocket.instances[0]!.onmessage?.({ data: 'not json' });
  FakeSocket.instances[0]!.emit({ e: 'trade', s: 'BTCUSDT', p: '1' });
  assert.equal(feed.status().frames, before, 'neither malformed nor non-kline frames count');
  assert.notEqual(cache.candles('BTCUSDT', '1m', NOW), null);
  feed.stop();
});
