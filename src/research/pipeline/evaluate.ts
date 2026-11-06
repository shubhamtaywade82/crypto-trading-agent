/**
 * Evaluation stage of the research pipeline: evaluates hypothesis specs across symbol x timeframe series.
 *
 * Per series: chronological train / validation / test split; entries fill at the next bar's open;
 * inside a bar the stop is checked before the target, and breakeven trailing is honored.
 * The test segment is read only for REGISTERED specs, and only after its window is recorded in the OOS ledger.
 * Significance is the null-centred cluster bootstrap from Bootstrap.ts with Holm correction across series.
 */
import type { Candle } from '../../types.js';
import { bootstrapMean, holm, utcDay, type BootstrapSummary } from '../Bootstrap.js';
import type { HypothesisSpec } from './hypothesis.js';
import { appendRead, decideRead, readLedger, type ReadDecision } from './oosLedger.js';
import { simulateStrategy, type StrategyParams, type Trade } from './strategySimulator.js';
export { contextFlags, simulateLong, type SimInput } from './strategySimulator.js';

export const SUPPORTED_FAMILY = 'DONCHIAN_BREAKOUT';
export const SUPPORTED_FAMILIES = [
  'DONCHIAN_BREAKOUT',
  'DONCHIAN_BREAK',
  'EMA_CROSS',
  'PULLBACK_RECLAIM',
  'SQUEEZE_EXPANSION',
  'MACD_CROSS',
  'STOCH_CROSS',
  'QUANT_DISCOVERY',
  'STRATEGY_DISCOVERY',
] as const;
export const SUPPORTED_CONTEXT = 'EMA50_GT_EMA200_ATR14_Q33_TRAIN';
const BOOTSTRAP_ITERATIONS = 2000;
const SEED_HEX_DIGITS = 8;
const MIN_TEST_CLUSTERS = 20;

export interface SegmentStats {
  trades: number;
  summary: BootstrapSummary | null;
}

export type SeriesVerdict =
  | 'INSUFFICIENT_EVIDENCE'
  | 'REJECTED'
  | 'NOT_SIGNIFICANT'
  | 'PROMISING'
  | 'TEST_UNREAD_DRAFT'
  | 'LEDGER_REFUSED';

export interface SeriesEvaluation {
  symbol: string;
  timeframe: string;
  bars: number;
  atrPctMax: number;
  train: SegmentStats;
  validation: SegmentStats;
  test: SegmentStats | null;
  testFromIso: string;
  testToIso: string;
  ledger: ReadDecision['kind'] | 'not-read';
  verdict: SeriesVerdict;
  note: string | null;
}

export interface SeriesInput {
  symbol: string;
  timeframe: string;
  candles: Candle[];
}

export interface EvaluateArgs {
  spec: HypothesisSpec;
  hash: string;
  series: SeriesInput[];
  ledgerFile: string;
  runId: string;
  readAtIso: string;
}

export interface SpecEvaluation {
  fundingModeled: false;
  series: SeriesEvaluation[];
}

export function readParams(spec: HypothesisSpec): StrategyParams {
  if (!SUPPORTED_FAMILIES.includes(spec.family as (typeof SUPPORTED_FAMILIES)[number])) {
    throw new Error(`${spec.id}: family ${spec.family} is not supported, must be one of ${SUPPORTED_FAMILIES.join(', ')}`);
  }
  const p = spec.params as unknown as StrategyParams;
  return {
    trigger: (p.trigger ?? (spec.family === 'DONCHIAN_BREAKOUT' ? 'DONCHIAN_BREAK' : spec.family)) as any,
    regimeFilter: (p.regimeFilter ?? (spec.context.id === 'EMA50_GT_EMA200_ATR14_Q33_TRAIN' ? 'LOW_VOL_EXPANSION' : 'NONE')) as any,
    direction: p.direction ?? 'LONG',
    lookback: typeof p.lookback === 'number' ? p.lookback : 20,
    fastPeriod: typeof p.fastPeriod === 'number' ? p.fastPeriod : 20,
    slowPeriod: typeof p.slowPeriod === 'number' ? p.slowPeriod : 50,
    targetPct: typeof p.targetPct === 'number' ? p.targetPct : undefined,
    targetR: typeof p.targetR === 'number' ? p.targetR : 2.0,
    stopAtr: typeof p.stopAtr === 'number' ? p.stopAtr : 1.0,
    rrRatio: typeof p.rrRatio === 'number' ? p.rrRatio : undefined,
    useBreakeven: Boolean(p.useBreakeven),
    maxHoldingBars: typeof p.maxHoldingBars === 'number' ? p.maxHoldingBars : 18,
  };
}

interface BootConfig {
  seed: number;
  confidence: number;
}

function bootConfigOf(args: EvaluateArgs): BootConfig {
  return {
    seed: Number.parseInt(args.hash.slice(0, SEED_HEX_DIGITS), 16),
    confidence: 1 - 2 * args.spec.evidence.alpha,
  };
}

function summarizeTrades(trades: Trade[], boot: BootConfig): SegmentStats {
  const samples = trades.map((t) => ({ value: t.netR, cluster: utcDay(t.entryTime) }));
  return { trades: trades.length, summary: bootstrapMean(samples, { iterations: BOOTSTRAP_ITERATIONS, ...boot }) };
}

