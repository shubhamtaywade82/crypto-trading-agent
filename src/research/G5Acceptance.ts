import { bootstrapMean, utcDay } from './Bootstrap.js';
import { computeDeflatedSharpeFromReturns } from './DeflatedSharpe.js';
import type { Trade } from './SignalBacktest.js';

/**
 * Walk-forward selection and the seven pre-registered acceptance checks of docs/NEMESIS_G4_STRATEGY_SPECS.md §4.
 * Every check reads only walk-forward test-fold trades; variant choice inside a fold reads only that fold's train trades.
 */
export type SymbolTrade = Trade & { symbol: string };
export interface Fold { trainFrom: number; trainTo: number; testFrom: number; testTo: number }
export interface VariantRef { id: string; strategy: string; axes: number[] }

export interface AcceptanceInput {
  strategy: string;
  variants: VariantRef[];
  allVariants: VariantRef[];
  tradesByVariant: ReadonlyMap<string, SymbolTrade[]>;
  folds: Fold[];
  momentum: SymbolTrade[];
  randomFor: (trades: SymbolTrade[]) => SymbolTrade[];
  symbols: string[];
  trialCount: number;
  /** Overrides the trial Sharpe variance measured from `allVariants` (use when this run simulates only a few of them). */
  trialSharpeVariance?: number;
}

export interface Check { id: string; pass: boolean; detail: string }
export interface AcceptanceResult {
  strategy: string; verdict: 'PASSED_DEV' | 'REJECTED'; selections: string[]; checks: Check[];
  stats: { trades: number; meanNetR: number; meanGrossR: number; meanCostR: number; meanFundingR: number; winRate: number; maxLosingStreak: number; ciLow: number | null; dsr: number | null };
  bySymbol: Record<string, { trades: number; meanNetR: number }>;
  lines: string[];
}

const DAY_MS = 86_400_000;
const RISK_FRACTION = 0.01;
const MIN_TRAIN_TRADES = 10;
const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
const within = (t: SymbolTrade, from: number, to: number): boolean => t.entryTime >= from && t.entryTime < to;

/** Per fold: the variant with the best mean net R on that fold's train window; its test-window trades are kept. */
export function walkForward(variants: VariantRef[], byVariant: ReadonlyMap<string, SymbolTrade[]>, folds: Fold[]): { trades: SymbolTrade[]; selections: string[] } {
  const trades: SymbolTrade[] = [];
  const selections: string[] = [];
  for (const fold of folds) {
    let best: { id: string; score: number } | null = null;
    for (const v of variants) {
      const train = (byVariant.get(v.id) ?? []).filter((t) => within(t, fold.trainFrom, fold.trainTo));
      const score = mean(train.map((t) => t.netR));
      if (train.length >= MIN_TRAIN_TRADES && (best === null || score > best.score)) best = { id: v.id, score };
    }
    selections.push(best?.id ?? 'NONE');
    if (best) trades.push(...byVariant.get(best.id)!.filter((t) => within(t, fold.testFrom, fold.testTo)));
  }
  return { trades, selections };
}

function maxLosingStreak(trades: readonly SymbolTrade[]): number {
  let worst = 0;
  let run = 0;
  for (const t of [...trades].sort((a, b) => a.entryTime - b.entryTime)) { run = t.netR < 0 ? run + 1 : 0; worst = Math.max(worst, run); }
  return worst;
}

/** Daily portfolio returns over [from, to), zero on days with no exits: the equity cadence the deflated Sharpe needs. */
export function dailyReturns(trades: readonly SymbolTrade[], from: number, to: number): number[] {
  const days = new Array<number>(Math.round((to - from) / DAY_MS)).fill(0);
  for (const t of trades) {
    const d = Math.floor((t.exitTime - from) / DAY_MS);
    if (d >= 0 && d < days.length) days[d]! += t.netR * RISK_FRACTION * t.sizeMultiplier;
  }
  return days;
}

const sharpe = (xs: readonly number[]): number => {
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, xs.length - 1));
  return sd > 0 ? m / sd : 0;
};

function neighbourCheck(input: AcceptanceInput, selections: string[], span: [number, number]): Check {
  const counts = new Map<string, number>();
  for (const s of selections) if (s !== 'NONE') counts.set(s, (counts.get(s) ?? 0) + 1);
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const ref = input.variants.find((v) => v.id === modal);
  if (!ref) return { id: '5-neighbours', pass: false, detail: 'no variant selected' };
  const neighbours = input.variants.filter((v) => v.axes.reduce((d, a, i) => d + Math.abs(a - ref.axes[i]!), 0) === 1);
  const means = neighbours.map((v) => ({ id: v.id, m: mean((input.tradesByVariant.get(v.id) ?? []).filter((t) => within(t, span[0], span[1])).map((t) => t.netR)) }));
  return { id: '5-neighbours', pass: means.length > 0 && means.every((x) => x.m > 0), detail: `modal ${modal}; ${means.map((x) => `${x.id} ${x.m.toFixed(3)}R`).join(', ')}` };
}

