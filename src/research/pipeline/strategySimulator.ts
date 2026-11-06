import { ema, rsi, sma, wilderAtr } from '../../binance/indicators.js';
import type { Candle } from '../../types.js';
import { quantileSorted } from '../Bootstrap.js';

export interface StrategyParams {
  trigger?: 'DONCHIAN_BREAK' | 'EMA_CROSS' | 'PULLBACK_RECLAIM' | 'SQUEEZE_EXPANSION' | 'MACD_CROSS' | 'STOCH_CROSS';
  regimeFilter?: 'NONE' | 'TREND_EMA_50_200' | 'SUPERTREND_REGIME' | 'ADX_TRENDING' | 'RSI_MOMENTUM' | 'VOLUME_SURGE' | 'VOL_AND_TREND' | 'LOW_VOL_EXPANSION';
  direction?: 'LONG' | 'SHORT' | 'BOTH';
  lookback?: number;
  fastPeriod?: number;
  slowPeriod?: number;
  targetPct?: number;
  targetR?: number;
  stopAtr?: number;
  rrRatio?: number;
  useBreakeven?: boolean;
  maxHoldingBars?: number;
}

export interface Trade {
  entryTime: number;
  netR: number;
}

export interface SimInput {
  candles: Candle[];
  eligible: boolean[];
  atr: number[];
  params: { lookback: number; stopAtr: number; targetR: number; maxHoldingBars: number };
  roundTripBps: number;
}

const WARMUP_BARS = 200;
const ATR_PCT_QUANTILE = 0.33;
const BPS = 10_000;

export function contextFlags(candles: Candle[], atr: number[], trainEnd: number): { eligible: boolean[]; atrPctMax: number } {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, 50);
  const slow = ema(closes, 200);
  const atrPct = atr.map((value, i) => value / closes[i]!);
  const trainAtrPct = atrPct.slice(WARMUP_BARS, trainEnd).filter(Number.isFinite).sort((a, b) => a - b);
  const atrPctMax = quantileSorted(trainAtrPct, ATR_PCT_QUANTILE);
  if (!Number.isFinite(atrPctMax)) throw new Error(`train segment of ${trainEnd} bars leaves no bars after the ${WARMUP_BARS}-bar warmup`);
  const eligible = candles.map((_, i) => i >= WARMUP_BARS && fast[i]! > slow[i]! && atrPct[i]! <= atrPctMax);
  return { eligible, atrPctMax };
}

function walkToExit(candles: Candle[], entryIndex: number, levels: { stop: number; target: number }, maxHold: number): { index: number; price: number } {
  const lastIndex = entryIndex + maxHold - 1;
  for (let i = entryIndex; i <= lastIndex; i += 1) {
    const bar = candles[i]!;
    if (bar.low <= levels.stop) return { index: i, price: Math.min(levels.stop, bar.open) };
    if (bar.high >= levels.target) return { index: i, price: levels.target };
  }
  return { index: lastIndex, price: candles[lastIndex]!.close };
}

export function simulateLong(input: SimInput, range: { start: number; end: number }): Trade[] {
  const { candles, eligible, atr, params, roundTripBps } = input;
  const trades: Trade[] = [];
  let nextFreeIndex = 0;
  const lastSignal = range.end - params.maxHoldingBars;
  for (let i = Math.max(range.start, WARMUP_BARS, params.lookback); i < lastSignal; i += 1) {
    if (i < nextFreeIndex || !eligible[i]) continue;
    let priorHigh = -Infinity;
    for (let k = i - params.lookback; k < i; k += 1) priorHigh = Math.max(priorHigh, candles[k]!.high);
    if (candles[i]!.close <= priorHigh) continue;

    const entry = candles[i + 1]!.open;
    const risk = params.stopAtr * atr[i]!;
    if (!(risk > 0)) continue;
    const exit = walkToExit(candles, i + 1, { stop: entry - risk, target: entry + params.targetR * risk }, params.maxHoldingBars);
    trades.push({ entryTime: candles[i + 1]!.openTime, netR: (exit.price - entry - (roundTripBps / BPS) * entry) / risk });
    nextFreeIndex = exit.index + 1;
  }
  return trades;
}

