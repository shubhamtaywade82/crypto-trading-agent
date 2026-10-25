#!/usr/bin/env node
/**
 * Offline evaluation of MICRO_RECORD JSONL data.
 *
 * Examples:
 *   npx tsx scripts/micro-eval.ts
 *   npx tsx scripts/micro-eval.ts --input data/microstructure --sample-ms 1000
 *   npx tsx scripts/micro-eval.ts --input data/microstructure --fee-bps-per-leg 4 --train-fraction 0.7
 *
 * Net return is mid-to-mid directional movement less entry-side and exit-side depth-walked slippage
 * (each measured from mid and therefore already includes spread) and two per-leg fees. Spread is
 * reported separately for diagnostics and is not subtracted a second time.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FlowWindowRecord {
  ms: number;
  complete: boolean;
  trades?: number;
  delta?: number | null;
  signedQty?: number;
  ofi?: number | null;
  priceBps?: number | null;
  phase?: string;
}

export interface MicroRecord {
  symbol: string;
  t: number;
  book: { status: string; reason?: string; ageMs?: number | null };
  mid: number | null;
  spreadBps?: number | null;
  friction?: {
    status?: string;
    spreadBps?: number | null;
    buySlipBps?: number | null;
    sellSlipBps?: number | null;
    orderNotional?: number;
    reasons?: string[];
  };
  phase?: string;
  windows?: FlowWindowRecord[];
  bias?: { bias?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ParsedJsonl {
  records: MicroRecord[];
  malformedJson: number;
  invalidRecords: number;
}

export interface BootstrapOptions {
  iterations: number;
  blockMs: number;
  seed: number;
  confidence: number;
}

export interface BootstrapResult {
  n: number;
  mean: number;
  low: number | null;
  high: number | null;
}

export interface EvalOptions {
  sampleMs: number;
  feeBpsPerLeg: number;
  trainFraction: number;
  horizonsMs: number[];
  bootstrapIterations: number;
  blockMs: number;
  seed: number;
  confidence: number;
  minN: number;
}

interface Point { t: number; value: number; }
interface BucketStats {
  points: Point[];
  spreads: number[];
  roundTripCosts: number[];
  gross: number[];
}
export interface EvaluationRow {
  split: 'TRAIN' | 'HOLDOUT';
  dimension: string;
  key: string;
  horizonMs: number;
  side: 'LONG' | 'SHORT';
  regime: 'ALL' | 'LOW' | 'MID' | 'HIGH' | 'UNKNOWN';
  n: number;
  meanNetBps: number;
  ciLowBps: number | null;
  ciHighBps: number | null;
  meanGrossBps: number;
  meanSpreadBps: number | null;
  meanRoundTripCostBps: number;
}
export interface EvaluationDiagnostics {
  records: number;
  symbols: number;
  malformedJson: number;
  invalidRecords: number;
  duplicates: number;
  gaps: number;
  missingIntervals: number;
  nonLiveRecords: number;
  labels: number;
  skipped: Record<string, number>;
  splits: Array<{ symbol: string; trainRecords: number; holdoutRecords: number; cutoff: number }>;
  volatilityCuts: Array<{ symbol: string; lowBps: number | null; highBps: number | null }>;
}
export interface EvaluationResult {
  diagnostics: EvaluationDiagnostics;
  rows: EvaluationRow[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;

export function parseJsonlContent(content: string): ParsedJsonl {
  const records: MicroRecord[] = [];
  let malformedJson = 0;
  let invalidRecords = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformedJson += 1;
      continue;
    }
    if (!value || typeof value !== 'object') { invalidRecords += 1; continue; }
    const r = value as Partial<MicroRecord>;
    if (typeof r.symbol !== 'string' || !r.symbol || !finite(r.t) ||
        !(r.mid === null || finite(r.mid)) || !r.book || typeof r.book.status !== 'string') {
      invalidRecords += 1;
      continue;
    }
    records.push(r as MicroRecord);
  }
  return { records, malformedJson, invalidRecords };
}

function lowerBound(records: readonly MicroRecord[], target: number): number {
  let lo = 0;
  let hi = records.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (records[mid].t < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function pathIsValid(records: readonly MicroRecord[], startIndex: number, endIndex: number, sampleMs: number): boolean {
  if (startIndex < 0 || endIndex >= records.length || startIndex > endIndex) return false;
  for (let i = startIndex; i <= endIndex; i += 1) {
    const r = records[i];
    if (r.book.status !== 'LIVE' || !positive(r.mid)) return false;
    if (i > startIndex && records[i].t - records[i - 1].t > sampleMs * 1.5) return false;
    if (i > startIndex && records[i].t <= records[i - 1].t) return false;
  }
  return true;
}

/** Cost-adjusted mid-to-mid return in bps. The mid-based slippage estimates already include spread. */
export function costAdjustedReturnBps(
  entry: MicroRecord,
  exit: MicroRecord,
  side: 'LONG' | 'SHORT',
  feeBpsPerLeg: number,
): number | null {
  if (!positive(entry.mid) || !positive(exit.mid)) return null;
  const entryFriction = entry.friction;
  const exitFriction = exit.friction;
  if (!entryFriction || !exitFriction) return null;
  const entrySlip = side === 'LONG' ? entryFriction.buySlipBps : entryFriction.sellSlipBps;
  const exitSlip = side === 'LONG' ? exitFriction.sellSlipBps : exitFriction.buySlipBps;
  if (!finite(entrySlip) || !finite(exitSlip) || entrySlip < 0 || exitSlip < 0) return null;
  const rawMove = ((exit.mid / entry.mid) - 1) * 10_000;
  const gross = side === 'LONG' ? rawMove : -rawMove;
  return gross - entrySlip - exitSlip - (2 * feeBpsPerLeg);
}

