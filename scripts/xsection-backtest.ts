/**
 * §13 weekly long/short rank portfolios across all USDⓈ-M perps in the local archive mirror (research only).
 * Development window only: the panel ends before 2025-01-01 unless --sealed is passed for one frozen variant.
 *
 *   npx tsx scripts/xsection-backtest.ts [--sealed X2]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseFundingCsv, parseMetricsCsv } from '../src/backtesting/archiveDerivatives.js';
import { readFirstZipEntry } from '../src/backtesting/archiveKlines.js';
import { bootstrapMean, mulberry32, quantileSorted } from '../src/research/Bootstrap.js';
import { loadPanel as loadPanelFiles } from '../src/research/PanelLoader.js';
import { listingEvents, listingNet, moveEvents, randomPeerMeans } from '../src/research/ListingEvents.js';
import { buildWeeks, carryScores, DAY_MS, netReturn, randomBasketMeans, randomCarryMeans, runCarry, runPortfolio, scoreWeeks, SIGNALS, type FundingSeries, type Panel, type SignalId, type SymbolDays, type WeekResult, type WeekUniverse } from '../src/research/CrossSection.js';
import { computeDeflatedSharpeFromReturns } from '../src/research/DeflatedSharpe.js';
import { minimumDetectableEffect } from '../src/research/SampleSize.js';

const PANEL_START = Date.UTC(2019, 8, 1); // early enough to see every contract's real listing day (age signal)
const flag = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; };
const SKIP_TOP = Number(flag('skip-top', '0'));
const COST_STRESS = Number(flag('cost-stress', '1.5'));
const GATE_DSR = flag('gate-dsr', 'true') === 'true';
const ONLY = flag('ids', '');
const sealedId = process.argv.includes('--sealed') ? (process.argv[process.argv.indexOf('--sealed') + 1] as SignalId) : null;
const PANEL_END = sealedId ? Date.UTC(2026, 10, 1) : Date.UTC(2025, 0, 1);
const FIRST_MONDAY = sealedId ? Date.UTC(2025, 0, 6) : Date.parse(`${flag('first', '2021-03-01')}T00:00:00Z`);
const LAST_MONDAY = sealedId ? Date.UTC(2026, 9, 26) : Date.UTC(2024, 11, 30);
const HALF_SPLIT = Date.UTC(2023, 0, 1);
const TRIALS = Number(flag("trials", "54"));
const RANDOM_RUNS = 2000;

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

interface Verdict { id: SignalId | 'CARRY'; checks: { id: string; pass: boolean; detail: string }[]; report: Record<string, unknown>; weekly: number[] }

function evaluate(panel: Panel, id: SignalId | 'CARRY', run: (q: number) => WeekResult[], trialVariance: number, random: number[]): Verdict {
  const base = run(6);
  const net = base.map((w) => netReturn(w));
  const boot = bootstrapMean(base.map((w, i) => ({ value: net[i]!, cluster: monthOf(w.time) })), { confidence: 0.8, seed: 7 });
  const early = base.filter((w) => w.time < HALF_SPLIT).map((w) => netReturn(w));
  const late = base.filter((w) => w.time >= HALF_SPLIT).map((w) => netReturn(w));
  const stressed = mean(base.map((w) => netReturn(w, COST_STRESS)));
  const neighbours = [4, 8].map((q) => mean(run(q).map((w) => netReturn(w))));
  const p95 = quantileSorted([...random].sort((a, b) => a - b), 0.95);
  const dsr = net.length > 2 ? computeDeflatedSharpeFromReturns({ returns: net, samplingFrequencyMs: 7 * DAY_MS, trialCount: TRIALS, trialSharpeVariance: trialVariance }).dsr : NaN;
  const sorted = [...net].sort((a, b) => a - b);
  const trimmed = sorted.slice(0, Math.floor(sorted.length * 0.95));
  const mde = minimumDetectableEffect({ n: net.length, sigmaR: sd(net), alpha: 0.2, power: 0.8 }).mdeR;
  const checks = [
    { id: '1-weeks>=100', pass: net.length >= 100, detail: `${net.length} weeks` },
    { id: '2-mean>0-and-lcb>0', pass: mean(net) > 0 && (boot?.ciLow ?? -1) > 0, detail: `mean ${(mean(net) * 100).toFixed(3)}%/wk, 90% LCB ${((boot?.ciLow ?? NaN) * 100).toFixed(3)}%` },
    { id: '3-both-halves', pass: mean(early) > 0 && mean(late) > 0, detail: `2021-22 ${(mean(early) * 100).toFixed(3)}% (${early.length}), 2023-24 ${(mean(late) * 100).toFixed(3)}% (${late.length})` },
    { id: `4-costs-${COST_STRESS}x`, pass: stressed > 0, detail: `${(stressed * 100).toFixed(3)}%/wk` },
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

const EVENT_NOTIONAL = 0.03; // equity share per event, a sizing example, not a tuned value

/** Per year, without the worst events, and the monthly profile of a fixed-fraction book. Reported, never selected on. */
function listingDiagnostics(events: readonly { time: number }[], net: readonly number[]): void {
  const years = [2021, 2022, 2023, 2024].map((y) => { const x = net.filter((_, i) => new Date(events[i]!.time).getUTCFullYear() === y); return `${y}: ${(mean(x) * 100).toFixed(1)}% (${x.length})`; });
  const sorted = [...net].sort((a, b) => a - b);
  const monthly = new Map<string, number>();
  net.forEach((v, i) => monthly.set(monthOf(events[i]!.time), (monthly.get(monthOf(events[i]!.time)) ?? 0) + v * EVENT_NOTIONAL));
  const months = [...monthly.values()];
  console.log(`  per year ${years.join(', ')}; without worst 5: ${(mean(sorted.slice(5)) * 100).toFixed(2)}%; median ${(sorted[Math.floor(sorted.length / 2)]! * 100).toFixed(1)}%; win rate ${(net.filter((v) => v > 0).length / net.length * 100).toFixed(0)}%`);
  console.log(`  book at ${EVENT_NOTIONAL * 100}% of equity per event: mean month ${(mean(months) * 100).toFixed(2)}%, sd ${(sd(months) * 100).toFixed(2)}%, worst month ${(Math.min(...months) * 100).toFixed(1)}%, positive months ${months.filter((v) => v > 0).length}/${months.length}`);
}

