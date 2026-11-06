/**
 * Automated research run: one command for GitHub Actions, a local machine (cron) or a cloud host.
 *
 *   npm run research:run -- [--specs research/hypotheses] [--include-drafts] [--source auto|api|archive]
 *                           [--out data/research/runs] [--ledger research/oos-ledger.jsonl]
 *                           [--propose N] [--model beam:cloud] [--llm-host http://127.0.0.1:11434]
 *
 * Stages:
 *   0. optional (--propose N): an Ollama model drafts N new DRAFT specs into <specs>/proposed/. That folder is not loaded,
 *      so a proposal enters a run only after a human moves it into <specs> (and registers it). LLM failures do not stop the run
 *   1. load + validate pre-registered specs (research/hypotheses/*.json); each gets a sha256 spec hash
 *   2. pick the kline source for this host (auto: api if fapi.binance.com answers, else archive)
 *   3. data: for every spec x symbol x timeframe, compute the window (no from/to input), fetch, run the integrity gate
 *   4. write one manifest per spec: window, per-series sha256 and bar counts, source and reason, pass/fail per series
 *   5. evaluation: per series train/validation/test; REGISTERED specs record the test-window read in the OOS ledger first,
 *      DRAFT specs leave the test segment unread. Written next to the manifest as <runId>.evaluation.json
 *
 * Observability: every line is timestamped (+seconds since start) and mirrored to <out>/research-run_<stamp>.log; the LLM
 * prompt, raw reply and latency of each proposal attempt go to <out>/proposals_<stamp>.json.
 *
 * Raw candles are fetched per run and never stored. Exit code 1 if any series fails the integrity gate or a ledger read is
 * refused (fail closed).
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { CandleIntegrityError } from '../src/backtesting/candleIntegrity.js';
import { loadValidatedKlines, type LoadedKlines } from '../src/backtesting/klineLoader.js';
import {
  buildRunId,
  describeSeries,
  readCodeState,
  resolveResearchWindow,
  writeRunManifest,
  type ResearchWindow,
  type SeriesRecord,
} from '../src/backtesting/researchRun.js';
import { evaluateSpec, type SeriesInput, type SpecEvaluation } from '../src/research/pipeline/evaluate.js';
import { loadSpecs, type HypothesisSpec } from '../src/research/pipeline/hypothesis.js';
import { proposeSpecs, writeProposals, type LlmClient } from '../src/research/pipeline/propose.js';
import { jsonFormatFor } from '../src/ollama/jsonMode.js';
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
const proposeCount = Number(arg('propose', '0'));
if (!Number.isInteger(proposeCount) || proposeCount < 0) throw new Error(`--propose must be a non-negative integer, got ${arg('propose', '0')}`);
// The local daemon proxies `:cloud` models with the signed-in account, so one host serves local and cloud models alike.
const llmHost = arg('llm-host', 'http://127.0.0.1:11434');
const llmModel = arg('model', process.env.RESEARCH_MODEL ?? 'beam:cloud');

const runNowMs = Date.now();
const runStamp = new Date(runNowMs).toISOString().replace(/[:.]/g, '-');
mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, `research-run_${runStamp}.log`);

/** Every line goes to stdout and to the run's log file, so a cron or CI run can be read after the fact. */
function log(line = ''): void {
  const stamped = `${new Date().toISOString().slice(11, 23)} +${((Date.now() - runNowMs) / 1000).toFixed(1).padStart(6)}s  ${line}`;
  console.log(stamped);
  appendFileSync(logFile, `${stamped}\n`);
}

const seconds = (sinceMs: number): string => `${((Date.now() - sinceMs) / 1000).toFixed(1)}s`;

