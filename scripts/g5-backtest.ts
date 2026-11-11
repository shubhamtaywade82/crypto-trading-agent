/**
 * G5: walk-forward test of the pre-registered G4 candidates (docs/NEMESIS_G4_STRATEGY_SPECS.md) on the local mirror.
 * Development window only by default. The untouched OOS window is never read here unless `--oos <strategy>` is passed
 * for a strategy that already passed development; that run is one-shot by protocol.
 *
 *   npx tsx scripts/g5-backtest.ts
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadFunding, loadMetrics, type FundingPoint, type MetricsPoint } from '../src/backtesting/archiveDerivatives.js';
import { fetchArchiveKlines, fetchArchiveMarkPriceKlines } from '../src/backtesting/archiveKlines.js';
import { resampleCandles } from '../src/market/TimeframeEngine.js';
import { mulberry32 } from '../src/research/Bootstrap.js';
import { breakoutB1, fundingFadeE1, fundingStates, hourContext, meanReversionC1, momentumBenchmark, type HourContext } from '../src/research/CandidateSignals.js';
import { acceptance, type Fold, type SymbolTrade } from '../src/research/G5Acceptance.js';
import { classifyRegime, regimeFeatures, type RegimeFeatures } from '../src/research/RegimeClassifier.js';
import { HOUR_MS, MINUTE_MS, runStrategy, simulateTrade, type Market, type MinuteSeries, type Signal } from '../src/research/SignalBacktest.js';
import type { Candle } from '../src/types.js';

const SYMBOLS = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT'];
const DEV_FROM = Date.UTC(2023, 0, 1);
const DEV_TO = Date.UTC(2025, 0, 1);
const LEVERAGE = 5; // MIN_LEVERAGE default; at 1% risk with ATR stops the position is far below 1x notional
const MMR = 0.01; // Binance tier-1 maintenance margin rate for these contracts' smallest bracket

type Factory = (sym: SymbolData) => (hour: number) => Signal | null;
interface Variant { id: string; strategy: string; axes: number[]; make: Factory }
interface SymbolData { symbol: string; market: Market; ctx: HourContext; hours: number }

async function minuteSeries(symbol: string, mark: boolean, from: number, to: number): Promise<{ series: MinuteSeries; hours: Candle[] }> {
  const n = (to - from) / MINUTE_MS;
  const series: MinuteSeries = { start: from, open: new Float64Array(n).fill(NaN), high: new Float64Array(n).fill(NaN), low: new Float64Array(n).fill(NaN), close: new Float64Array(n).fill(NaN) };
  const hours: Candle[] = [];
  for (let start = from; start < to;) {
    const d = new Date(start);
    const end = Math.min(to, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const { candles } = await (mark ? fetchArchiveMarkPriceKlines(symbol, '1m', start, end) : fetchArchiveKlines(symbol, '1m', start, end));
    for (const c of candles) {
      const i = (c.openTime - from) / MINUTE_MS;
      series.open[i] = c.open; series.high[i] = c.high; series.low[i] = c.low; series.close[i] = c.close;
    }
    if (!mark) hours.push(...resampleCandles(candles, '1h'));
    start = end;
  }
  return { series, hours };
}

async function loadSymbol(symbol: string, btc: Map<number, RegimeFeatures>, from: number, to: number) {
  const trade = await minuteSeries(symbol, false, from, to);
  const mark = await minuteSeries(symbol, true, from, to);
  const features = regimeFeatures(trade.hours);
  const regimes = trade.hours.map((b, i) => classifyRegime(features[i]!, btc.get(b.openTime)));
  const funding = await loadFunding(symbol, from, to);
  const metrics = await loadMetrics(symbol, from - 2 * 86_400_000, to);
  const fundingByMinute = new Map(funding.points.map((p) => [Math.floor((p.time - from) / MINUTE_MS), p.rate]));
  const market: Market = { trade: trade.series, mark: mark.series, fundingByMinute, hourStart: from, leverage: LEVERAGE, mmr: MMR };
  const data: SymbolData = { symbol, market, ctx: hourContext(trade.hours, features, regimes), hours: trade.hours.length };
  return { data, funding: funding.points, metrics: metrics.points };
}

interface FundingInputs { states: ReturnType<typeof fundingStates>; points: FundingPoint[]; metrics: MetricsPoint[] }

function variants(e1: Map<string, FundingInputs>): Variant[] {
  const out: Variant[] = [];
  [24, 48, 96].forEach((n, a) => [0.2, 0.3, 0.4].forEach((p, b) => out.push({ id: `B1:N=${n},P=${p}`, strategy: 'B1', axes: [a, b], make: (s) => breakoutB1(s.ctx, n, p) })));
  [2, 2.5, 3].forEach((k, a) => [24, 48, 96].forEach((l, b) => out.push({ id: `C1:k=${k},L=${l}`, strategy: 'C1', axes: [a, b], make: (s) => meanReversionC1(s.ctx, k, l) })));
  [0.9, 0.95, 0.975].forEach((q, a) => [false, true].forEach((oi, b) => out.push({
    id: `E1:Q=${q * 100},OI=${oi ? 'on' : 'off'}`, strategy: 'E1', axes: [a, b],
    make: (s) => { const d = e1.get(`${s.symbol}|${q}`)!; return fundingFadeE1(s.ctx, d, d.metrics, { quantile: q, requireOiRise: oi }); },
  })));
  return out;
}

const FOLDS: Fold[] = [0, 1, 2, 3, 4, 5].map((k) => {
  const testFrom = Date.UTC(2023, 6 + 3 * k, 1);
  return { trainFrom: Date.UTC(2023, 3 * k, 1), trainTo: testFrom, testFrom, testTo: Date.UTC(2023, 9 + 3 * k, 1) };
});

/** Random entries matched to each real trade: same symbol, side, regime, stop in ATR units, holding time; same fold window. */
function matchedRandom(trades: SymbolTrade[], data: Map<string, SymbolData>, seed: number): SymbolTrade[] {
  const rand = mulberry32(seed);
  const out: SymbolTrade[] = [];
  for (const t of trades) {
    const s = data.get(t.symbol)!;
    const atrMultiple = t.stopDistance / s.ctx.atr[t.hour]!;
    const fold = FOLDS.find((f) => t.entryTime >= f.testFrom && t.entryTime < f.testTo)!;
    const candidates: number[] = [];
    for (let h = Math.ceil((fold.testFrom - s.ctx.hourStart) / HOUR_MS); h < (fold.testTo - s.ctx.hourStart) / HOUR_MS - 1; h += 1) if (s.ctx.regimes[h] === s.ctx.regimes[t.hour]) candidates.push(h);
    if (candidates.length === 0) continue;
    const hour = candidates[Math.floor(rand() * candidates.length)]!;
    const holdMs = Math.max(HOUR_MS, Math.ceil((t.exitTime - t.entryTime) / HOUR_MS) * HOUR_MS);
    const sim = simulateTrade(s.market, { side: t.side, hour, label: 'BENCH:random', stopDistance: atrMultiple * s.ctx.atr[hour]!, maxHoldMs: holdMs, sizeMultiplier: 1 });
    if (sim) out.push({ ...sim, symbol: t.symbol });
  }
  return out;
}

