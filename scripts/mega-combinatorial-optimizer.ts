import type { Bar } from './indicator-matrix-scanner.js';
import { loadBarHistory } from './indicator-matrix-scanner.js';
import { type IndicatorSet, buildIndicators } from './indicator-library.js';

export interface StrategyRank {
  symbol: string;
  tf: '1h' | '4h';
  comboName: string;
  targetPct: number;
  stopDesc: string;
  isBreakeven: boolean;
  trN: number;
  trWr: number;
  trR: number;
  teN: number;
  teWr: number;
  teR: number;
  pf: number;
}

export type ConditionFn = (i: number, ind: IndicatorSet, b: Bar[]) => boolean;

interface TradeRun {
  dir: 1 | -1;
  targetPct: number;
  stopAtr: number;
  rrRatio?: number;
  useBreakeven: boolean;
  maxHold: number;
}

function simulateFast(bars: Bar[], ind: IndicatorSet, trigger: (i: number) => 1 | -1 | 0, opt: TradeRun) {
  const trades: Array<{ entryIdx: number; netR: number }> = [];
  let inPos = false, dir: 1 | -1 = 1, entry = 0, stop = 0, target = 0, entryIdx = 0, beActive = false;

  for (let i = 210; i < bars.length - 1; i++) {
    const b = bars[i];
    if (inPos) {
      const isLong = dir === 1;
      const curStop = beActive ? entry : stop;
      // Trailing to breakeven once price reaches 50% of the target distance
      if (opt.useBreakeven && !beActive) {
        const halfTgt = entry + dir * (Math.abs(target - entry) * 0.5);
        if (isLong ? b.high >= halfTgt : b.low <= halfTgt) beActive = true;
      }
      let exitPrice = 0;
      if (isLong ? b.open <= curStop : b.open >= curStop) exitPrice = b.open;
      else if (isLong ? b.low <= curStop : b.high >= curStop) exitPrice = curStop;
      else if (isLong ? b.high >= target : b.low <= target) exitPrice = target;
      else if (i - entryIdx >= opt.maxHold) exitPrice = b.close;

      if (exitPrice > 0) {
        const netPct = (dir * (exitPrice - entry) / entry) - 0.0015;
        const initialRisk = Math.abs(entry - stop) / entry;
        trades.push({ entryIdx, netR: netPct / initialRisk });
        inPos = false;
      }
      continue;
    }
    const sig = trigger(i);
    if (sig !== 0) {
      entryIdx = i + 1; dir = sig; entry = bars[i + 1].open; beActive = false;
      const targetDist = entry * (opt.targetPct / 100);
      const riskDist = opt.rrRatio ? targetDist / opt.rrRatio : opt.stopAtr * ind.atr14[i];
      stop = entry - sig * riskDist;
      target = entry + sig * targetDist;
      inPos = true;
    }
  }
  return trades;
}

function getStats(trades: Array<{ entryIdx: number; netR: number }>) {
  if (!trades.length) return { n: 0, meanR: 0, winRate: 0, pf: 0 };
  const wins = trades.filter(t => t.netR > 0);
  const winRate = (wins.length / trades.length) * 100;
  const meanR = trades.reduce((s, t) => s + t.netR, 0) / trades.length;
  const winSum = wins.reduce((s, t) => s + t.netR, 0);
  const lossSum = Math.abs(trades.filter(t => t.netR < 0).reduce((s, t) => s + t.netR, 0));
  const pf = lossSum > 0 ? winSum / lossSum : (winSum > 0 ? 99 : 0);
  return { n: trades.length, meanR, winRate, pf };
}

