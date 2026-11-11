/**
 * Scores the point-in-time regime classifier against what the next 24h actually did, per symbol and year.
 * Reads 1m klines from the verified local mirror (scripts/archive-backfill.ts), resamples to 1h.
 *
 *   npx tsx scripts/regime-eval.ts [--from 2023-01-01] [--to 2026-11-01]
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fetchArchiveKlines, validateCandles } from '../src/backtesting/archiveKlines.js';
import { resampleCandles } from '../src/market/TimeframeEngine.js';
import {
  classifyRegime, confusionMatrix, realizedRegime, regimeFeatures, REGIME_RULES, scoreClasses, transitionStats,
  type Regime, type RegimeFeatures,
} from '../src/research/RegimeClassifier.js';
import type { Candle } from '../src/types.js';

const SYMBOLS = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT'];
const ANCHOR = 'BTCUSDT';
const HOUR_MS = 3_600_000;
const STRIDE = REGIME_RULES.rvBars; // non-overlapping 24h answer windows

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

/** 1h bars month by month, so 1m history never sits in memory all at once. */
async function hourBars(symbol: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let start = fromMs; start < toMs;) {
    const d = new Date(start);
    const end = Math.min(toMs, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const { candles, missingDays } = await fetchArchiveKlines(symbol, '1m', start, end);
    if (missingDays.length > 0) throw new Error(`${symbol} missing archive days ${missingDays.join(',')}`);
    validateCandles(candles, 60_000, start, end);
    out.push(...resampleCandles(candles, '1h'));
    start = end;
  }
  validateCandles(out, HOUR_MS, fromMs, toMs);
  return out;
}

interface Sample { year: string; predicted: Regime; actual: Regime; fwdRet: number; fwdEfficiency: number; trendAligned: boolean | null }

/** |net move| / path length over the next 24 bars: a threshold-free check that does not depend on the realized-label cut-offs. */
function forwardEfficiency(bars: Candle[], i: number): number {
  let net = 0;
  let path = 0;
  for (let j = i + 1; j <= i + STRIDE; j += 1) {
    const move = Math.log(bars[j]!.close / bars[j - 1]!.close);
    net += move;
    path += Math.abs(move);
  }
  return path > 0 ? Math.abs(net) / path : 0;
}

function samplesFor(bars: Candle[], features: RegimeFeatures[], btc: Map<number, RegimeFeatures>): { samples: Sample[]; labels: Regime[] } {
  const labels = bars.map((b, i) => classifyRegime(features[i]!, btc.get(b.openTime)));
  const samples: Sample[] = [];
  for (let i = REGIME_RULES.historyBars; i + STRIDE < bars.length; i += STRIDE) {
    const fwdRet = Math.log(bars[i + STRIDE]!.close / bars[i]!.close);
    const pastRet = Math.log(bars[i]!.close / bars[i - STRIDE]!.close);
    const trendAligned = labels[i] === 'CALM_TREND' ? Math.sign(pastRet) === Math.sign(fwdRet) : null;
    const year = new Date(bars[i]!.openTime).getUTCFullYear().toString();
    samples.push({ year, predicted: labels[i]!, actual: realizedRegime(bars, i, features), fwdRet, fwdEfficiency: forwardEfficiency(bars, i), trendAligned });
  }
  return { samples, labels: labels.slice(REGIME_RULES.historyBars) };
}

function summarize(samples: Sample[]) {
  const matrix = confusionMatrix(samples);
  const byPredicted = Object.fromEntries(['CALM_TREND', 'SIDEWAYS_RANGE', 'HIGH_VOL_EXPANSION', 'STRESS_CRASH', 'UNKNOWN'].map((regime) => {
    const s = samples.filter((x) => x.predicted === regime);
    const meanAbs = s.reduce((t, x) => t + Math.abs(x.fwdRet), 0) / Math.max(1, s.length);
    const meanEfficiency = s.reduce((t, x) => t + x.fwdEfficiency, 0) / Math.max(1, s.length);
    return [regime, { n: s.length, meanAbsFwd24RetPct: +(100 * meanAbs).toFixed(3), meanFwdEfficiency: +meanEfficiency.toFixed(3) }];
  }));
  const trend = samples.filter((x) => x.trendAligned !== null);
  const trendHitRate = trend.filter((x) => x.trendAligned).length / Math.max(1, trend.length);
  return { n: samples.length, matrix, scores: scoreClasses(matrix), byPredicted, trendContinuationHitRate: +trendHitRate.toFixed(3), trendSamples: trend.length };
}

const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '  n/a');

function printScores(title: string, summary: ReturnType<typeof summarize>): void {
  console.log(`\n${title}  n=${summary.n}  trend-continuation hit ${summary.trendContinuationHitRate} (n=${summary.trendSamples})`);
  for (const s of summary.scores) {
    console.log(`  ${s.regime.padEnd(19)} pred ${String(s.predicted).padStart(4)}  precision ${fmt(s.precision)}  recall ${fmt(s.recall)}  base ${fmt(s.baseRate)}  lift ${fmt(s.lift)}  |fwd24| ${summary.byPredicted[s.regime]!.meanAbsFwd24RetPct}%  fwdER ${summary.byPredicted[s.regime]!.meanFwdEfficiency}`);
  }
}

async function main(): Promise<void> {
  const fromMs = Date.parse(`${arg('from', '2023-01-01')}T00:00:00Z`);
  const toMs = Date.parse(`${arg('to', '2026-11-01')}T00:00:00Z`);
  const btcBars = await hourBars(ANCHOR, fromMs, toMs);
  const btcFeatures = regimeFeatures(btcBars);
  const btc = new Map(btcBars.map((b, i) => [b.openTime, btcFeatures[i]!]));
  const report: Record<string, unknown> = {};
  const pooled: Sample[] = [];
  for (const symbol of SYMBOLS) {
    const bars = await hourBars(symbol, fromMs, toMs);
    const { samples, labels } = samplesFor(bars, regimeFeatures(bars), btc);
    pooled.push(...samples);
    const years = [...new Set(samples.map((s) => s.year))];
    report[symbol] = { all: summarize(samples), transitions: transitionStats(labels), byYear: Object.fromEntries(years.map((y) => [y, summarize(samples.filter((s) => s.year === y))])) };
    printScores(`${symbol}  dwell ${transitionStats(labels).meanDwellBars.toFixed(1)}h`, summarize(samples));
  }
  printScores('POOLED', summarize(pooled));
  for (const year of [...new Set(pooled.map((s) => s.year))]) printScores(`POOLED ${year}`, summarize(pooled.filter((s) => s.year === year)));
  const commit = execSync('git rev-parse --short HEAD').toString().trim();
  const dirty = execSync('git status --porcelain -- src scripts').toString().trim().length > 0;
  const out = `research-runs/regime-eval-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}Z.json`;
  mkdirSync('research-runs', { recursive: true });
  writeFileSync(out, JSON.stringify({ commit, dirty, from: arg('from', '2023-01-01'), to: arg('to', '2026-11-01'), rules: REGIME_RULES, source: 'data/cache/vision 1m klines -> 1h', symbols: report, pooled: summarize(pooled) }, null, 1));
  console.log(`\nreport: ${out}`);
}

await main();
