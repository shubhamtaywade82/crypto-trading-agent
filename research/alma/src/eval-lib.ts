/**
 * eval-lib — shared, deterministic helpers for event-graduation evaluations
 * (Stage B sweep-eval, Stage C sweep-eval-stagec, and any future predeclared
 * families). Extracted verbatim from scripts/sweep-eval.ts so both stages use
 * byte-identical statistics and data plumbing.
 *
 * Everything here is pure or I/O-only; no family definitions live in this
 * module. Families and gates are declared in the scripts that use it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFirstZipEntry } from '../../../src/backtesting/archiveKlines.js';
import { validateCandles } from './data-quality.js';
import type { Candle, NativeTimeframe } from './types.js';

export const ARCHIVE_BASE = 'https://data.binance.vision/data/futures/um';
export const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Snapshot loading
// ---------------------------------------------------------------------------

export function loadSnapshot(path: string, timeframe: NativeTimeframe, symbol: string): Candle[] {
  if (!existsSync(path)) throw new Error('missing snapshot ' + path);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('snapshot ' + path + ' is not a candle array');
  const candles = parsed as Candle[];
  const report = validateCandles(candles, timeframe);
  if (!report.valid) throw new Error('snapshot ' + symbol + ' ' + timeframe + ' failed validation: ' + report.issues.slice(0, 5).join('; '));
  return candles;
}

export function manifestSha256(manifestDir: string, symbol: string, timeframe: NativeTimeframe): string | null {
  const path = resolve(manifestDir, symbol + '-' + timeframe + '.manifest.json');
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sha256?: unknown };
  return typeof parsed.sha256 === 'string' ? parsed.sha256 : null;
}

// ---------------------------------------------------------------------------
// Historical funding (actual settlements from data.binance.vision)
// ---------------------------------------------------------------------------

export interface FundingPoint { time: number; rate: number }

export function monthKeys(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  const start = new Date(fromMs);
  const end = new Date(toMs);
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; ) {
    const key = y + '-' + String(m + 1).padStart(2, '0');
    const monthStart = Date.UTC(y, m, 1);
    const nextMonth = Date.UTC(y, m + 1, 1);
    if (monthStart < toMs && nextMonth > fromMs) out.push(key);
    if (nextMonth > toMs || (y === end.getUTCFullYear() && m === end.getUTCMonth())) break;
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

/**
 * Days whose funding must come from daily zips: days NOT covered by the
 * enumerated month keys. With complete month enumeration over [from, to)
 * this is normally empty; it exists to mirror the original Stage-B plumbing.
 */
export function dayKeysNotInMonths(fromMs: number, toMs: number, months: Set<string>): string[] {
  const out: string[] = [];
  for (let t = fromMs; t < toMs; t += DAY_MS) {
    const d = new Date(t);
    const key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    if (months.has(key)) continue;
    out.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'));
  }
  return out;
}

export function parseFundingCsv(text: string): FundingPoint[] {
  const out: FundingPoint[] = [];
  for (const line of text.split('\n')) {
    const cells = line.trim().split(',').map(Number);
    if (cells.length < 2) continue;
    const time = cells[0];
    const rate = cells[cells.length - 1];
    if (!Number.isFinite(time) || !Number.isFinite(rate)) continue; // header row
    out.push({ time: time < 1e12 ? time * 1000 : time, rate });
  }
  return out;
}

export async function fetchZipText(url: string): Promise<string | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('archive fetch failed HTTP ' + res.status + ' for ' + url);
  const zip = Buffer.from(new Uint8Array(await res.arrayBuffer()));
  return readFirstZipEntry(zip);
}

export async function loadFundingHistory(symbol: string, fromMs: number, toMs: number): Promise<{ points: FundingPoint[]; missingFiles: string[] }> {
  const points: FundingPoint[] = [];
  const missingFiles: string[] = [];
  const months = monthKeys(fromMs, toMs);
  for (const key of months) {
    const url = ARCHIVE_BASE + '/monthly/fundingRate/' + symbol + '/' + symbol + '-fundingRate-' + key + '.zip';
    const text = await fetchZipText(url);
    if (text === null) { missingFiles.push(key); continue; }
    points.push(...parseFundingCsv(text));
  }
  for (const key of dayKeysNotInMonths(fromMs, toMs, new Set(months))) {
    const url = ARCHIVE_BASE + '/daily/fundingRate/' + symbol + '/' + symbol + '-fundingRate-' + key + '.zip';
    const text = await fetchZipText(url);
    if (text === null) { missingFiles.push(key); continue; }
    points.push(...parseFundingCsv(text));
  }
  points.sort((a, b) => a.time - b.time);
  const deduped: FundingPoint[] = [];
  for (const point of points) {
    if (deduped.length > 0 && deduped[deduped.length - 1].time === point.time) continue;
    deduped.push(point);
  }
  return { points: deduped, missingFiles };
}

