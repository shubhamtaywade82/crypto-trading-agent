/**
 * Layer A (docs/NEMESIS_G4_STRATEGY_SPECS.md §29): do causal multi-timeframe price/volume/flow features predict the next move, net of costs?
 *
 *   npx tsx scripts/state-study.ts --set A1|A2 [--null]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadFunding } from '../src/backtesting/archiveDerivatives.js';
import { loadTickDay, type DepthMinute, type TradeMinute } from '../src/backtesting/archiveTicks.js';
import { mirrorFirstFetch } from '../src/backtesting/archiveKlines.js';
import { fetchFlowMinutes } from '../src/market/directional/archive-flow.js';
import { bootstrapMean, mulberry32 } from '../src/research/Bootstrap.js';
import { buildFrame, type MinuteInputs } from '../src/research/MtfFrame.js';
import { buildStateData, featureRow, PRICE_FEATURES, TICK_FEATURES } from '../src/research/StateFeatures.js';
import { fitRidge, predictRidge } from '../src/research/Ridge.js';
import { fitGbt, predictGbt } from '../src/research/Gbt.js';

const flag = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; };
const SET = flag('set', 'A1') as 'A1' | 'A2' | 'A3';
const NULL_MODEL = process.argv.includes('--null');
const SYMBOLS = flag('symbols', 'SOLUSDT,ETHUSDT,XRPUSDT').split(',');
const HORIZONS = [15, 60, 240, 1440];
const COST = 0.0012;
const DATA_FROM = Date.parse(`${flag('data-from', '2020-11-01')}T00:00:00Z`);
const DATA_TO = Date.UTC(2026, 10, 1);
const TICK_FROM = SET === 'A3' ? Date.UTC(2023, 0, 1) : Date.UTC(2025, 0, 1);
const FIRST_TEST = SET === 'A1' ? Date.UTC(2021, 6, 1) : SET === 'A2' ? Date.UTC(2025, 6, 1) : Date.UTC(2023, 6, 1);
/** A3 replicates a §30 result on samples before this date only (§31). */
const PICKS_BEFORE = SET === 'A3' && !process.argv.includes('--all-picks') ? Date.UTC(2025, 0, 1) : Infinity;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const SELECT_QUANTILE = Number(flag('select', '0.9'));
const MODEL = flag('model', 'ridge') as 'ridge' | 'gbt' | 'regime';
const MIN_REGIME_ROWS = 1000;
const RIDGE_LAMBDA = 10;
const trials = SET === 'A3' ? Number(flag('trials', '136')) : MODEL === 'ridge' && SELECT_QUANTILE === 0.9 ? 111 : 135;

interface Rows { time: number[]; sym: number[]; x: number[][]; ret: Record<number, number[]> }

