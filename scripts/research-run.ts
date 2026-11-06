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
 *   5. evaluation: per series train/validation/test; REGISTERED specs record the test-window read in the OOS ledger first,
 *      DRAFT specs leave the test segment unread. Written next to the manifest as <runId>.evaluation.json
 *
 * Raw candles are fetched per run and never stored. Exit code 1 if any series fails the integrity gate or a ledger read is
 * refused (fail closed).
 */
import { writeFileSync } from 'node:fs';
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
import { evaluateSpec, type SeriesInput, type SpecEvaluation } from '../src/research/pipeline/evaluate.js';
import { loadSpecs } from '../src/research/pipeline/hypothesis.js';
import { selectSource, type SourcePreference } from '../src/research/pipeline/sourceSelect.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const specsDir = path.resolve(arg('specs', 'research/hypotheses'));
const outDir = path.resolve(arg('out', 'data/research/runs'));
const ledgerFile = path.resolve(arg('ledger', 'research/oos-ledger.jsonl'));
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

function verdictLine(evaluation: SpecEvaluation): string {
  const counts = new Map<string, number>();
  for (const s of evaluation.series) counts.set(s.verdict, (counts.get(s.verdict) ?? 0) + 1);
  return [...counts].map(([verdict, n]) => `${verdict}=${n}`).join(' ') + ' · fundingModeled=false · not a promotion';
}

function reportEvaluation(evaluation: SpecEvaluation, file: string): void {
  writeFileSync(file, `${JSON.stringify(evaluation, null, 2)}\n`);
  for (const s of evaluation.series) {
    const test = s.test?.summary ? `test n=${s.test.trades} mean=${s.test.summary.mean.toFixed(3)}R p=${s.test.summary.pValue.toFixed(3)}` : 'test unread';
    console.log(`  ${s.symbol} ${s.timeframe}: ${s.verdict} · train n=${s.train.trades} · validation n=${s.validation.trades} · ${test}${s.note ? ` · ${s.note}` : ''}`);
  }
  console.log(`  evaluation: ${file}`);
}

const { commit, dirty } = readCodeState(process.cwd());
let failures = 0;
console.log('\n' + ['spec', 'symbol', 'tf', 'status', 'bars'].map((h, i) => h.padEnd([34, 10, 5, 8, 12][i]!)).join(''));
for (const { spec, hash } of specs) {
  const endMs = spec.window.endIso ? Date.parse(spec.window.endIso) : undefined;
  const window = resolveResearchWindow({ days: spec.window.days, endDaysAgo: spec.window.endDaysAgo, source: choice.source, nowMs: runNowMs, endMs });
  const series: SeriesRecord[] = [];
  const loadedSeries: SeriesInput[] = [];
  const failed: string[] = [];
  for (const symbol of spec.symbols) {
    for (const timeframe of spec.timeframes) {
      const label = `${spec.id}@${spec.version}`.padEnd(34) + symbol.padEnd(10) + timeframe.padEnd(5);
      try {
        const loaded = await load(symbol, timeframe, window.fromMs, window.toMs);
        const record = describeSeries({ symbol, interval: timeframe, source: choice.source, window: loaded.window, candles: loaded.candles });
        series.push(record);
        loadedSeries.push({ symbol, timeframe, candles: loaded.candles });
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
  const runId = buildRunId('research-run', `${spec.id}-v${spec.version}-${choice.source}`, runNowMs);
  // An incomplete series set would skew the Holm family, so a data failure skips evaluation (and the ledger) for the whole spec.
  const evaluation = failed.length === 0
    ? evaluateSpec({ spec, hash, series: loadedSeries, ledgerFile, runId, readAtIso: new Date(runNowMs).toISOString() })
    : null;
  const refused = evaluation?.series.filter((s) => s.verdict === 'LEDGER_REFUSED').length ?? 0;
  failures += refused;
  const manifestPath = writeRunManifest({
    schemaVersion: 1,
    runId,
    kind: 'research-run:data+evaluation',
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
      evaluation: evaluation ? verdictLine(evaluation) : 'SKIPPED: data stage failed',
    },
  }, outDir);
  console.log(`  manifest: ${manifestPath}`);
  if (evaluation) reportEvaluation(evaluation, manifestPath.replace(/\.manifest\.json$/, '.evaluation.json'));
}

console.log(`\nrun: ${failures === 0 ? 'all series passed the integrity gate and the ledger' : `${failures} failures (integrity gate or refused ledger read)`}`);
process.exit(failures === 0 ? 0 : 1);