async function main(): Promise<void> {
  const btcHours = (await minuteSeries('BTCUSDT', false, DEV_FROM, DEV_TO)).hours;
  const btcFeatures = regimeFeatures(btcHours);
  const btc = new Map(btcHours.map((b, i) => [b.openTime, btcFeatures[i]!]));
  const data = new Map<string, SymbolData>();
  const e1 = new Map<string, FundingInputs>();
  for (const symbol of SYMBOLS) {
    const loaded = await loadSymbol(symbol, btc, DEV_FROM, DEV_TO);
    data.set(symbol, loaded.data);
    for (const q of [0.9, 0.95, 0.975]) e1.set(`${symbol}|${q}`, { states: fundingStates(loaded.funding, q), points: loaded.funding, metrics: loaded.metrics });
    console.log(`loaded ${symbol}: ${loaded.data.hours} hours, ${loaded.funding.length} funding, ${loaded.metrics.length} metrics`);
  }
  const allVariants = variants(e1);
  const tradesByVariant = new Map<string, SymbolTrade[]>();
  for (const v of allVariants) {
    const trades: SymbolTrade[] = [];
    for (const s of data.values()) trades.push(...runStrategy(s.market, s.hours, v.make(s)).map((t) => ({ ...t, symbol: s.symbol })));
    tradesByVariant.set(v.id, trades);
    console.log(`  ${v.id.padEnd(22)} trades ${trades.length}`);
  }
  const momentum: SymbolTrade[] = [];
  for (const s of data.values()) momentum.push(...runStrategy(s.market, s.hours, momentumBenchmark(s.ctx)).map((t) => ({ ...t, symbol: s.symbol })));
  const results = ['B1', 'C1', 'E1'].map((strategy) => acceptance({
    strategy, variants: allVariants.filter((v) => v.strategy === strategy), allVariants, tradesByVariant, folds: FOLDS, momentum,
    randomFor: (trades) => matchedRandom(trades, data, 2026), symbols: SYMBOLS, trialCount: 27,
  }));
  for (const r of results) console.log(`\n${r.strategy}: ${r.verdict}\n${r.lines.join('\n')}`);
  const commit = execSync('git rev-parse --short HEAD').toString().trim();
  const dirty = execSync('git status --porcelain -- src scripts').toString().trim().length > 0;
  mkdirSync('research-runs', { recursive: true });
  const out = `research-runs/g5-dev-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}Z.json`;
  writeFileSync(out, JSON.stringify({ commit, dirty, window: { from: '2023-01-01', to: '2025-01-01' }, folds: FOLDS, leverage: LEVERAGE, mmr: MMR, notTested: { E2: 'needs a historical MarketState replay (crowding, sweeps, liquidity pools) for CrowdingAgent; not built' }, results: results.map(({ lines, ...r }) => r) }, null, 1));
  console.log(`\nreport: ${out}`);
}

await main();