function roundTripCostBps(entry: MicroRecord, exit: MicroRecord, side: 'LONG' | 'SHORT', feeBpsPerLeg: number): number | null {
  if (!entry.friction || !exit.friction) return null;
  const a = side === 'LONG' ? entry.friction.buySlipBps : entry.friction.sellSlipBps;
  const b = side === 'LONG' ? exit.friction.sellSlipBps : exit.friction.buySlipBps;
  if (!finite(a) || !finite(b) || a < 0 || b < 0) return null;
  return a + b + 2 * feeBpsPerLeg;
}

/** Trailing realized volatility in bps, requiring a sufficiently complete, live, gap-free window. */
export function realizedVolatilityBps(
  records: readonly MicroRecord[],
  windowMs: number,
  sampleMs: number,
  coverage = 0.95,
): number | null {
  if (records.length < 2) return null;
  const endIndex = records.length - 1;
  const end = records[endIndex].t;
  const startTarget = end - windowMs;
  const startIndex = lowerBound(records, startTarget);
  if (startIndex >= endIndex || records[startIndex].t - startTarget > sampleMs * 1.5) return null;
  const expected = Math.floor(windowMs / sampleMs) + 1;
  if (endIndex - startIndex + 1 < Math.ceil(expected * coverage)) return null;
  if (!pathIsValid(records, startIndex, endIndex, sampleMs)) return null;
  let sumSquares = 0;
  for (let i = startIndex + 1; i <= endIndex; i += 1) {
    const a = records[i - 1].mid as number;
    const b = records[i].mid as number;
    const r = Math.log(b / a) * 10_000;
    sumSquares += r * r;
  }
  return Math.sqrt(sumSquares);
}

