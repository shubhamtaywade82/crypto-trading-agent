import { inflateRawSync } from 'node:zlib';
import type { Candle } from '../types.js';

/**
 * Klines from Binance's public data archive (data.binance.vision), for environments where the REST API is geo-blocked.
 * Monthly files cover complete months; the current month (and any month whose monthly file is not published yet) is
 * assembled from daily files. Today's candles are never available, the archive lags by about a day.
 */
const BASE = 'https://data.binance.vision/data/futures/um';
const DAY_MS = 86_400_000;
const BATCH = 6;

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Text of the first entry of a zip. Handles stored and deflated entries, which is all the archive uses. */
export function readFirstZipEntry(zip: Buffer): string {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const central = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(central) !== CENTRAL_SIGNATURE) throw new Error('corrupt zip central directory');
  const method = zip.readUInt16LE(central + 10);
  const compressedSize = zip.readUInt32LE(central + 20);
  const localOffset = zip.readUInt32LE(central + 42);
  if (zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error('corrupt zip local header');
  const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
  const body = zip.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return body.toString('utf8');
  if (method === 8) return inflateRawSync(body).toString('utf8');
  throw new Error(`unsupported zip compression method ${method}`);
}

/** Archive CSV rows (with or without a header line) to candles; malformed rows are skipped. */
export function parseKlineCsv(text: string): Candle[] {
  const out: Candle[] = [];
  for (const line of text.split('\n')) {
    const cells = line.trim().split(',');
    if (cells.length < 6) continue;
    const [openTime, open, high, low, close, volume] = cells.slice(0, 6).map(Number);
    if ([openTime, open, high, low, close, volume].some((n) => !Number.isFinite(n))) continue; // the header row lands here
    out.push({ openTime: openTime!, open: open!, high: high!, low: low!, close: close!, volume: volume! });
  }
  return out;
}


export interface CandleValidationSummary {
  intervalMs: number;
  expectedBars: number;
  actualBars: number;
  firstOpenTime: number | null;
  lastOpenTime: number | null;
}

/**
 * Strictly validate an OHLCV series for the requested open-time window [fromMs, toMs).
 *
 * This throws rather than warning: a backtest built on malformed, duplicated, missing, or
 * irregularly spaced bars must not produce a performance result.
 */
