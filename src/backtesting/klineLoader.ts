import { fetchArchiveKlines, type FetchLike } from './archiveKlines.js';
import { alignWindow, assertCandleIntegrity, type CandleWindow } from './candleIntegrity.js';
import type { Candle } from '../types.js';

/**
 * The only path from Binance klines to a backtest or sweep. The window is aligned to the bar grid, fetched, then gated by
 * assertCandleIntegrity: callers receive complete, contiguous, in-window candles or an exception, never a partial series.
 */

export type KlineSource = 'api' | 'archive';

/** The JSON REST call used for /fapi/v1/klines; injectable so tests can serve fixtures. */
export type JsonFetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

type HeaderFetch = (url: string) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

/**
 * Binance USDⓈ-M allows 2400 request weight a minute per IP and a 1500-row klines page costs 10, so one multi-year 15m pull
 * can exceed it. Repeated 429s escalate to an HTTP 418 IP ban, so the loader backs off instead of retrying blindly.
 * The budget is shared with any live trading process on the same IP (measured ~400-500 weight a minute here), so offline
 * pulls yield at half the cap and never starve live order and stop traffic.
 */
const WEIGHT_PAUSE_ABOVE = 1200;
const MAX_429_RETRIES = 5;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MINUTE_MS = 60_000;

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with Binance's rate-limit rules: when the used weight nears the limit, pause until the next minute; on HTTP 429 wait
 * Retry-After and retry (up to 5 times). HTTP 418 (banned) is returned as is, never retried.
 */
export function rateLimitedFetch(fetchImpl: HeaderFetch, onWait: (ms: number, reason: string) => void = () => undefined, sleep = sleepMs): JsonFetchLike {
  return async (url) => {
    for (let retry = 0; ; retry += 1) {
      const response = await fetchImpl(url);
      if (response.status !== 429) {
        const usedWeight = Number(response.headers.get('x-mbx-used-weight-1m'));
        if (usedWeight > WEIGHT_PAUSE_ABOVE) {
          const waitMs = MINUTE_MS - (Date.now() % MINUTE_MS);
          onWait(waitMs, `used weight ${usedWeight}/2400 this minute`);
          await sleep(waitMs);
        }
        return response;
      }
      if (retry >= MAX_429_RETRIES) return response;
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      const waitMs = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : DEFAULT_RETRY_AFTER_MS;
      onWait(waitMs, `HTTP 429, retry ${retry + 1}/${MAX_429_RETRIES}`);
      await sleep(waitMs);
    }
  };
}

const FAPI_BASE = 'https://fapi.binance.com';
/** Maximum rows per /fapi/v1/klines response. */
const FAPI_PAGE_LIMIT = 1500;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** '15m' -> 900000. Only the Binance unit suffixes m, h and d are accepted. */
export function intervalToMs(interval: string): number {
  const match = /^(\d+)([mhd])$/.exec(interval);
  if (!match) throw new Error(`unsupported kline interval "${interval}"`);
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}

export interface LoadKlinesOptions {
  symbol: string;
  /** Binance kline interval: '15m', '1h', '4h', ... */
  interval: string;
  fromMs: number;
  toMs: number;
  source: KlineSource;
  /** Test seams. Default to the global fetch. */
  apiFetch?: JsonFetchLike;
  archiveFetch?: FetchLike;
}

export interface LoadedKlines {
  candles: Candle[];
  window: CandleWindow;
  /** Archive days with no published file inside the window. Always empty for the api source. */
  missingDays: string[];
}

/**
 * Paginated /fapi/v1/klines over the window. endTime excludes the bar that is still forming at toMs, and the final filter
 * drops any row outside [fromMs, toMs) that a misbehaving response might include.
 */
export async function fetchFuturesKlines(symbol: string, interval: string, window: CandleWindow, apiFetch: JsonFetchLike = rateLimitedFetch(fetch as unknown as HeaderFetch)): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = window.fromMs;
  for (;;) {
    // endTime is inclusive on openTime, so toMs - 1 keeps the bar opening at toMs (still forming) out of the page
    const url = `${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${window.toMs - 1}&limit=${FAPI_PAGE_LIMIT}`;
    const response = await apiFetch(url);
    if (!response.ok) throw new Error(`klines ${interval} failed: HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error(`klines ${interval}: unexpected response shape`);
    const rows = body as unknown[];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) throw new Error(`klines ${interval}: malformed kline row ${JSON.stringify(row)}`);
      out.push({ openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) });
    }
    if (rows.length < FAPI_PAGE_LIMIT) break;
    const next = Number((rows[rows.length - 1] as unknown[])[0]) + window.intervalMs;
    if (next <= cursor) throw new Error(`klines ${interval}: pagination did not advance past ${cursor}`);
    cursor = next;
  }
  return out.filter((c) => c.openTime >= window.fromMs && c.openTime < window.toMs);
}

/** Fetches, aligns and gates one series. Throws CandleIntegrityError on any violation, including a window with missing bars. */
export async function loadValidatedKlines(options: LoadKlinesOptions): Promise<LoadedKlines> {
  const window = alignWindow(options.fromMs, options.toMs, intervalToMs(options.interval));
  const label = `${options.symbol} ${options.interval} (${options.source})`;
  if (options.source === 'archive') {
    const archive = await fetchArchiveKlines(options.symbol, options.interval, window.fromMs, window.toMs, options.archiveFetch);
    const noFile = archive.missingDays.length > 0 ? `no file for ${archive.missingDays.join(', ')}; ` : '';
    const hint = `${noFile}the archive lags by about a day and has nothing for today, so end the window at least one day ago (--end-days-ago)`;
    assertCandleIntegrity(archive.candles, window, label, hint);
    return { candles: archive.candles, window, missingDays: archive.missingDays };
  }
  const candles = await fetchFuturesKlines(options.symbol, options.interval, window, options.apiFetch);
  assertCandleIntegrity(candles, window, label);
  return { candles, window, missingDays: [] };
}