async function runProposals(existing: HypothesisSpec[]): Promise<void> {
  const proposedDir = path.join(specsDir, 'proposed');
  log(`[propose] ${proposeCount} draft(s) from ${llmModel} via ${llmHost} -> ${proposedDir}`);
  try {
    const earlier = existsSync(proposedDir) ? loadSpecs(proposedDir).map((s) => s.spec) : [];
    const sdk = new OllamaClient({ baseUrl: llmHost, retries: 0 });
    const client: LlmClient = { generateText: (request) => sdk.generateText({ ...request, ...jsonFormatFor(llmHost) }) };
    const result = await proposeSpecs({ client, model: llmModel, count: proposeCount, existing: [...existing, ...earlier], log: (line) => log(`[propose] ${line}`) });
    const written = writeProposals(result.proposals, proposedDir);
    const transcript = path.join(outDir, `proposals_${runStamp}.json`);
    writeFileSync(transcript, `${JSON.stringify({ model: llmModel, host: llmHost, createdAtIso: new Date(runNowMs).toISOString(), written, attempts: result.attempts }, null, 2)}\n`);
    log(`[propose] ${written.length} written, ${result.rejected.length} rejected · transcript ${transcript}`);
    for (const file of written) log(`[propose]   + ${file}`);
  } catch (error) {
    log(`[propose] FAILED, run continues without proposals: ${error instanceof Error ? error.message : String(error)}`);
  }
}

log(`research run ${new Date(runNowMs).toISOString()} · specs ${specsDir} · out ${outDir} · ledger ${ledgerFile} · log ${logFile}`);
const loadedSpecs = loadSpecs(specsDir);
if (proposeCount > 0) await runProposals(loadedSpecs.map((s) => s.spec));
const specs = loadedSpecs.filter(({ spec }) => spec.status === 'REGISTERED' || (includeDrafts && spec.status === 'DRAFT'));
log(`[specs] ${specs.length} of ${loadedSpecs.length} selected${includeDrafts ? ' (drafts included)' : ' (REGISTERED only)'}: ${specs.map(({ spec }) => `${spec.id}@${spec.version} ${spec.status}`).join(', ') || 'none'}`);
if (specs.length === 0) {
  log('nothing to run: no REGISTERED specs (pass --include-drafts to exercise DRAFT specs)');
  process.exit(0);
}

const choice = await selectSource(preference);
log(`[source] ${choice.source} (${choice.reason})`);

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

interface FetchedSeries {
  records: SeriesRecord[];
  inputs: SeriesInput[];
  failed: string[];
}

/** One series through the integrity gate; a gate failure is recorded in `out`, any other error aborts the run. */
async function fetchOne(symbol: string, timeframe: string, window: ResearchWindow, out: FetchedSeries): Promise<void> {
  const startedMs = Date.now();
  try {
    const loaded = await load(symbol, timeframe, window.fromMs, window.toMs);
    const record = describeSeries({ symbol, interval: timeframe, source: choice.source, window: loaded.window, candles: loaded.candles });
    out.records.push(record);
    out.inputs.push({ symbol, timeframe, candles: loaded.candles });
    log(`[data] ${symbol} ${timeframe} PASS ${record.bars}/${record.expectedBars} bars ${record.firstOpenIso}..${record.lastOpenIso} (${seconds(startedMs)})`);
  } catch (error) {
    if (!(error instanceof CandleIntegrityError)) throw error;
    // The first non-count violation names the cause (gap, duplicate, OHLC, ...); the count line only restates it.
    const cause = error.violations.find((v) => v.kind !== 'count') ?? error.violations[0];
    const detail = cause ? `[${cause.kind}] ${cause.detail}` : (error.message.split('\n')[0] ?? error.message);
    out.failed.push(`${symbol} ${timeframe}: ${detail}`);
    log(`[data] ${symbol} ${timeframe} FAIL ${detail} (${seconds(startedMs)})`);
  }
}

async function fetchSpecSeries(spec: HypothesisSpec, window: ResearchWindow): Promise<FetchedSeries> {
  const out: FetchedSeries = { records: [], inputs: [], failed: [] };
  for (const symbol of spec.symbols) {
    for (const timeframe of spec.timeframes) await fetchOne(symbol, timeframe, window, out);
  }
  return out;
}

function verdictLine(evaluation: SpecEvaluation): string {
  const counts = new Map<string, number>();
  for (const s of evaluation.series) counts.set(s.verdict, (counts.get(s.verdict) ?? 0) + 1);
  return [...counts].map(([verdict, n]) => `${verdict}=${n}`).join(' ') + ' · fundingModeled=false · not a promotion';
}

