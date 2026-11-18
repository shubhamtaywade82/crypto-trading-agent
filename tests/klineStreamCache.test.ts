import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KlineStreamCache, parseKlineFrame, type KlineFrame } from '../src/market/KlineStreamCache.js';
import type { NativeTimeframe } from '../src/market/MarketDataTypes.js';

const MIN = 60_000;
/** Minute-aligned origin. Candles open at T0 + n * MIN. */
const T0 = Math.floor(1_800_000_000_000 / MIN) * MIN;
/** 10 seconds into the candle that opens at T0 + 5 min. The newest closed candle is T0 + 4 min. */
const NOW = T0 + 5 * MIN + 10_000;

function candle(openTime: number, price = 100) {
  return { openTime, open: price, high: price + 1, low: price - 1, close: price, volume: 5 };
}

function frame(openTime: number, closed: boolean, opts: { interval?: NativeTimeframe; symbol?: string; price?: number } = {}): KlineFrame {
  const price = opts.price ?? 100;
  return {
    symbol: opts.symbol ?? 'BTCUSDT',
    interval: opts.interval ?? '1m',
    openTime,
    open: price, high: price + 1, low: price - 1, close: price, volume: 5,
    closed,
  };
}

function seededCache(opts: { limit?: number; maxSilenceMs?: number; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: NOW };
  const cache = new KlineStreamCache({ limit: opts.limit ?? 5, maxSilenceMs: opts.maxSilenceMs ?? 15_000, now: () => clock.t });
  cache.register('BTCUSDT', '1m');
  const token = cache.beginSeed('BTCUSDT', '1m');
  assert.notEqual(token, null);
  // Closed candles T0..T0+4min, plus the forming candle at T0+5min, which must never be served.
  const rows = [0, 1, 2, 3, 4].map((i) => candle(T0 + i * MIN));
  assert.equal(cache.seed('BTCUSDT', '1m', token!, rows, NOW), true);
  // Any frame counts as a sign of life, so the stream is live right after the seed.
  cache.apply(frame(T0 + 5 * MIN, false), NOW);
  return { cache, clock, token: token! };
}

test('a kline frame is read in raw and combined-stream form, and rejects anything else', () => {
  const raw = {
    e: 'kline', E: 1, s: 'BTCUSDT',
    k: { t: T0, T: T0 + MIN - 1, s: 'BTCUSDT', i: '1m', o: '63918.00', c: '63885.40', h: '63933.50', l: '63874.00', v: '66.022', x: true },
  };
  assert.deepEqual(parseKlineFrame(raw), {
    symbol: 'BTCUSDT', interval: '1m', openTime: T0, open: 63918, high: 63933.5, low: 63874, close: 63885.4, volume: 66.022, closed: true,
  });
  assert.equal(parseKlineFrame({ stream: 'btcusdt@kline_1m', data: { ...raw, k: { ...raw.k, x: false } } })?.closed, false);

  assert.equal(parseKlineFrame({ e: 'trade', s: 'BTCUSDT', p: '1' }), null, 'not a kline');
  assert.equal(parseKlineFrame({ e: 'kline', s: 'BTCUSDT', k: { ...raw.k, i: '3m' } }), null, 'an unsupported interval');
  assert.equal(parseKlineFrame({ e: 'kline', s: 'BTCUSDT', k: { ...raw.k, i: 'constructor' } }), null, 'a prototype key is not an interval');
  assert.equal(parseKlineFrame({ e: 'kline', s: 'BTCUSDT', k: { ...raw.k, c: 'NaN' } }), null, 'a non-finite price');
  assert.equal(parseKlineFrame({ e: 'kline', s: 'BTCUSDT', k: { ...raw.k, c: '0' } }), null, 'a non-positive price');
  assert.equal(parseKlineFrame('not json'), null);
});

test('nothing is served before a seed, and the seed serves only closed candles', () => {
  const cache = new KlineStreamCache({ limit: 5, now: () => NOW });
  cache.register('BTCUSDT', '1m');
  assert.equal(cache.candles('BTCUSDT', '1m', NOW), null, 'unseeded');

  const { cache: seeded } = seededCache();
  const served = seeded.candles('BTCUSDT', '1m', NOW);
  assert.ok(served);
  assert.deepEqual(served.map((c) => c.openTime), [0, 1, 2, 3, 4].map((i) => T0 + i * MIN));
});

test('a closed frame extends the series and respects the limit, while a forming frame never does', () => {
  const { cache } = seededCache({ limit: 5 });

  assert.equal(cache.apply(frame(T0 + 5 * MIN, false), NOW), 'ignored', 'a forming candle is not a closed one');
  assert.equal(cache.apply(frame(T0 + 5 * MIN, true), NOW), 'applied');

  const served = cache.candles('BTCUSDT', '1m', NOW);
  assert.ok(served);
  assert.equal(served.length, 5, 'the oldest candle is dropped to hold the limit');
  assert.equal(served.at(-1)!.openTime, T0 + 5 * MIN);
  assert.equal(served[0]!.openTime, T0 + 1 * MIN);
});