async function loadMinutes(symbol: string): Promise<MinuteInputs> {
  const n = (DATA_TO - DATA_FROM) / MINUTE_MS;
  const m: MinuteInputs = { start: DATA_FROM, open: new Float64Array(n).fill(NaN), high: new Float64Array(n).fill(NaN), low: new Float64Array(n).fill(NaN), close: new Float64Array(n).fill(NaN), volume: new Float64Array(n), takerBuy: new Float64Array(n) };
  for (let start = DATA_FROM; start < DATA_TO;) {
    const d = new Date(start);
    const end = Math.min(DATA_TO, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    for (const c of (await fetchFlowMinutes(symbol, start, end, mirrorFirstFetch)).minutes) {
      const i = (c.openTime - DATA_FROM) / MINUTE_MS;
      m.open[i] = c.open; m.high[i] = c.high; m.low[i] = c.low; m.close[i] = c.close; m.volume[i] = c.baseVolume; m.takerBuy[i] = c.takerBuyBaseVolume;
    }
    start = end;
  }
  return m;
}

async function fundingByMinute(symbol: string, minutes: number): Promise<Float64Array> {
  const out = new Float64Array(minutes).fill(NaN);
  const points = (await loadFunding(symbol, DATA_FROM - 90 * DAY_MS, DATA_TO)).points;
  let p = 0; let rate = NaN;
  for (let i = 0; i < minutes; i += 1) {
    while (p < points.length && points[p]!.time <= DATA_FROM + i * MINUTE_MS) { rate = points[p]!.rate; p += 1; }
    out[i] = rate;
  }
  return out;
}

function loadTicks(symbol: string, minutes: number): { trades: TradeMinute[]; depth: DepthMinute[]; start: number } {
  const trades: TradeMinute[] = new Array(minutes); const depth: DepthMinute[] = new Array(minutes);
  for (let t = TICK_FROM; t < DATA_TO; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const tr = loadTickDay<TradeMinute>('data/cache', 'aggTrades', symbol, day); const de = loadTickDay<DepthMinute>('data/cache', 'bookDepth', symbol, day);
    const base = (t - DATA_FROM) / MINUTE_MS;
    if (tr) tr.forEach((row, i) => { trades[base + i] = row; });
    if (de) de.forEach((row, i) => { depth[base + i] = row; });
  }
  return { trades, depth, start: DATA_FROM };
}

async function buildRows(): Promise<Rows> {
  const rows: Rows = { time: [], sym: [], x: [], ret: Object.fromEntries(HORIZONS.map((h) => [h, [] as number[]])) };
  for (const [s, symbol] of SYMBOLS.entries()) {
    const m = await loadMinutes(symbol);
    const f = buildFrame(m);
    const data = buildStateData(f, await fundingByMinute(symbol, f.minutes), SET !== 'A1' ? loadTicks(symbol, f.minutes) : undefined);
    const firstK = SET !== 'A1' ? (TICK_FROM - DATA_FROM) / MINUTE_MS + 1500 : 0;
    for (let k = Math.max(firstK, 1500); k + Math.max(...HORIZONS) < f.minutes; k += 1) {
      if ((k + 1) % 15 !== 0) continue;
      const row = featureRow(data, k);
      const entry = f.open[k + 1]!;
      const returns = HORIZONS.map((h) => f.close[k + h]! / entry - 1);
      if (!row || !Number.isFinite(entry) || !returns.every(Number.isFinite)) continue;
      rows.time.push(DATA_FROM + (k + 1) * MINUTE_MS); rows.sym.push(s); rows.x.push(row);
      HORIZONS.forEach((h, j) => rows.ret[h]!.push(returns[j]!));
    }
    console.log(`${symbol}: ${rows.x.length} rows so far`);
  }
  return rows;
}

interface Pick { time: number; sym: number; side: 1 | -1; ret: number; pred: number }

type Predictor = (row: number[]) => number;

/** Regime = sign of the 4h EMA gap x tercile of 1h ATR/close (terciles from the training rows); thin regimes fall back to the pooled ridge. */
function regimeRidge(x: number[][], y: number[]): Predictor {
  const trend = PRICE_FEATURES.indexOf('gap4h'); const vol = PRICE_FEATURES.indexOf('atr1h');
  const sortedVol = x.map((r) => r[vol]!).sort((a, b) => a - b);
  const cuts = [sortedVol[Math.floor(sortedVol.length / 3)]!, sortedVol[Math.floor((2 * sortedVol.length) / 3)]!];
  const regime = (r: number[]): number => (r[trend]! > 0 ? 3 : 0) + (r[vol]! < cuts[0]! ? 0 : r[vol]! < cuts[1]! ? 1 : 2);
  const pooled = fitRidge(x, y, RIDGE_LAMBDA);
  const models = Array.from({ length: 6 }, (_, k) => { const idx = x.map((r, i) => i).filter((i) => regime(x[i]!) === k); return idx.length >= MIN_REGIME_ROWS ? fitRidge(idx.map((i) => x[i]!), idx.map((i) => y[i]!), RIDGE_LAMBDA) : pooled; });
  return (row) => predictRidge(models[regime(row)]!, row);
}

function makePredictor(x: number[][], y: number[]): Predictor {
  if (MODEL === 'gbt') { const model = fitGbt(x, y); return (row) => predictGbt(model, row); }
  if (MODEL === 'regime') return regimeRidge(x, y);
  const model = fitRidge(x, y, RIDGE_LAMBDA);
  return (row) => predictRidge(model, row);
}

function folds(): { trainFrom: number; testFrom: number; testTo: number }[] {
  const out = [];
  const at = (months: number): number => { const d = new Date(FIRST_TEST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1); };
  for (let k = 0; at(3 * k + 3) <= DATA_TO; k += 1) out.push({ trainFrom: at(3 * k - 6), testFrom: at(3 * k), testTo: at(3 * k + 3) });
  return out;
}

function quantile(values: number[], q: number): number { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!; }

/** Walk-forward: fit on each fold's train rows, select the test rows with the strongest predictions. Also returns daily rank correlations. */
function walkForward(rows: Rows, h: number, shuffleSeed: number | null): { picks: Pick[]; ic: { day: string; value: number }[]; coefSigns: number[][] } {
  const picks: Pick[] = []; const coefSigns: number[][] = []; const byDay = new Map<string, { p: number[]; y: number[] }>();
  for (const fold of folds()) {
    const train: number[] = []; const test: number[] = [];
    rows.time.forEach((t, i) => { if (t >= fold.trainFrom && t + (h + 1) * MINUTE_MS <= fold.testFrom) train.push(i); else if (t >= fold.testFrom && t < fold.testTo) test.push(i); });
    if (train.length < 1000 || test.length === 0) continue;
    const y = train.map((i) => rows.ret[h]![i]!);
    if (shuffleSeed !== null) { const r = mulberry32(shuffleSeed + fold.testFrom); for (let i = y.length - 1; i > 0; i -= 1) { const j = Math.floor(r() * (i + 1)); [y[i], y[j]] = [y[j]!, y[i]!]; } }
    const predict = makePredictor(train.map((i) => rows.x[i]!), y);
    const threshold = quantile(train.map((i) => Math.abs(predict(rows.x[i]!))), SELECT_QUANTILE);
    for (const i of test) {
      const pred = predict(rows.x[i]!);
      const day = new Date(rows.time[i]!).toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? { p: [], y: [] }; bucket.p.push(pred); bucket.y.push(rows.ret[h]![i]!); byDay.set(day, bucket);
      if (Math.abs(pred) >= threshold) picks.push({ time: rows.time[i]!, sym: rows.sym[i]!, side: pred > 0 ? 1 : -1, ret: rows.ret[h]![i]!, pred });
    }
  }
  return { picks, ic: [...byDay].filter(([, b]) => b.p.length >= 20).map(([day, b]) => ({ day, value: spearman(b.p, b.y) })), coefSigns };
}

function ranks(xs: number[]): number[] { const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array<number>(xs.length); order.forEach(([, i], rank) => { r[i] = rank; }); return r; }
function spearman(a: number[], b: number[]): number {
  const [ra, rb] = [ranks(a), ranks(b)]; const n = a.length; const ma = (n - 1) / 2;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { num += (ra[i]! - ma) * (rb[i]! - ma); da += (ra[i]! - ma) ** 2; db += (rb[i]! - ma) ** 2; }
  return num / Math.sqrt(da * db);
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
const net = (p: Pick, scale = 1): number => p.side * p.ret - scale * COST;
const fmt = (x: number | undefined): string => (x === undefined || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(3)}%`);

/** A few market-wide days can dominate overlapping picks: one value per day, and the mean with the five best days removed. */
function dayLevelRobustness(picks: Pick[], day: (t: number) => string): { withoutTop5: number; dayMean: number; dayLcb: number | undefined; days: number; positiveDays: number } {
  const byDay = new Map<string, number[]>();
  for (const p of picks) byDay.set(day(p.time), [...(byDay.get(day(p.time)) ?? []), net(p)]);
  const daily = [...byDay].map(([d, v]) => ({ d, mean: mean(v), sum: v.reduce((a, b) => a + b, 0), n: v.length }));
  const top5 = new Set([...daily].sort((a, b) => b.sum - a.sum).slice(0, 5).map((x) => x.d));
  const rest = picks.filter((p) => !top5.has(day(p.time))).map((p) => net(p));
  const boot = bootstrapMean(daily.map((x) => ({ value: x.mean, cluster: x.d })), { confidence: 0.8, seed: 7 });
  return { withoutTop5: mean(rest), dayMean: mean(daily.map((x) => x.mean)), dayLcb: boot?.ciLow, days: daily.length, positiveDays: daily.filter((x) => x.mean > 0).length };
}

function report(h: number, wf: ReturnType<typeof walkForward>): { gate: boolean; summary: Record<string, unknown> } {
  const lcb = (values: number[], clusters: string[]): number | undefined => bootstrapMean(values.map((value, i) => ({ value, cluster: clusters[i]! })), { confidence: 0.8, seed: 7 })?.ciLow;
  const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
  const nets = wf.picks.map((p) => net(p));
  const meanNet = mean(nets); const low = lcb(nets, wf.picks.map((p) => day(p.time)));
  const bySymbol = SYMBOLS.map((_, s) => mean(wf.picks.filter((p) => p.sym === s).map((p) => net(p))));
  const years = [...new Set(wf.picks.map((p) => new Date(p.time).getUTCFullYear()))].sort();
  const byYear = Object.fromEntries(years.map((y) => [y, mean(wf.picks.filter((p) => new Date(p.time).getUTCFullYear() === y).map((p) => net(p)))]));
  const stressed = mean(wf.picks.map((p) => net(p, 1.5)));
  const icLow = lcb(wf.ic.map((d) => d.value), wf.ic.map((d) => d.day));
  const meanIc = mean(wf.ic.map((d) => d.value));
  const big = wf.picks.filter((p) => Math.abs(p.pred) >= 0.01).length / Math.max(1, wf.picks.length);
  const positiveYears = Object.values(byYear).filter((v) => v > 0).length;
  const [yearA, yearB] = SET === 'A3' ? [2023, 2024] : [2025, 2026];
  const gate = h >= 60 && meanNet > 0 && (low ?? -1) > 0 && bySymbol.filter((v) => v > 0).length >= 2 && (byYear[yearA] ?? -1) > 0 && (byYear[yearB] ?? -1) > 0 && positiveYears >= (SET === 'A1' ? 4 : 2) && stressed > 0 && meanIc > 0 && (icLow ?? -1) > 0;
  const robust = dayLevelRobustness(wf.picks, day);
  console.log(`      robustness: mean without best 5 days ${fmt(robust.withoutTop5)}, one value per day: mean ${fmt(robust.dayMean)} LCB ${fmt(robust.dayLcb)} over ${robust.days} days, positive days ${robust.positiveDays}`);
  console.log(`h=${String(h).padStart(4)}m picks ${String(wf.picks.length).padStart(6)} gross ${fmt(mean(wf.picks.map((p) => p.side * p.ret)))} net ${fmt(meanNet)} LCB ${fmt(low)} 1.5x ${fmt(stressed)} IC ${meanIc.toFixed(4)} (LCB ${(icLow ?? NaN).toFixed(4)}) share|pred|>=1% ${(big * 100).toFixed(1)}%  symbols ${bySymbol.map(fmt).join('/')}  years ${years.map((y) => `${y}:${fmt(byYear[y])}`).join(' ')}  GATE ${gate ? 'PASS' : 'fail'}`);
  return { gate, summary: { h, picks: wf.picks.length, meanNet, low, bySymbol, byYear, stressed, meanIc, icLow, shareBig: big } };
}

/** Same symbol, same UTC day, same side, every decision point that day: separates timing within the day from the day's market move. */
function dayBaseline(rows: Rows): (h: number, picks: Pick[]) => void {
  const index = new Map<string, number[]>();
  rows.time.forEach((t, i) => { const key = `${rows.sym[i]}|${new Date(t).toISOString().slice(0, 10)}`; index.set(key, [...(index.get(key) ?? []), i]); });
  return (h, picks) => {
    const base = picks.map((p) => mean((index.get(`${p.sym}|${new Date(p.time).toISOString().slice(0, 10)}`) ?? []).map((i) => p.side * rows.ret[h]![i]! - COST)));
    console.log(`      h=${h}m day-matched baseline (same symbol, day, side, every 15 min): ${fmt(mean(base))} vs picks ${fmt(mean(picks.map((p) => net(p))))}; longs ${picks.filter((p) => p.side === 1).length}/${picks.length}`);
  };
}

async function main(): Promise<void> {
  console.log(`set ${SET} model ${MODEL} select ${SELECT_QUANTILE}${NULL_MODEL ? ' (shuffled-label null)' : ''}, ${folds().length} folds from ${new Date(FIRST_TEST).toISOString().slice(0, 10)}, features ${PRICE_FEATURES.length + (SET !== 'A1' ? TICK_FEATURES.length : 0)}, trials ${trials}`);
  const rows = await buildRows();
  console.log(`rows ${rows.x.length}`);
  const dumpPath = flag('dump-picks', '');
  const dumped: Record<number, Pick[]> = {};
  const sameDay = dayBaseline(rows);
  const out = HORIZONS.map((h) => { const wf = walkForward(rows, h, NULL_MODEL ? 11 : null); wf.picks = wf.picks.filter((p) => p.time < PICKS_BEFORE); wf.ic = wf.ic.filter((d) => Date.parse(d.day) < PICKS_BEFORE); dumped[h] = wf.picks; sameDay(h, wf.picks); return report(h, wf); });
  if (dumpPath) writeFileSync(dumpPath, JSON.stringify(dumped));
  mkdirSync('research-runs', { recursive: true });
  const file = `research-runs/state-study-${SET}-${MODEL}-q${SELECT_QUANTILE}${NULL_MODEL ? '-null' : ''}-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '')}Z.json`;
  writeFileSync(file, JSON.stringify({ set: SET, model: MODEL, select: SELECT_QUANTILE, null: NULL_MODEL, trials, results: out.map((o) => ({ gate: o.gate, ...o.summary })) }, null, 1));
  console.log(`report: ${file}`);
}

await main();