/** Settlement rates strictly inside the holding window (entryOpenTime, exitCloseTime]. */
export function fundingSumBetween(points: readonly FundingPoint[], fromTime: number, toTime: number): number[] {
  const rates: number[] = [];
  for (const point of points) {
    if (point.time > fromTime && point.time <= toTime) rates.push(point.rate);
  }
  return rates;
}

// ---------------------------------------------------------------------------
// Statistics (deterministic, seeded)
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded sign-flip permutation p-value (one-sided, mean > 0) for the mean of
 * a trade series. Floor is 1 / (1 + iterations).
 */
export function permutationP(netR: readonly number[], seed: number, iterations: number): number {
  if (netR.length === 0) return 1;
  const observed = netR.reduce((s, r) => s + r, 0) / netR.length;
  const rand = mulberry32(seed);
  let exceed = 0;
  const signs = netR.map(() => 1);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < netR.length; i++) {
      signs[i] = rand() < 0.5 ? 1 : -1;
    }
    let sum = 0;
    for (let i = 0; i < netR.length; i++) sum += signs[i] * netR[i];
    if (sum / netR.length >= observed) exceed++;
  }
  return (1 + exceed) / (1 + iterations);
}

/** Holm step-down family-wise rejection at `alpha` over ordered p-values. */
export function holmRejects(pValues: readonly number[], alpha = 0.05): boolean[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const rejected = new Array<boolean>(pValues.length).fill(false);
  let active = pValues.length;
  for (const { p, i } of order) {
    if (p <= alpha / active) { rejected[i] = true; active--; } else break;
  }
  return rejected;
}

export interface SummarizedR {
  mean: number | null;
  median: number | null;
  win: number | null;
  pf: number | null;
  maxDD: number | null;
}

export function summarizeR(netR: readonly number[]): SummarizedR {
  if (netR.length === 0) return { mean: null, median: null, win: null, pf: null, maxDD: null };
  const sorted = [...netR].sort((a, b) => a - b);
  const mean = netR.reduce((s, r) => s + r, 0) / netR.length;
  const wins = netR.filter((r) => r > 0);
  const losses = netR.filter((r) => r < 0);
  const grossWin = wins.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));
  let cum = 0; let peak = 0; let maxDD = 0;
  for (const r of netR) { cum += r; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }
  return {
    mean,
    median: sorted[Math.floor(0.5 * (sorted.length - 1))],
    win: wins.length / netR.length,
    pf: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDD,
  };
}

// ---------------------------------------------------------------------------
// Predeclared gates (Stage C)
// ---------------------------------------------------------------------------

export interface StageCGateInput {
  n: number;
  holmSignificant: boolean;
  netMeanR: number | null;
  foldMeanR: readonly (number | null)[];
}

export interface ConfirmationGateInput {
  n: number;
  netMeanR: number | null;
  permutationP: number | null;
}

export interface GateVerdict { pass: boolean; failures: string[] }

/**
 * TRAIN gate: the config must earn promotion out of the training window on
 * all four legs — enough fills, family-wise significance, positive net
 * expectancy, and chronological consistency (at least `minPositiveFolds` of
 * the folds strictly positive).
 */
export function evalStageCGate(
  input: StageCGateInput,
  options: { minFills: number; minPositiveFolds: number },
): GateVerdict {
  const failures: string[] = [];
  if (input.n < options.minFills) failures.push('fills ' + input.n + ' < ' + options.minFills);
  if (!input.holmSignificant) failures.push('not Holm-significant');
  if (input.netMeanR === null || !(input.netMeanR > 0)) failures.push('net E[R] not > 0');
  const positive = input.foldMeanR.filter((f) => f !== null && f > 0).length;
  if (positive < options.minPositiveFolds) {
    failures.push('positive folds ' + positive + '/' + input.foldMeanR.length + ' < ' + options.minPositiveFolds);
  }
  return { pass: failures.length === 0, failures };
}

/**
 * CONFIRMATION gate (untouched test / replication windows): positive net
 * expectancy with an individually significant permutation p. If more than one
 * train survivor is confirmed, callers must re-Holm across survivors.
 */
export function evalConfirmationGate(
  input: ConfirmationGateInput,
  options: { minFills: number; alpha: number },
): GateVerdict {
  const failures: string[] = [];
  if (input.n < options.minFills) failures.push('fills ' + input.n + ' < ' + options.minFills);
  if (input.netMeanR === null || !(input.netMeanR > 0)) failures.push('net E[R] not > 0');
  if (input.permutationP === null || !(input.permutationP < options.alpha)) {
    failures.push('permutation p ' + (input.permutationP === null ? 'n/a' : input.permutationP.toFixed(4)) + ' not < ' + options.alpha);
  }
  return { pass: failures.length === 0, failures };
}