function rollingVolatility(records: readonly MicroRecord[], windowMs: number, sampleMs: number, coverage: number): Array<number | null> {
  const n = records.length;
  const badRowPrefix = new Array<number>(n + 1).fill(0);
  const badGapPrefix = new Array<number>(n + 1).fill(0);
  const squarePrefix = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    badRowPrefix[i + 1] = badRowPrefix[i] + (records[i].book.status !== 'LIVE' || !positive(records[i].mid) ? 1 : 0);
    badGapPrefix[i + 1] = badGapPrefix[i] + (i > 0 && (records[i].t - records[i - 1].t > sampleMs * 1.5 || records[i].t <= records[i - 1].t) ? 1 : 0);
    if (i > 0 && positive(records[i].mid) && positive(records[i - 1].mid)) {
      const r = Math.log((records[i].mid as number) / (records[i - 1].mid as number)) * 10_000;
      squarePrefix[i] = squarePrefix[i - 1] + r * r;
    } else if (i > 0) squarePrefix[i] = squarePrefix[i - 1];
  }
  const result: Array<number | null> = new Array(n).fill(null);
  const expected = Math.floor(windowMs / sampleMs) + 1;
  let start = 0;
  for (let i = 0; i < n; i += 1) {
    const target = records[i].t - windowMs;
    while (start < i && records[start].t < target) start += 1;
    if (start >= i || records[start].t - target > sampleMs * 1.5) continue;
    if (i - start + 1 < Math.ceil(expected * coverage)) continue;
    if (badRowPrefix[i + 1] - badRowPrefix[start] > 0) continue;
    if (badGapPrefix[i + 1] - badGapPrefix[start + 1] > 0) continue;
    result[i] = Math.sqrt(Math.max(0, squarePrefix[i] - squarePrefix[start]));
  }
  return result;
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function volatilityRegimes(values: Array<number | null>, splitIndex: number): { regimes: Array<'LOW' | 'MID' | 'HIGH' | 'UNKNOWN'>; low: number | null; high: number | null } {
  const train = values.slice(0, splitIndex).filter((v): v is number => v !== null && Number.isFinite(v));
  const low = quantile(train, 1 / 3);
  const high = quantile(train, 2 / 3);
  return {
    low,
    high,
    regimes: values.map((v) => v === null || low === null || high === null ? 'UNKNOWN' : v <= low ? 'LOW' : v <= high ? 'MID' : 'HIGH'),
  };
}

function ofiBucket(value: unknown): string {
  if (!finite(value)) return 'UNKNOWN';
  if (value <= -0.5) return 'STRONG_NEG';
  if (value < -0.1) return 'NEG';
  if (value <= 0.1) return 'NEUTRAL';
  if (value < 0.5) return 'POS';
  return 'STRONG_POS';
}