interface CalculatedIndicators {
  closes: number[];
  atr: number[];
  emaFast: number[];
  emaSlow: number[];
  emaTrendFast: number[];
  emaTrendSlow: number[];
  rsi14: number[];
  volSma: number[];
  atrPctMax: number;
}

function computeIndicators(candles: Candle[], trainEnd: number, p: StrategyParams): CalculatedIndicators {
  const closes = candles.map((c) => c.close);
  const atr = wilderAtr(candles, 14);
  const emaFast = ema(closes, p.fastPeriod ?? (p.trigger === 'EMA_CROSS' ? 20 : 9));
  const emaSlow = ema(closes, p.slowPeriod ?? (p.trigger === 'EMA_CROSS' ? 50 : 21));
  const emaTrendFast = ema(closes, 50);
  const emaTrendSlow = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const volSma = sma(candles.map((c) => c.volume), 20);

  const trainAtrPct = atr.map((v, i) => v / closes[i]!).slice(WARMUP_BARS, trainEnd).filter(Number.isFinite).sort((a, b) => a - b);
  const atrPctMax = quantileSorted(trainAtrPct, ATR_PCT_QUANTILE);
  if (!Number.isFinite(atrPctMax)) throw new Error(`train segment of ${trainEnd} bars leaves no bars after the ${WARMUP_BARS}-bar warmup`);
  return { closes, atr, emaFast, emaSlow, emaTrendFast, emaTrendSlow, rsi14, volSma, atrPctMax };
}

function checkTrigger(candles: Candle[], ind: CalculatedIndicators, i: number, p: StrategyParams): 1 | -1 | 0 {
  const lookback = p.lookback ?? 20;
  const trigger = p.trigger ?? 'DONCHIAN_BREAK';

  if (trigger === 'EMA_CROSS') {
    const bull = ind.emaFast[i] > ind.emaSlow[i] && ind.emaFast[i - 1] <= ind.emaSlow[i - 1];
    const bear = ind.emaFast[i] < ind.emaSlow[i] && ind.emaFast[i - 1] >= ind.emaSlow[i - 1];
    return bull ? 1 : bear ? -1 : 0;
  }
  if (trigger === 'PULLBACK_RECLAIM') {
    const bull = ind.emaTrendFast[i] > ind.emaTrendSlow[i] && candles[i]!.low <= ind.emaFast[i] && candles[i]!.close > ind.emaFast[i];
    const bear = ind.emaTrendFast[i] < ind.emaTrendSlow[i] && candles[i]!.high >= ind.emaFast[i] && candles[i]!.close < ind.emaFast[i];
    return bull ? 1 : bear ? -1 : 0;
  }
  if (trigger === 'SQUEEZE_EXPANSION') {
    const band = ind.atr[i]! * 1.5;
    const wasSqueeze = Math.abs(candles[i - 1]!.close - ind.emaFast[i - 1]!) < band;
    const isExpanding = Math.abs(candles[i]!.close - ind.emaFast[i]!) >= band;
    if (wasSqueeze && isExpanding) return candles[i]!.close > ind.emaFast[i] ? 1 : -1;
    return 0;
  }
  let priorHigh = -Infinity, priorLow = Infinity;
  for (let k = i - lookback; k < i; k++) {
    if (candles[k]!.high > priorHigh) priorHigh = candles[k]!.high;
    if (candles[k]!.low < priorLow) priorLow = candles[k]!.low;
  }
  if (candles[i]!.close > priorHigh) return 1;
  if (candles[i]!.close < priorLow) return -1;
  return 0;
}

function checkRegime(
  candles: Candle[],
  ind: CalculatedIndicators,
  i: number,
  opts: { dir: 1 | -1; filter?: StrategyParams['regimeFilter'] }
): boolean {
  const filter = opts.filter ?? 'LOW_VOL_EXPANSION';
  const dir = opts.dir;
  if (filter === 'NONE') return true;
  if (filter === 'TREND_EMA_50_200') return dir === 1 ? ind.emaTrendFast[i] > ind.emaTrendSlow[i] : ind.emaTrendFast[i] < ind.emaTrendSlow[i];
  if (filter === 'RSI_MOMENTUM') return dir === 1 ? ind.rsi14[i] > 52 : ind.rsi14[i] < 48;
  if (filter === 'VOLUME_SURGE') return candles[i]!.volume > ind.volSma[i]! * 1.4;
  if (filter === 'VOL_AND_TREND') {
    const trendOk = dir === 1 ? ind.emaTrendFast[i] > ind.emaTrendSlow[i] : ind.emaTrendFast[i] < ind.emaTrendSlow[i];
    return trendOk && candles[i]!.volume > ind.volSma[i]! * 1.3;
  }
  const atrRatio = ind.atr[i]! / ind.closes[i]!;
  return dir === 1 && ind.emaTrendFast[i] > ind.emaTrendSlow[i] && atrRatio <= ind.atrPctMax;
}