type EventRun = { name: string; events: ReturnType<typeof listingEvents>; others: number[] };

function eventChecks(r: EventRun, runs: readonly EventRun[], trials: number, variance: number): { id: string; pass: boolean; detail: string }[] {
  const netsOf = (events: EventRun['events'], scale = 1): number[] => events.map((e) => listingNet(e, scale));
  const net = netsOf(r.events);
  const boot = bootstrapMean(r.events.map((e, k) => ({ value: net[k]!, cluster: monthOf(e.time) })), { confidence: 0.8, seed: 7 });
  const p95 = quantileSorted(randomPeerMeans(r.events, RANDOM_RUNS, mulberry32(21)).sort((a, b) => a - b), 0.95);
  const dsr = computeDeflatedSharpeFromReturns({ returns: net, samplingFrequencyMs: DAY_MS, trialCount: trials, trialSharpeVariance: variance }).dsr;
  const early = netsOf(r.events.filter((e) => e.time < HALF_SPLIT)); const late = netsOf(r.events.filter((e) => e.time >= HALF_SPLIT));
  const others = r.others.map((i) => mean(netsOf(runs[i]!.events)));
  const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
  return [
    { id: '1-events>=100', pass: net.length >= 100, detail: `${net.length} events` },
    { id: '2-mean>0-and-lcb>0', pass: mean(net) > 0 && (boot?.ciLow ?? -1) > 0, detail: `mean ${pct(mean(net))}, 90% LCB ${pct(boot?.ciLow ?? NaN)}` },
    { id: '3-both-halves', pass: mean(early) > 0 && mean(late) > 0, detail: `early ${pct(mean(early))} (${early.length}), late ${pct(mean(late))} (${late.length})` },
    { id: '4-costs-3x', pass: mean(netsOf(r.events, 3)) > 0, detail: pct(mean(netsOf(r.events, 3))) },
    { id: '5-other-variants', pass: others.every((m) => m > 0), detail: others.map(pct).join(', ') },
    { id: '6-beats-random', pass: mean(net) > p95, detail: `net ${pct(mean(net))} vs random p95 ${pct(p95)}` },
    { id: '7-dsr>0.95', pass: dsr > 0.95, detail: `DSR ${dsr.toFixed(3)} (N=${trials})` },
  ];
}