function formatWindow(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function featuresOf(r: MicroRecord): Array<{ dimension: string; key: string }> {
  const features: Array<{ dimension: string; key: string }> = [];
  const windows = Array.isArray(r.windows) ? r.windows : [];
  for (const w of windows) {
    if (!w.complete || !finite(w.ms)) continue;
    const name = formatWindow(w.ms);
    features.push({ dimension: 'window', key: name });
    features.push({ dimension: 'window-phase', key: `${name} ${w.phase ?? 'UNKNOWN'}` });
    features.push({ dimension: 'window-ofi', key: `${name} ${ofiBucket(w.ofi)}` });
  }
  const w30 = windows.find((w) => w.ms === 30_000);
  if (w30?.complete) features.push({ dimension: 'phase', key: r.phase ?? w30.phase ?? 'UNKNOWN' });
  const w2m = windows.find((w) => w.ms === 120_000);
  if (w2m?.complete && typeof r.bias?.bias === 'string') features.push({ dimension: 'bias', key: r.bias.bias });
  return features;
}

function lowerBoundTime(rows: readonly MicroRecord[], target: number): number {
  return lowerBound(rows, target);
}

function seedFor(base: number, text: string): number {
  let h = base >>> 0;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h || 1;
}

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

/** Time-block bootstrap: resample contiguous fixed-duration blocks to reduce 1s serial-dependence bias. */
export function bootstrapMeanCI(points: readonly Point[], options: BootstrapOptions): BootstrapResult {
  const values = [...points].sort((a, b) => a.t - b.t);
  const n = values.length;
  const mean = n ? values.reduce((sum, p) => sum + p.value, 0) / n : 0;
  if (n < 2 || options.iterations < 1 || !(options.blockMs > 0)) return { n, mean, low: null, high: null };
  const blocks = new Map<number, number[]>();
  for (const p of values) {
    const key = Math.floor(p.t / options.blockMs);
    const block = blocks.get(key) ?? [];
    block.push(p.value);
    blocks.set(key, block);
  }
  const blockValues = [...blocks.values()];
  const random = rng(options.seed);
  const means: number[] = [];
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const sample: number[] = [];
    while (sample.length < n) {
      const chosen = blockValues[Math.floor(random() * blockValues.length)];
      sample.push(...chosen);
    }
    const total = sample.slice(0, n).reduce((sum, v) => sum + v, 0);
    means.push(total / n);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - options.confidence) / 2;
  const lo = Math.floor(alpha * (means.length - 1));
  const hi = Math.ceil((1 - alpha) * (means.length - 1));
  return { n, mean, low: means[lo], high: means[hi] };
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

function recordGaps(rows: readonly MicroRecord[], sampleMs: number): { gaps: number; missingIntervals: number } {
  let gaps = 0;
  let missingIntervals = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const delta = rows[i].t - rows[i - 1].t;
    if (delta > sampleMs * 1.5) {
      gaps += 1;
      missingIntervals += Math.max(1, Math.round(delta / sampleMs) - 1);
    }
  }
  return { gaps, missingIntervals };
}

function parseInputPath(input: string): string[] {
  const found: string[] = [];
  const visit = (p: string) => {
    if (!existsSync(p)) throw new Error(`input path does not exist: ${p}`);
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p).sort()) visit(path.join(p, entry));
    } else if (p.endsWith('.jsonl')) found.push(p);
  };
  for (const p of input.split(',').map((s) => s.trim()).filter(Boolean)) visit(path.resolve(p));
  return found;
}

export function loadRecordings(input: string): { records: MicroRecord[]; malformedJson: number; invalidRecords: number; files: number } {
  const files = parseInputPath(input);
  let malformedJson = 0;
  let invalidRecords = 0;
  const records: MicroRecord[] = [];
  for (const file of files) {
    const parsed = parseJsonlContent(readFileSync(file, 'utf8'));
    records.push(...parsed.records);
    malformedJson += parsed.malformedJson;
    invalidRecords += parsed.invalidRecords;
  }
  return { records, malformedJson, invalidRecords, files: files.length };
}

function dedupeSort(records: readonly MicroRecord[]): { bySymbol: Map<string, MicroRecord[]>; duplicates: number } {
  const maps = new Map<string, Map<number, MicroRecord>>();
  let duplicates = 0;
  for (const r of records) {
    const symbol = maps.get(r.symbol) ?? new Map<number, MicroRecord>();
    if (symbol.has(r.t)) duplicates += 1;
    symbol.set(r.t, r);
    maps.set(r.symbol, symbol);
  }
  const bySymbol = new Map<string, MicroRecord[]>();
  for (const [symbol, rows] of maps) bySymbol.set(symbol, [...rows.values()].sort((a, b) => a.t - b.t));
  return { bySymbol, duplicates };
}

interface MutableStats {
  points: Point[];
  spreads: number[];
  roundTripCosts: number[];
  gross: number[];
}