export function buildAtomicPrimitives() {
  const triggers: Record<string, (i: number, ind: IndicatorSet, b: Bar[]) => 1 | -1 | 0> = {
    'EMA_CROSS_20_50': (i, ind) => {
      const bull = ind.ema20[i] > ind.ema50[i] && ind.ema20[i - 1] <= ind.ema50[i - 1];
      const bear = ind.ema20[i] < ind.ema50[i] && ind.ema20[i - 1] >= ind.ema50[i - 1];
      return bull ? 1 : bear ? -1 : 0;
    },
    'EMA_CROSS_9_21': (i, ind) => {
      const bull = ind.ema9[i] > ind.ema20[i] && ind.ema9[i - 1] <= ind.ema20[i - 1];
      const bear = ind.ema9[i] < ind.ema20[i] && ind.ema9[i - 1] >= ind.ema20[i - 1];
      return bull ? 1 : bear ? -1 : 0;
    },
    'DONCHIAN_20_BREAK': (i, ind, b) => {
      if (b[i].close > ind.donchianHigh20[i - 1]) return 1;
      if (b[i].close < ind.donchianLow20[i - 1]) return -1;
      return 0;
    },
    'PULLBACK_RECLAIM': (i, ind, b) => {
      const bull = ind.ema50[i] > ind.ema200[i] && b[i].low <= ind.ema20[i] && b[i].close > ind.ema20[i];
      const bear = ind.ema50[i] < ind.ema200[i] && b[i].high >= ind.ema20[i] && b[i].close < ind.ema20[i];
      return bull ? 1 : bear ? -1 : 0;
    },
    'MACD_CROSS': (i, ind) => {
      const bull = ind.macd[i] > ind.macdSig[i] && ind.macd[i - 1] <= ind.macdSig[i - 1];
      const bear = ind.macd[i] < ind.macdSig[i] && ind.macd[i - 1] >= ind.macdSig[i - 1];
      return bull ? 1 : bear ? -1 : 0;
    },
    'STOCH_CROSS': (i, ind) => {
      const bull = ind.stochK[i] > ind.stochD[i] && ind.stochK[i - 1] <= ind.stochD[i - 1] && ind.stochK[i] < 30;
      const bear = ind.stochK[i] < ind.stochD[i] && ind.stochK[i - 1] >= ind.stochD[i - 1] && ind.stochK[i] > 70;
      return bull ? 1 : bear ? -1 : 0;
    },
    'SQUEEZE_EXPANSION': (i, ind, b) => {
      const was = ind.isSqueeze[i - 1] === 1, exp = ind.isSqueeze[i] === 0;
      if (was && exp && b[i].close > ind.ema20[i]) return 1;
      if (was && exp && b[i].close < ind.ema20[i]) return -1;
      return 0;
    }
  };

  const filters: Record<string, (i: number, ind: IndicatorSet, b: Bar[], dir: 1 | -1) => boolean> = {
    'NONE': () => true,
    'TREND_EMA_50_200': (i, ind, _, d) => d === 1 ? ind.ema50[i] > ind.ema200[i] : ind.ema50[i] < ind.ema200[i],
    'SUPERTREND_REGIME': (i, ind, _, d) => d === 1 ? ind.supertrendDir[i] === 1 : ind.supertrendDir[i] === -1,
    'ADX_TRENDING': (i, ind) => ind.adx14[i] > 22,
    'RSI_MOMENTUM': (i, ind, _, d) => d === 1 ? ind.rsi14[i] > 52 : ind.rsi14[i] < 48,
    'VOLUME_SURGE': (i, ind, b) => b[i].volume > ind.volSma20[i] * 1.5,
    'TAKER_FLOW_DOMINANCE': (i, ind, _, d) => d === 1 ? ind.takerRatio[i] > 0.52 : ind.takerRatio[i] < 0.48,
    'VOL_AND_TAKER': (i, ind, b, d) => b[i].volume > ind.volSma20[i] * 1.4 && (d === 1 ? ind.takerRatio[i] > 0.52 : ind.takerRatio[i] < 0.48),
    'TREND_AND_MOMENTUM': (i, ind, _, d) => (d === 1 ? ind.ema50[i] > ind.ema200[i] && ind.rsi14[i] > 52 : ind.ema50[i] < ind.ema200[i] && ind.rsi14[i] < 48)
  };

  return { triggers, filters };
}

