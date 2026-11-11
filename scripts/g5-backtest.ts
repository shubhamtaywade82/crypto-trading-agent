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
import { fetchArchiveMarkPriceKlines, mirrorFirstFetch } from '../src/backtesting/archiveKlines.js';
import { fetchFlowMinutes } from '../src/market/directional/archive-flow.js';
import { crowdingSignalAt, type CrowdingData } from '../src/research/CrowdingReplay.js';
import { resampleCandles } from '../src/market/TimeframeEngine.js';
import { mulberry32 } from '../src/research/Bootstrap.js';
import { breakoutB1, fundingFadeE1, fundingStates, hourContext, hourOfDayT1, meanReversionC1, weeklyMomentumL1, dailyDonchianL3, momentumBenchmark, settlementReboundT2, type HourContext } from '../src/research/CandidateSignals.js';
import { acceptance, type Fold, type SymbolTrade } from '../src/research/G5Acceptance.js';
import { classifyRegime, regimeFeatures, type RegimeFeatures } from '../src/research/RegimeClassifier.js';
import { HOUR_MS, MINUTE_MS, runOnBars, runStrategy, simulateTrade, type Market, type MinuteSeries, type Signal, type Trade } from '../src/research/SignalBacktest.js';
import type { Candle } from '../src/types.js';

const SYMBOLS = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT'];
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
// Defaults are the §4 development window; §11 replays an earlier window with --from/--to/--first-test.
const DEV_FROM = day(arg('from', '2023-01-01'));
const DEV_TO = day(arg('to', '2025-01-01'));
const FIRST_TEST = day(arg('first-test', '2023-07-01'));
const STRATEGIES = arg('strategies', 'B1,C1,E1,E2,T1,T2,T1M,L1,L3').split(',');
const TRIALS = Number(arg('trials', '42'));
/** Optional: the trial Sharpe variance measured on a fuller search, when this run simulates only a few variants. */
const TRIAL_SR_VAR = arg('trial-sr-var', '') === '' ? undefined : Number(arg('trial-sr-var', ''));
const NEEDS_POSITIONING = STRATEGIES.some((s) => s === 'E1' || s === 'E2');
const LEVERAGE = 5; // MIN_LEVERAGE default; at 1% risk with ATR stops the position is far below 1x notional
const MMR = 0.01; // Binance tier-1 maintenance margin rate for these contracts' smallest bracket

type Factory = (sym: SymbolData) => (hour: number) => Signal | null;
interface Variant { id: string; strategy: string; axes: number[]; make?: Factory; runTrades?: (sym: SymbolData) => Trade[] }
interface SymbolData { symbol: string; market: Market; ctx: HourContext; hours: number; crowding: CrowdingData }

interface Loaded { series: MinuteSeries; hours: Candle[]; quarters: Candle[]; takerByHour: Map<number, { buy: number; total: number }> }

const emptySeries = (from: number, n: number): MinuteSeries => ({ start: from, open: new Float64Array(n).fill(NaN), high: new Float64Array(n).fill(NaN), low: new Float64Array(n).fill(NaN), close: new Float64Array(n).fill(NaN) });

function fill(series: MinuteSeries, candles: readonly Candle[]): void {
  for (const c of candles) {
    const i = (c.openTime - series.start) / MINUTE_MS;
    series.open[i] = c.open; series.high[i] = c.high; series.low[i] = c.low; series.close[i] = c.close;
  }
}

