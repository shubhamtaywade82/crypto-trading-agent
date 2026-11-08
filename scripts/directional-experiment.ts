/**
 * Runs a pre-specified directional experiment from a frozen config file.
 *
 *   npx tsx scripts/directional-experiment.ts --config research/directional/exp-001.json [--fetch]
 *                                             [--data-dir data/flow-klines] [--out data/directional]
 *
 * --fetch downloads the 1m archive for the window into --data-dir (one JSONL per symbol). Without it, the cache must
 * already exist. Funding comes from perp_funding_history when the config says `fundingSource: "db"` (PIT_DATABASE_URL),
 * or from <data-dir>/<SYMBOL>-funding.json when it says `"file"`.
 *
 * Outputs under <out>/<experiment>/<UTC timestamp>/: results.json, REPORT.md, manifest.json, config.json.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { fetchFlowMinutes } from '../src/market/directional/archive-flow.js';
import { requiredFundingSpanMs, renderReport, runExperiment, validateConfig, type ExperimentConfig, type SymbolData } from '../src/market/directional/experiment.js';
import { fundingSettlementsFromRows, type FundingSettlement, type PerpFundingRow } from '../src/market/directional/barriers.js';
import { DEFAULT_ADMISSION_POLICY } from '../src/market/directional/probability.js';
import { EXPANSION_CONTEXTS } from '../src/market/directional/context.js';
import type { MinuteInput } from '../src/market/rejection/types.js';

const PG_URL = process.env.PIT_DATABASE_URL ?? 'postgres://supervisor:supervisor@localhost:5434/supervisor';
const MS_PER_HOUR = 3_600_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function loadMinutes(symbol: string, dataDir: string, fromMs: number, toMs: number, fetchMissing: boolean): Promise<MinuteInput[]> {
  const file = path.join(dataDir, `${symbol}-1m.jsonl`);
  if (fetchMissing) {
    const got = await fetchFlowMinutes(symbol, fromMs, toMs);
    writeFileSync(file, got.minutes.map((m) => JSON.stringify(m)).join('\n') + '\n');
    console.log(`${symbol}: fetched ${got.minutes.length} minutes from ${got.files} archive file(s) -> ${file}`);
  }
  if (!existsSync(file)) fail(`missing ${file}; rerun with --fetch to download the archive for this window`);
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as MinuteInput);
}

async function loadFunding(
  c: ExperimentConfig,
  symbol: string,
  dataDir: string,
  fromMs: number,
  pool: pg.Pool | null,
): Promise<FundingSettlement[]> {
  if (c.fundingSource === 'file') {
    const file = path.join(dataDir, `${symbol}-funding.json`);
    if (!existsSync(file)) fail(`missing ${file}`);
    return JSON.parse(readFileSync(file, 'utf8')) as FundingSettlement[];
  }
  if (!pool) fail('fundingSource db needs a database connection');
  const from = fromMs - 8 * MS_PER_HOUR;
  const to = Date.parse(`${c.window.to}T00:00:00Z`) + requiredFundingSpanMs(c);
  const result = await pool.query<PerpFundingRow>(
    `SELECT (EXTRACT(EPOCH FROM funding_time) * 1000)::bigint AS funding_time, funding_rate, mark_price
       FROM perp_funding_history
      WHERE symbol = $1 AND funding_time >= to_timestamp($2::double precision / 1000)
        AND funding_time <= to_timestamp($3::double precision / 1000)
      ORDER BY funding_time`,
    [symbol, from, to],
  );
  return fundingSettlementsFromRows(result.rows);
}

async function main(): Promise<void> {
  const configPath = arg('config');
  if (!configPath) fail('usage: --config <file.json> [--fetch] [--data-dir dir] [--out dir]');
  const raw = readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw) as ExperimentConfig;
  validateConfig(config);

  const dataDir = arg('data-dir') ?? 'data/flow-klines';
  const outRoot = arg('out') ?? 'data/directional';
  const fetchMissing = process.argv.includes('--fetch');
  const fromMs = Date.parse(`${config.window.from}T00:00:00Z`);
  const toMs = Date.parse(`${config.window.to}T00:00:00Z`);
  mkdirSync(dataDir, { recursive: true });

  const pool = config.fundingSource === 'db' ? new pg.Pool({ connectionString: PG_URL, max: 2 }) : null;
  const data: SymbolData[] = [];
  try {
    for (const symbol of config.symbols) {
      const minutes = await loadMinutes(symbol, dataDir, fromMs, toMs, fetchMissing);
      const settlements = await loadFunding(config, symbol, dataDir, fromMs, pool);
      console.log(`${symbol}: ${minutes.length} minutes, ${settlements.length} funding settlements`);
      data.push({ symbol, minutes, settlements });
    }
  } finally {
    await pool?.end();
  }

  const result = runExperiment(config, data, DEFAULT_ADMISSION_POLICY);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(outRoot, config.experiment, stamp);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(path.join(outDir, 'REPORT.md'), renderReport(result, config.tagsOfInterest.filter((t) => EXPANSION_CONTEXTS.includes(t))));

  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const gitStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  const manifest = {
    experiment: config.experiment,
    createdAt: new Date().toISOString(),
    gitHead,
    workingTreeClean: gitStatus === '',
    configPath,
    configSha256: createHash('sha256').update(raw).digest('hex'),
    criterionId: result.criterionId,
    node: process.version,
    window: config.window,
    timeframe: config.timeframe,
    inputs: data.map((d) => ({ symbol: d.symbol, minutes: d.minutes.length, settlements: d.settlements.length })),
    labelCount: result.labelCount,
    excluded: result.excluded,
  };
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // The exact config bytes, so the live gate can reproduce the rules this table was built with (hash checked on load).
  writeFileSync(path.join(outDir, 'config.json'), raw);

  console.log(`\nwrote ${outDir}/{results.json,REPORT.md,manifest.json}`);
  console.log(`labels: ${result.labelCount}; excluded: ${result.excluded.length}; cells with a publishable probability: `
    + `${result.table.cells.filter((c) => c.admitted && c.holdoutAccepted).length} of ${result.table.familySize} tested`);
  if (!gitStatus) console.log(`git: ${gitHead} (clean)`);
  else console.log(`git: ${gitHead} (WORKING TREE NOT CLEAN; the manifest records this)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
