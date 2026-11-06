/**
 * Evaluation stage of the research pipeline: one pre-registered DONCHIAN_BREAKOUT spec, one symbol x timeframe series at a time.
 *
 * Per series: chronological train / validation / test split; the volatility threshold of the context is fitted on train only;
 * entries fill at the next bar's open; inside a bar the stop is checked before the target and a gap through the stop fills at
 * the open. The test segment is read only for REGISTERED specs, and only after its window is recorded in the OOS ledger.
 * Significance is the null-centred cluster bootstrap from Bootstrap.ts with Holm correction across the spec's series.
 * No verdict here is a promotion: the repository's promotion gate still applies.
 */
import { ema, wilderAtr } from '../../binance/indicators.js';
import type { Candle } from '../../types.js';
import { bootstrapMean, holm, quantileSorted, utcDay, type BootstrapSummary } from '../Bootstrap.js';
import type { HypothesisSpec } from './hypothesis.js';
import { appendRead, decideRead, readLedger, type ReadDecision } from './oosLedger.js';

const SUPPORTED_FAMILY = 'DONCHIAN_BREAKOUT';
const SUPPORTED_CONTEXT = 'EMA50_GT_EMA200_ATR14_Q33_TRAIN';
const ATR_PERIOD = 14;
const EMA_FAST_PERIOD = 50;
const EMA_SLOW_PERIOD = 200;
/**
 * No signal before this bar. ema() seeds from the first close, so at bar 200 the seed still weighs about 13% in EMA200: early
 * train eligibility is seed-shaped, validation and test bars (hundreds of bars later) are not.
 * ponytail: seed-from-first-close EMA; prefetch ~1000 warmup bars before the window if early-train stats start to matter.
 */
const WARMUP_BARS = EMA_SLOW_PERIOD;
const ATR_PCT_QUANTILE = 0.33;
const BOOTSTRAP_ITERATIONS = 2000;
/** Hex digits of the spec hash used as the bootstrap seed (32 bits, the width mulberry32 takes). */
const SEED_HEX_DIGITS = 8;
/**
 * A test segment spanning fewer UTC days is INSUFFICIENT_EVIDENCE whatever its p-value: with few day-clusters the cluster
 * bootstrap rejects a true null well above alpha (measured: ~9% at 5 days, ~5% from ~18). Same floor as the admission policy.
 */
const MIN_TEST_CLUSTERS = 20;
const BPS = 10_000;

export interface BreakoutParams {
  lookback: number;
  stopAtr: number;
  targetR: number;
  maxHoldingBars: number;
}

export interface Trade {
  entryTime: number;
  netR: number;
}

export interface SimInput {
  candles: Candle[];
  eligible: boolean[];
  atr: number[];
  params: BreakoutParams;
  roundTripBps: number;
}

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
  /** Null while the test segment is unread (DRAFT spec or refused ledger read). */
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
  /** Always false: the spec carries a round-trip cost only, so funding payments are not charged to any trade. */
  fundingModeled: false;
  series: SeriesEvaluation[];
}

function numberParam(spec: HypothesisSpec, name: string, integer: boolean): number {
  const value = spec.params[name];
  if (typeof value !== 'number' || !(value > 0) || (integer && !Number.isInteger(value))) {
    throw new Error(`${spec.id}: params.${name} must be a positive${integer ? ' integer' : ' number'}, got ${String(value)}`);
  }
  return value;
}

export function readParams(spec: HypothesisSpec): BreakoutParams {
  if (spec.family !== SUPPORTED_FAMILY) throw new Error(`${spec.id}: family ${spec.family} has no evaluator (supported: ${SUPPORTED_FAMILY})`);
  if (spec.context.id !== SUPPORTED_CONTEXT) throw new Error(`${spec.id}: context ${spec.context.id} has no evaluator (supported: ${SUPPORTED_CONTEXT})`);
  return {
    lookback: numberParam(spec, 'lookback', true),
    stopAtr: numberParam(spec, 'stopAtr', false),
    targetR: numberParam(spec, 'targetR', false),
    maxHoldingBars: numberParam(spec, 'maxHoldingBars', true),
  };
}

/** Context flags per bar. The ATR/close ceiling is the train-segment quantile, so test bars never shape it. */
export function contextFlags(candles: Candle[], atr: number[], trainEnd: number): { eligible: boolean[]; atrPctMax: number } {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, EMA_FAST_PERIOD);
  const slow = ema(closes, EMA_SLOW_PERIOD);
  const atrPct = atr.map((value, i) => value / closes[i]!);
  const trainAtrPct = atrPct.slice(WARMUP_BARS, trainEnd).filter(Number.isFinite).sort((a, b) => a - b);
  const atrPctMax = quantileSorted(trainAtrPct, ATR_PCT_QUANTILE);
  if (!Number.isFinite(atrPctMax)) throw new Error(`train segment of ${trainEnd} bars leaves no bars after the ${WARMUP_BARS}-bar warmup`);
  const eligible = candles.map((_, i) => i >= WARMUP_BARS && fast[i]! > slow[i]! && atrPct[i]! <= atrPctMax);
  return { eligible, atrPctMax };
}

function isBreakout(candles: Candle[], index: number, lookback: number): boolean {
  let priorHigh = -Infinity;
  for (let i = index - lookback; i < index; i += 1) priorHigh = Math.max(priorHigh, candles[i]!.high);
  return candles[index]!.close > priorHigh;
}

