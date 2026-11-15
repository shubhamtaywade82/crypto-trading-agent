import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readFirstZipEntry, readFirstZipEntryBytes } from './archiveKlines.js';

/**
 * Binance archive tick files (aggTrades, bookDepth) reduced to one record per UTC minute. The raw zip is held in memory,
 * reduced and discarded, so a day costs about 100 KB on disk instead of 5-20 MB. Downloads are sequential-ish and spaced out;
 * a 429/418 stops the whole run instead of retrying into a ban.
 */
const BASE = 'https://data.binance.vision/data/futures/um/daily';
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 1440;
const BACKOFF_MS = 60_000;
const MAX_ATTEMPTS = 3;
/** Fixed for every symbol so the feature means the same notional everywhere. */
export const LARGE_TRADE_QUOTE = 50_000;

export type TickDataset = 'aggTrades' | 'bookDepth';
/** [buyQuote, sellQuote, trades, largeBuyQuote, largeSellQuote]: taker-buy is the aggressor buying (is_buyer_maker = false). */
export type TradeMinute = [number, number, number, number, number];
/** [bid1, ask1, bid5, ask5]: USDT notional resting within 1% / 5% of mid on each side, last snapshot of the minute; null before the first one. */
export type DepthMinute = [number | null, number | null, number | null, number | null];

const COMMA = 44; const NEWLINE = 10; const DOT = 46; const ZERO = 48; const NINE = 57; const LETTER_F = 102;

function parseNumber(buf: Buffer, start: number, end: number): number {
  let value = 0; let decimals = -1;
  for (let i = start; i < end; i += 1) {
    const c = buf[i]!;
    if (c === DOT) { decimals = 0; continue; }
    if (c < ZERO || c > NINE) return NaN;
    value = value * 10 + (c - ZERO);
    if (decimals >= 0) decimals += 1;
  }
  return decimals > 0 ? value / 10 ** decimals : value;
}

/**
 * Reduces an aggTrades CSV for the UTC day starting at `dayStart` to 1440 minute records. Parses bytes directly: a busy day is
 * over 500 MB of text, which cannot be held as one string.
 */
export function reduceAggTrades(csv: string | Buffer, dayStart: number): TradeMinute[] {
  const buf = typeof csv === 'string' ? Buffer.from(csv) : csv;
  const minutes: TradeMinute[] = Array.from({ length: MINUTES_PER_DAY }, () => [0, 0, 0, 0, 0]);
  const comma = new Int32Array(7);
  for (let lineStart = 0; lineStart < buf.length;) {
    let lineEnd = buf.indexOf(NEWLINE, lineStart);
    if (lineEnd < 0) lineEnd = buf.length;
    let found = 0;
    for (let i = lineStart; i < lineEnd && found < 7; i += 1) if (buf[i] === COMMA) comma[found++] = i;
    if (found === 6) {
      const minute = Math.floor((parseNumber(buf, comma[4]! + 1, comma[5]!) - dayStart) / MINUTE_MS);
      const quote = parseNumber(buf, comma[0]! + 1, comma[1]!) * parseNumber(buf, comma[1]! + 1, comma[2]!);
      if (minute >= 0 && minute < MINUTES_PER_DAY && Number.isFinite(quote)) addTrade(minutes[minute]!, quote, buf[comma[5]! + 1] === LETTER_F);
    }
    lineStart = lineEnd + 1;
  }
  return minutes;
}

function addTrade(record: TradeMinute, quote: number, buyerIsAggressor: boolean): void {
  record[buyerIsAggressor ? 0 : 1] += quote;
  record[2] += 1;
  if (quote >= LARGE_TRADE_QUOTE) record[buyerIsAggressor ? 3 : 4] += quote;
}

