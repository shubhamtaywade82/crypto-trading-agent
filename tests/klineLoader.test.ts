import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CandleIntegrityError } from '../src/backtesting/candleIntegrity.js';
import type { FetchLike } from '../src/backtesting/archiveKlines.js';
import { fetchFuturesKlines, intervalToMs, loadValidatedKlines, rateLimitedFetch, type JsonFetchLike } from '../src/backtesting/klineLoader.js';

const MIN = 60_000;
const M15 = 15 * MIN;
const T0 = Date.UTC(2026, 9, 1);

/** Raw /fapi/v1/klines row, prices as strings the way Binance sends them. open = close - 1, high = close + 1, low = close - 2. */
const row = (openTime: number, close = 100): unknown[] => [openTime, String(close - 1), String(close + 1), String(close - 2), String(close), '10', openTime + M15 - 1, '0', 1, '0', '0', '0'];

/** Serves rows the way the endpoint does: openTime in [startTime, endTime], at most `limit`. honorEndTime=false simulates a server that ignores endTime. */
function fapi(rows: unknown[][], options: { honorEndTime?: boolean; log?: string[] } = {}): JsonFetchLike {
  const honorEndTime = options.honorEndTime ?? true;
  return async (url) => {
    options.log?.push(url);
    const params = new URL(url).searchParams;
    const start = Number(params.get('startTime'));
    const end = honorEndTime ? Number(params.get('endTime')) : Number.POSITIVE_INFINITY;
    const limit = Number(params.get('limit'));
    const page = rows.filter((r) => Number((r as unknown[])[0]) >= start && Number((r as unknown[])[0]) <= end).slice(0, limit);
    return { ok: true, status: 200, json: async () => page };
  };
}

test('intervalToMs maps Binance interval strings and rejects anything else', () => {
  assert.equal(intervalToMs('15m'), 900_000);
  assert.equal(intervalToMs('1h'), 3_600_000);
  assert.equal(intervalToMs('4h'), 14_400_000);
  assert.equal(intervalToMs('1d'), 86_400_000);
  assert.throws(() => intervalToMs('90s'), /unsupported kline interval "90s"/);
  assert.throws(() => intervalToMs('1w'), /unsupported kline interval/);
});

test('pages the futures API and returns a complete, gated series', async () => {
  const rows = Array.from({ length: 1600 }, (_, i) => row(T0 + i * M15));
  const log: string[] = [];
  const { candles, window, missingDays } = await loadValidatedKlines({
    symbol: 'SOLUSDT', interval: '15m', fromMs: T0, toMs: T0 + 1600 * M15, source: 'api', apiFetch: fapi(rows, { log }),
  });
  assert.equal(candles.length, 1600);
  assert.equal(candles[0]!.openTime, T0);
  assert.equal(candles[1599]!.openTime, T0 + 1599 * M15);
  assert.equal(log.length, 2); // one full page of 1500, then the remainder
  assert.equal(new URL(log[0]!).searchParams.get('endTime'), String(T0 + 1600 * M15 - 1));
  assert.deepEqual(window, { intervalMs: M15, fromMs: T0, toMs: T0 + 1600 * M15 });
  assert.deepEqual(missingDays, []);
});

test('aligns a ragged window and excludes the bar still forming at its end', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(T0 + i * M15)); // T0 .. T0 + 5 * M15
  // [T0 + 7 min, T0 + 63 min) aligns to [T0 + 15 min, T0 + 60 min): bars at +15, +30, +45
  const { candles, window } = await loadValidatedKlines({
    symbol: 'SOLUSDT', interval: '15m', fromMs: T0 + 7 * MIN, toMs: T0 + 4 * M15 + 3 * MIN, source: 'api', apiFetch: fapi(rows, { honorEndTime: false }),
  });
  assert.deepEqual(candles.map((c) => c.openTime), [T0 + M15, T0 + 2 * M15, T0 + 3 * M15]);
  assert.equal(window.toMs, T0 + 4 * M15);
});

test('fails hard when the API series has a gap', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(T0 + i * M15)).filter((_, i) => i < 10 || i > 12); // drops bars 10, 11, 12
  await assert.rejects(
    loadValidatedKlines({ symbol: 'SOLUSDT', interval: '15m', fromMs: T0, toMs: T0 + 20 * M15, source: 'api', apiFetch: fapi(rows) }),
    (err: unknown) => {
      assert.ok(err instanceof CandleIntegrityError);
      assert.ok(err.violations.some((v) => v.kind === 'gap' && /3 missing bar\(s\)/.test(v.detail)));
      return true;
    },
  );
});

