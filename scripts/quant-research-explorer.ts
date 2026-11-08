import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ema, rsi, sma, wilderAtr } from '../src/binance/indicators.js';
import { loadValidatedKlines } from '../src/backtesting/klineLoader.js';
import type { Candle } from '../src/types.js';

const CACHE_DIR = path.resolve('data/cache/klines');
const ROUND_TRIP_BPS = 15;
const BPS = 10_000;
const DAY_MS = 86_400_000;
const THREE_YEARS_MS = 1095 * DAY_MS;

mkdirSync(CACHE_DIR, { recursive: true });

async function getCachedCandles(symbol: string, interval: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const cacheFile = path.join(CACHE_DIR, `${symbol}_${interval}_${fromMs}_${toMs}.json`);
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8')) as Candle[];
  }
  const loaded = await loadValidatedKlines({
    symbol,
    interval: interval as any,
    fromMs,
    toMs,
    source: 'api',
  });
  writeFileSync(cacheFile, JSON.stringify(loaded.candles));
  return loaded.candles;
}

export interface TradeResult {
  entryTime: number;
  entryPrice: number;
  exitPrice: number;
  netR: number;
  retPct: number;
  isWin: boolean;
  barsHeld: number;
}

export interface SimSetup {
  name: string;
  symbol: string;
  timeframe: string;
  trigger: 'MACD_CROSS' | 'SQUEEZE_EXPANSION' | 'DONCHIAN_BREAK' | 'PULLBACK_RECLAIM' | 'EMA_CROSS';
  regime: 'NONE' | 'TREND_EMA_50_200' | 'VOLUME_SURGE' | 'VOL_AND_TREND' | 'LOW_VOL_EXP';
  direction: 'LONG' | 'SHORT' | 'BOTH';
  targetPct?: number;
  targetR?: number;
  stopAtr: number;
  rrRatio?: number;
  useBreakeven: boolean;
  maxHold: number;
  lookback?: number;
}

export interface StrategyPerformance {
  setup: SimSetup;
  train: { trades: number; winRate: number; meanR: number; profitFactor: number };
  val: { trades: number; winRate: number; meanR: number; profitFactor: number };
}

function computeSupertrend(candles: Candle[], atrPeriod = 10, multiplier = 3.0): { trend: number[]; upper: number[]; lower: number[] } {
  const atr = wilderAtr(candles, atrPeriod);
  const trend: number[] = new Array(candles.length).fill(1);
  const upper: number[] = new Array(candles.length).fill(0);
  const lower: number[] = new Array(candles.length).fill(0);

  for (let i = 1; i < candles.length; i++) {
    const hl2 = (candles[i]!.high + candles[i]!.low) / 2;
    const band = multiplier * atr[i]!;
    let basicUpper = hl2 + band;
    let basicLower = hl2 - band;

    lower[i] = basicLower > (lower[i - 1] ?? 0) || candles[i - 1]!.close < (lower[i - 1] ?? 0) ? basicLower : lower[i - 1]!;
    upper[i] = basicUpper < (upper[i - 1] ?? 0) || candles[i - 1]!.close > (upper[i - 1] ?? 0) ? basicUpper : upper[i - 1]!;

    if (trend[i - 1] === 1) {
      trend[i] = candles[i]!.close < lower[i]! ? -1 : 1;
    } else {
      trend[i] = candles[i]!.close > upper[i]! ? 1 : -1;
    }
  }
  return { trend, upper, lower };
}

function computeBollinger(closes: number[], period = 20, mult = 2.0): { mid: number[]; upper: number[]; lower: number[] } {
  const mid = sma(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper.push(closes[i]!);
      lower.push(closes[i]!);
      continue;
    }
    let variance = 0;
    for (let k = i - period + 1; k <= i; k++) {
      variance += (closes[k]! - mid[i]!) ** 2;
    }
    const std = Math.sqrt(variance / period);
    upper.push(mid[i]! + mult * std);
    lower.push(mid[i]! - mult * std);
  }
  return { mid, upper, lower };
}