/** Reduces a bookDepth CSV (rows: time, percentage, depth, notional) to the last snapshot seen in each minute. */
export function reduceBookDepth(csv: string, dayStart: number): DepthMinute[] {
  const minutes: DepthMinute[] = Array.from({ length: MINUTES_PER_DAY }, () => [null, null, null, null]);
  const slot: Record<string, number> = { '-1': 0, '1': 1, '-5': 2, '5': 3 };
  for (const line of csv.split('\n')) {
    const [time, percentage, , notional] = line.split(',');
    const index = slot[String(Number(percentage))];
    const minute = Math.floor((Date.parse(`${time!.replace(' ', 'T')}Z`) - dayStart) / MINUTE_MS);
    if (index === undefined || !(minute >= 0 && minute < MINUTES_PER_DAY) || !Number.isFinite(Number(notional))) continue;
    minutes[minute]![index] = Number(notional);
  }
  return minutes;
}

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const tickPath = (root: string, dataset: TickDataset, symbol: string, day: string): string => path.join(root, 'ticks', dataset, symbol, `${symbol}-${day}.json`);

/** Reduced minutes for one day, or null when the day has not been backfilled. */
export function loadTickDay<T>(root: string, dataset: TickDataset, symbol: string, day: string): T[] | null {
  const file = tickPath(root, dataset, symbol, day);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { minutes: T[] }).minutes : null;
}

class RateLimited extends Error {}

async function fetchZip(url: string): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch(() => null);
    if (response?.status === 404) return null;
    if (response?.status === 429 || response?.status === 418) throw new RateLimited(`${url}: HTTP ${response.status}`);
    const body = response?.ok ? await response.arrayBuffer().catch(() => null) : null; // a slow body can time out mid-download: retry it
    if (body) return Buffer.from(body);
    await sleep(BACKOFF_MS * attempt);
  }
  throw new Error(`${url}: failed ${MAX_ATTEMPTS} times`);
}

export interface TickBackfill { symbols: string[]; datasets: TickDataset[]; fromMs: number; toMs: number; root: string; pauseMs?: number; workers?: number }
export interface TickCounts { written: number; existing: number; missing: number }

async function fetchDay(root: string, dataset: TickDataset, symbol: string, dayStart: number, counts: TickCounts): Promise<void> {
  const day = dayKey(dayStart);
  const file = tickPath(root, dataset, symbol, day);
  if (existsSync(file)) { counts.existing += 1; return; }
  const zip = await fetchZip(`${BASE}/${dataset}/${symbol}/${symbol}-${dataset}-${day}.zip`);
  if (!zip) { counts.missing += 1; return; }
  const minutes = dataset === 'aggTrades' ? reduceAggTrades(readFirstZipEntryBytes(zip), dayStart) : reduceBookDepth(readFirstZipEntry(zip), dayStart);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ symbol, day, dataset, minutes: dataset === 'aggTrades' ? (minutes as TradeMinute[]).map((m) => m.map((x) => Math.round(x * 100) / 100)) : minutes }));
  counts.written += 1;
}

/** Fetches and reduces every missing day, `workers` at a time with `pauseMs` between files; resumable (existing days are skipped). */
export async function backfillTicks(options: TickBackfill): Promise<TickCounts> {
  const jobs: { dataset: TickDataset; symbol: string; dayStart: number }[] = [];
  for (const dataset of options.datasets) for (const symbol of options.symbols) for (let t = options.fromMs; t < options.toMs; t += DAY_MS) jobs.push({ dataset, symbol, dayStart: t });
  const counts: TickCounts = { written: 0, existing: 0, missing: 0 };
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && next < jobs.length) {
      const job = jobs[next++]!;
      try { await fetchDay(options.root, job.dataset, job.symbol, job.dayStart, counts); } catch (error) { stopped = true; throw error; }
      if (next % 25 === 0) console.log(`  ticks ${next}/${jobs.length} written ${counts.written} existing ${counts.existing} missing ${counts.missing}`);
      await sleep(options.pauseMs ?? 5_000);
    }
  };
  await Promise.all(Array.from({ length: options.workers ?? 2 }, worker));
  return counts;
}