function deflatedSharpeCheck(input: AcceptanceInput, trades: SymbolTrade[], span: [number, number]): { check: Check; dsr: number | null } {
  const trialSharpes = input.allVariants.map((v) => sharpe(dailyReturns((input.tradesByVariant.get(v.id) ?? []).filter((t) => within(t, span[0], span[1])), span[0], span[1])));
  const m = mean(trialSharpes);
  const variance = input.trialSharpeVariance ?? trialSharpes.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, trialSharpes.length - 1);
  try {
    const r = computeDeflatedSharpeFromReturns({ returns: dailyReturns(trades, span[0], span[1]), samplingFrequencyMs: DAY_MS, trialCount: input.trialCount, trialSharpeVariance: variance });
    return { check: { id: '7-deflated-sharpe', pass: r.dsr > 0.95, detail: `DSR ${r.dsr.toFixed(3)} (daily SR ${r.sharpeRatio.toFixed(3)}, trials ${input.trialCount}, trial SR var ${variance.toExponential(2)})` }, dsr: r.dsr };
  } catch (error) {
    return { check: { id: '7-deflated-sharpe', pass: false, detail: (error as Error).message }, dsr: null };
  }
}

export function acceptance(input: AcceptanceInput): AcceptanceResult {
  const { trades, selections } = walkForward(input.variants, input.tradesByVariant, input.folds);
  const span: [number, number] = [input.folds[0]!.testFrom, input.folds[input.folds.length - 1]!.testTo];
  const net = trades.map((t) => t.netR);
  const boot = bootstrapMean(trades.map((t) => ({ value: t.netR, cluster: utcDay(t.entryTime) })), { confidence: 0.8, seed: 7 });
  const bySymbol = Object.fromEntries(input.symbols.map((s) => { const x = trades.filter((t) => t.symbol === s); return [s, { trades: x.length, meanNetR: mean(x.map((t) => t.netR)) }]; }));
  const stressed = mean(trades.map((t) => t.netR - 0.5 * t.costR));
  const random = mean(input.randomFor(trades).map((t) => t.netR));
  const momentum = mean(input.momentum.filter((t) => within(t, span[0], span[1])).map((t) => t.netR));
  const { check: dsrCheck, dsr } = deflatedSharpeCheck(input, trades, span);
  const checks: Check[] = [
    { id: '1-trades>=100', pass: trades.length >= 100, detail: `${trades.length} trades` },
    { id: '2-mean>0-and-lcb>0', pass: mean(net) > 0 && (boot?.ciLow ?? -1) > 0, detail: `mean ${mean(net).toFixed(3)}R, 90% one-sided LCB ${boot?.ciLow.toFixed(3) ?? 'n/a'}R` },
    { id: '3-two-thirds-of-symbols', pass: Object.values(bySymbol).filter((s) => s.meanNetR > 0).length >= Math.ceil((2 * input.symbols.length) / 3), detail: Object.entries(bySymbol).map(([s, v]) => `${s} ${v.meanNetR.toFixed(3)}R/${v.trades}`).join(', ') },
    { id: '4-costs-1.5x', pass: stressed > 0, detail: `mean at 1.5x costs ${stressed.toFixed(3)}R, at 2x ${mean(trades.map((t) => t.netR - t.costR)).toFixed(3)}R` },
    neighbourCheck(input, selections, span),
    { id: '6-beats-baselines', pass: mean(net) > random && mean(net) > momentum, detail: `strategy ${mean(net).toFixed(3)}R vs matched random ${random.toFixed(3)}R vs momentum ${momentum.toFixed(3)}R` },
    dsrCheck,
  ];
  const stats = {
    trades: trades.length, meanNetR: mean(net), meanGrossR: mean(trades.map((t) => t.grossR)), meanCostR: mean(trades.map((t) => t.costR)),
    meanFundingR: mean(trades.map((t) => t.fundingR)), winRate: trades.filter((t) => t.netR > 0).length / Math.max(1, trades.length),
    maxLosingStreak: maxLosingStreak(trades), ciLow: boot?.ciLow ?? null, dsr,
  };
  const verdict = checks.every((c) => c.pass) ? 'PASSED_DEV' : 'REJECTED';
  const lines = [`  selections: ${selections.join(' | ')}`, `  gross ${stats.meanGrossR.toFixed(3)}R cost ${stats.meanCostR.toFixed(3)}R funding ${stats.meanFundingR.toFixed(3)}R net ${stats.meanNetR.toFixed(3)}R win ${(100 * stats.winRate).toFixed(1)}% max losing streak ${stats.maxLosingStreak}`, ...checks.map((c) => `  [${c.pass ? 'PASS' : 'FAIL'}] ${c.id}: ${c.detail}`)];
  return { strategy: input.strategy, verdict, selections, checks, stats, bySymbol, lines };
}