/** Trade 1m bars with taker volume (full-column archive rows), month by month, plus 1h/15m bars and hourly taker volume. */
async function tradeMinutes(symbol: string, from: number, to: number): Promise<Loaded> {
  const loaded: Loaded = { series: emptySeries(from, (to - from) / MINUTE_MS), hours: [], quarters: [], takerByHour: new Map() };
  for (let start = from; start < to;) {
    const d = new Date(start);
    const end = Math.min(to, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const { minutes } = await fetchFlowMinutes(symbol, start, end, mirrorFirstFetch);
    const candles = minutes.map((m) => ({ openTime: m.openTime, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.baseVolume }));
    fill(loaded.series, candles);
    for (const m of minutes) {
      const hour = Math.floor(m.openTime / HOUR_MS) * HOUR_MS;
      const acc = loaded.takerByHour.get(hour) ?? { buy: 0, total: 0 };
      acc.buy += m.takerBuyBaseVolume; acc.total += m.baseVolume;
      loaded.takerByHour.set(hour, acc);
    }
    loaded.hours.push(...resampleCandles(candles, '1h'));
    loaded.quarters.push(...resampleCandles(candles, '15m'));
    start = end;
  }
  return loaded;
}

async function markMinutes(symbol: string, from: number, to: number): Promise<MinuteSeries> {
  const series = emptySeries(from, (to - from) / MINUTE_MS);
  for (let start = from; start < to;) {
    const d = new Date(start);
    const end = Math.min(to, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    fill(series, (await fetchArchiveMarkPriceKlines(symbol, '1m', start, end)).candles);
    start = end;
  }
  return series;
}

async function loadSymbol(symbol: string, btc: Map<number, RegimeFeatures>, from: number, to: number) {
  const trade = await tradeMinutes(symbol, from, to);
  const mark = { series: await markMinutes(symbol, from, to) };
  const features = regimeFeatures(trade.hours);
  const regimes = trade.hours.map((b, i) => classifyRegime(features[i]!, btc.get(b.openTime)));
  const funding = await loadFunding(symbol, from, to);
  const metrics = NEEDS_POSITIONING ? await loadMetrics(symbol, from, to) : { points: [], missing: [] }; // early OI lookbacks are simply unavailable
  const fundingByMinute = new Map(funding.points.map((p) => [Math.floor((p.time - from) / MINUTE_MS), p.rate]));
  const market: Market = { trade: trade.series, mark: mark.series, fundingByMinute, hourStart: from, leverage: LEVERAGE, mmr: MMR };
  const markBefore = (time: number): number => {
    const i = (time - from) / MINUTE_MS - 1;
    return Number.isFinite(mark.series.close[i]!) ? mark.series.close[i]! : trade.series.close[i]!;
  };
  const crowding: CrowdingData = {
    bars15: trade.quarters, bars1h: trade.hours, bars4h: resampleCandles(trade.hours, '4h'), takerByHour: trade.takerByHour,
    metrics: metrics.points, funding: funding.points, markBefore,
  };
  const data: SymbolData = { symbol, market, ctx: hourContext(trade.hours, features, regimes), hours: trade.hours.length, crowding };
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
  [2, 2.5, 3].forEach((tau, a) => out.push({ id: `T1:tau=${tau}`, strategy: 'T1', axes: [a], make: (s) => hourOfDayT1(s.ctx, tau) }));
  [2, 2.5, 3].forEach((tau, a) => out.push({ id: `T1M:tau=${tau}`, strategy: 'T1M', axes: [a], make: (s) => passive(hourOfDayT1(s.ctx, tau), `T1M:tau=${tau}`) }));
  [7, 14, 28].forEach((l, a) => out.push({ id: `L1:L=${l}`, strategy: 'L1', axes: [a], make: (s) => weeklyMomentumL1(s.ctx, l) }));
  [10, 20, 55].forEach((n, a) => out.push({ id: `L3:N=${n}`, strategy: 'L3', axes: [a], make: (s) => dailyDonchianL3(s.ctx, n) }));
  [1, 2, 4].forEach((h, a) => out.push({ id: `T2:H=${h}`, strategy: 'T2', axes: [a], make: (s) => settlementReboundT2(s.ctx, e1.get(`${s.symbol}|0.75`)!, h) }));
  [1.2, 1.5, 2].forEach((rr, a) => out.push({
    id: `E2:minRR=${rr}`, strategy: 'E2', axes: [a],
    runTrades: (s) => runOnBars(s.market, s.crowding.bars15.length, crowdingSignalAt(s.crowding, s.ctx, rr), (k) => s.crowding.bars15[k]!.openTime + 15 * MINUTE_MS),
  }));
  return out;
}

const MAKER_WINDOW_MINUTES = 5;

/** §9: the same signal entered with a passive limit at the nominal open. */
function passive(signalAt: (hour: number) => Signal | null, label: string): (hour: number) => Signal | null {
  return (hour) => { const s = signalAt(hour); return s && { ...s, label, makerEntryWindowMinutes: MAKER_WINDOW_MINUTES }; };
}

/** 6-month train / 3-month test, stepping 3 months from FIRST_TEST until DEV_TO (§4). */
const FOLDS: Fold[] = (() => {
  const folds: Fold[] = [];
  const first = new Date(FIRST_TEST);
  const at = (months: number): number => Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + months, 1);
  for (let k = 0; at(3 * k + 3) <= DEV_TO; k += 1) folds.push({ trainFrom: at(3 * k - 6), trainTo: at(3 * k), testFrom: at(3 * k), testTo: at(3 * k + 3) });
  return folds;
})();

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
    const makerEntryWindowMinutes = t.label.startsWith('T1M') ? MAKER_WINDOW_MINUTES : undefined;
    const sim = simulateTrade(s.market, { side: t.side, hour, label: 'BENCH:random', stopDistance: atrMultiple * s.ctx.atr[hour]!, maxHoldMs: holdMs, sizeMultiplier: 1, makerEntryWindowMinutes });
    if (sim) out.push({ ...sim, symbol: t.symbol });
  }
  return out;
}