export function validateCandles(
  candles: readonly Candle[],
  intervalMs: number,
  fromMs: number,
  toMs: number,
): CandleValidationSummary {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(`Candle integrity validation requires a positive integer intervalMs; got ${intervalMs}`);
  }
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    throw new Error(`Candle integrity validation received an invalid window [${fromMs}, ${toMs})`);
  }

  // Count epoch-aligned candle opens satisfying fromMs <= openTime < toMs.
  const firstExpectedOpen = Math.ceil(fromMs / intervalMs) * intervalMs;
  const endExpectedOpen = Math.ceil(toMs / intervalMs) * intervalMs;
  const expectedBars = Math.max(0, Math.round((endExpectedOpen - firstExpectedOpen) / intervalMs));
  const issues: string[] = [];
  const addIssue = (issue: string): void => { issues.push(issue); };

  if (candles.length !== expectedBars) {
    addIssue(`expected ${expectedBars} bars for [${fromMs}, ${toMs}), received ${candles.length}`);
  }

  let previousOpenTime: number | null = null;
  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i]!;
    const label = `bar[${i}] openTime=${String(candle.openTime)}`;

    if (!Number.isSafeInteger(candle.openTime)) {
      addIssue(`${label}: openTime must be a safe integer`);
    } else {
      if (candle.openTime < fromMs || candle.openTime >= toMs) {
        addIssue(`${label}: openTime is outside requested window [${fromMs}, ${toMs})`);
      }
      if (candle.openTime % intervalMs !== 0) {
        addIssue(`${label}: openTime is not aligned to the ${intervalMs}ms interval`);
      }
      if (previousOpenTime !== null) {
        if (candle.openTime === previousOpenTime) {
          addIssue(`${label}: duplicate openTime`);
        } else if (candle.openTime < previousOpenTime) {
          addIssue(`${label}: openTime is not strictly increasing after ${previousOpenTime}`);
        } else if (candle.openTime - previousOpenTime !== intervalMs) {
          addIssue(`${label}: expected interval step ${intervalMs}ms after ${previousOpenTime}, got ${candle.openTime - previousOpenTime}ms`);
        }
      }
      const expectedOpenTime = firstExpectedOpen + i * intervalMs;
      if (candle.openTime !== expectedOpenTime) {
        addIssue(`${label}: expected openTime ${expectedOpenTime} at sequence index ${i}`);
      }
      previousOpenTime = candle.openTime;
    }

    const pricesAndVolume = [candle.open, candle.high, candle.low, candle.close, candle.volume];
    if (pricesAndVolume.some((value) => !Number.isFinite(value))) {
      addIssue(`${label}: OHLCV fields must all be finite numbers`);
      continue;
    }
    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
      addIssue(`${label}: OHLC prices must be greater than zero`);
    }
    if (candle.low > candle.high) {
      addIssue(`${label}: low exceeds high`);
    }
    if (candle.low > candle.open || candle.low > candle.close) {
      addIssue(`${label}: low exceeds open/close`);
    }
    if (candle.high < candle.open || candle.high < candle.close) {
      addIssue(`${label}: high is below open/close`);
    }
    if (candle.volume < 0) {
      addIssue(`${label}: volume must be non-negative`);
    }
  }

  if (issues.length > 0) {
    const shown = issues.slice(0, 20);
    const remaining = issues.length - shown.length;
    throw new Error([
      `Candle integrity validation failed (interval=${intervalMs}ms, expected=${expectedBars}, actual=${candles.length}).`,
      ...shown.map((issue) => `- ${issue}`),
      ...(remaining > 0 ? [`- ... and ${remaining} more issue(s)`] : []),
    ].join('\n'));
  }

  return {
    intervalMs,
    expectedBars,
    actualBars: candles.length,
    firstOpenTime: candles[0]?.openTime ?? null,
    lastOpenTime: candles[candles.length - 1]?.openTime ?? null,
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');
const dayKey = (ms: number): string => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const monthKey = (ms: number): string => dayKey(ms).slice(0, 7);
const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
const startOfNextMonth = (ms: number): number => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

async function fetchZip(url: string, fetchImpl: FetchLike): Promise<Candle[] | null> {
  const response = await fetchImpl(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return parseKlineCsv(readFirstZipEntry(Buffer.from(await response.arrayBuffer())));
}

export interface ArchiveResult {
  candles: Candle[];
  /** Days the archive had no file for (not yet published, or a gap) inside the requested window. */
  missingDays: string[];
}

/** Candles with openTime in [fromMs, toMs), oldest first, de-duplicated. */
export async function fetchArchiveKlines(
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: number = Date.now(),
): Promise<ArchiveResult> {
  const lastDay = Math.min(startOfDay(toMs - 1), startOfDay(now) - DAY_MS); // the archive has nothing for today
  const byTime = new Map<number, Candle>();
  const missingDays: string[] = [];
  const add = (candles: Candle[]): void => {
    for (const candle of candles) {
      if (candle.openTime < fromMs || candle.openTime >= toMs) continue;
      // Do not silently hide corrupted/overlapping archive rows behind Map de-duplication.
      if (byTime.has(candle.openTime)) {
        throw new Error(`duplicate archive candle openTime ${candle.openTime} (${new Date(candle.openTime).toISOString()})`);
      }
      byTime.set(candle.openTime, candle);
    }
  };

  const dailyTasks: number[] = [];
  for (let monthStart = Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), 1); monthStart <= lastDay; monthStart = startOfNextMonth(monthStart)) {
    const nextMonth = startOfNextMonth(monthStart);
    const firstDay = Math.max(startOfDay(fromMs), monthStart);
    const lastDayOfMonth = Math.min(lastDay, nextMonth - DAY_MS);
    const wholeMonth = firstDay === monthStart && lastDayOfMonth === nextMonth - DAY_MS;
    const monthly = wholeMonth ? await fetchZip(`${BASE}/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${monthKey(monthStart)}.zip`, fetchImpl) : null;
    if (monthly) { add(monthly); continue; }
    for (let day = firstDay; day <= lastDayOfMonth; day += DAY_MS) dailyTasks.push(day);
  }
  for (let i = 0; i < dailyTasks.length; i += BATCH) {
    const batch = dailyTasks.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((day) => fetchZip(`${BASE}/daily/klines/${symbol}/${interval}/${symbol}-${interval}-${dayKey(day)}.zip`, fetchImpl)));
    results.forEach((candles, index) => (candles ? add(candles) : missingDays.push(dayKey(batch[index]!))));
  }
  return { candles: [...byTime.values()].sort((a, b) => a.openTime - b.openTime), missingDays };
}