interface WalkLevels {
  stop: number;
  target: number;
  initialRisk: number;
  useBe: boolean;
  dir: 1 | -1;
}

function walkExit(candles: Candle[], entryIdx: number, lvls: WalkLevels, maxHold: number): { index: number; price: number } {
  let curStop = lvls.stop;
  let beActive = false;
  const lastIdx = entryIdx + maxHold - 1;

  for (let i = entryIdx; i <= lastIdx; i++) {
    const bar = candles[i]!;
    if (lvls.useBe && !beActive) {
      const halfTgt = lvls.dir === 1 ? bar.open + Math.abs(lvls.target - bar.open) * 0.5 : bar.open - Math.abs(lvls.target - bar.open) * 0.5;
      if (lvls.dir === 1 ? bar.high >= halfTgt : bar.low <= halfTgt) {
        curStop = candles[entryIdx]!.open;
        beActive = true;
      }
    }
    if (lvls.dir === 1 ? bar.low <= curStop : bar.high >= curStop) return { index: i, price: curStop };
    if (lvls.dir === 1 ? bar.high >= lvls.target : bar.low <= lvls.target) return { index: i, price: lvls.target };
  }
  return { index: lastIdx, price: candles[lastIdx]!.close };
}

export interface StrategyRunOptions {
  range: { start: number; end: number };
  roundTripBps: number;
  trainEnd: number;
}

interface ExecutionContext {
  params: StrategyParams;
  bps: number;
  maxHold: number;
  sig: 1 | -1;
}

function executeBar(
  candles: Candle[],
  ind: CalculatedIndicators,
  i: number,
  ctx: ExecutionContext
): { trade: Trade; nextIdx: number } | null {
  const { params: p, bps, maxHold, sig } = ctx;
  const entry = candles[i + 1]!.open;
  const stopAtr = p.stopAtr ?? 1.0;
  const targetDist = p.targetPct ? entry * (p.targetPct / 100) : (p.targetR ?? 2.0) * (stopAtr * ind.atr[i]!);
  const risk = p.rrRatio ? targetDist / p.rrRatio : stopAtr * ind.atr[i]!;
  if (!(risk > 0)) return null;

  const lvls = { stop: entry - sig * risk, target: entry + sig * targetDist, initialRisk: risk, useBe: p.useBreakeven ?? false, dir: sig };
  const exit = walkExit(candles, i + 1, lvls, maxHold);
  const fee = (bps / 10_000) * entry;
  return { trade: { entryTime: candles[i + 1]!.openTime, netR: (sig * (exit.price - entry) - fee) / risk }, nextIdx: exit.index + 1 };
}

export function simulateStrategy(
  candles: Candle[],
  p: StrategyParams,
  opts: StrategyRunOptions
): { trades: Trade[]; atrPctMax: number } {
  const ind = computeIndicators(candles, opts.trainEnd, p);
  const trades: Trade[] = [];
  const maxHold = p.maxHoldingBars ?? 18;
  const allowedDir = p.direction === 'SHORT' ? -1 : p.direction === 'BOTH' ? 0 : 1;
  let nextFreeIdx = 0;

  for (let i = Math.max(opts.range.start, WARMUP_BARS); i < opts.range.end - maxHold; i++) {
    if (i < nextFreeIdx) continue;
    const sig = checkTrigger(candles, ind, i, p);
    if (sig === 0 || (allowedDir !== 0 && sig !== allowedDir) || !checkRegime(candles, ind, i, { dir: sig, filter: p.regimeFilter })) continue;
    const res = executeBar(candles, ind, i, { params: p, bps: opts.roundTripBps, maxHold, sig });
    if (res) {
      trades.push(res.trade);
      nextFreeIdx = res.nextIdx;
    }
  }
  return { trades, atrPctMax: ind.atrPctMax };
}