function reportEvaluation(evaluation: SpecEvaluation, file: string): void {
  writeFileSync(file, `${JSON.stringify(evaluation, null, 2)}\n`);
  for (const s of evaluation.series) {
    const test = s.test === null ? 'test unread'
      : s.test.summary ? `test n=${s.test.trades} days=${s.test.summary.clusters} mean=${s.test.summary.mean.toFixed(3)}R p=${s.test.summary.pValue.toFixed(3)}`
        : 'test read, no trades';
    log(`[eval]   ${s.symbol} ${s.timeframe}: ${s.verdict} · ledger ${s.ledger} · train n=${s.train.trades} · validation n=${s.validation.trades} · ${test}${s.note ? ` · ${s.note}` : ''}`);
  }
  log(`[eval]   ${verdictLine(evaluation)} · ${file}`);
}

const { commit, dirty } = readCodeState(process.cwd());
let failures = 0;
const verdictTotals = new Map<string, number>();
for (const { spec, hash } of specs) {
  const specStartedMs = Date.now();
  const endMs = spec.window.endIso ? Date.parse(spec.window.endIso) : undefined;
  const window = resolveResearchWindow({ days: spec.window.days, endDaysAgo: spec.window.endDaysAgo, source: choice.source, nowMs: runNowMs, endMs });
  log(`[spec] ${spec.id}@${spec.version} ${spec.status} · ${spec.symbols.length * spec.timeframes.length} series · window ${window.fromIso}..${window.toIso} (${window.anchor})`);
  const { records, inputs, failed } = await fetchSpecSeries(spec, window);
  failures += failed.length;
  const runId = buildRunId('research-run', `${spec.id}-v${spec.version}-${choice.source}`, runNowMs);
  // An incomplete series set would skew the Holm family, so a data failure skips evaluation (and the ledger) for the whole spec.
  const evaluation = failed.length === 0
    ? evaluateSpec({ spec, hash, series: inputs, ledgerFile, runId, readAtIso: new Date(runNowMs).toISOString() })
    : null;
  if (!evaluation) log(`[eval] ${spec.id}: SKIPPED, ${failed.length} series failed the integrity gate`);
  failures += evaluation?.series.filter((s) => s.verdict === 'LEDGER_REFUSED').length ?? 0;
  for (const s of evaluation?.series ?? []) verdictTotals.set(s.verdict, (verdictTotals.get(s.verdict) ?? 0) + 1);
  const manifestPath = writeRunManifest({
    schemaVersion: 1,
    runId,
    kind: evaluation ? 'research-run:data+evaluation' : 'research-run:data',
    createdAtIso: new Date(runNowMs).toISOString(),
    codeCommit: commit,
    codeDirty: dirty,
    argv: process.argv.slice(2),
    window,
    series: records,
    summary: {
      specId: spec.id,
      specVersion: spec.version,
      specHash: hash,
      specStatus: spec.status,
      source: choice.source,
      sourceReason: choice.reason,
      seriesPassed: records.length,
      seriesFailed: failed.length,
      failures: failed.length ? failed.join(' | ') : null,
      evaluation: evaluation ? verdictLine(evaluation) : 'SKIPPED: data stage failed',
    },
  }, outDir);
  if (evaluation) reportEvaluation(evaluation, manifestPath.replace(/\.manifest\.json$/, '.evaluation.json'));
  log(`[spec] ${spec.id}@${spec.version} done in ${seconds(specStartedMs)} · manifest ${manifestPath}`);
}

const verdicts = [...verdictTotals].map(([verdict, n]) => `${verdict}=${n}`).join(' ') || 'none';
log(`done in ${seconds(runNowMs)} · ${specs.length} spec(s) · verdicts ${verdicts} · ${failures === 0 ? 'no failures' : `${failures} failure(s): integrity gate or refused ledger read`} · log ${logFile}`);
process.exit(failures === 0 ? 0 : 1);