function reportEventRun(r: EventRun, checks: ReturnType<typeof eventChecks>): void {
  const net = r.events.map((e) => listingNet(e)); const sorted = [...net].sort((a, b) => a - b);
  console.log(`\n== ${r.name}: ${checks.every((c) => c.pass) ? 'PASSED_DEV' : 'REJECTED'} (${checks.filter((c) => c.pass).length}/7)`);
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}`);
  listingDiagnostics(r.events, net);
  console.log(`  worst ${(sorted[0]! * 100).toFixed(1)}%, p01 ${(quantileSorted(sorted, 0.01) * 100).toFixed(1)}%, p99 ${(quantileSorted(sorted, 0.99) * 100).toFixed(1)}%, symbol-only mean ${(mean(r.events.map((e) => e.dir * e.ret)) * 100).toFixed(2)}%, btc leg mean ${(mean(r.events.map((e) => -e.dir * e.btcRet)) * 100).toFixed(2)}%`);
}

function evaluateEvents(runs: EventRun[], trials: number): void {
  const variance = Math.max(sd(runs.map((r) => sharpeOf(r.events.map((e) => listingNet(e))))) ** 2, 9.29e-3);
  for (const r of runs) reportEventRun(r, eventChecks(r, runs, trials, variance));
}

function printExtremes(panel: Panel, events: ReturnType<typeof listingEvents>): void {
  const ranked = events.map((e) => ({ name: panel.symbols[e.symbol]!, day: new Date(e.time).toISOString().slice(0, 10), net: listingNet(e), symbolRet: e.ret })).sort((a, b) => a.net - b.net);
  const show = (xs: typeof ranked): string => xs.map((x) => `${x.name} ${x.day} net ${(x.net * 100).toFixed(0)}% (symbol ${(x.symbolRet * 100).toFixed(0)}%)`).join('; ');
  console.log(`  worst: ${show(ranked.slice(0, 8))}\n  best: ${show(ranked.slice(-5))}`);
}

function evaluateListings(panel: Panel): void {
  const btc = panel.symbols.indexOf('BTCUSDT');
  const specs = LISTING_VARIANTS.map((v) => ({ ...v, events: listingEvents(panel, btc, v.delay, v.hold, LISTING_FIRST, LISTING_LAST) }));
  if (process.argv.includes('--extremes')) printExtremes(panel, specs[1]!.events);
  evaluateEvents(specs.map((r, i) => ({ name: `NL D=${r.delay} H=${r.hold}`, events: r.events, others: specs.map((_, k) => k).filter((k) => k !== i) })), LISTING_TRIALS);
}

function evaluateMoves(panel: Panel): void {
  const btc = panel.symbols.indexOf('BTCUSDT');
  const rules = [{ dir: -1 as const, dayReturn: 0.3, hold: 3 }, { dir: -1 as const, dayReturn: 0.3, hold: 7 }, { dir: 1 as const, dayReturn: 0.25, hold: 3 }, { dir: 1 as const, dayReturn: 0.25, hold: 7 }];
  const runs = rules.map((rule, i) => ({ name: `${rule.dir === -1 ? 'PF' : 'CB'} ${rule.dayReturn * 100}% H=${rule.hold}`, events: moveEvents(panel, btc, { ...rule, from: LISTING_FIRST, to: LISTING_LAST }), others: [i ^ 1] }));
  evaluateEvents(runs, 72);
}

/** Robustness view of one frozen variant: per year, per leg, drawdown and rebalance weekday. Reported, never selected on. */
function diagnose(panel: Panel, id: SignalId): void {
  const base = buildWeeks(panel, FIRST_MONDAY, LAST_MONDAY, SKIP_TOP);
  const byTie = Array.from({ length: 25 }, (_, seed) => mean(runPortfolio(base, scoreWeeks(panel, base, id), 6, seed).map((w) => netReturn(w)))).sort((a, b) => a - b);
  console.log(`  tie-break seeds (25): mean net min ${(byTie[0]! * 100).toFixed(3)}%, median ${(byTie[12]! * 100).toFixed(3)}%, max ${(byTie[24]! * 100).toFixed(3)}%`);
  for (let offset = 0; offset < 7; offset += 1) {
    const weeks = buildWeeks(panel, FIRST_MONDAY + offset * DAY_MS, LAST_MONDAY + offset * DAY_MS);
    const results = runPortfolio(weeks, scoreWeeks(panel, weeks, id), 6);
    const net = results.map((w) => netReturn(w));
    let peak = 0; let equity = 0; let worstDrawdown = 0;
    for (const r of net) { equity += r; peak = Math.max(peak, equity); worstDrawdown = Math.min(worstDrawdown, equity - peak); }
    console.log(`  rebalance weekday +${offset}d: ${net.length} weeks, mean ${(mean(net) * 100).toFixed(3)}%, sharpe/wk ${sharpeOf(net).toFixed(3)}, max drawdown ${(worstDrawdown * 100).toFixed(0)}% of one leg`);
    if (offset > 0) continue;
    for (const year of [2021, 2022, 2023, 2024]) {
      const inYear = results.filter((w) => new Date(w.time).getUTCFullYear() === year);
      console.log(`  ${year}: ${inYear.length} weeks net ${(mean(inYear.map((w) => netReturn(w))) * 100).toFixed(3)}%  long leg ${(mean(inYear.map((w) => w.longLeg)) * 100).toFixed(3)}%  short leg ${(mean(inYear.map((w) => w.shortLeg)) * 100).toFixed(3)}%  funding ${(mean(inYear.map((w) => w.funding)) * 100).toFixed(3)}%`);
    }
  }
}

const CARRY_TRIALS_SHARPE_VARIANCE = 0.0115; // measured across the six §13 signals, so one carry variant cannot make the bar lenient

function evaluateCarry(panel: Panel, weeks: WeekUniverse[]): void {
  const scores = carryScores(panel, weeks);
  const random = randomCarryMeans(panel, weeks, 6, RANDOM_RUNS, mulberry32(13));
  const v = evaluate(panel, 'CARRY', (q) => runCarry(panel, weeks, scores, q), CARRY_TRIALS_SHARPE_VARIANCE, random);
  console.log(`\n== CARRY: ${v.checks.every((c) => c.pass) ? 'PASSED_DEV' : 'REJECTED'} (${v.checks.filter((c) => c.pass).length}/7)`);
  for (const c of v.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}`);
  console.log(`  ${JSON.stringify(v.report)}`);
  const results = runCarry(panel, weeks, scores, 6);
  const eligibleShort = results.length < weeks.length ? `${weeks.length - results.length} of ${weeks.length} weeks had fewer than 6 names with spot` : 'every week had 6 names with spot';
  console.log(`  ${eligibleShort}; weeks with negative net ${results.filter((w) => netReturn(w) < 0).length}/${results.length}; worst week ${(Math.min(...results.map((w) => netReturn(w))) * 100).toFixed(2)}%`);
  for (const year of [2021, 2022, 2023, 2024]) {
    const x = results.filter((w) => new Date(w.time).getUTCFullYear() === year);
    console.log(`  ${year}: net ${(mean(x.map((w) => netReturn(w))) * 100).toFixed(3)}%/wk = funding ${(mean(x.map((w) => w.funding)) * 100).toFixed(3)} + basis ${(mean(x.map((w) => w.gross)) * 100).toFixed(3)} - cost ${(mean(x.map((w) => w.cost)) * 100).toFixed(3)}`);
  }
}

