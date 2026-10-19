/**
 * The SMC/ICT component-ablation study CLI.
 *
 * Replays every variant of the playbooks (core, full, isolation, ablation, pairs) in ONE causal pass, then reports
 * per-segment metrics, Holm-corrected holdout p-values, negative controls and a reproducibility manifest:
 *
 *   npm run research:ablation -- --symbol SOLUSDT --days 90 [--end-days-ago 1] [--source archive|sdk]
 *                                 [--spread-bps 1] [--config path/to/config.json] [--param maxTriggerBars=12]
 *                                 [--pairs sweep,displacement|none] [--no-session] [--out data/ablation]
 *
 * Outputs land in data/ablation/<studyId>/ : REPORT.md, results.json, manifest.json, config.json and one journal per
 * variant. The study id hashes the config, so the same config resumes its journals and a changed config starts a new
 * study (and a new holdout read) instead of silently mixing evidence.
 *
 * archive = data.binance.vision (lags about a day; works where fapi.binance.com answers HTTP 451)
 * sdk     = @nemesis-oss/binance-sdk, read-only client with its clock synced
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fetchArchiveKlines } from '../src/backtesting/archiveKlines.js';
import type { Candle } from '../src/types.js';
import type { SMCFrame } from '../src/strategies/smc-ml/types.js';
import { FRAME_MS, fetchSdkCandles, createReadOnlyMarketClient, sdkKlineSource } from '../src/playbooks/index.js';
import { DEFAULT_ABLATION_CONFIG, runAblationStudy, studyIdOf, type ExperimentConfig } from '../src/research/ablation/index.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);
const DAY = 24 * 60 * 60_000;
const WINDOW = 300;
const FRAMES: SMCFrame[] = ['5m', '15m', '1h', '4h'];

const symbol = arg('symbol', DEFAULT_ABLATION_CONFIG.symbol).toUpperCase();
const days = Number(arg('days', '90'));
const endDaysAgo = Number(arg('end-days-ago', '1'));
const source = arg('source', 'archive') as 'archive' | 'sdk';
const spreadBps = Number(arg('spread-bps', String(DEFAULT_ABLATION_CONFIG.execution.spreadBps)));
const outRoot = arg('out', 'data/ablation');
if (!['archive', 'sdk'].includes(source)) throw new Error('--source must be archive or sdk');
if (!(days > 0) || !(spreadBps >= 0)) throw new Error('--days must be > 0 and --spread-bps >= 0');

// Config: defaults, then an optional JSON file, then CLI overrides. Every deviation is recorded in the manifest.
const config: ExperimentConfig = structuredClone(DEFAULT_ABLATION_CONFIG);
const configPath = arg('config', '');
if (configPath) {
  if (!existsSync(configPath)) throw new Error(`--config file not found: ${configPath}`);
  const loaded = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<ExperimentConfig>;
  if (loaded.version !== undefined && loaded.version !== 1) throw new Error(`config version ${loaded.version} unsupported`);
  Object.assign(config, loaded);
}
config.symbol = symbol;
config.source = source;
config.execution = { ...config.execution, spreadBps };
config.sessionPreset = hasFlag('no-session') ? 'none' : (arg('session', config.sessionPreset) as ExperimentConfig['sessionPreset']);
if (hasFlag('no-pairs')) config.pairs = 'none';
if (process.argv.includes('--pairs')) {
  const raw = arg('pairs', 'none');
  config.pairs = raw === 'none' ? 'none' : raw.split(',').map((s) => s.trim()).filter(Boolean);
}
for (const raw of process.argv.filter((a) => a.startsWith('--param='))) {
  const [name, value] = raw.slice('--param='.length).split('=');
  if (!name || value === undefined) throw new Error(`--param needs name=value, got ${raw}`);
  const numeric = Number(value);
  (config.paramOverrides as Record<string, number>)[name] = Number.isFinite(numeric) && value.trim() !== '' ? numeric : (value as unknown as number);
}
if (config.paramOverrides.maxTriggerBars !== undefined && config.paramOverrides.maxTriggerBars <= 3) {
  throw new Error('maxTriggerBars must be above the 5m trigger swing length (3)');
}
const to = Math.floor(Date.now() / DAY) * DAY - endDaysAgo * DAY;
config.to = to;
config.from = to - days * DAY;

const gitSha = (() => {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
})();

async function load(): Promise<Partial<Record<SMCFrame, Candle[]>>> {
  const client = source === 'sdk' ? sdkKlineSource(await createReadOnlyMarketClient([symbol])) : null;
  const out: Partial<Record<SMCFrame, Candle[]>> = {};
  for (const frame of FRAMES) {
    const fetchFrom = config.from - WINDOW * FRAME_MS[frame];
    // 5m also covers the entry TTL and the outcome horizon after the last decision
    const fetchTo = frame === '5m' ? config.to + (config.outcomePolicy.entryTtlBars + config.outcomePolicy.horizonBars + 1) * FRAME_MS['5m'] : config.to;
    if (client) {
      out[frame] = await fetchSdkCandles(client, symbol, frame, fetchFrom, fetchTo);
    } else {
      const archive = await fetchArchiveKlines(symbol, frame, fetchFrom, fetchTo);
      if (archive.missingDays.length) console.log(`  ${frame}: archive has no file for ${archive.missingDays.join(', ')}`);
      out[frame] = archive.candles;
    }
    console.log(`  ${frame}: ${out[frame]!.length} bars`);
  }
  return out;
}

const fmt = (x: number | null | undefined, d = 3): string => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));

console.log(`Ablation study ${symbol}: ${new Date(config.from).toISOString()} to ${new Date(config.to).toISOString()} from ${source}; assumed spread ${spreadBps} bps`);
console.log(`  param overrides: ${JSON.stringify(config.paramOverrides)}; session: ${config.sessionPreset}; pairs: ${config.pairs === 'none' ? 'none' : config.pairs.join(',')}`);
const candles = await load();
const result = runAblationStudy({
  config,
  candles,
  outDir: path.join(outRoot, studyIdOf(config)),
  gitSha,
  log: (line) => console.log(line),
});

console.log('');
console.log(`Selection: ${result.selection.summary}`);
for (const v of result.variants) {
  const f = v.metrics.full;
  const h = v.metrics.holdout;
  const flag = v.selection.promoted ? 'PROMOTED' : v.selection.considered ? 'considered' : '-';
  console.log(`  ${v.spec.label.padEnd(58)} full n=${String(f.filled).padStart(4)} E[R]=${fmt(f.evR)} LB=${fmt(f.bootstrap?.ciLow ?? null)} | holdout n=${String(h.filled).padStart(4)} E[R]=${fmt(h.evR)} LB=${fmt(h.bootstrap?.ciLow ?? null)} holm=${v.selection.holmRejected === null ? 'n/a' : v.selection.holmRejected ? 'rej' : 'no'} ${flag}`);
}
console.log(`\nReports: ${path.join(outRoot, result.manifest.studyId, 'REPORT.md')}`);