export function scanAssetCombos(symbol: string, tf: '1h' | '4h'): StrategyRank[] {
  const bars = loadBarHistory(symbol, tf);
  if (bars.length < 500) return [];
  const splitIdx = Math.floor(bars.length * 0.7);
  const ind = buildIndicators(bars);
  const { triggers, filters } = buildAtomicPrimitives();
  const targets = tf === '1h' ? [1.0, 1.5, 2.0, 3.0, 5.0] : [2.0, 3.0, 5.0, 8.0, 10.0];
  const stopConfigs = [
    { desc: 'ATR_0.75', atr: 0.75 },
    { desc: 'ATR_1.0', atr: 1.0 },
    { desc: 'ATR_1.5', atr: 1.5 },
    { desc: 'RR_1.5', atr: 1.0, rr: 1.5 },
    { desc: 'RR_2.0', atr: 1.0, rr: 2.0 }
  ];
  const results: StrategyRank[] = [];

  for (const [tName, tFn] of Object.entries(triggers)) {
    for (const [fName, fFn] of Object.entries(filters)) {
      const comboName = fName === 'NONE' ? tName : `${tName}+${fName}`;
      const trigger = (i: number): 1 | -1 | 0 => {
        const sig = tFn(i, ind, bars);
        if (sig === 0) return 0;
        return fFn(i, ind, bars, sig) ? sig : 0;
      };

      for (const tgt of targets) {
        for (const stp of stopConfigs) {
          for (const be of [false, true]) {
            const trades = simulateFast(bars, ind, trigger, {
              dir: 1, targetPct: tgt, stopAtr: stp.atr, rrRatio: stp.rr, useBreakeven: be, maxHold: tf === '1h' ? 24 : 18
            });
            const trStat = getStats(trades.filter(t => t.entryIdx < splitIdx));
            const teStat = getStats(trades.filter(t => t.entryIdx >= splitIdx));
            results.push({
              symbol, tf, comboName, targetPct: tgt, stopDesc: stp.desc, isBreakeven: be,
              trN: trStat.n, trWr: trStat.winRate, trR: trStat.meanR,
              teN: teStat.n, teWr: teStat.winRate, teR: teStat.meanR, pf: teStat.pf
            });
          }
        }
      }
    }
  }
  return results;
}

function runOptimizer() {
  const symbols = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT', 'BTCUSDT'];
  const tfs: Array<'1h' | '4h'> = ['4h', '1h'];
  console.log('=== MEGA COMBINATORIAL STRATEGY OPTIMIZER ===');
  const all: StrategyRank[] = [];
  for (const tf of tfs) {
    for (const s of symbols) all.push(...scanAssetCombos(s, tf));
  }
  const viable = all.filter(r => r.teN >= 30 && r.teR > 0 && r.trR > 0);
  viable.sort((a, b) => b.teR - a.teR);

  console.log(`\nTotal tested configurations: ${all.length}`);
  console.log(`Viable configurations (n>=30 OOS, Train E[R]>0, Test E[R]>0): ${viable.length}`);

  const small = viable.filter(r => r.targetPct <= 2.0);
  const medium = viable.filter(r => r.targetPct >= 3.0 && r.targetPct <= 5.0);
  const large = viable.filter(r => r.targetPct >= 8.0);

  printBucket('1% - 2% SMALL MOVES (INTRADAY SCALPS)', small.slice(0, 15));
  printBucket('3% - 5% MEDIUM MOVES (INTRADAY/SWING)', medium.slice(0, 15));
  printBucket('8% - 10% LARGE MOVES (SWING)', large.slice(0, 15));
}

function printBucket(title: string, list: StrategyRank[]) {
  console.log(`\n>>> ${title} (Top ${list.length}) <<<`);
  console.log('Rank | Sym     | TF | Strategy Combo                                 | Tgt   | Stop     | BE?   | Train (WR%, E[R])    | Test (WR%, E[R])     | PF');
  console.log('------------------------------------------------------------------------------------------------------------------------------------------------');
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    console.log(
      `${String(i + 1).padStart(4)} | ${r.symbol.padEnd(7)} | ${r.tf} | ${r.comboName.padEnd(46)} | ` +
      `+${r.targetPct.toFixed(1)}% | ${r.stopDesc.padEnd(8)} | ${r.isBreakeven ? 'YES' : 'NO '} | ` +
      `n=${String(r.trN).padStart(3)} (${r.trWr.toFixed(1)}%, ${r.trR.toFixed(2)}R) | ` +
      `n=${String(r.teN).padStart(3)} (${r.teWr.toFixed(1)}%, ${r.teR.toFixed(2)}R) | ` +
      `PF ${r.pf.toFixed(2)}`
    );
  }
}

if (process.argv[1]?.endsWith('mega-combinatorial-optimizer.ts')) runOptimizer();
