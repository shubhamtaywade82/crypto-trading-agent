/**
 * Phase 1 of the intraday search (docs/NEMESIS_G4_STRATEGY_SPECS.md §21): signal-free entries on the 1m path.
 *
 *   npx tsx scripts/opportunity-map.ts [--symbols BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT] [--from 2021-01-01] [--to 2025-01-01]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fetchArchiveKlines } from '../src/backtesting/archiveKlines.js';
import { MINUTE_MS, toMinuteSeries, type MinuteSeries } from '../src/research/SignalBacktest.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const SYMBOLS = arg('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',');
const FROM = Date.parse(`${arg('from', '2021-01-01')}T00:00:00Z`);
const TO = Date.parse(`${arg('to', '2025-01-01')}T00:00:00Z`);
const STOPS = [0.005, 0.01, 0.02];
const TARGETS = [0.01, 0.02, 0.03, 0.05, 0.1];
const HORIZONS = [240, 1440, 4320]; // minutes
const SAMPLE_STEP = 30;
const ROUND_TRIP_COST = 0.0012;
const SWING_THRESHOLDS = [0.01, 0.02, 0.03, 0.05, 0.1];
const YEARS = [2021, 2022, 2023, 2024];

async function loadMinutes(symbol: string): Promise<MinuteSeries> {
  const series = toMinuteSeries([], FROM, TO);
  for (let start = FROM; start < TO;) {
    const d = new Date(start);
    const end = Math.min(TO, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const part = toMinuteSeries((await fetchArchiveKlines(symbol, '1m', start, end)).candles, FROM, TO);
    for (let i = (start - FROM) / MINUTE_MS; i < (end - FROM) / MINUTE_MS; i += 1) {
      series.open[i] = part.open[i]!; series.high[i] = part.high[i]!; series.low[i] = part.low[i]!; series.close[i] = part.close[i]!;
    }
    start = end;
  }
  return series;
}

interface Cell { n: number; takeProfit: number; stop: number; timeExit: number; grossSum: number }
const newCell = (): Cell => ({ n: 0, takeProfit: 0, stop: 0, timeExit: 0, grossSum: 0 });
/** key: side|year|S|T|H */
type Cells = Map<string, Cell>;
const cellKey = (side: number, year: number, s: number, t: number, h: number): string => `${side}|${year}|${s}|${t}|${h}`;

/** First minute offset at which each stop and target level is reached from `entry`, scanning until every stop level has fired. */
function firstTouches(m: MinuteSeries, i0: number, side: 1 | -1, last: number): { stopAt: number[]; targetAt: number[] } {
  const entry = m.open[i0]!;
  const stopAt = STOPS.map(() => Infinity);
  const targetAt = TARGETS.map(() => Infinity);
  let stopsLeft = STOPS.length;
  for (let i = i0; i <= last && stopsLeft > 0; i += 1) {
    const favourable = side === 1 ? m.high[i]! / entry - 1 : 1 - m.low[i]! / entry;
    const adverse = side === 1 ? 1 - m.low[i]! / entry : m.high[i]! / entry - 1;
    TARGETS.forEach((level, k) => { if (targetAt[k] === Infinity && favourable >= level) targetAt[k] = i - i0; });
    STOPS.forEach((level, k) => { if (stopAt[k] === Infinity && adverse >= level) { stopAt[k] = i - i0; stopsLeft -= 1; } });
  }
  return { stopAt, targetAt };
}

function record(cells: Cells, side: 1 | -1, year: number, m: MinuteSeries, i0: number, touches: ReturnType<typeof firstTouches>): void {
  const entry = m.open[i0]!;
  STOPS.forEach((s, si) => TARGETS.forEach((t, ti) => HORIZONS.forEach((h) => {
    const cell = cells.get(cellKey(side, year, s, t, h)) ?? newCell();
    const tStop = touches.stopAt[si]!; const tTarget = touches.targetAt[ti]!;
    cell.n += 1;
    if (tTarget < tStop && tTarget < h) { cell.takeProfit += 1; cell.grossSum += t; }
    else if (tStop < h) { cell.stop += 1; cell.grossSum -= s; }
    else { cell.timeExit += 1; cell.grossSum += side * (m.close[i0 + h - 1]! / entry - 1); }
    cells.set(cellKey(side, year, s, t, h), cell);
  })));
}

function sampleEntries(m: MinuteSeries): Cells {
  const cells: Cells = new Map();
  const maxHorizon = Math.max(...HORIZONS);
  const lastStart = m.open.length - maxHorizon - 1;
  for (let i0 = 0; i0 < lastStart; i0 += SAMPLE_STEP) {
    if (!Number.isFinite(m.open[i0]!)) continue;
    const year = new Date(m.start + i0 * MINUTE_MS).getUTCFullYear();
    for (const side of [1, -1] as const) record(cells, side, year, m, i0, firstTouches(m, i0, side, i0 + maxHorizon - 1));
  }
  return cells;
}

