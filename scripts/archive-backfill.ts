/**
 * Mirrors Binance's public USD-M archive (data.binance.vision) into data/cache/vision as the original zips, then
 * validates each file and writes a manifest. Raw zips are kept so every research number traces to exact source bytes.
 *
 *   npx tsx scripts/archive-backfill.ts [--from 2023-01-01] [--to 2023-01-01] [--symbols SOLUSDT,ETHUSDT,XRPUSDT,BTCUSDT]
 *     [--datasets klines,markPriceKlines,fundingRate,metrics]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseKlineCsv, readFirstZipEntry, validateCandles } from '../src/backtesting/archiveKlines.js';

const BASE = 'https://data.binance.vision/data/futures/um';
const ROOT = path.resolve('data/cache/vision');
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const METRICS_STEP_MS = 5 * MINUTE_MS;
const CONCURRENCY = 6;

type Dataset = 'klines' | 'markPriceKlines' | 'fundingRate' | 'metrics';
interface ArchiveFile { dataset: Dataset; symbol: string; period: string; daily: boolean; relPath: string }
interface FileReport { relPath: string; status: 'OK' | 'INVALID' | 'MISSING' | 'SUPERSEDED_BY_DAILY'; sha256?: string; bytes?: number; rows?: number; issue?: string }

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const months = (fromMs: number, toMs: number): string[] => {
  const out: string[] = [];
  for (let d = new Date(fromMs); d.getTime() < toMs; d.setUTCMonth(d.getUTCMonth() + 1, 1)) out.push(iso(d.getTime()).slice(0, 7));
  return out;
};
const days = (fromMs: number, toMs: number): string[] => {
  const out: string[] = [];
  for (let t = fromMs; t < toMs; t += DAY_MS) out.push(iso(t));
  return out;
};

function fileFor(dataset: Dataset, symbol: string, period: string): ArchiveFile {
  const daily = period.length === 10;
  const sub = dataset === 'klines' || dataset === 'markPriceKlines' ? `${dataset}/${symbol}/1m` : `${dataset}/${symbol}`;
  const name = dataset === 'klines' || dataset === 'markPriceKlines' ? `${symbol}-1m-${period}` : `${symbol}-${dataset}-${period}`;
  return { dataset, symbol, period, daily, relPath: `${daily ? 'daily' : 'monthly'}/${sub}/${name}.zip` };
}

/** Full months come as monthly zips; the current, unpublished month as dailies. Metrics are only published daily. */
function planFiles(symbol: string, fromMs: number, untilMs: number, datasets: ReadonlySet<string>): ArchiveFile[] {
  const currentMonthStart = Date.UTC(new Date(untilMs).getUTCFullYear(), new Date(untilMs).getUTCMonth(), 1);
  const fullMonths = months(fromMs, currentMonthStart);
  const tailDays = days(currentMonthStart, untilMs);
  const files: ArchiveFile[] = [];
  for (const dataset of ['klines', 'markPriceKlines'] as const) {
    files.push(...fullMonths.map((m) => fileFor(dataset, symbol, m)), ...tailDays.map((d) => fileFor(dataset, symbol, d)));
  }
  // ponytail: fundingRate has no daily files; the running month comes from REST /fapi/v1/fundingRate when research needs it
  files.push(...fullMonths.map((m) => fileFor('fundingRate', symbol, m)));
  files.push(...days(fromMs, untilMs).map((d) => fileFor('metrics', symbol, d)));
  return files.filter((f) => datasets.has(f.dataset));
}

