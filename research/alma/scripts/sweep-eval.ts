#!/usr/bin/env node
/**
 * sweep-eval — Stage-B cost-adjusted evaluation of the predeclared
 * sweep-and-reclaim trade family (graduation from the descriptive sweep study).
 *
 * Predeclared family (frozen before this run; do not extend after seeing results):
 *   timeframes: 4h, 1h          sides: short, long
 *   stop buffer: 0.25 / 0.50 ATR(14) beyond the sweep-episode extreme
 *   exits: time6 (close of event+6) | stop-or-2R (48-bar time stop)
 *        | stop-or-1.5R (48-bar time stop)
 *   entry: next bar open after the reclaim close; same-bar reclaim variant only
 *   costs: taker 4 bps + slippage 2 bps per side (round trip = 12 bps of notional)
 *   funding: ACTUAL historical settlements from data.binance.vision
 *   intrabar: stop fills before target; open gaps through the stop fill at the open
 *
 * Statistics: per-config net E[R] with a seeded sign-flip permutation p-value
 * (one-sided, mean > 0), Holm step-down across the whole family, and E[R] per
 * chronological quarter (4 folds) as the continuity check.
 *
 * Usage:
 *   npx tsx research/alma/scripts/sweep-eval.ts --symbol SOLUSDT \
 *     --timeframes 4h,1h --raw-dir data/research/alma/raw
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFirstZipEntry } from '../../../src/backtesting/archiveKlines.js';
import { validateCandles } from '../src/data-quality.js';
import { atrWilder } from '../src/atr.js';
import type { Direction } from '../src/events.js';
import { detectSweepReclaim } from '../src/sweeps.js';
import { costsInR, fundingInR, simulateTrade } from '../src/trade-sim.js';
import { NATIVE_TIMEFRAMES, type Candle, type NativeTimeframe } from '../src/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ARCHIVE_BASE = 'https://data.binance.vision/data/futures/um';
const DAY_MS = 86_400_000;

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function num(name: string, fallback: number, min: number): number {
  const raw = arg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new Error('--' + name + ' must be >= ' + min);
  return value;
}

function loadSnapshot(path: string, timeframe: NativeTimeframe, symbol: string): Candle[] {
  if (!existsSync(path)) throw new Error('missing snapshot ' + path);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('snapshot ' + path + ' is not a candle array');
  const candles = parsed as Candle[];
  const report = validateCandles(candles, timeframe);
  if (!report.valid) throw new Error('snapshot ' + symbol + ' ' + timeframe + ' failed validation: ' + report.issues.slice(0, 5).join('; '));
  return candles;
}

function manifestSha256(manifestDir: string, symbol: string, timeframe: NativeTimeframe): string | null {
  const path = resolve(manifestDir, symbol + '-' + timeframe + '.manifest.json');
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sha256?: unknown };
  return typeof parsed.sha256 === 'string' ? parsed.sha256 : null;
}

interface FundingPoint { time: number; rate: number }

function monthKeys(fromMs: number, toMs: number): string[] {
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

function dayKeysNotInMonths(fromMs: number, toMs: number, months: Set<string>): string[] {
  const out: string[] = [];
  for (let t = fromMs; t < toMs; t += DAY_MS) {
    const d = new Date(t);
    const key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    if (months.has(key)) continue;
    out.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'));
  }
  return out;
}

function parseFundingCsv(text: string): FundingPoint[] {
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

async function fetchZipText(url: string): Promise<string | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('archive fetch failed HTTP ' + res.status + ' for ' + url);
  const zip = Buffer.from(new Uint8Array(await res.arrayBuffer()));
  return readFirstZipEntry(zip);
}

async function loadFundingHistory(symbol: string, fromMs: number, toMs: number): Promise<{ points: FundingPoint[]; missingFiles: string[] }> {
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

function fundingSumBetween(points: readonly FundingPoint[], fromTime: number, toTime: number): number[] {
  const rates: number[] = [];
  for (const point of points) {
    if (point.time > fromTime && point.time <= toTime) rates.push(point.rate);
  }
  return rates;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutationP(netR: readonly number[], seed: number, iterations: number): number {
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

function holmRejects(pValues: readonly number[], alpha = 0.05): boolean[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const rejected = new Array<boolean>(pValues.length).fill(false);
  let active = pValues.length;
  for (const { p, i } of order) {
    if (p <= alpha / active) { rejected[i] = true; active--; } else break;
  }
  return rejected;
}

interface ConfigRow {
  timeframe: NativeTimeframe;
  side: 'short' | 'long';
  bufferAtr: number;
  exit: string;
  n: number;
  excluded: number;
  netMeanR: number | null;
  netMedianR: number | null;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  foldMeanR: (number | null)[];
  grossMeanR: number | null;
  costsMeanR: number | null;
  fundingMeanR: number | null;
  permutationP: number;
  holmSignificant: boolean;
}

function summarize(netR: readonly number[]): { mean: number | null; median: number | null; win: number | null; pf: number | null; maxDD: number | null } {
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

const FOLDS = 4;

async function main(): Promise<void> {
  const symbol = arg('symbol', 'SOLUSDT').toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('invalid --symbol');
  const rawDir = resolve(arg('raw-dir', resolve(REPO_ROOT, 'data', 'research', 'alma', 'raw')));
  const manifestDir = resolve(arg('manifest-dir', rawDir.replace(/raw$/, 'manifests')));
  const outPath = resolve(arg('out', resolve(REPO_ROOT, 'data', 'research', 'alma', 'events', 'sweep-eval.json')));
  const timeframes = arg('timeframes', '4h,1h').split(',').map((s) => s.trim()) as NativeTimeframe[];
  for (const tf of timeframes) {
    if (!(NATIVE_TIMEFRAMES as readonly string[]).includes(tf)) throw new Error('unsupported timeframe ' + tf);
  }
  const swing = num('swing', 3, 1);
  const cooldownBars = num('cooldown', 5, 0);
  const atrLength = num('atr', 14, 1);
  const feeBps = num('fee-bps', 4, 0);
  const slipBps = num('slip-bps', 2, 0);
  const seed = num('seed', 20261021, 1);
  const iterations = num('permutations', 10000, 100);
  const timeStopBars = num('time-stop-bars', 48, 1);

  // Predeclared exits.
  const exits: Array<{ name: string; targetR: number | null; horizonBars: number }> = [
    { name: 'time6', targetR: null, horizonBars: 6 },
    { name: 'stop_or_2R', targetR: 2.0, horizonBars: timeStopBars },
    { name: 'stop_or_1.5R', targetR: 1.5, horizonBars: timeStopBars },
  ];
  const buffers = [0.25, 0.5];
  const sides: Array<'short' | 'long'> = ['short', 'long'];

  const rows: ConfigRow[] = [];
  const datasets: Record<string, object> = {};
  let fundingPoints: FundingPoint[] = [];
  let fundingMissing: string[] = [];

  for (const timeframe of timeframes) {
    const candles = loadSnapshot(resolve(rawDir, symbol + '-' + timeframe + '.json'), timeframe, symbol);
    const events = detectSweepReclaim(candles, swing, { reclaimWithinBars: 0, cooldownBars });
    const atr = atrWilder(candles, atrLength);

    if (fundingPoints.length === 0) {
      const loaded = await loadFundingHistory(symbol, candles[0].openTime, candles[candles.length - 1].closeTime);
      fundingPoints = loaded.points;
      fundingMissing = loaded.missingFiles;
    }

    const foldSize = Math.ceil(candles.length / FOLDS);
    for (const side of sides) {
      const sideEvents = events.filter((e) => (side === 'short' ? e.direction === -1 : e.direction === 1));
      for (const bufferAtr of buffers) {
        for (const exit of exits) {
          const netR: number[] = [];
          const foldR: (number | null)[] = Array.from({ length: FOLDS }, () => null);
          const foldAccum: number[][] = Array.from({ length: FOLDS }, () => []);
          let excluded = 0;
          let grossSum = 0; let costSum = 0; let fundingSum = 0;

          for (const event of sideEvents) {
            const entryIndex = event.index + 1;
            if (entryIndex >= candles.length) { excluded++; continue; }
            const atrValue = atr[event.index];
            if (atrValue === null || atrValue <= 0) { excluded++; continue; }
            const bullish = event.direction === 1;
            const entryPrice = candles[entryIndex].open;
            let extreme = bullish ? Infinity : -Infinity;
            for (let b = event.sweepIndex; b <= event.index; b++) {
              extreme = bullish ? Math.min(extreme, candles[b].low) : Math.max(extreme, candles[b].high);
            }
            const stopPrice = bullish ? extreme - bufferAtr * atrValue : extreme + bufferAtr * atrValue;
            const risk = bullish ? entryPrice - stopPrice : stopPrice - entryPrice;
            if (!(risk > 0)) { excluded++; continue; }
            const targetPrice = exit.targetR === null ? null : (bullish ? entryPrice + exit.targetR * risk : entryPrice - exit.targetR * risk);
            const timeExitIndex = event.index + exit.horizonBars;
            const outcome = simulateTrade(candles, {
              entryIndex, direction: event.direction, entryPrice, stopPrice, targetPrice, timeExitIndex,
            });
            if (outcome === null) { excluded++; continue; }
            const costsR = costsInR(entryPrice, stopPrice, feeBps, slipBps);
            const rates = fundingSumBetween(fundingPoints, candles[entryIndex].openTime, candles[outcome.exitIndex].closeTime);
            const fundingR = fundingInR(event.direction, rates, entryPrice, stopPrice);
            const net = outcome.grossR - costsR + fundingR;
            netR.push(net);
            grossSum += outcome.grossR; costSum += costsR; fundingSum += fundingR;
            foldAccum[Math.min(FOLDS - 1, Math.floor(entryIndex / foldSize))].push(net);
          }

          for (let f = 0; f < FOLDS; f++) {
            foldR[f] = foldAccum[f].length > 0 ? foldAccum[f].reduce((s, r) => s + r, 0) / foldAccum[f].length : null;
          }
          const s = summarize(netR);
          rows.push({
            timeframe, side, bufferAtr, exit: exit.name,
            n: netR.length, excluded,
            netMeanR: s.mean, netMedianR: s.median, winRate: s.win, profitFactor: s.pf, maxDrawdownR: s.maxDD,
            foldMeanR: foldR,
            grossMeanR: netR.length ? grossSum / netR.length : null,
            costsMeanR: netR.length ? costSum / netR.length : null,
            fundingMeanR: netR.length ? fundingSum / netR.length : null,
            permutationP: permutationP(netR, seed, iterations),
            holmSignificant: false,
          });
        }
      }
    }
    datasets[timeframe] = {
      bars: candles.length,
      manifestSha256: manifestSha256(manifestDir, symbol, timeframe),
    };
  }

  const rejects = holmRejects(rows.map((r) => r.permutationP));
  rows.forEach((row, i) => { row.holmSignificant = rejects[i]; });

  const fmt = (v: number | null, digits = 3): string => v === null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(digits);
  console.log('\nSweep-reclaim cost-adjusted evaluation (net R after fees/slippage/funding)');
  console.log('family: ' + rows.length + ' predeclared configs | Holm alpha 0.05 | permutation seed ' + seed);
  for (const row of rows) {
    console.log(
      row.timeframe.padEnd(3) + ' ' + row.side.padEnd(5) + ' buf' + row.bufferAtr.toFixed(2) + ' ' + row.exit.padEnd(11) +
      ' n=' + String(row.n).padStart(4) + ' (excl ' + row.excluded + ')' +
      ' E[R]=' + fmt(row.netMeanR) + ' med=' + fmt(row.netMedianR) +
      ' win=' + (row.winRate === null ? 'n/a' : (row.winRate * 100).toFixed(1) + '%') +
      ' PF=' + (row.profitFactor === null ? 'n/a' : row.profitFactor.toFixed(2)) +
      ' DD=' + fmt(row.maxDrawdownR) + 'R' +
      ' folds=' + row.foldMeanR.map((f) => fmt(f, 2)).join('/') +
      ' p=' + row.permutationP.toFixed(4) + (row.holmSignificant ? ' HOLM-SIG' : ''),
    );
  }

  const report = {
    schemaVersion: 1,
    kind: 'SWEEP_RECLAIM_COST_ADJUSTED_EVAL',
    generatedAt: new Date().toISOString(),
    instrument: { symbol, venue: 'BINANCE_USDM_PERPETUAL' },
    config: {
      swingStrength: swing, cooldownBars, atrLength, sameBarReclaimOnly: true,
      buffersAtr: buffers, exits, timeStopBars,
      feeBpsPerSide: feeBps, slippageBpsPerSide: slipBps,
      funding: 'actual historical settlements (data.binance.vision), missing files: ' + (fundingMissing.length ? fundingMissing.join(', ') : 'none'),
      folds: FOLDS, permutationIterations: iterations, seed,
      familySize: rows.length,
      execution: 'next-bar-open entry; stop fills before target within a bar; open gaps fill at open',
    },
    datasets,
    results: rows,
    caveats: [
      'Kline data carries no observed spread; the spread/slippage figures are assumptions.',
      'Conservative intrabar ordering (stop before target) biases results downward.',
      'A HOLM-SIG verdict is a research candidate, not live admission: the repository admission gate still applies.',
      'The family was predeclared before running; any post-hoc addition is a new study and a new holdout read.',
    ],
  };
  const digest = createHash('sha256').update(JSON.stringify(report.config)).digest('hex');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('\nReport written: ' + outPath + ' (config sha256 ' + digest.slice(0, 12) + '…)');
}

main().catch((error: unknown) => {
  console.error('sweep-eval failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
