/**
 * Pre-registered H5 runner (docs/research-log.md §12). Reads recorded minutes, applies the frozen rules in
 * src/marketdata/RegimeEventStudy.ts, and writes results.json.
 *
 *   npx tsx scripts/regime-event-study.ts [--dir data/market] [--symbols BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT]
 *                                         [--out data/regime-study] [--after <ISO time>] [--allow-dirty]
 *
 * The run refuses a dirty working tree unless --allow-dirty is given, and the result records which it was, so every result
 * names a commit that matches the code. --after keeps only records later than that time: for the replication run, pass the
 * previous run's dataCutoff. The replication verdict is printed only when --after is given.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadMinutes } from '../src/marketdata/loadMinutes.js';
import {
  H5_ALPHA, H5_BOOTSTRAP_DRAWS, H5_BOOTSTRAP_SEED, H5_COST_BPS, H5_HISTORY_MINUTES, H5_HORIZONS, H5_MAX_DROPPED_DRAW_SHARE,
  H5_MIN_DAY_COVERAGE, H5_MIN_GROUP_EVENTS, H5_MIN_POSITIVE_SYMBOLS, H5_MIN_USABLE_DAYS, H5_REGIMES, H5_REPLICATION_ALPHA,
  runH5Study, type H5Run,
} from '../src/marketdata/RegimeEventStudy.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] ?? fallback) : fallback;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const fmt = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : x.toFixed(2));

const dir = path.resolve(arg('dir', 'data/market'));
const symbols = arg('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const outRoot = path.resolve(arg('out', 'data/regime-study'));
const afterText = arg('after', '');
const after = afterText === '' ? undefined : Date.parse(afterText);
if (after !== undefined && !Number.isFinite(after)) fail(`--after is not a valid time: ${afterText}`);
const allowDirty = process.argv.includes('--allow-dirty');

const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const gitStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
if (gitStatus !== '' && !allowDirty) {
  fail('working tree is not clean: commit first, or pass --allow-dirty (the result records that it was dirty)');
}

const inputs = symbols.map((symbol) => ({ symbol, records: loadMinutes(dir, symbol) }));
for (const { symbol, records } of inputs) {
  console.log(`${symbol}: ${records.length} minute records in ${dir}`);
}

const run: H5Run = runH5Study({ symbols: inputs, ...(after === undefined ? {} : { after }) });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(outRoot, stamp);
mkdirSync(outDir, { recursive: true });
const toIso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());
const payload = {
  experiment: 'H5',
  researchLog: 'docs/research-log.md section 12, amendment 1',
  createdAt: new Date().toISOString(),
  gitHead,
  workingTreeClean: gitStatus === '',
  dir,
  symbols,
  after: after === undefined ? null : new Date(after).toISOString(),
  constants: {
    horizons: [...H5_HORIZONS], costBps: H5_COST_BPS, alpha: H5_ALPHA, replicationAlpha: H5_REPLICATION_ALPHA,
    bootstrapDraws: H5_BOOTSTRAP_DRAWS, bootstrapSeed: H5_BOOTSTRAP_SEED, minGroupEvents: H5_MIN_GROUP_EVENTS,
    minUsableDays: H5_MIN_USABLE_DAYS, minDayCoverage: H5_MIN_DAY_COVERAGE, minPositiveSymbols: H5_MIN_POSITIVE_SYMBOLS,
    maxDroppedDrawShare: H5_MAX_DROPPED_DRAW_SHARE, historyMinutes: H5_HISTORY_MINUTES,
  },
  inputs: inputs.map((i) => ({ symbol: i.symbol, minuteRecords: i.records.length })),
  result: { ...run, dataCutoff: toIso(run.dataCutoff) },
};
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(payload, null, 2) + '\n');

console.log(`\nH5 · usable days ${run.usableDays.length}, excluded ${run.excludedDays.length}, data cutoff ${toIso(run.dataCutoff) ?? 'none'}`);
if (run.status === 'NOT_RUN') {
  console.log(`NOT RUN: ${run.reason}`);
} else {
  for (const h of run.horizons) {
    const c = h.stats.counts;
    const counts = H5_REGIMES.map((r) => `${r}=${c[r]}`).join(' ');
    const b = h.stats.bounds;
    console.log(`\nh=${h.horizon}m  ${counts}`);
    console.log(`  Test A excess ${fmt(h.stats.meanExcess)} bps, lower bound ${fmt(b.meanExcess.family)}`);
    console.log(`  Test B delta  ${fmt(h.stats.delta)} bps, lower bound ${fmt(b.delta.family)}`);
    console.log(`  net mean      ${fmt(h.stats.netMean)} bps, lower bound ${fmt(b.net.family)}`);
    const why = h.judgement.failed.length > 0 ? ` (${h.judgement.failed.join('; ')})` : '';
    console.log(`  verdict ${h.judgement.verdict}${why}`);
    if (after !== undefined) {
      const rwhy = h.replication.failed.length > 0 ? ` (${h.replication.failed.join('; ')})` : '';
      console.log(`  replication ${h.replication.verdict}${rwhy}`);
    }
  }
}
console.log(`\nwrote ${path.join(outDir, 'results.json')}`);
if (gitStatus !== '') console.log('git: WORKING TREE NOT CLEAN (recorded in the result)');
