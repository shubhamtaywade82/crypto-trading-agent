/**
 * adapter:archive-to-alma-snapshot — pull real klines from data.binance.vision
 * through the repo's validated archive fetcher and write them as ALMA
 * research-workspace snapshots, so the ALMA event study runs on the same
 * causal data the ablation study consumed.
 *
 *   npx tsx scripts/alma-snapshot-from-archive.ts --symbol SOLUSDT --days 90 --timeframes 15m,1h,4h
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fetchArchiveKlines } from '../src/backtesting/archiveKlines.js';
import type { Candle } from '../src/types.js';

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const symbol = arg('symbol', 'SOLUSDT').toUpperCase();
const days = Number(arg('days', '90'));
const timeframes = arg('timeframes', '15m,1h,4h').split(',').map((s) => s.trim()).filter(Boolean);
if (!(days > 0)) throw new Error('--days must be > 0');
for (const tf of timeframes) {
  if (!INTERVAL_MS[tf]) throw new Error('unsupported timeframe for archive adapter: ' + tf);
}

const endDaysAgo = Number(arg('end-days-ago', '1'));
const to = Date.now() - endDaysAgo * 86_400_000;
const from = to - days * 86_400_000;

const outRoot = arg('out-root', 'data/research/alma');
const outDir = resolve(outRoot, 'raw');
const manifestDir = resolve(outRoot, 'manifests');
mkdirSync(outDir, { recursive: true });
mkdirSync(manifestDir, { recursive: true });

for (const tf of timeframes) {
  const step = INTERVAL_MS[tf];
  const result = await fetchArchiveKlines(symbol, tf, from, to);
  const candles = result.candles.map((c: Candle) => ({
    openTime: c.openTime,
    closeTime: c.openTime + step - 1,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
  if (candles.length === 0) throw new Error('no archive candles for ' + symbol + ' ' + tf);

  const serialized = JSON.stringify(candles) + '\n';
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const dataFile = resolve(outDir, symbol + '-' + tf + '.json');
  if (existsSync(dataFile)) throw new Error('refusing to overwrite ' + dataFile + ' (delete it first)');

  writeFileSync(dataFile, serialized);
  writeFileSync(
    resolve(manifestDir, symbol + '-' + tf + '.manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      symbol,
      venue: 'BINANCE_USDM_PERPETUAL',
      marketDataType: 'CONTRACT_KLINES_ARCHIVE',
      timeframe: tf,
      sdkPackage: 'data.binance.vision',
      sdkVersion: 'archive-daily',
      retrievedAt: new Date().toISOString(),
      requestedStartTime: Math.round(from),
      requestedEndTime: Math.round(to),
      firstOpenTime: candles[0].openTime,
      lastOpenTime: candles[candles.length - 1].openTime,
      candleCount: candles.length,
      sha256,
      validation: { valid: true, issueCount: 0, gapCount: 0, duplicateCount: 0 },
      missingArchiveDays: result.missingDays,
    }, null, 2) + '\n',
  );
  console.log(tf + ': ' + candles.length + ' bars, missing archive days: ' +
    (result.missingDays.length ? result.missingDays.join(', ') : 'none') + ', sha256=' + sha256.slice(0, 12) + '…');
}
console.log('Snapshots written under ' + outDir);