/** First bar from entry on whose range touches the stop (checked first) or the target; else the close of the last allowed bar. */
function walkToExit(candles: Candle[], entryIndex: number, levels: { stop: number; target: number }, maxHold: number): { index: number; price: number } {
  const lastIndex = entryIndex + maxHold - 1;
  for (let i = entryIndex; i <= lastIndex; i += 1) {
    const bar = candles[i]!;
    if (bar.low <= levels.stop) return { index: i, price: Math.min(levels.stop, bar.open) };
    // Target fills at the target even when the bar gaps above it: the conservative convention.
    if (bar.high >= levels.target) return { index: i, price: levels.target };
  }
  return { index: lastIndex, price: candles[lastIndex]!.close };
}

/** Long trades with signal bar in [start, end). The whole hold (signal + maxHoldingBars) ends inside the range, so no trade straddles a split. */
export function simulateLong(input: SimInput, range: { start: number; end: number }): Trade[] {
  const { candles, eligible, atr, params, roundTripBps } = input;
  const trades: Trade[] = [];
  let nextFreeIndex = 0;
  const lastSignal = range.end - params.maxHoldingBars;
  for (let i = Math.max(range.start, WARMUP_BARS, params.lookback); i < lastSignal; i += 1) {
    if (i < nextFreeIndex || !eligible[i] || !isBreakout(candles, i, params.lookback)) continue;
    const entry = candles[i + 1]!.open;
    const risk = params.stopAtr * atr[i]!;
    if (!(risk > 0)) continue;
    const exit = walkToExit(candles, i + 1, { stop: entry - risk, target: entry + params.targetR * risk }, params.maxHoldingBars);
    trades.push({ entryTime: candles[i + 1]!.openTime, netR: (exit.price - entry - (roundTripBps / BPS) * entry) / risk });
    nextFreeIndex = exit.index + 1;
  }
  return trades;
}

interface BootConfig {
  seed: number;
  confidence: number;
}

function bootConfigOf(args: EvaluateArgs): BootConfig {
  return {
    // Seeded from the spec hash: a spec always resamples the same way, and a changed spec cannot pick a luckier seed.
    seed: Number.parseInt(args.hash.slice(0, SEED_HEX_DIGITS), 16),
    // Two-sided interval at 1 - 2*alpha puts alpha in the lower tail, matching the one-sided test that ciLow > 0 stands for.
    confidence: 1 - 2 * args.spec.evidence.alpha,
  };
}

function segmentStats(sim: SimInput, range: { start: number; end: number }, boot: BootConfig): SegmentStats {
  const trades = simulateLong(sim, range);
  const samples = trades.map((t) => ({ value: t.netR, cluster: utcDay(t.entryTime) }));
  return { trades: trades.length, summary: bootstrapMean(samples, { iterations: BOOTSTRAP_ITERATIONS, ...boot }) };
}

type Claim = ReadDecision | { kind: 'not-read' };
type TestWindow = { testFromIso: string; testToIso: string };

/** Records the test-window read in the ledger BEFORE any test statistic exists. DRAFT specs never touch the ledger. */
function claimTestRead(args: EvaluateArgs, series: SeriesInput, window: TestWindow): Claim {
  if (args.spec.status !== 'REGISTERED') return { kind: 'not-read' };
  const read = { specId: args.spec.id, specVersion: args.spec.version, specHash: args.hash, symbol: series.symbol, timeframe: series.timeframe, ...window };
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
  sim: SimInput;
  validationEnd: number;
  window: TestWindow;
  atrPctMax: number;
  train: SegmentStats;
  validation: SegmentStats;
}

/** Everything that can throw for a bad spec or a short series, plus the train and validation stats. Never reads the ledger. */
function prepareSeries(args: EvaluateArgs, params: BreakoutParams, series: SeriesInput, boot: BootConfig): PreparedSeries {
  const { candles } = series;
  const { trainEnd, validationEnd } = splitIndices(candles.length, args.spec.window.split);
  const atr = wilderAtr(candles, ATR_PERIOD);
  const { eligible, atrPctMax } = contextFlags(candles, atr, trainEnd);
  const sim: SimInput = { candles, eligible, atr, params, roundTripBps: args.spec.costs.roundTripBps };
  return {
    series, sim, validationEnd, atrPctMax,
    window: testWindowOf(candles, validationEnd),
    train: segmentStats(sim, { start: 0, end: trainEnd }, boot),
    validation: segmentStats(sim, { start: trainEnd, end: validationEnd }, boot),
  };
}

function initialVerdict(claim: Claim): SeriesVerdict {
  if (claim.kind === 'refused') return 'LEDGER_REFUSED';
  return claim.kind === 'not-read' ? 'TEST_UNREAD_DRAFT' : 'INSUFFICIENT_EVIDENCE';
}

function readTest(args: EvaluateArgs, prepared: PreparedSeries, boot: BootConfig): SeriesEvaluation {
  const { series, sim, validationEnd, window } = prepared;
  const claim = claimTestRead(args, series, window);
  const isReadable = claim.kind === 'first-read' || claim.kind === 'replay';
  return {
    symbol: series.symbol, timeframe: series.timeframe, bars: series.candles.length, atrPctMax: prepared.atrPctMax, ...window,
    train: prepared.train, validation: prepared.validation,
    test: isReadable ? segmentStats(sim, { start: validationEnd, end: series.candles.length }, boot) : null,
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

/**
 * Evaluates every series of one spec. All series are prepared before the first ledger write, so a spec that fails on any
 * series fails before it can consume a test window. Holm runs over every declared series; an unread or tradeless test
 * counts as p = 1, so a series dropping out never loosens the threshold for the others.
 * ponytail: the family is this spec's series only; reads by other spec ids are in the ledger but not counted here.
 */
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
