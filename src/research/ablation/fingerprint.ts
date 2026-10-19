import { createHash } from 'node:crypto';
import type { Candle } from '../../types.js';
import type { DatasetFrameFingerprint } from './types.js';

/**
 * Reproducibility hashes. A study is only interpretable if the exact config and the exact candle series can be pinned:
 * the manifest stores a canonical-JSON sha256 of the config and a per-frame content hash of the dataset, so two runs
 * are comparable iff their study ids match.
 */

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Canonical JSON: object keys sorted, undefined dropped, arrays in order. Same value, same hash, any key order. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const hashOfConfig = (config: unknown): string => sha256(canonicalJson(config));

/** Content fingerprint of one candle series: counts, bounds and a sha256 over every bar's OHLCV line. */
export function fingerprintCandles(frame: string, candles: readonly Candle[]): DatasetFrameFingerprint {
  const hash = createHash('sha256');
  for (const c of candles) hash.update(`${c.openTime}|${c.open}|${c.high}|${c.low}|${c.close}|${c.volume}\n`);
  return {
    frame,
    bars: candles.length,
    firstOpenTime: candles.length > 0 ? candles[0].openTime : Number.NaN,
    lastOpenTime: candles.length > 0 ? candles[candles.length - 1].openTime : Number.NaN,
    sha256: hash.digest('hex'),
  };
}
