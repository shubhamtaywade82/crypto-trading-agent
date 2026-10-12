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
export async function fetchFuturesKlines(symbol: string, interval: string, window: CandleWindow, apiFetch: JsonFetchLike = fetch as unknown as JsonFetchLike): Promise<Candle[]> {
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