test('fails hard on an impossible OHLC bar from the feed', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(T0 + i * M15));
  const broken = row(T0 + 3 * M15) as string[];
  broken[2] = '99'; // high
  broken[3] = '101'; // low, so high < low
  rows[3] = broken;
  await assert.rejects(
    loadValidatedKlines({ symbol: 'SOLUSDT', interval: '15m', fromMs: T0, toMs: T0 + 10 * M15, source: 'api', apiFetch: fapi(rows) }),
    (err: unknown) => err instanceof CandleIntegrityError && err.violations.some((v) => v.kind === 'ohlc' && v.index === 3),
  );
});

test('surfaces HTTP errors, error bodies and malformed rows instead of returning partial data', async () => {
  const window = { fromMs: T0, toMs: T0 + 10 * M15 };
  const blocked: JsonFetchLike = async () => ({ ok: false, status: 451, json: async () => ({}) });
  await assert.rejects(fetchFuturesKlines('SOLUSDT', '15m', { intervalMs: M15, ...window }, blocked), /klines 15m failed: HTTP 451/);

  const apiError: JsonFetchLike = async () => ({ ok: true, status: 200, json: async () => ({ code: -1121, msg: 'Invalid symbol.' }) });
  await assert.rejects(fetchFuturesKlines('SOLUSDT', '15m', { intervalMs: M15, ...window }, apiError), /unexpected response shape/);

  const junkRow: JsonFetchLike = async () => ({ ok: true, status: 200, json: async () => [null] });
  await assert.rejects(fetchFuturesKlines('SOLUSDT', '15m', { intervalMs: M15, ...window }, junkRow), /malformed kline row null/);
});

test('refuses a response that does not advance the pagination cursor', async () => {
  const page = Array.from({ length: 1500 }, (_, i) => row(T0 + i * M15));
  const stuck: JsonFetchLike = async () => ({ ok: true, status: 200, json: async () => page }); // ignores startTime
  await assert.rejects(
    fetchFuturesKlines('SOLUSDT', '15m', { intervalMs: M15, fromMs: T0, toMs: T0 + 3000 * M15 }, stuck),
    /pagination did not advance/,
  );
});

test('archive window that reaches the publication lag fails with the lag hint and the missing days', async () => {
  const nothing: FetchLike = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(
    loadValidatedKlines({ symbol: 'SOLUSDT', interval: '15m', fromMs: Date.UTC(2025, 0, 1), toMs: Date.UTC(2025, 0, 3), source: 'archive', archiveFetch: nothing }),
    (err: unknown) => {
      assert.ok(err instanceof CandleIntegrityError);
      assert.match(err.message, /hint: no file for 2025-01-01, 2025-01-02; the archive lags/);
      return true;
    },
  );
});

/** Answers with the given statuses in order, each with its headers; records the waits the limiter asked for. */
function binanceReplies(replies: Array<{ status: number; headers?: Record<string, string> }>) {
  const waits: number[] = [];
  let calls = 0;
  const fetchImpl = async () => {
    const reply = replies[Math.min(calls, replies.length - 1)]!;
    calls += 1;
    return { ok: reply.status === 200, status: reply.status, headers: { get: (name: string) => reply.headers?.[name] ?? null }, json: async () => [] };
  };
  const limited = rateLimitedFetch(fetchImpl, () => undefined, async (ms) => { waits.push(ms); });
  return { limited, waits, calls: () => calls };
}

test('rateLimitedFetch waits Retry-After on HTTP 429, then retries', async () => {
  const { limited, waits, calls } = binanceReplies([{ status: 429, headers: { 'retry-after': '7' } }, { status: 200 }]);
  assert.equal((await limited('u')).status, 200);
  assert.deepEqual(waits, [7000]);
  assert.equal(calls(), 2);
});

test('rateLimitedFetch gives up after five 429s and never retries an HTTP 418 ban', async () => {
  const always429 = binanceReplies([{ status: 429 }]);
  assert.equal((await always429.limited('u')).status, 429);
  assert.equal(always429.calls(), 6);
  assert.deepEqual(always429.waits, [60_000, 60_000, 60_000, 60_000, 60_000]);
  const banned = binanceReplies([{ status: 418, headers: { 'retry-after': '600' } }]);
  assert.equal((await banned.limited('u')).status, 418);
  assert.equal(banned.calls(), 1);
  assert.deepEqual(banned.waits, []);
});

test('rateLimitedFetch pauses until the next minute when the used weight nears the limit', async () => {
  const busy = binanceReplies([{ status: 200, headers: { 'x-mbx-used-weight-1m': '2390' } }]);
  await busy.limited('u');
  assert.equal(busy.waits.length, 1);
  assert.ok(busy.waits[0]! > 0 && busy.waits[0]! <= 60_000);
  const quiet = binanceReplies([{ status: 200, headers: { 'x-mbx-used-weight-1m': '400' } }]);
  await quiet.limited('u');
  assert.deepEqual(quiet.waits, []);
});