async function download(file: ArchiveFile): Promise<Buffer | null> {
  const local = path.join(ROOT, file.relPath);
  if (existsSync(local)) return readFileSync(local);
  const response = await fetch(`${BASE}/${file.relPath}`, { signal: AbortSignal.timeout(60_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${file.relPath}: HTTP ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  mkdirSync(path.dirname(local), { recursive: true });
  writeFileSync(local, zip);
  return zip;
}

function periodWindow(file: ArchiveFile): [number, number] {
  const start = Date.parse(file.daily ? `${file.period}T00:00:00Z` : `${file.period}-01T00:00:00Z`);
  if (file.daily) return [start, start + DAY_MS];
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return [start, end.getTime()];
}

/** Metrics rows must sit on the 5m grid with finite numbers; missing slots are reported, not filled. */
function validateMetrics(csv: string, file: ArchiveFile): number {
  const [from, to] = periodWindow(file);
  const seen = new Set<number>();
  for (const line of csv.split('\n').slice(1)) {
    const cells = line.trim().split(',');
    if (cells.length < 8) continue;
    const at = Date.parse(`${cells[0]!.replace(' ', 'T')}Z`);
    if (!Number.isFinite(at) || at < from || at >= to || at % METRICS_STEP_MS !== 0) throw new Error(`bad create_time ${cells[0]}`);
    if (seen.has(at)) throw new Error(`duplicate create_time ${cells[0]}`);
    seen.add(at);
  }
  const expected = (to - from) / METRICS_STEP_MS;
  if (seen.size !== expected) throw new Error(`expected ${expected} 5m rows, got ${seen.size}`);
  return seen.size;
}

function validateFunding(csv: string): number {
  const rates = csv.split('\n').slice(1).map((l) => l.trim().split(',')).filter((c) => c.length >= 3);
  let previous = 0;
  for (const [calcTime, , rate] of rates) {
    const at = Number(calcTime);
    if (!Number.isFinite(at) || !Number.isFinite(Number(rate)) || at <= previous) throw new Error(`bad funding row ${calcTime},${rate}`);
    previous = at;
  }
  if (rates.length === 0) throw new Error('no funding rows');
  return rates.length;
}

function validate(file: ArchiveFile, csv: string): number {
  if (file.dataset === 'metrics') return validateMetrics(csv, file);
  if (file.dataset === 'fundingRate') return validateFunding(csv);
  const [from, to] = periodWindow(file);
  return validateCandles(parseKlineCsv(csv), MINUTE_MS, from, to).actualBars;
}

async function processFile(file: ArchiveFile): Promise<FileReport> {
  const zip = await download(file);
  if (!zip) return { relPath: file.relPath, status: 'MISSING' };
  const base = { relPath: file.relPath, sha256: createHash('sha256').update(zip).digest('hex'), bytes: zip.length };
  try {
    return { ...base, status: 'OK', rows: validate(file, readFirstZipEntry(zip)) };
  } catch (error) {
    return { ...base, status: 'INVALID', issue: (error as Error).message.split('\n').slice(0, 4).join(' | ') };
  }
}

async function runPool(files: ArchiveFile[]): Promise<FileReport[]> {
  const reports: FileReport[] = new Array(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const index = next++;
      reports[index] = await processFile(files[index]!);
      if (index % 200 === 0) console.log(`  ${index}/${files.length} ${files[index]!.relPath}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return reports;
}

/** Binance monthly zips can drop whole days (2026-10 klines lack 10-28) while the dailies have them: retry those months day by day. */
function dailyReplacements(files: ArchiveFile[], reports: FileReport[], untilMs: number): ArchiveFile[] {
  const out: ArchiveFile[] = [];
  files.forEach((file, i) => {
    if (file.daily || reports[i]!.status !== 'INVALID' || file.dataset === 'fundingRate') return;
    const [from, to] = periodWindow(file);
    out.push(...days(from, Math.min(to, untilMs)).map((d) => fileFor(file.dataset, file.symbol, d)));
  });
  return out;
}

/** A broken monthly zip whose every day validated as a daily zip is fully covered: loaders read the dailies instead. */
function markSuperseded(files: ArchiveFile[], monthly: FileReport[], dailies: ArchiveFile[], dailyReports: FileReport[]): void {
  files.forEach((file, i) => {
    if (file.daily || monthly[i]!.status !== 'INVALID') return;
    const covering = dailies.map((d, j) => ({ d, r: dailyReports[j]! }))
      .filter(({ d }) => d.dataset === file.dataset && d.symbol === file.symbol && d.period.startsWith(file.period));
    if (covering.length > 0 && covering.every(({ r }) => r.status === 'OK')) monthly[i]!.status = 'SUPERSEDED_BY_DAILY';
  });
}

async function main(): Promise<void> {
  const fromMs = Date.parse(`${arg('from', '2023-01-01')}T00:00:00Z`);
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS; // the archive lags a day: today is never published
  const untilMs = Math.min(today, Date.parse(`${arg('to', iso(today))}T00:00:00Z`));
  const datasets = new Set(arg('datasets', 'klines,markPriceKlines,fundingRate,metrics').split(','));
  const symbols = arg('symbols', 'SOLUSDT,ETHUSDT,XRPUSDT,BTCUSDT').split(',');
  const files = symbols.flatMap((s) => planFiles(s, fromMs, untilMs, datasets));
  console.log(`planning ${files.length} files for ${symbols.join(',')} from ${iso(fromMs)} until ${iso(untilMs)} (exclusive)`);
  const firstPass = await runPool(files);
  const replacements = dailyReplacements(files, firstPass, untilMs);
  console.log(`retrying ${replacements.length} days from invalid monthly files`);
  const dailyReports = await runPool(replacements);
  markSuperseded(files, firstPass, replacements, dailyReports);
  const reports = [...firstPass, ...dailyReports];
  const counts = { OK: 0, INVALID: 0, MISSING: 0, SUPERSEDED_BY_DAILY: 0 };
  for (const r of reports) counts[r.status] += 1;
  const manifest = { generatedAt: new Date().toISOString(), source: BASE, from: iso(fromMs), untilExclusive: iso(untilMs), symbols, counts, files: reports };
  const manifestPath = path.join(ROOT, `manifest-${iso(fromMs)}_${iso(untilMs)}.json`); // one per window: runs never overwrite each other
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  console.log(`done: ${JSON.stringify(counts)} -> ${manifestPath}`);
  for (const r of reports.filter((x) => x.status !== 'OK')) console.log(`  ${r.status} ${r.relPath}${r.issue ? `: ${r.issue}` : ''}`);
}

await main();