test('a repeated closed candle replaces its last row, and an older one is ignored', () => {
  const { cache } = seededCache();
  assert.equal(cache.apply(frame(T0 + 4 * MIN, true, { price: 250 }), NOW), 'applied');
  assert.equal(cache.apply(frame(T0 + 2 * MIN, true), NOW), 'ignored');

  const served = cache.candles('BTCUSDT', '1m', NOW)!;
  assert.equal(served.at(-1)!.close, 250);
  assert.equal(served.length, 5);
});

test('a missing closed candle is a gap: the series stops serving until it is backfilled', () => {
  const { cache } = seededCache();
  assert.equal(cache.apply(frame(T0 + 7 * MIN, true), NOW), 'gap', 'T0+5min and T0+6min were never seen');
  assert.equal(cache.candles('BTCUSDT', '1m', NOW), null);
  assert.deepEqual(cache.pendingSeeds(), [{ symbol: 'BTCUSDT', interval: '1m' }]);
});

test('a silent stream is not served, so the caller reads REST', () => {
  const { cache } = seededCache({ maxSilenceMs: 15_000 });
  assert.notEqual(cache.candles('BTCUSDT', '1m', NOW + 14_000), null);
  assert.equal(cache.candles('BTCUSDT', '1m', NOW + 16_000), null);
});

test('one candle of grace covers the close latency, but two missing candles stop the series being served', () => {
  const { cache } = seededCache({ maxSilenceMs: 60 * MIN });
  // The newest closed candle is T0+4min; at T0+6min the candle at T0+5min should have closed. One behind is tolerated.
  const oneBehind = T0 + 6 * MIN + 1_000;
  assert.notEqual(cache.candles('BTCUSDT', '1m', oneBehind), null);
  // At T0+7min the candle at T0+6min should have closed too. Two behind means the stream lost data.
  const twoBehind = T0 + 7 * MIN + 1_000;
  assert.equal(cache.candles('BTCUSDT', '1m', twoBehind), null);
});

test('markAllStale invalidates every series, and a seed started before the invalidation is discarded', () => {
  const { cache, token } = seededCache();
  cache.markAllStale();
  assert.equal(cache.candles('BTCUSDT', '1m', NOW), null);

  // A backfill that was in flight when the stream dropped must not install its (possibly stale) rows.
  assert.equal(cache.seed('BTCUSDT', '1m', token, [candle(T0)], NOW), false);
  assert.equal(cache.candles('BTCUSDT', '1m', NOW), null);
  assert.deepEqual(cache.pendingSeeds(), [{ symbol: 'BTCUSDT', interval: '1m' }]);

  const fresh = cache.beginSeed('BTCUSDT', '1m')!;
  assert.equal(cache.seed('BTCUSDT', '1m', fresh, [0, 1, 2, 3, 4].map((i) => candle(T0 + i * MIN)), NOW), true);
  assert.notEqual(cache.candles('BTCUSDT', '1m', NOW), null);
});

test('closed frames that arrive while a backfill is in flight are merged into it, not lost', () => {
  const cache = new KlineStreamCache({ limit: 10, now: () => NOW });
  cache.register('BTCUSDT', '1m');
  const token = cache.beginSeed('BTCUSDT', '1m')!;

  // The backfill was requested before T0+4min closed, so its rows stop at T0+3min. The frame for T0+4min arrives mid-flight.
  assert.equal(cache.apply(frame(T0 + 4 * MIN, true), NOW), 'buffered');
  assert.equal(cache.seed('BTCUSDT', '1m', token, [0, 1, 2, 3].map((i) => candle(T0 + i * MIN)), NOW), true);

  const served = cache.candles('BTCUSDT', '1m', NOW);
  assert.ok(served);
  assert.equal(served.at(-1)!.openTime, T0 + 4 * MIN, 'the candle that closed during the request is present');
  assert.equal(served.length, 5);
});

test('a failed backfill leaves the series pending, and nothing is served from it', () => {
  const cache = new KlineStreamCache({ limit: 5, now: () => NOW });
  cache.register('BTCUSDT', '1m');
  const token = cache.beginSeed('BTCUSDT', '1m')!;
  cache.abortSeed('BTCUSDT', '1m', token);
  assert.equal(cache.candles('BTCUSDT', '1m', NOW), null);
  assert.deepEqual(cache.pendingSeeds(), [{ symbol: 'BTCUSDT', interval: '1m' }]);
});

test('a series that is not registered is ignored, and a symbol is matched case-insensitively', () => {
  const { cache } = seededCache();
  assert.equal(cache.apply(frame(T0 + 5 * MIN, true, { symbol: 'XRPUSDT' }), NOW), 'ignored');
  assert.equal(cache.apply(frame(T0 + 5 * MIN, true, { symbol: 'btcusdt' }), NOW), 'applied');
});
