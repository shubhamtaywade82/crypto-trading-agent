/**
 * Research run windows and manifests.
 *
 * The caller states a length (`days`) and an optional offset (`endDaysAgo`). This module turns them into absolute UTC
 * bounds, so nobody types from/to. Every run records the bounds it used, the bar-aligned window the loader validated and
 * a sha256 of each series it read, so a result can later be checked against a fresh fetch. Raw candles are never written
 * to disk: only the manifest is.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expectedBarCount, type CandleWindow } from './candleIntegrity.js';
import type { Candle } from '../types.js';

export type WindowSource = 'api' | 'archive';

const DAY_MS = 86_400_000;

export interface ResearchWindowInput {
  /** Window length in days. */
  days: number;
  /** Shifts the whole window into the past; 0 ends the window at the anchor. */
  endDaysAgo: number;
  source: WindowSource;
  nowMs: number;
}

export interface ResearchWindow extends ResearchWindowInput {
  /** Requested bounds, before the loader aligns them to each bar grid. */
  fromMs: number;
  toMs: number;
  fromIso: string;
  toIso: string;
  /**
   * api: the anchor is now, and the loader drops the forming bar.
   * archive: the anchor is the start of yesterday (UTC). The archive has no file for today and publishes a day late, so
   * yesterday is usually missing too; the window ends where the archive is expected to be complete. If a day inside the
   * window is still missing, the integrity gate fails closed.
   */
  anchor: 'now' | 'start-of-previous-utc-day';
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function resolveResearchWindow(input: ResearchWindowInput): ResearchWindow {
  const { days, endDaysAgo, source, nowMs } = input;
  if (!Number.isFinite(days) || days <= 0) throw new Error(`days must be a positive number, got ${days}`);
  if (!Number.isFinite(endDaysAgo) || endDaysAgo < 0) throw new Error(`endDaysAgo must be >= 0, got ${endDaysAgo}`);
  if (!Number.isFinite(nowMs)) throw new Error(`nowMs must be finite, got ${nowMs}`);
  if (source !== 'api' && source !== 'archive') throw new Error(`source must be api or archive, got ${String(source)}`);
  const anchor = source === 'archive' ? 'start-of-previous-utc-day' : 'now';
  const anchorMs = anchor === 'start-of-previous-utc-day' ? startOfUtcDay(nowMs) - DAY_MS : nowMs;
  const toMs = anchorMs - endDaysAgo * DAY_MS;
  const fromMs = toMs - days * DAY_MS;
  return { days, endDaysAgo, source, nowMs, fromMs, toMs, fromIso: iso(fromMs), toIso: iso(toMs), anchor };
}

/** sha256 over the canonical CSV of each candle (openTime, open, high, low, close, volume). Any changed value changes it. */
export function fingerprintCandles(candles: readonly Candle[]): string {
  const hash = createHash('sha256');
  for (const c of candles) hash.update(`${c.openTime},${c.open},${c.high},${c.low},${c.close},${c.volume}\n`);
  return hash.digest('hex');
}

export interface SeriesRecord {
  symbol: string;
  interval: string;
  source: WindowSource;
  /** The bar-aligned window the loader validated, [fromIso, toIso). */
  fromIso: string;
  toIso: string;
  expectedBars: number;
  bars: number;
  firstOpenIso: string | null;
  lastOpenIso: string | null;
  sha256: string;
}

export function describeSeries(args: {
  symbol: string;
  interval: string;
  source: WindowSource;
  window: CandleWindow;
  candles: readonly Candle[];
}): SeriesRecord {
  const { symbol, interval, source, window, candles } = args;
  const first = candles[0];
  const last = candles[candles.length - 1];
  return {
    symbol,
    interval,
    source,
    fromIso: iso(window.fromMs),
    toIso: iso(window.toMs),
    expectedBars: expectedBarCount(window),
    bars: candles.length,
    firstOpenIso: first ? iso(first.openTime) : null,
    lastOpenIso: last ? iso(last.openTime) : null,
    sha256: fingerprintCandles(candles),
  };
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  kind: string;
  createdAtIso: string;
  codeCommit: string | null;
  /** True when the working tree had uncommitted changes, so the commit alone does not describe the code that ran. */
  codeDirty: boolean | null;
  argv: string[];
  window: ResearchWindow;
  series: SeriesRecord[];
  summary: Record<string, string | number | boolean | null>;
}

export function buildRunId(kind: string, label: string, nowMs: number): string {
  const stamp = iso(nowMs).replace(/[:.]/g, '-');
  return `${kind}_${label.replace(/[^A-Za-z0-9_-]+/g, '-')}_${stamp}`;
}

export function readCodeState(cwd: string): { commit: string | null; dirty: boolean | null } {
  try {
    const commit = execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
    const dirty = execSync('git status --porcelain', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

/** Writes `<dir>/<runId>.manifest.json` and returns its path. Only the manifest is written; raw candles are not. */
export function writeRunManifest(manifest: RunManifest, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${manifest.runId}.manifest.json`);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}
