/**
 * Automated research run: one command for GitHub Actions, a local machine (cron) or a cloud host.
 *
 *   npm run research:run -- [--specs research/hypotheses] [--include-drafts] [--source auto|api|archive]
 *                           [--out data/research/runs]
 *
 * Stages:
 *   1. load + validate pre-registered specs (research/hypotheses/*.json); each gets a sha256 spec hash
 *   2. pick the kline source for this host (auto: api if fapi.binance.com answers, else archive)
 *   3. data: for every spec x symbol x timeframe, compute the window (no from/to input), fetch, run the integrity gate
 *   4. write one manifest per spec: window, per-series sha256 and bar counts, source and reason, pass/fail per series
 *   5. evaluation: not built yet (walk-forward grid, family-wide correction, OOS ledger reads) - reported as NOT_RUN
 *
 * Raw candles are fetched per run and never stored. Exit code 1 if any series fails the integrity gate (fail closed).
 */
import path from 'node:path';
import { CandleIntegrityError } from '../src/backtesting/candleIntegrity.js';
import { loadValidatedKlines, type LoadedKlines } from '../src/backtesting/klineLoader.js';
import {
  buildRunId,
  describeSeries,
  readCodeState,
  resolveResearchWindow,
  writeRunManifest,
  type SeriesRecord,
} from '../src/backtesting/researchRun.js';
import { loadSpecs } from '../src/research/pipeline/hypothesis.js';
import { selectSource, type SourcePreference } from '../src/research/pipeline/sourceSelect.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const specsDir = path.resolve(arg('specs', 'research/hypotheses'));
const outDir = path.resolve(arg('out', 'data/research/runs'));
const includeDrafts = process.argv.includes('--include-drafts');
const preference = arg('source', 'auto') as SourcePreference;
if (!['auto', 'api', 'archive'].includes(preference)) throw new Error('--source must be auto, api or archive');

const runNowMs = Date.now();
const specs = loadSpecs(specsDir).filter(({ spec }) => spec.status === 'REGISTERED' || (includeDrafts && spec.status === 'DRAFT'));
console.log(`research run ${new Date(runNowMs).toISOString()} · specs ${specs.length} from ${specsDir}${includeDrafts ? ' (drafts included)' : ''}`);
if (specs.length === 0) {
  console.log('nothing to run: no REGISTERED specs (pass --include-drafts to exercise DRAFT specs)');
  process.exit(0);
}

const choice = await selectSource(preference);
console.log(`source: ${choice.source} (${choice.reason})`);

// In-memory only: a series shared by several specs is fetched once per run. Nothing is written to disk.
const fetched = new Map<string, Promise<LoadedKlines>>();
const load = (symbol: string, interval: string, fromMs: number, toMs: number): Promise<LoadedKlines> => {
  const key = `${symbol}|${interval}|${fromMs}|${toMs}`;
  let pending = fetched.get(key);
  if (!pending) {
    pending = loadValidatedKlines({ symbol, interval, fromMs, toMs, source: choice.source });
    fetched.set(key, pending);
  }
  return pending;
};

const { commit, dirty } = readCodeState(process.cwd());
let failures = 0;
console.log('\n' + ['spec', 'symbol', 'tf', 'status', 'bars'].map((h, i) => h.padEnd([34, 10, 5, 8, 12][i]!)).join(''));
for (const { spec, hash } of specs) {
  const window = resolveResearchWindow({ days: spec.window.days, endDaysAgo: spec.window.endDaysAgo, source: choice.source, nowMs: runNowMs });
  const series: SeriesRecord[] = [];
  const failed: string[] = [];
  for (const symbol of spec.symbols) {
    for (const timeframe of spec.timeframes) {
      const label = `${spec.id}@${spec.version}`.padEnd(34) + symbol.padEnd(10) + timeframe.padEnd(5);
      try {
        const loaded = await load(symbol, timeframe, window.fromMs, window.toMs);
        const record = describeSeries({ symbol, interval: timeframe, source: choice.source, window: loaded.window, candles: loaded.candles });
        series.push(record);
        console.log(label + 'PASS'.padEnd(8) + `${record.bars}/${record.expectedBars}`);
      } catch (error) {
        if (!(error instanceof CandleIntegrityError)) throw error;
        failures += 1;
        // The first non-count violation names the cause (gap, duplicate, OHLC, ...); the count line only restates it.
        const cause = error.violations.find((v) => v.kind !== 'count') ?? error.violations[0];
        const detail = cause ? `[${cause.kind}] ${cause.detail}` : (error.message.split('\n')[0] ?? error.message);
        failed.push(`${symbol} ${timeframe}: ${detail}`);
        console.log(label + 'FAIL'.padEnd(8) + detail);
      }
    }
  }
  const manifestPath = writeRunManifest({
    schemaVersion: 1,
    runId: buildRunId('research-run', `${spec.id}-v${spec.version}-${choice.source}`, runNowMs),
    kind: 'research-run:data',
    createdAtIso: new Date(runNowMs).toISOString(),
    codeCommit: commit,
    codeDirty: dirty,
    argv: process.argv.slice(2),
    window,
    series,
    summary: {
      specId: spec.id,
      specVersion: spec.version,
      specHash: hash,
      specStatus: spec.status,
      source: choice.source,
      sourceReason: choice.reason,
      seriesPassed: series.length,
      seriesFailed: failed.length,
      failures: failed.length ? failed.join(' | ') : null,
      evaluation: 'NOT_RUN: evaluation stage not built yet',
    },
  }, outDir);
  console.log(`  manifest: ${manifestPath}`);
}

console.log(`\ndata stage: ${failures === 0 ? 'all series passed' : `${failures} series failed the integrity gate`} · evaluation stage: NOT_RUN (not built yet)`);
process.exit(failures === 0 ? 0 : 1);