interface Indicators {
  closes: number[];
  atr: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  volSma: number[];
  rsi14: number[];
  macdLine: number[];
  macdSignal: number[];
  bbUpper: number[];
  bbLower: number[];
  stTrend: number[];
}

function buildIndicators(candles: Candle[]): Indicators {
  const closes = candles.map((c) => c.close);
  const atr = wilderAtr(candles, 14);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const volSma = sma(candles.map((c) => c.volume), 20);
  const rsi14 = rsi(closes, 14);

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]!);
  const macdSignal = ema(macdLine, 9);

  const { upper: bbUpper, lower: bbLower } = computeBollinger(closes, 20, 2.0);
  const { trend: stTrend } = computeSupertrend(candles, 10, 3.0);

  return { closes, atr, ema20, ema50, ema200, volSma, rsi14, macdLine, macdSignal, bbUpper, bbLower, stTrend };
}

function checkTrigger(candles: Candle[], ind: Indicators, i: number, s: SimSetup): 1 | -1 | 0 {
  const { trigger, lookback = 20 } = s;

  if (trigger === 'MACD_CROSS') {
    const bull = ind.macdLine[i]! > ind.macdSignal[i]! && ind.macdLine[i - 1]! <= ind.macdSignal[i - 1]!;
    const bear = ind.macdLine[i]! < ind.macdSignal[i]! && ind.macdLine[i - 1]! >= ind.macdSignal[i - 1]!;
    return bull ? 1 : bear ? -1 : 0;
  }
  if (trigger === 'EMA_CROSS') {
    const bull = ind.ema20[i]! > ind.ema50[i]! && ind.ema20[i - 1]! <= ind.ema50[i - 1]!;
    const bear = ind.ema20[i]! < ind.ema50[i]! && ind.ema20[i - 1]! >= ind.ema50[i - 1]!;
    return bull ? 1 : bear ? -1 : 0;
  }
  if (trigger === 'PULLBACK_RECLAIM') {
    const bull = ind.ema50[i]! > ind.ema200[i]! && candles[i]!.low <= ind.ema20[i]! && candles[i]!.close > ind.ema20[i]!;
    const bear = ind.ema50[i]! < ind.ema200[i]! && candles[i]!.high >= ind.ema20[i]! && candles[i]!.close < ind.ema20[i]!;
    return bull ? 1 : bear ? -1 : 0;
  }
  if (trigger === 'SQUEEZE_EXPANSION') {
    const band = ind.atr[i]! * 1.5;
    const wasSqueeze = Math.abs(candles[i - 1]!.close - ind.ema20[i - 1]!) < band;
    const isExpanding = Math.abs(candles[i]!.close - ind.ema20[i]!) >= band;
    if (wasSqueeze && isExpanding) return candles[i]!.close > ind.ema20[i]! ? 1 : -1;
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

function checkRegime(candles: Candle[], ind: Indicators, i: number, dir: 1 | -1, regime: SimSetup['regime']): boolean {
  if (regime === 'NONE') return true;
  if (regime === 'TREND_EMA_50_200') return dir === 1 ? ind.ema50[i]! > ind.ema200[i]! : ind.ema50[i]! < ind.ema200[i]!;
  if (regime === 'VOLUME_SURGE') return candles[i]!.volume > ind.volSma[i]! * 1.35;
  if (regime === 'VOL_AND_TREND') {
    const trendOk = dir === 1 ? ind.ema50[i]! > ind.ema200[i]! : ind.ema50[i]! < ind.ema200[i]!;
    return trendOk && candles[i]!.volume > ind.volSma[i]! * 1.3;
  }
  return true;
}

function walkTrade(
  candles: Candle[],
  startIdx: number,
  lvls: { stop: number; target: number; initialRisk: number; dir: 1 | -1; useBe: boolean },
  maxHold: number
): { price: number; idx: number } {
  let { stop } = lvls;
  const { target, initialRisk, dir, useBe } = lvls;
  let beArmed = false;
  const last = Math.min(startIdx + maxHold - 1, candles.length - 1);

  for (let i = startIdx; i <= last; i++) {
    const c = candles[i]!;
    if (useBe && !beArmed) {
      const profit = dir === 1 ? c.high - (target - (target - stop) / 2) : (target + (stop - target) / 2) - c.low;
      if (profit > 0) {
        stop = dir === 1 ? lvls.stop + initialRisk * 0.9 : lvls.stop - initialRisk * 0.9;
        beArmed = true;
      }
    }
    if (dir === 1 ? c.low <= stop : c.high >= stop) {
      return { price: dir === 1 ? Math.min(stop, c.open) : Math.max(stop, c.open), idx: i };
    }
    if (dir === 1 ? c.high >= target : c.low <= target) {
      return { price: target, idx: i };
    }
  }
  return { price: candles[last]!.close, idx: last };
}

function executeSimulation(candles: Candle[], ind: Indicators, s: SimSetup, range: { start: number; end: number }): TradeResult[] {
  const trades: TradeResult[] = [];
  const allowedDir = s.direction === 'SHORT' ? -1 : s.direction === 'BOTH' ? 0 : 1;
  let nextFree = 0;

  for (let i = Math.max(range.start, 200); i < range.end - s.maxHold; i++) {
    if (i < nextFree) continue;
    const sig = checkTrigger(candles, ind, i, s);
    if (sig === 0 || (allowedDir !== 0 && sig !== allowedDir)) continue;
    if (!checkRegime(candles, ind, i, sig, s.regime)) continue;

    const entry = candles[i + 1]!.open;
    const targetDist = s.targetPct ? entry * (s.targetPct / 100) : (s.targetR ?? 2.0) * (s.stopAtr * ind.atr[i]!);
    const risk = s.rrRatio ? targetDist / s.rrRatio : s.stopAtr * ind.atr[i]!;
    if (!(risk > 0)) continue;

    const stop = entry - sig * risk;
    const target = entry + sig * targetDist;
    const exit = walkTrade(candles, i + 1, { stop, target, initialRisk: risk, dir: sig, useBe: s.useBreakeven }, s.maxHold);
    const fee = (ROUND_TRIP_BPS / BPS) * entry;
    const netProfit = sig * (exit.price - entry) - fee;
    const netR = netProfit / risk;

    trades.push({
      entryTime: candles[i + 1]!.openTime,
      entryPrice: entry,
      exitPrice: exit.price,
      netR,
      retPct: (netProfit / entry) * 100,
      isWin: netProfit > 0,
      barsHeld: exit.idx - i,
    });
    nextFree = exit.idx + 1;
  }
  return trades;
}

function summarize(trades: TradeResult[]): { trades: number; winRate: number; meanR: number; profitFactor: number } {
  if (!trades.length) return { trades: 0, winRate: 0, meanR: 0, profitFactor: 0 };
  const wins = trades.filter((t) => t.isWin);
  const winRate = (wins.length / trades.length) * 100;
  const meanR = trades.reduce((acc, t) => acc + t.netR, 0) / trades.length;

  const grossProfit = wins.reduce((acc, t) => acc + t.netR, 0);
  const grossLoss = Math.abs(trades.filter((t) => !t.isWin).reduce((acc, t) => acc + t.netR, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  return { trades: trades.length, winRate, meanR, profitFactor };
}

async function runResearch() {
  const now = Date.now();
  const fromMs = now - THREE_YEARS_MS;
  const toMs = now;
  const symbols = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT'];
  const timeframes = ['4h', '1h'];

  console.log('Fetching & caching multi-year market data for SOL, ETH, XRP...');
  const candleMap = new Map<string, Candle[]>();
  const indMap = new Map<string, Indicators>();

  for (const sym of symbols) {
    for (const tf of timeframes) {
      const key = `${sym}_${tf}`;
      const candles = await getCachedCandles(sym, tf, fromMs, toMs);
      candleMap.set(key, candles);
      indMap.set(key, buildIndicators(candles));
      console.log(`Loaded ${sym} ${tf}: ${candles.length} candles.`);
    }
  }

  console.log('\nRunning combinatorial strategy exploration...');
  const results: StrategyPerformance[] = [];

  const triggers: SimSetup['trigger'][] = ['MACD_CROSS', 'SQUEEZE_EXPANSION', 'DONCHIAN_BREAK', 'PULLBACK_RECLAIM', 'EMA_CROSS'];
  const regimes: SimSetup['regime'][] = ['TREND_EMA_50_200', 'VOLUME_SURGE', 'VOL_AND_TREND', 'NONE'];
  const targets = [2.0, 3.5, 5.0, 7.5];
  const stopAtrs = [1.0, 1.5];
  const rrRatios = [1.5, 2.0];
  const directions: SimSetup['direction'][] = ['LONG', 'BOTH'];

  for (const sym of symbols) {
    for (const tf of timeframes) {
      const key = `${sym}_${tf}`;
      const candles = candleMap.get(key)!;
      const ind = indMap.get(key)!;
      const trainEnd = Math.floor(candles.length * 0.6);
      const valEnd = Math.floor(candles.length * 0.8);

      for (const trigger of triggers) {
        for (const regime of regimes) {
          for (const targetPct of targets) {
            for (const stopAtr of stopAtrs) {
              for (const rrRatio of rrRatios) {
                for (const direction of directions) {
                  for (const useBreakeven of [true, false]) {
                    const setup: SimSetup = {
                      name: `${sym}_${tf}_${trigger}_${regime}_Tgt${targetPct}%_Stop${stopAtr}Atr_rr${rrRatio}_BE${useBreakeven}_${direction}`,
                      symbol: sym,
                      timeframe: tf,
                      trigger,
                      regime,
                      direction,
                      targetPct,
                      stopAtr,
                      rrRatio,
                      useBreakeven,
                      maxHold: tf === '4h' ? 24 : 36,
                      lookback: 20,
                    };

                    const trainTrades = executeSimulation(candles, ind, setup, { start: 0, end: trainEnd });
                    if (trainTrades.length < 15) continue;
                    const trainStats = summarize(trainTrades);
                    if (trainStats.meanR <= 0 || trainStats.profitFactor < 1.1) continue;

                    const valTrades = executeSimulation(candles, ind, setup, { start: trainEnd, end: valEnd });
                    if (valTrades.length < 8) continue;
                    const valStats = summarize(valTrades);

                    if (valStats.meanR > 0 && valStats.profitFactor > 1.15) {
                      results.push({ setup, train: trainStats, val: valStats });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  console.log(`\nDiscovered ${results.length} robust candidate strategies with positive expectancy on both Train and Validation!`);
  results.sort((a, b) => b.val.profitFactor * b.val.meanR - a.val.profitFactor * a.val.meanR);

  console.log('\n================ TOP 10 DISCOVERED STRATEGIES ================');
  for (const r of results.slice(0, 10)) {
    console.log(`[${r.setup.symbol} ${r.setup.timeframe}] ${r.setup.trigger} | Regime: ${r.setup.regime} | Target: ${r.setup.targetPct}% | RR: ${r.setup.rrRatio} | BE: ${r.setup.useBreakeven}`);
    console.log(`  TRAIN: trades=${r.train.trades}, WinRate=${r.train.winRate.toFixed(1)}%, MeanR=+${r.train.meanR.toFixed(3)}, PF=${r.train.profitFactor.toFixed(2)}`);
    console.log(`  VAL:   trades=${r.val.trades}, WinRate=${r.val.winRate.toFixed(1)}%, MeanR=+${r.val.meanR.toFixed(3)}, PF=${r.val.profitFactor.toFixed(2)}`);
    console.log('--------------------------------------------------------------');
  }

  const outPath = path.resolve('data/research/discovered-strategies.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Saved full discovered candidate list to ${outPath}`);
}

runResearch().catch(console.error);