export function evaluateRecordings(records: readonly MicroRecord[], options: EvalOptions): EvaluationResult {
  if (!(options.sampleMs > 0) || !(options.feeBpsPerLeg >= 0) || !(options.trainFraction > 0 && options.trainFraction < 1)) {
    throw new Error('sampleMs must be positive, feeBpsPerLeg non-negative, and trainFraction between 0 and 1');
  }
  if (!options.horizonsMs.length || options.horizonsMs.some((h) => !Number.isInteger(h) || h <= 0)) throw new Error('horizonsMs must contain positive integer milliseconds');
  const { bySymbol, duplicates } = dedupeSort(records);
  const accumulators = new Map<string, MutableStats>();
  const diagnostics: EvaluationDiagnostics = {
    records: records.length,
    symbols: bySymbol.size,
    malformedJson: 0,
    invalidRecords: 0,
    duplicates,
    gaps: 0,
    missingIntervals: 0,
    nonLiveRecords: 0,
    labels: 0,
    skipped: {},
    splits: [],
    volatilityCuts: [],
  };
  const skip = (reason: string) => { diagnostics.skipped[reason] = (diagnostics.skipped[reason] ?? 0) + 1; };
  const add = (split: 'TRAIN' | 'HOLDOUT', feature: { dimension: string; key: string }, horizonMs: number, side: 'LONG' | 'SHORT', regime: 'LOW' | 'MID' | 'HIGH' | 'UNKNOWN', entry: MicroRecord, exit: MicroRecord, netBps: number, grossBps: number, costBps: number) => {
    const dims = [
      { dimension: feature.dimension, key: feature.key, regime: 'ALL' as const },
      { dimension: feature.dimension, key: feature.key, regime },
    ];
    for (const d of dims) {
      const id = [split, d.dimension, d.key, horizonMs, side, d.regime].join('|');
      const bucket = accumulators.get(id) ?? { points: [], spreads: [], roundTripCosts: [], gross: [] };
      bucket.points.push({ t: entry.t, value: netBps });
      const spread = entry.friction?.spreadBps ?? entry.spreadBps;
      if (finite(spread) && spread >= 0) bucket.spreads.push(spread);
      bucket.roundTripCosts.push(costBps);
      bucket.gross.push(grossBps);
      accumulators.set(id, bucket);
    }
  };

  for (const [symbol, rows] of bySymbol) {
    const splitIndex = Math.max(1, Math.min(rows.length - 1, Math.floor(rows.length * options.trainFraction)));
    if (rows.length < 2) { skip('symbol-too-short'); continue; }
    const cutoff = rows[splitIndex]?.t ?? rows[rows.length - 1].t;
    diagnostics.splits.push({ symbol, trainRecords: splitIndex, holdoutRecords: rows.length - splitIndex, cutoff });
    const gaps = recordGaps(rows, options.sampleMs);
    diagnostics.gaps += gaps.gaps;
    diagnostics.missingIntervals += gaps.missingIntervals;
    diagnostics.nonLiveRecords += rows.filter((r) => r.book.status !== 'LIVE' || !positive(r.mid)).length;

    const vols = rollingVolatility(rows, 300_000, options.sampleMs, 0.8);
    const regimes = volatilityRegimes(vols, splitIndex);
    diagnostics.volatilityCuts.push({ symbol, lowBps: regimes.low, highBps: regimes.high });

    for (let i = 0; i < rows.length; i += 1) {
      const entry = rows[i];
      if (entry.book.status !== 'LIVE' || !positive(entry.mid)) { skip('entry-not-live'); continue; }
      const features = featuresOf(entry);
      if (!features.length) skip('no-complete-features');
      for (const horizonMs of options.horizonsMs) {
        const targetTime = entry.t + horizonMs;
        const exitIndex = lowerBoundTime(rows, targetTime);
        if (exitIndex >= rows.length || rows[exitIndex].t - targetTime > options.sampleMs * 1.5) { skip('no-future-label'); continue; }
        if (!pathIsValid(rows, i, exitIndex, options.sampleMs)) { skip('invalid-path-gap-or-book'); continue; }
        let split: 'TRAIN' | 'HOLDOUT';
        if (i < splitIndex && exitIndex < splitIndex) split = 'TRAIN';
        else if (i >= splitIndex && exitIndex >= splitIndex) split = 'HOLDOUT';
        else { skip('crosses-train-holdout-boundary'); continue; }

        for (const side of ['LONG', 'SHORT'] as const) {
          const net = costAdjustedReturnBps(entry, rows[exitIndex], side, options.feeBpsPerLeg);
          const cost = roundTripCostBps(entry, rows[exitIndex], side, options.feeBpsPerLeg);
          if (net === null || cost === null) { skip('cost-unavailable-or-book-too-thin'); continue; }
          const rawMove = ((rows[exitIndex].mid as number) / (entry.mid as number) - 1) * 10_000;
          const gross = side === 'LONG' ? rawMove : -rawMove;
          const regime = regimes.regimes[i];
          for (const feature of features) add(split, feature, horizonMs, side, regime, entry, rows[exitIndex], net, gross, cost);
          diagnostics.labels += 1;
        }
      }
    }
  }

  const rowsOut: EvaluationRow[] = [];
  for (const [id, s] of accumulators) {
    const [split, dimension, key, horizon, side, regime] = id.split('|');
    const ci = s.points.length >= options.minN
      ? bootstrapMeanCI(s.points, { iterations: options.bootstrapIterations, blockMs: options.blockMs, seed: seedFor(options.seed, id), confidence: options.confidence })
      : { n: s.points.length, mean: mean(s.points.map((p) => p.value)) ?? 0, low: null, high: null };
    rowsOut.push({
      split: split as 'TRAIN' | 'HOLDOUT',
      dimension,
      key,
      horizonMs: Number(horizon),
      side: side as 'LONG' | 'SHORT',
      regime: regime as EvaluationRow['regime'],
      n: s.points.length,
      meanNetBps: mean(s.points.map((p) => p.value)) ?? 0,
      ciLowBps: ci.low,
      ciHighBps: ci.high,
      meanGrossBps: mean(s.gross) ?? 0,
      meanSpreadBps: mean(s.spreads),
      meanRoundTripCostBps: mean(s.roundTripCosts) ?? 0,
    });
  }
  rowsOut.sort((a, b) =>
    a.split.localeCompare(b.split) ||
    a.dimension.localeCompare(b.dimension) ||
    a.key.localeCompare(b.key) ||
    a.horizonMs - b.horizonMs ||
    a.side.localeCompare(b.side) ||
    a.regime.localeCompare(b.regime),
  );
  return { diagnostics, rows: rowsOut };
}

function getArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function getNumber(name: string, fallback: number, min = 0): number {
  const v = Number(getArg(name, String(fallback)));
  if (!Number.isFinite(v) || v < min) throw new Error(`--${name} must be a finite number >= ${min}`);
  return v;
}
function fmt(n: number | null, digits = 2): string {
  return n === null || !Number.isFinite(n) ? 'n/a' : n.toFixed(digits);
}
function fmtTime(ms: number): string { return new Date(ms).toISOString(); }

export function runCli(): void {
  const input = getArg('input', 'data/microstructure');
  const sampleMs = getNumber('sample-ms', 1000, 1);
  const feeBpsPerLeg = getNumber('fee-bps-per-leg', 4, 0);
  const trainFraction = getNumber('train-fraction', 0.7, 0.01);
  const horizonsMs = getArg('horizons', '1000,5000,30000,60000').split(',').map((v) => Number(v.trim()));
  const iterations = getNumber('bootstrap-iterations', 2000, 0);
  const blockSeconds = getNumber('block-seconds', 30, 1);
  const minN = getNumber('min-n', 30, 2);
  const seed = getNumber('seed', 1, 0);
  const confidence = getNumber('confidence', 0.95, 0.5);
  if (trainFraction >= 1) throw new Error('--train-fraction must be less than 1');
  if (confidence >= 1) throw new Error('--confidence must be less than 1');
  const loaded = loadRecordings(input);
  if (!loaded.records.length) throw new Error(`no valid microstructure readings found in ${input} (JSONL files: ${loaded.files})`);
  const result = evaluateRecordings(loaded.records, {
    sampleMs, feeBpsPerLeg, trainFraction, horizonsMs, bootstrapIterations: iterations,
    blockMs: blockSeconds * 1000, seed, confidence, minN,
  });
  result.diagnostics.malformedJson = loaded.malformedJson;
  result.diagnostics.invalidRecords = loaded.invalidRecords;

  console.log('MICROSTRUCTURE OFFLINE EVALUATION');
  console.log(`input ${input} · files ${loaded.files} · records ${result.diagnostics.records} · symbols ${result.diagnostics.symbols}`);
  console.log(`malformed JSON ${loaded.malformedJson} · invalid records ${loaded.invalidRecords} · duplicate timestamps ${result.diagnostics.duplicates}`);
  console.log(`recording gaps ${result.diagnostics.gaps} · estimated missing samples ${result.diagnostics.missingIntervals} · non-live/invalid-book readings ${result.diagnostics.nonLiveRecords}`);
  console.log(`fee ${feeBpsPerLeg.toFixed(2)} bps/leg · horizons ${horizonsMs.map(formatWindow).join(', ')} · train ${(trainFraction * 100).toFixed(0)}% / holdout ${((1 - trainFraction) * 100).toFixed(0)}% · bootstrap ${iterations} iterations, ${blockSeconds}s blocks, ${(confidence * 100).toFixed(0)}% CI`);
  for (const s of result.diagnostics.splits) console.log(`split ${s.symbol}: train=${s.trainRecords}, holdout=${s.holdoutRecords}, cutoff=${fmtTime(s.cutoff)}`);
  for (const v of result.diagnostics.volatilityCuts) console.log(`volatility ${v.symbol}: 5m realized-vol tertiles fit on training only: LOW <= ${fmt(v.lowBps)} bps; MID <= ${fmt(v.highBps)} bps; otherwise HIGH`);
  console.log(`usable side/horizon labels ${result.diagnostics.labels}`);
  console.log('Skipped labels/readings: ' + (Object.keys(result.diagnostics.skipped).length
    ? Object.entries(result.diagnostics.skipped).map(([k, v]) => `${k}=${v}`).join(' · ')
    : 'none'));
  console.log('\nNET MID-TO-MID MOVE AFTER COSTS · positive is favorable for the listed side');
  console.log('Split  Dimension       Feature                         Horizon Side   Regime    N     Mean bp       CI bp          Gross bp  Spread bp  RT cost bp');
  const maxRows = Math.floor(getNumber('max-rows', 500, 1));
  const shown = result.rows.slice(0, maxRows);
  for (const r of shown) {
    const ci = r.ciLowBps === null || r.ciHighBps === null ? 'thin/no CI' : `[${fmt(r.ciLowBps)}, ${fmt(r.ciHighBps)}]`;
    console.log(`${r.split.padEnd(6)} ${r.dimension.padEnd(15)} ${r.key.slice(0, 30).padEnd(30)} ${formatWindow(r.horizonMs).padEnd(7)} ${r.side.padEnd(6)} ${r.regime.padEnd(8)} ${String(r.n).padStart(5)} ${fmt(r.meanNetBps).padStart(10)} ${ci.padEnd(22)} ${fmt(r.meanGrossBps).padStart(9)} ${fmt(r.meanSpreadBps).padStart(10)} ${fmt(r.meanRoundTripCostBps).padStart(10)}`);
  }
  if (result.rows.length > shown.length) console.log(`… ${result.rows.length - shown.length} rows omitted; increase --max-rows to display them all.`);
  console.log('\nInterpretation guardrails: CI is a time-block bootstrap interval for the mean, not a win probability. Feature buckets are descriptive; do not tune on HOLDOUT. Costs use entry-side and exit-side mid-based slippage plus two fees; spread is shown separately and is not double-counted.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(`micro-eval: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