async function main(): Promise<void> {
  const btcHours = (await tradeMinutes('BTCUSDT', DEV_FROM, DEV_TO)).hours;
  const btcFeatures = regimeFeatures(btcHours);
  const btc = new Map(btcHours.map((b, i) => [b.openTime, btcFeatures[i]!]));
  const data = new Map<string, SymbolData>();
  const e1 = new Map<string, FundingInputs>();
  for (const symbol of SYMBOLS) {
    const loaded = await loadSymbol(symbol, btc, DEV_FROM, DEV_TO);
    data.set(symbol, loaded.data);
    for (const q of [0.75, 0.9, 0.95, 0.975]) e1.set(`${symbol}|${q}`, { states: fundingStates(loaded.funding, q), points: loaded.funding, metrics: loaded.metrics });
    console.log(`loaded ${symbol}: ${loaded.data.hours} hours, ${loaded.funding.length} funding, ${loaded.metrics.length} metrics`);
  }
  const allVariants = variants(e1).filter((v) => STRATEGIES.includes(v.strategy));
  const tradesByVariant = new Map<string, SymbolTrade[]>();
  for (const v of allVariants) {
    const trades: SymbolTrade[] = [];
    for (const s of data.values()) trades.push(...(v.runTrades ? v.runTrades(s) : runStrategy(s.market, s.hours, v.make!(s))).map((t) => ({ ...t, symbol: s.symbol })));
    tradesByVariant.set(v.id, trades);
    console.log(`  ${v.id.padEnd(22)} trades ${trades.length}`);
  }
  const momentum: SymbolTrade[] = [];
  for (const s of data.values()) momentum.push(...runStrategy(s.market, s.hours, momentumBenchmark(s.ctx)).map((t) => ({ ...t, symbol: s.symbol })));
  const results = STRATEGIES.map((strategy) => acceptance({
    strategy, variants: allVariants.filter((v) => v.strategy === strategy), allVariants, tradesByVariant, folds: FOLDS, momentum,
    randomFor: (trades) => matchedRandom(trades, data, 2026), symbols: SYMBOLS, trialCount: TRIALS, trialSharpeVariance: TRIAL_SR_VAR,
  }));
  for (const r of results) console.log(`\n${r.strategy}: ${r.verdict}\n${r.lines.join('\n')}`);
  const commit = execSync('git rev-parse --short HEAD').toString().trim();
  const dirty = execSync('git status --porcelain -- src scripts').toString().trim().length > 0;
  mkdirSync('research-runs', { recursive: true });
  const out = `research-runs/g5-dev-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}Z.json`;
  writeFileSync(out, JSON.stringify({ commit, dirty, window: { from: arg('from', '2023-01-01'), to: arg('to', '2025-01-01') }, strategies: STRATEGIES, trials: TRIALS, trialSharpeVarianceOverride: TRIAL_SR_VAR ?? null, folds: FOLDS, leverage: LEVERAGE, mmr: MMR, e2ReplayNotes: 'funding = last settled rate (live: predicted); taker ratio = last closed hour from 1m klines; ratios = 5m archive snapshot usable at bar close; 48h time cap', results: results.map(({ lines, ...r }) => r) }, null, 1));
  console.log(`\nreport: ${out}`);
}

await main();
