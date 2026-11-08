import { readFirstZipEntry, type FetchLike } from '../../backtesting/archiveKlines.js';
import type { MinuteInput } from '../rejection/types.js';

/**
 * Full-column 1m klines from Binance's public USD-M archive (data.binance.vision). The existing archive loader keeps only
 * the first six columns, which drops the quote and taker-buy volume that the rejection and flow features need. This loader
 * keeps the twelve-column kline layout:
 *   0 open_time, 1 open, 2 high, 3 low, 4 close, 5 volume, 6 close_time, 7 quote_volume, 8 count,
 *   9 taker_buy_volume, 10 taker_buy_quote_volume, 11 ignore
 * Fail closed: a timestamp outside the millisecond range, a non-numeric data row, or a missing file throws.
 */

const BASE = 'https://data.binance.vision/data/futures/um';
const DAY_MS = 86_400_000;
const MIN_MS = Date.UTC(2017, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);

export function parseFlowKlineCsv(text: string, symbol: string): MinuteInput[] {
  const out: MinuteInput[] = [];
  text.split('\n').forEach((raw, idx) => {
    const line = raw.trim();
    if (line === '') return;
    const cells = line.split(',');
    const openTime = Number(cells[0]);
    if (!Number.isFinite(openTime)) return; // a header row
    if (cells.length < 10) throw new Error(`line ${idx + 1}: expected at least 10 columns, got ${cells.length}`);
    if (openTime < MIN_MS || openTime > MAX_MS) {
      throw new Error(`line ${idx + 1}: open_time ${openTime} is not a millisecond timestamp; check the archive format`);
    }
    const n = (i: number): number => Number(cells[i]);
    const values = [n(1), n(2), n(3), n(4), n(5), n(7), n(8), n(9)];
    if (!values.every(Number.isFinite)) throw new Error(`line ${idx + 1}: non-numeric kline field`);
    out.push({
      symbol,
      openTime,
      open: values[0] as number,
      high: values[1] as number,
      low: values[2] as number,
      close: values[3] as number,
      baseVolume: values[4] as number,
      quoteVolume: values[5] as number,
      trades: Math.round(values[6] as number),
      takerBuyBaseVolume: values[7] as number,
    });
  });
  return out;
}

export interface ArchiveFile {
  kind: 'monthly' | 'daily';
  key: string;
  url: string;
  startMs: number;
  endMs: number;
}

const startOfUtcDay = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;
const monthKey = (t: number): string => new Date(t).toISOString().slice(0, 7);
const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * Which archive files cover [fromMs, toMs). A complete month that is published is read as one monthly file. Everything
 * else is read per day. The archive lags about a day, so the last day is unavailable and is reported, not assumed.
 */
export function planArchiveFiles(symbol: string, fromMs: number, toMs: number, nowMs: number): { files: ArchiveFile[]; unavailableDays: string[] } {
  const lastAvailableDay = startOfUtcDay(nowMs) - DAY_MS;
  const files: ArchiveFile[] = [];
  const unavailableDays: string[] = [];
  const dailyDays: number[] = [];

  const first = new Date(fromMs);
  let monthStart = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  while (monthStart < toMs) {
    const m = new Date(monthStart);
    const monthEnd = Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1);
    const fullyInWindow = monthStart >= fromMs && monthEnd <= toMs;
    const published = monthEnd - DAY_MS <= lastAvailableDay;
    if (fullyInWindow && published) {
      const key = monthKey(monthStart);
      files.push({
        kind: 'monthly',
        key,
        url: `${BASE}/monthly/klines/${symbol}/1m/${symbol}-1m-${key}.zip`,
        startMs: monthStart,
        endMs: monthEnd,
      });
    } else {
      for (let day = startOfUtcDay(Math.max(monthStart, fromMs)); day < Math.min(monthEnd, toMs); day += DAY_MS) {
        if (day > lastAvailableDay) unavailableDays.push(dayKey(day));
        else dailyDays.push(day);
      }
    }
    monthStart = monthEnd;
  }

  for (const day of dailyDays) {
    const key = dayKey(day);
    files.push({
      kind: 'daily',
      key,
      url: `${BASE}/daily/klines/${symbol}/1m/${symbol}-1m-${key}.zip`,
      startMs: day,
      endMs: day + DAY_MS,
    });
  }
  return { files, unavailableDays };
}

export interface FlowFetchResult {
  minutes: MinuteInput[];
  files: number;
  unavailableDays: string[];
}

/**
 * Downloads and parses the 1m archive for one symbol over [fromMs, toMs). Any HTTP failure, including a missing file,
 * throws. A silent gap would look like missing data to the experiment, so the caller must decide explicitly.
 */
export async function fetchFlowMinutes(
  symbol: string,
  fromMs: number,
  toMs: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  nowMs: number = Date.now(),
): Promise<FlowFetchResult> {
  const { files, unavailableDays } = planArchiveFiles(symbol, fromMs, toMs, nowMs);
  if (unavailableDays.length > 0) {
    throw new Error(`ARCHIVE_UNAVAILABLE: ${unavailableDays.length} day(s) not yet published, first ${unavailableDays[0]}; shorten the window`);
  }
  const minutes: MinuteInput[] = [];
  for (const file of files) {
    const res = await fetchImpl(file.url);
    if (!res.ok) throw new Error(`ARCHIVE_HTTP ${res.status}: ${file.url}`);
    const text = readFirstZipEntry(Buffer.from(await res.arrayBuffer()));
    for (const m of parseFlowKlineCsv(text, symbol)) {
      if (m.openTime >= fromMs && m.openTime < toMs) minutes.push(m);
    }
  }
  minutes.sort((a, b) => a.openTime - b.openTime);
  return { minutes, files: files.length, unavailableDays };
}
