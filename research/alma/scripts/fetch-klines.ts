#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { BinanceClient } from '@nemesis-oss/binance-sdk';
import { assertValidCandles, nextOpenTime, validateCandles } from '../src/data-quality.js';
import { NATIVE_TIMEFRAMES, type Candle, type NativeTimeframe } from '../src/types.js';

const DEFAULT_TIMEFRAMES: NativeTimeframe[] = ['15m', '1h', '2h', '4h', '1d'];
const DEFAULT_DAYS: Record<NativeTimeframe, number> = {
  '1m': 180, '3m': 365, '5m': 365, '15m': 730, '30m': 1095,
  '1h': 1460, '2h': 1460, '4h': 1460, '6h': 1460, '8h': 1460, '12h': 1460,
  '1d': 1825, '3d': 1825, '1w': 1825, '1M': 2500,
};
const SDK_VERSION = '3.0.0';
const PAGE_LIMIT = 1000;

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes('--' + name);
}

function parseTimestamp(value: string, option: string): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('--' + option + ' must be an epoch-ms number or parseable date');
  return parsed;
}

function numeric(record: Record<string, unknown>, key: string, arrayIndex: number, fallback?: unknown): number {
  const fromNamed = record[key];
  const fromArray = Array.isArray(record) ? record[arrayIndex] : undefined;
  const raw = fromNamed ?? fromArray ?? fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error('Kline has invalid ' + key + ': ' + String(raw));
  return value;
}

function normalizeKline(input: unknown, timeframe: NativeTimeframe): Candle {
  if (!input || typeof input !== 'object') throw new Error('SDK returned a non-object kline');
  const row = input as Record<string, unknown>;
  const openTime = numeric(row, 'openTime', 0);
  const closeTime = numeric(row, 'closeTime', 6, nextOpenTime(openTime, timeframe) - 1);
  return {
    openTime,
    closeTime,
    open: numeric(row, 'open', 1),
    high: numeric(row, 'high', 2),
    low: numeric(row, 'low', 3),
    close: numeric(row, 'close', 4),
    volume: numeric(row, 'volume', 5),
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function fetchInterval(
  client: BinanceClient,
  symbol: string,
  timeframe: NativeTimeframe,
  startTime: number,
  endTime: number,
  now: number,
): Promise<Candle[]> {
  const output: Candle[] = [];
  let cursor = startTime;
  let page = 0;

  while (cursor <= endTime) {
    page++;
    if (page > 100_000) throw new Error('pagination safety limit exceeded for ' + timeframe);

    const result = await client.futures.market.klines(symbol, timeframe, {
      startTime: cursor,
      endTime,
      limit: PAGE_LIMIT,
    });
    if (!Array.isArray(result)) throw new Error('SDK klines result was not an array for ' + timeframe);
    if (result.length === 0) break;

    const batch = result.map((row) => normalizeKline(row, timeframe))
      .filter((bar) => bar.openTime >= cursor && bar.openTime <= endTime && bar.closeTime < now);
    output.push(...batch);

    const lastReturned = normalizeKline(result[result.length - 1], timeframe);
    const nextCursor = nextOpenTime(lastReturned.openTime, timeframe);
    if (nextCursor <= cursor) {
      throw new Error('pagination did not advance for ' + timeframe + ' at ' + cursor);
    }
    if (result.length < PAGE_LIMIT) break;
    cursor = nextCursor;
  }

  return output;
}

async function main(): Promise<void> {
  const symbol = arg('symbol', 'SOLUSDT').toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('invalid --symbol');

  const rawTimeframes = arg('timeframes', DEFAULT_TIMEFRAMES.join(','))
    .split(',').map((value) => value.trim()).filter(Boolean);
  const invalid = rawTimeframes.filter((tf) => !(NATIVE_TIMEFRAMES as readonly string[]).includes(tf));
  if (invalid.length) throw new Error('unsupported timeframe(s): ' + invalid.join(', ') + '. Supported: ' + NATIVE_TIMEFRAMES.join(', '));
  const timeframes = [...new Set(rawTimeframes)] as NativeTimeframe[];
  if (timeframes.length === 0) throw new Error('at least one timeframe is required');

  const now = Date.now();
  const endTime = parseTimestamp(arg('end', String(now)), 'end');
  const explicitStart = process.argv.includes('--start');
  const explicitDays = process.argv.includes('--days');
  const globalDays = explicitDays ? Number(arg('days', '0')) : null;
  if (globalDays !== null && (!Number.isFinite(globalDays) || globalDays <= 0)) throw new Error('--days must be > 0');
  const outRoot = resolve(arg('out', 'data/research/alma/raw'));
  const manifestRoot = resolve(arg('manifest-out', 'data/research/alma/manifests'));
  const force = hasFlag('force');

  const apiBase = arg('api-base', '').trim();
  const client = new BinanceClient(apiBase ? { apiBase } : {});
  console.log(
    'Fetching public Binance USD-M contract klines for ' + symbol + ' (SDK v' + SDK_VERSION + ')' +
    (apiBase ? ' via apiBase ' + apiBase : ''),
  );

  for (const timeframe of timeframes) {
    const startTime = explicitStart
      ? parseTimestamp(arg('start', ''), 'start')
      : endTime - (globalDays ?? DEFAULT_DAYS[timeframe]) * 86_400_000;
    if (startTime >= endTime) throw new Error('start must be before end for ' + timeframe);

    const filePath = resolve(outRoot, symbol + '-' + timeframe + '.json');
    const manifestPath = resolve(manifestRoot, symbol + '-' + timeframe + '.manifest.json');
    if (!force && (await exists(filePath) || await exists(manifestPath))) {
      throw new Error('output already exists for ' + timeframe + '; use a new output directory or pass --force');
    }

    console.log('  ' + timeframe + ': ' + new Date(startTime).toISOString() + ' -> ' + new Date(endTime).toISOString());
    const candles = await fetchInterval(client, symbol, timeframe, startTime, endTime, now);
    if (candles.length === 0) throw new Error('no closed candles returned for ' + symbol + ' ' + timeframe);

    const quality = validateCandles(candles, timeframe);
    if (!quality.valid) {
      throw new Error(
        'refusing to persist invalid ' + timeframe + ' data: ' +
        quality.issues.slice(0, 10).join('; '),
      );
    }
    assertValidCandles(candles, timeframe);

    const serialized = JSON.stringify(candles) + '\n';
    const sha256 = createHash('sha256').update(serialized).digest('hex');
    const retrievedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      symbol,
      venue: 'BINANCE_USDM_PERPETUAL',
      marketDataType: 'CONTRACT_KLINES',
      timeframe,
      sdkPackage: '@nemesis-oss/binance-sdk',
      sdkVersion: SDK_VERSION,
      retrievedAt,
      requestedStartTime: startTime,
      requestedEndTime: endTime,
      firstOpenTime: candles[0].openTime,
      lastOpenTime: candles[candles.length - 1].openTime,
      candleCount: candles.length,
      sha256,
      validation: {
        valid: quality.valid,
        issueCount: quality.issueCount,
        gapCount: quality.gapCount,
        duplicateCount: quality.duplicateCount,
      },
    };

    await mkdir(dirname(filePath), { recursive: true });
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(filePath, serialized, { flag: force ? 'w' : 'wx' });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: force ? 'w' : 'wx' });

    console.log('    ' + candles.length + ' validated closed bars; sha256=' + sha256);
  }
  console.log('Complete. No orders were submitted.');
}

main().catch((error: unknown) => {
  console.error('ALMA data fetch failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