type Claim = ReadDecision | { kind: 'not-read' };
type TestWindow = { testFromIso: string; testToIso: string };

function claimTestRead(args: EvaluateArgs, series: SeriesInput, window: TestWindow): Claim {
  if (args.spec.status !== 'REGISTERED') return { kind: 'not-read' };
  const read = { specId: args.spec.id, specVersion: args.spec.version, specHash: args.hash, symbol: series.symbol, timeframe: series.timeframe, ...window, campaign: args.spec.campaign };
  const decision = decideRead(readLedger(args.ledgerFile), read);
  if (decision.kind === 'first-read') appendRead(args.ledgerFile, { ...read, readAtIso: args.readAtIso, runId: args.runId });
  return decision;
}

function splitIndices(bars: number, split: HypothesisSpec['window']['split']): { trainEnd: number; validationEnd: number } {
  const total = split.trainPct + split.validationPct + split.testPct;
  return { trainEnd: Math.floor((bars * split.trainPct) / total), validationEnd: Math.floor((bars * (split.trainPct + split.validationPct)) / total) };
}

function testWindowOf(candles: Candle[], validationEnd: number): TestWindow {
  const intervalMs = candles[1]!.openTime - candles[0]!.openTime;
  return {
    testFromIso: new Date(candles[validationEnd]!.openTime).toISOString(),
    testToIso: new Date(candles[candles.length - 1]!.openTime + intervalMs).toISOString(),
  };
}

interface PreparedSeries {
  series: SeriesInput;
  params: StrategyParams;
  validationEnd: number;
  trainEnd: number;
  window: TestWindow;
  atrPctMax: number;
  train: SegmentStats;
  validation: SegmentStats;
}

function prepareSeries(args: EvaluateArgs, params: StrategyParams, series: SeriesInput, boot: BootConfig): PreparedSeries {
  const { candles } = series;
  const { trainEnd, validationEnd } = splitIndices(candles.length, args.spec.window.split);
  const trainRes = simulateStrategy(candles, params, { range: { start: 0, end: trainEnd }, roundTripBps: args.spec.costs.roundTripBps, trainEnd });
  const valRes = simulateStrategy(candles, params, { range: { start: trainEnd, end: validationEnd }, roundTripBps: args.spec.costs.roundTripBps, trainEnd });

  return {
    series, params, validationEnd, trainEnd, atrPctMax: trainRes.atrPctMax,
    window: testWindowOf(candles, validationEnd),
    train: summarizeTrades(trainRes.trades, boot),
    validation: summarizeTrades(valRes.trades, boot),
  };
}

function initialVerdict(claim: Claim): SeriesVerdict {
  if (claim.kind === 'refused') return 'LEDGER_REFUSED';
  return claim.kind === 'not-read' ? 'TEST_UNREAD_DRAFT' : 'INSUFFICIENT_EVIDENCE';
}

function readTest(args: EvaluateArgs, prepared: PreparedSeries, boot: BootConfig): SeriesEvaluation {
  const { series, validationEnd, window } = prepared;
  const claim = claimTestRead(args, series, window);
  const isReadable = claim.kind === 'first-read' || claim.kind === 'replay';
  const testTrades = isReadable ? simulateStrategy(series.candles, prepared.params, { range: { start: validationEnd, end: series.candles.length }, roundTripBps: args.spec.costs.roundTripBps, trainEnd: prepared.trainEnd }).trades : null;

  return {
    symbol: series.symbol, timeframe: series.timeframe, bars: series.candles.length, atrPctMax: prepared.atrPctMax, ...window,
    train: prepared.train, validation: prepared.validation,
    test: testTrades ? summarizeTrades(testTrades, boot) : null,
    ledger: claim.kind,
    verdict: initialVerdict(claim),
    note: claim.kind === 'refused' ? claim.reason : null,
  };
}

function verdictOf(test: SegmentStats, holmRejected: boolean, spec: HypothesisSpec): SeriesVerdict {
  if (!test.summary || test.trades < spec.evidence.minOosTrades || test.summary.clusters < MIN_TEST_CLUSTERS) return 'INSUFFICIENT_EVIDENCE';
  if (test.summary.mean <= 0) return 'REJECTED';
  return test.summary.ciLow > 0 && holmRejected ? 'PROMISING' : 'NOT_SIGNIFICANT';
}

export function evaluateSpec(args: EvaluateArgs): SpecEvaluation {
  if (args.spec.status === 'RETIRED') throw new Error(`${args.spec.id}@${args.spec.version} is RETIRED and cannot be evaluated`);
  const params = readParams(args.spec);
  const boot = bootConfigOf(args);
  const prepared = args.series.map((s) => prepareSeries(args, params, s, boot));
  const series = prepared.map((p) => readTest(args, p, boot));
  const rejected = holm(series.map((s) => s.test?.summary?.pValue ?? 1), args.spec.evidence.alpha);
  series.forEach((s, i) => { if (s.test) s.verdict = verdictOf(s.test, rejected[i]!, args.spec); });
  return { fundingModeled: false, series };
}