function sharpeOf(xs: readonly number[]): number { return mean(xs) / sd(xs); }

function main(): void {
  const panel = loadPanelFiles({ start: PANEL_START, end: PANEL_END }, ONLY.split(',').some((id) => id === 'X11' || id === 'X12'), process.argv.includes('--carry'));
  console.log(`panel: ${panel.symbols.length} symbols, ${panel.days} days${sealedId ? ' (SEALED window, one frozen variant)' : ''}`);
  if (process.argv.includes('--listings')) return evaluateListings(panel);
  if (process.argv.includes('--moves')) return evaluateMoves(panel);
  if (process.argv.includes('--carry')) return evaluateCarry(panel, buildWeeks(panel, FIRST_MONDAY, LAST_MONDAY, SKIP_TOP));
  if (process.argv.includes('--list-universe')) {
    const names = new Set(buildWeeks(panel, FIRST_MONDAY, LAST_MONDAY, SKIP_TOP).flatMap((w) => w.symbols.map((i) => panel.symbols[i]!)));
    return console.log([...names].sort().join('\n'));
  }
  if (process.argv.includes('--count-moves')) {
    const btc = panel.symbols.indexOf('BTCUSDT');
    for (const dir of [-1, 1] as const) for (const level of [0.15, 0.2, 0.25, 0.3, 0.4]) {
      const n = moveEvents(panel, btc, { dir, dayReturn: level, hold: 7, from: LISTING_FIRST, to: LISTING_LAST }).length;
      console.log(`${dir === -1 ? 'pump >=' : 'crash <=-'}${level * 100}%: ${n} events`);
    }
    return;
  }
  const diagnoseId = process.argv.includes('--diagnose') ? (process.argv[process.argv.indexOf('--diagnose') + 1] as SignalId) : null;
  if (diagnoseId) return diagnose(panel, diagnoseId);
  const weeks = buildWeeks(panel, FIRST_MONDAY, LAST_MONDAY, SKIP_TOP);
  console.log(`weeks: ${weeks.length}, universe size median ${weeks.map((w) => w.symbols.length).sort((a, b) => a - b)[Math.floor(weeks.length / 2)]}`);
  const ids = sealedId ? [sealedId] : ONLY ? (ONLY.split(',') as SignalId[]) : [...SIGNALS];
  const sharpes = SIGNALS.map((id) => sharpeOf(runPortfolio(weeks, scoreWeeks(panel, weeks, id), 6).map((w) => netReturn(w))));
  const trialVariance = sd(sharpes) ** 2;
  const random = randomBasketMeans(weeks, 6, RANDOM_RUNS, mulberry32(13));
  if (process.env.DUMP) writeFileSync(process.env.DUMP, JSON.stringify(weeks.map((w) => [w.time, w.symbols.map((s) => panel.symbols[s]), w.ret, w.funding])));
  if (process.env.DUMP) writeFileSync(process.env.DUMP, JSON.stringify(weeks.map((w) => [w.time, w.symbols.map((s) => panel.symbols[s]), w.ret, w.funding])));
  const verdicts = ids.map((id) => { const scores = scoreWeeks(panel, weeks, id); return evaluate(panel, id, (q) => runPortfolio(weeks, scores, q), trialVariance, random); });
  for (const v of verdicts) {
    const gated = v.checks.filter((c) => GATE_DSR || !c.id.startsWith('7'));
    console.log(`\n== ${v.id} skip-top ${SKIP_TOP}: ${gated.every((c) => c.pass) ? (GATE_DSR ? 'PASSED_DEV' : 'REPLICATED') : 'REJECTED'} (${gated.filter((c) => c.pass).length}/${gated.length})`);
    for (const c of v.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}`);
    console.log(`  ${JSON.stringify(v.report)}`);
  }
  mkdirSync('research-runs', { recursive: true });
  const out = `research-runs/xsection-${sealedId ? 'sealed' : 'dev'}-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '')}Z.json`;
  writeFileSync(out, JSON.stringify({ trials: TRIALS, trialSharpeVariance: trialVariance, verdicts: verdicts.map(({ weekly, ...rest }) => rest) }, null, 1));
  console.log(`\nreport: ${out}`);
}

main();