/** Zigzag swings on 1m extremes: a leg ends when price retraces `reversal` from its extreme. Returns swing sizes (fraction of start price). */
function zigzag(m: MinuteSeries, reversal: number, from: number, to: number): number[] {
  const swings: number[] = [];
  let pivot = NaN; let extreme = NaN; let dir = 0;
  for (let i = from; i < to; i += 1) {
    const high = m.high[i]!; const low = m.low[i]!;
    if (!Number.isFinite(high)) continue;
    if (!Number.isFinite(pivot)) { pivot = extreme = (high + low) / 2; continue; }
    if (dir >= 0 && high > extreme) { extreme = high; dir = 1; }
    else if (dir <= 0 && low < extreme) { extreme = low; dir = -1; }
    const retrace = dir === 1 ? 1 - low / extreme : dir === -1 ? high / extreme - 1 : 0;
    if (dir !== 0 && retrace >= reversal) { swings.push(Math.abs(extreme / pivot - 1)); pivot = extreme; extreme = dir === 1 ? low : high; dir = -dir; }
  }
  return swings;
}

function swingCeiling(m: MinuteSeries): Record<string, Record<number, { swingsPerYear: number; meanSize: number; oracleNetPctPerYear: number }>> {
  const out: Record<string, Record<number, { swingsPerYear: number; meanSize: number; oracleNetPctPerYear: number }>> = {};
  for (const year of YEARS) {
    const from = Math.max(0, (Date.UTC(year, 0, 1) - m.start) / MINUTE_MS); const to = Math.min(m.open.length, (Date.UTC(year + 1, 0, 1) - m.start) / MINUTE_MS);
    if (from >= to) continue;
    out[year] = {};
    for (const r of SWING_THRESHOLDS) {
      const sizes = zigzag(m, r, from, to).filter((x) => x >= r);
      out[year]![r] = { swingsPerYear: sizes.length, meanSize: sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length), oracleNetPctPerYear: sizes.reduce((a, b) => a + b - ROUND_TRIP_COST, 0) * 100 };
    }
  }
  return out;
}

const pct = (x: number, digits = 2): string => `${(x * 100).toFixed(digits)}%`;

function printTable(symbol: string, cells: Cells, horizon: number): void {
  console.log(`\n== ${symbol}, horizon ${horizon / 60}h (pooled 2021-2024; net = gross - 12 bps)`);
  console.log('side stop  target |   n    TP%   SL%  time%  benchmark |  gross%/trade  net%/trade  netR');
  for (const side of [1, -1]) for (const s of STOPS) for (const t of TARGETS) {
    const total = newCell();
    for (const year of YEARS) { const c = cells.get(cellKey(side, year, s, t, horizon)); if (c) { total.n += c.n; total.takeProfit += c.takeProfit; total.stop += c.stop; total.timeExit += c.timeExit; total.grossSum += c.grossSum; } }
    const gross = total.grossSum / total.n;
    console.log(`${side === 1 ? 'LONG ' : 'SHORT'} ${pct(s, 1).padEnd(5)} ${pct(t, 0).padEnd(5)} | ${String(total.n).padStart(6)} ${pct(total.takeProfit / total.n, 1).padStart(6)} ${pct(total.stop / total.n, 1).padStart(6)} ${pct(total.timeExit / total.n, 1).padStart(6)}  ${pct(s / (s + t), 1).padStart(7)}   | ${pct(gross, 3).padStart(10)} ${pct(gross - ROUND_TRIP_COST, 3).padStart(10)} ${((gross - ROUND_TRIP_COST) / s).toFixed(3).padStart(8)}`);
  }
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = {};
  for (const symbol of SYMBOLS) {
    const minutes = await loadMinutes(symbol);
    const cells = sampleEntries(minutes);
    for (const h of HORIZONS) printTable(symbol, cells, h);
    const ceiling = swingCeiling(minutes);
    console.log(`\n${symbol} swing ceiling (perfect hindsight, after 12 bps): ${JSON.stringify(ceiling[2023] ?? {})}`);
    report[symbol] = { cells: Object.fromEntries(cells), swingCeiling: ceiling };
  }
  mkdirSync('research-runs', { recursive: true });
  const out = `research-runs/opportunity-map-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '')}Z.json`;
  writeFileSync(out, JSON.stringify({ from: FROM, to: TO, step: SAMPLE_STEP, cost: ROUND_TRIP_COST, report }, null, 1));
  console.log(`\nreport: ${out}`);
}

await main();
