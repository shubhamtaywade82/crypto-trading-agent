/**
 * §13 weekly long/short rank portfolios across all USDⓈ-M perps in the local archive mirror (research only).
 * Development window only: the panel ends before 2025-01-01 unless --sealed is passed for one frozen variant.
 *
 *   npx tsx scripts/xsection-backtest.ts [--sealed X2]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseFundingCsv } from '../src/backtesting/archiveDerivatives.js';
import { readFirstZipEntry } from '../src/backtesting/archiveKlines.js';
import { bootstrapMean, mulberry32, quantileSorted } from '../src/research/Bootstrap.js';
import { buildWeeks, DAY_MS, listingEvents, listingNet, netReturn, randomBasketMeans, randomPeerMeans, runPortfolio, scoreWeeks, SIGNALS, type FundingSeries, type Panel, type SignalId, type SymbolDays, type WeekResult, type WeekUniverse } from '../src/research/CrossSection.js';
import { computeDeflatedSharpeFromReturns } from '../src/research/DeflatedSharpe.js';
import { minimumDetectableEffect } from '../src/research/SampleSize.js';

const ROOT = path.resolve('data/cache/vision/monthly');
const PANEL_START = Date.UTC(2020, 8, 1);
const sealedId = process.argv.includes('--sealed') ? (process.argv[process.argv.indexOf('--sealed') + 1] as SignalId) : null;
const PANEL_END = sealedId ? Date.UTC(2026, 10, 1) : Date.UTC(2025, 0, 1);
const FIRST_MONDAY = sealedId ? Date.UTC(2025, 0, 6) : Date.UTC(2021, 2, 1);
const LAST_MONDAY = sealedId ? Date.UTC(2026, 9, 26) : Date.UTC(2024, 11, 30);
const HALF_SPLIT = Date.UTC(2023, 0, 1);
const TRIALS = 54;
const RANDOM_RUNS = 2000;
const EXCLUDED = /^(BTCDOM|DEFI|FOOTBALL|BLUEBIRD|USDC)/;

function readKlineZip(file: string, panelDays: number, data: SymbolDays): void {
  for (const line of readFirstZipEntry(readFileSync(file)).split('\n')) {
    const c = line.trim().split(',').map(Number);
    const day = Math.round((c[0]! - PANEL_START) / DAY_MS);
    if (c.length < 8 || !Number.isFinite(c[0]!) || day < 0 || day >= panelDays) continue;
    data.open[day] = c[1]!; data.close[day] = c[4]!; data.quoteVolume[day] = c[7]!;
  }
}

function loadSymbol(symbol: string, panelDays: number): { days: SymbolDays; funding: FundingSeries } | null {
  const klineDir = path.join(ROOT, 'klines', symbol, '1d');
  if (!existsSync(klineDir)) return null;
  const days: SymbolDays = { open: new Float64Array(panelDays).fill(NaN), close: new Float64Array(panelDays).fill(NaN), quoteVolume: new Float64Array(panelDays).fill(NaN) };
  const inRange = (file: string): boolean => { const t = Date.parse(`${file.match(/(\d{4}-\d{2})\.zip$/)?.[1]}-01T00:00:00Z`); return t >= PANEL_START && t < PANEL_END; };
  for (const f of readdirSync(klineDir).filter(inRange)) readKlineZip(path.join(klineDir, f), panelDays, days);
  const funding: FundingSeries = { time: [], cum: [] };
  const fundingDir = path.join(ROOT, 'fundingRate', symbol);
  const points = existsSync(fundingDir) ? readdirSync(fundingDir).filter(inRange).sort().flatMap((f) => parseFundingCsv(readFirstZipEntry(readFileSync(path.join(fundingDir, f))))) : [];
  let total = 0;
  for (const p of points.sort((a, b) => a.time - b.time)) { total += p.rate; funding.time.push(p.time); funding.cum.push(total); }
  return { days, funding };
}

function loadPanel(): Panel {
  const panelDays = (PANEL_END - PANEL_START) / DAY_MS;
  const symbols = readdirSync(path.join(ROOT, 'klines')).filter((s) => s.endsWith('USDT') && !EXCLUDED.test(s)).sort();
  const panel: Panel = { start: PANEL_START, days: panelDays, symbols: [], data: [], funding: [] };
  for (const symbol of symbols) {
    const loaded = loadSymbol(symbol, panelDays);
    if (!loaded) continue;
    panel.symbols.push(symbol); panel.data.push(loaded.days); panel.funding.push(loaded.funding);
  }
  return panel;
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
const sd = (xs: readonly number[]): number => { const m = mean(xs); return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const monthOf = (t: number): string => new Date(t).toISOString().slice(0, 7);

function beta(weeks: readonly WeekResult[]): number {
  const x = weeks.map((w) => w.marketReturn);
  const y = weeks.map((w) => netReturn(w));
  const mx = mean(x); const my = mean(y);
  return x.reduce((s, v, i) => s + (v - mx) * (y[i]! - my), 0) / x.reduce((s, v) => s + (v - mx) ** 2, 0);
}

function topContributors(weeks: readonly WeekResult[], symbols: readonly string[]): string {
  const totals = new Map<number, number>();
  for (const w of weeks) for (const [s, v] of w.contributions) totals.set(s, (totals.get(s) ?? 0) + v);
  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  const top = [...totals.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
  return top.map(([s, v]) => `${symbols[s]} ${(v * 100).toFixed(1)}%`).join(', ') + ` (total ${(total * 100).toFixed(1)}%)`;
}

interface Verdict { id: SignalId; checks: { id: string; pass: boolean; detail: string }[]; report: Record<string, unknown>; weekly: number[] }

function evaluate(panel: Panel, weeks: WeekUniverse[], id: SignalId, trialVariance: number, random: number[]): Verdict {
  const scores = scoreWeeks(panel, weeks, id);
  const base = runPortfolio(weeks, scores, 6);
  const net = base.map((w) => netReturn(w));
  const boot = bootstrapMean(base.map((w, i) => ({ value: net[i]!, cluster: monthOf(w.time) })), { confidence: 0.8, seed: 7 });
  const early = base.filter((w) => w.time < HALF_SPLIT).map((w) => netReturn(w));
  const late = base.filter((w) => w.time >= HALF_SPLIT).map((w) => netReturn(w));
  const stressed = mean(base.map((w) => netReturn(w, 1.5)));
  const neighbours = [4, 8].map((q) => mean(runPortfolio(weeks, scores, q).map((w) => netReturn(w))));
  const p95 = quantileSorted([...random].sort((a, b) => a - b), 0.95);
  const dsr = net.length > 2 ? computeDeflatedSharpeFromReturns({ returns: net, samplingFrequencyMs: 7 * DAY_MS, trialCount: TRIALS, trialSharpeVariance: trialVariance }).dsr : NaN;
  const sorted = [...net].sort((a, b) => a - b);
  const trimmed = sorted.slice(0, Math.floor(sorted.length * 0.95));
  const mde = minimumDetectableEffect({ n: net.length, sigmaR: sd(net), alpha: 0.2, power: 0.8 }).mdeR;
  const checks = [
    { id: '1-weeks>=100', pass: net.length >= 100, detail: `${net.length} weeks` },
    { id: '2-mean>0-and-lcb>0', pass: mean(net) > 0 && (boot?.ciLow ?? -1) > 0, detail: `mean ${(mean(net) * 100).toFixed(3)}%/wk, 90% LCB ${((boot?.ciLow ?? NaN) * 100).toFixed(3)}%` },
    { id: '3-both-halves', pass: mean(early) > 0 && mean(late) > 0, detail: `2021-22 ${(mean(early) * 100).toFixed(3)}% (${early.length}), 2023-24 ${(mean(late) * 100).toFixed(3)}% (${late.length})` },
    { id: '4-costs-1.5x', pass: stressed > 0, detail: `${(stressed * 100).toFixed(3)}%/wk` },
    { id: '5-q4-q8', pass: neighbours.every((v) => v > 0), detail: `Q4 ${(neighbours[0]! * 100).toFixed(3)}%, Q8 ${(neighbours[1]! * 100).toFixed(3)}%` },
    { id: '6-beats-random', pass: mean(net) > p95, detail: `net ${(mean(net) * 100).toFixed(3)}% vs random p95 ${(p95 * 100).toFixed(3)}%` },
    { id: '7-dsr>0.95', pass: dsr > 0.95, detail: `DSR ${dsr.toFixed(3)} (N=${TRIALS})` },
  ];
  const report = {
    weeks: net.length, grossPct: mean(base.map((w) => w.gross)) * 100, fundingPct: mean(base.map((w) => w.funding)) * 100, costPct: mean(base.map((w) => w.cost)) * 100,
    netPct: mean(net) * 100, weeklySdPct: sd(net) * 100, mdeWeeklyPct: mde * 100, beta: beta(base), meanWithoutBest5pctPct: mean(trimmed) * 100, top5Symbols: topContributors(base, panel.symbols),
  };
  return { id, checks, report, weekly: net };
}

const LISTING_VARIANTS = [{ delay: 3, hold: 7 }, { delay: 3, hold: 21 }, { delay: 7, hold: 7 }, { delay: 7, hold: 21 }];
const LISTING_TRIALS = 58;
const LISTING_FIRST = Date.UTC(2021, 2, 1);
const LISTING_LAST = Date.UTC(2024, 11, 30);

function evaluateListings(panel: Panel): void {
  const btc = panel.symbols.indexOf('BTCUSDT');
  const runs = LISTING_VARIANTS.map((v) => ({ ...v, events: listingEvents(panel, btc, v.delay, v.hold, LISTING_FIRST, LISTING_LAST) }));
  const netsOf = (events: typeof runs[number]['events'], scale = 1): number[] => events.map((e) => listingNet(e, scale));
  const variance = Math.max(sd(runs.map((r) => sharpeOf(netsOf(r.events)))) ** 2, 9.29e-3);
  const means = runs.map((r) => mean(netsOf(r.events)));
  runs.forEach((r, i) => {
    const net = netsOf(r.events);
    const boot = bootstrapMean(r.events.map((e, k) => ({ value: net[k]!, cluster: monthOf(e.time) })), { confidence: 0.8, seed: 7 });
    const random = randomPeerMeans(r.events, RANDOM_RUNS, mulberry32(21));
    const p95 = quantileSorted(random.sort((a, b) => a - b), 0.95);
    const dsr = computeDeflatedSharpeFromReturns({ returns: net, samplingFrequencyMs: DAY_MS, trialCount: LISTING_TRIALS, trialSharpeVariance: variance }).dsr;
    const early = netsOf(r.events.filter((e) => e.time < HALF_SPLIT)); const late = netsOf(r.events.filter((e) => e.time >= HALF_SPLIT));
    const checks = [
      { id: '1-events>=100', pass: net.length >= 100, detail: `${net.length} events` },
      { id: '2-mean>0-and-lcb>0', pass: mean(net) > 0 && (boot?.ciLow ?? -1) > 0, detail: `mean ${(mean(net) * 100).toFixed(2)}%, 90% LCB ${((boot?.ciLow ?? NaN) * 100).toFixed(2)}%` },
      { id: '3-both-halves', pass: mean(early) > 0 && mean(late) > 0, detail: `early ${(mean(early) * 100).toFixed(2)}% (${early.length}), late ${(mean(late) * 100).toFixed(2)}% (${late.length})` },
      { id: '4-costs-3x', pass: mean(netsOf(r.events, 3)) > 0, detail: `${(mean(netsOf(r.events, 3)) * 100).toFixed(2)}%` },
      { id: '5-other-variants', pass: means.every((m) => m > 0), detail: means.map((m) => `${(m * 100).toFixed(2)}%`).join(', ') },
      { id: '6-beats-random', pass: mean(net) > p95, detail: `net ${(mean(net) * 100).toFixed(2)}% vs random p95 ${(p95 * 100).toFixed(2)}%` },
      { id: '7-dsr>0.95', pass: dsr > 0.95, detail: `DSR ${dsr.toFixed(3)} (N=${LISTING_TRIALS})` },
    ];
    const sorted = [...net].sort((a, b) => a - b);
    console.log(`\n== NL D=${r.delay} H=${r.hold}: ${checks.every((c) => c.pass) ? 'PASSED_DEV' : 'REJECTED'} (${checks.filter((c) => c.pass).length}/7)`);
    for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}`);
    console.log(`  worst ${(sorted[0]! * 100).toFixed(1)}%, p01 ${(quantileSorted(sorted, 0.01) * 100).toFixed(1)}%, p99 ${(quantileSorted(sorted, 0.99) * 100).toFixed(1)}%, gross-short-only mean ${(mean(r.events.map((e) => -e.ret)) * 100).toFixed(2)}%, btc leg mean ${(mean(r.events.map((e) => e.btcRet)) * 100).toFixed(2)}%`);
  });
}

function sharpeOf(xs: readonly number[]): number { return mean(xs) / sd(xs); }

function main(): void {
  const panel = loadPanel();
  console.log(`panel: ${panel.symbols.length} symbols, ${panel.days} days${sealedId ? ' (SEALED window, one frozen variant)' : ''}`);
  if (process.argv.includes('--listings')) return evaluateListings(panel);
  const weeks = buildWeeks(panel, FIRST_MONDAY, LAST_MONDAY);
  console.log(`weeks: ${weeks.length}, universe size median ${weeks.map((w) => w.symbols.length).sort((a, b) => a - b)[Math.floor(weeks.length / 2)]}`);
  const ids = sealedId ? [sealedId] : [...SIGNALS];
  const sharpes = SIGNALS.map((id) => sharpeOf(runPortfolio(weeks, scoreWeeks(panel, weeks, id), 6).map((w) => netReturn(w))));
  const trialVariance = sd(sharpes) ** 2;
  const random = randomBasketMeans(weeks, 6, RANDOM_RUNS, mulberry32(13));
  const verdicts = ids.map((id) => evaluate(panel, weeks, id, trialVariance, random));
  for (const v of verdicts) {
    console.log(`\n== ${v.id}: ${v.checks.every((c) => c.pass) ? 'PASSED_DEV' : 'REJECTED'} (${v.checks.filter((c) => c.pass).length}/7)`);
    for (const c of v.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}`);
    console.log(`  ${JSON.stringify(v.report)}`);
  }
  mkdirSync('research-runs', { recursive: true });
  const out = `research-runs/xsection-${sealedId ? 'sealed' : 'dev'}-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '')}Z.json`;
  writeFileSync(out, JSON.stringify({ trials: TRIALS, trialSharpeVariance: trialVariance, verdicts: verdicts.map(({ weekly, ...rest }) => rest) }, null, 1));
  console.log(`\nreport: ${out}`);
}

main();
