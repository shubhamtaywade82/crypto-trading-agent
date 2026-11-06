import type { Bar } from './indicator-matrix-scanner.js';
import { loadBarHistory } from './indicator-matrix-scanner.js';
import { type IndicatorSet, buildIndicators } from './indicator-library.js';

export interface StrategyStat {
  symbol: string;
  tf: '1h' | '4h';
  rule: string;
  target: number;
  stopType: string;
  trN: number;
  trWr: number;
  trR: number;
  teN: number;
  teWr: number;
  teR: number;
  pf: number;
}

type SigChecker = (i: number, ind: IndicatorSet, bars: Bar[]) => 1 | -1 | 0;

interface ExitCtx {
  dir: 1 | -1;
  stopPrice: number;
  targetPrice: number;
  held: number;
  maxHold: number;
}

function checkExit(b: Bar, ctx: ExitCtx) {
  const isLong = ctx.dir === 1;
  if (isLong ? b.open <= ctx.stopPrice : b.open >= ctx.stopPrice) return { price: b.open, outcome: 'STOP_GAP' };
  const hitStop = isLong ? b.low <= ctx.stopPrice : b.high >= ctx.stopPrice;
  const hitTgt = isLong ? b.high >= ctx.targetPrice : b.low <= ctx.targetPrice;
  if (hitStop && hitTgt) return { price: ctx.stopPrice, outcome: 'STOP_TOUCH' };
  if (hitStop) return { price: ctx.stopPrice, outcome: 'STOP' };
  if (hitTgt) return { price: ctx.targetPrice, outcome: 'TARGET' };
  if (ctx.held >= ctx.maxHold) return { price: b.close, outcome: 'TIME_STOP' };
  return { price: 0, outcome: '' };
}

interface SimOpt {
  sigFn: SigChecker;
  targetPct: number;
  stopType: string;
  maxHold: number;
}

function simulateOpt(bars: Bar[], ind: IndicatorSet, opt: SimOpt) {
  const trades: Array<{ entryIdx: number; netR: number }> = [];
  let inPos = false, dir: 1 | -1 = 1, entry = 0, stop = 0, target = 0, entryIdx = 0;

  for (let i = 210; i < bars.length - 1; i++) {
    const b = bars[i];
    if (inPos) {
      const exit = checkExit(b, { dir, stopPrice: stop, targetPrice: target, held: i - entryIdx, maxHold: opt.maxHold });
      if (exit.price > 0) {
        const netPct = (dir * (exit.price - entry) / entry) - 0.0015;
        const riskPct = Math.abs(entry - stop) / entry;
        trades.push({ entryIdx, netR: netPct / riskPct });
        inPos = false;
      }
      continue;
    }
    const sig = opt.sigFn(i, ind, bars);
    if (sig !== 0) {
      entryIdx = i + 1; dir = sig; entry = bars[i + 1].open;
      const targetDist = entry * (opt.targetPct / 100);
      let riskDist = ind.atr14[i];
      if (opt.stopType === 'ATR_0.75') riskDist = 0.75 * ind.atr14[i];
      else if (opt.stopType === 'ATR_1.5') riskDist = 1.5 * ind.atr14[i];
      else if (opt.stopType === 'RR_1.5') riskDist = targetDist / 1.5;
      else if (opt.stopType === 'RR_2.0') riskDist = targetDist / 2.0;
      stop = entry - sig * riskDist;
      target = entry + sig * targetDist;
      inPos = true;
    }
  }
  return trades;
}

function calcMetric(trades: Array<{ entryIdx: number; netR: number }>) {
  if (!trades.length) return { n: 0, meanR: 0, winRate: 0, pf: 0 };
  const wins = trades.filter(t => t.netR > 0);
  const winRate = (wins.length / trades.length) * 100;
  const meanR = trades.reduce((s, t) => s + t.netR, 0) / trades.length;
  const winSum = wins.reduce((s, t) => s + t.netR, 0);
  const lossSum = Math.abs(trades.filter(t => t.netR < 0).reduce((s, t) => s + t.netR, 0));
  const pf = lossSum > 0 ? winSum / lossSum : (winSum > 0 ? 99 : 0);
  return { n: trades.length, meanR, winRate, pf };
}

export function getExhaustiveRules(): Record<string, SigChecker> {
  return {
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
    'EMA_RIBBON_ALIGN': (i, ind) => {
      const bull = ind.ema9[i] > ind.ema20[i] && ind.ema20[i] > ind.ema50[i] && ind.ema9[i - 1] <= ind.ema20[i - 1];
      const bear = ind.ema9[i] < ind.ema20[i] && ind.ema20[i] < ind.ema50[i] && ind.ema9[i - 1] >= ind.ema20[i - 1];
      return bull ? 1 : bear ? -1 : 0;
    },
    'SUPERTREND_FLIP': (i, ind) => {
      if (ind.supertrendDir[i] === 1 && ind.supertrendDir[i - 1] === -1) return 1;
      if (ind.supertrendDir[i] === -1 && ind.supertrendDir[i - 1] === 1) return -1;
      return 0;
    },
    'SUPERTREND_ADX_CONFIRM': (i, ind) => {
      const strong = ind.adx14[i] > 25;
      if (ind.supertrendDir[i] === 1 && ind.supertrendDir[i - 1] === -1 && strong) return 1;
      if (ind.supertrendDir[i] === -1 && ind.supertrendDir[i - 1] === 1 && strong) return -1;
      return 0;
    },
    'DONCHIAN_20_BREAKOUT': (i, ind, b) => {
      if (b[i].close > ind.donchianHigh20[i - 1]) return 1;
      if (b[i].close < ind.donchianLow20[i - 1]) return -1;
      return 0;
    },
    'DONCHIAN_VOL_SURGE': (i, ind, b) => {
      const vol = b[i].volume > ind.volSma20[i] * 1.5;
      if (b[i].close > ind.donchianHigh20[i - 1] && vol) return 1;
      if (b[i].close < ind.donchianLow20[i - 1] && vol) return -1;
      return 0;
    },
    'DONCHIAN_TAKER_FLOW': (i, ind, b) => {
      if (b[i].close > ind.donchianHigh20[i - 1] && ind.takerRatio[i] > 0.53) return 1;
      if (b[i].close < ind.donchianLow20[i - 1] && ind.takerRatio[i] < 0.47) return -1;
      return 0;
    },
    'TTM_SQUEEZE_EXPANSION': (i, ind, b) => {
      const wasSqueeze = ind.isSqueeze[i - 1] === 1;
      const fired = ind.isSqueeze[i] === 0;
      if (wasSqueeze && fired && b[i].close > ind.ema20[i]) return 1;
      if (wasSqueeze && fired && b[i].close < ind.ema20[i]) return -1;
      return 0;
    },
    'BB_MEAN_REVERSION': (i, ind, b) => {
      const bull = ind.rsi14[i - 1] < 30 && ind.rsi14[i] >= 30 && b[i].close > b[i].open;
      const bear = ind.rsi14[i - 1] > 70 && ind.rsi14[i] <= 70 && b[i].close < b[i].open;
      return bull ? 1 : bear ? -1 : 0;
    },
    'MACD_SIGNAL_CROSS': (i, ind) => {
      const bull = ind.macd[i] > ind.macdSig[i] && ind.macd[i - 1] <= ind.macdSig[i - 1];
      const bear = ind.macd[i] < ind.macdSig[i] && ind.macd[i - 1] >= ind.macdSig[i - 1];
      return bull ? 1 : bear ? -1 : 0;
    },
    'STOCH_OVERSOLD_CROSS': (i, ind) => {
      const bull = ind.stochK[i] > ind.stochD[i] && ind.stochK[i - 1] <= ind.stochD[i - 1] && ind.stochK[i] < 25;
      const bear = ind.stochK[i] < ind.stochD[i] && ind.stochK[i - 1] >= ind.stochD[i - 1] && ind.stochK[i] > 75;
      return bull ? 1 : bear ? -1 : 0;
    },
    'CONFLUENCE_TREND_MOMENTUM': (i, ind) => {
      const bull = ind.ema20[i] > ind.ema50[i] && ind.rsi14[i] > 52 && ind.macd[i] > ind.macdSig[i] && ind.macd[i - 1] <= ind.macdSig[i - 1];
      const bear = ind.ema20[i] < ind.ema50[i] && ind.rsi14[i] < 48 && ind.macd[i] < ind.macdSig[i] && ind.macd[i - 1] >= ind.macdSig[i - 1];
      return bull ? 1 : bear ? -1 : 0;
    },
    'CONFLUENCE_BREAKOUT_VOL_FLOW': (i, ind, b) => {
      const surge = b[i].volume > ind.volSma20[i] * 1.5;
      const bull = b[i].close > ind.donchianHigh20[i - 1] && surge && ind.takerRatio[i] > 0.52;
      const bear = b[i].close < ind.donchianLow20[i - 1] && surge && ind.takerRatio[i] < 0.48;
      return bull ? 1 : bear ? -1 : 0;
    }
  };
}

export function scanGrid(symbol: string, tf: '1h' | '4h'): StrategyStat[] {
  const bars = loadBarHistory(symbol, tf);
  if (bars.length < 500) return [];
  const splitIdx = Math.floor(bars.length * 0.7);
  const ind = buildIndicators(bars);
  const rules = getExhaustiveRules();
  const targets = tf === '1h' ? [1.0, 1.5, 2.0, 3.0, 5.0] : [2.0, 3.0, 5.0, 8.0, 10.0];
  const stops = ['ATR_0.75', 'ATR_1.0', 'ATR_1.5', 'RR_1.5', 'RR_2.0'];
  const maxHold = tf === '1h' ? 24 : 18;
  const results: StrategyStat[] = [];

  for (const [rule, sigFn] of Object.entries(rules)) {
    for (const target of targets) {
      for (const stopType of stops) {
        const trades = simulateOpt(bars, ind, { sigFn, targetPct: target, stopType, maxHold });
        const trStat = calcMetric(trades.filter(t => t.entryIdx < splitIdx));
        const teStat = calcMetric(trades.filter(t => t.entryIdx >= splitIdx));
        results.push({
          symbol, tf, rule, target, stopType,
          trN: trStat.n, trWr: trStat.winRate, trR: trStat.meanR,
          teN: teStat.n, teWr: teStat.winRate, teR: teStat.meanR, pf: teStat.pf
        });
      }
    }
  }
  return results;
}

function runEngine() {
  const symbols = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT', 'BTCUSDT'];
  const tfs: Array<'1h' | '4h'> = ['4h', '1h'];
  console.log('=== EXHAUSTIVE COMBINATORIAL STRATEGY ENGINE ===');
  const all: StrategyStat[] = [];
  for (const tf of tfs) {
    for (const s of symbols) all.push(...scanGrid(s, tf));
  }
  const viable = all.filter(r => r.teN >= 30 && r.teR > 0 && r.trR > 0);
  viable.sort((a, b) => b.teR - a.teR);

  console.log(`\nEvaluated: ${all.length} configurations across 4 assets & 2 timeframes.`);
  console.log(`Viable configurations (n>=30 OOS, Train E[R]>0, Test E[R]>0): ${viable.length}`);

  const small = viable.filter(r => r.target <= 2.0);
  const medium = viable.filter(r => r.target >= 3.0 && r.target <= 5.0);
  const large = viable.filter(r => r.target >= 8.0);

  printBucket('1% - 2% SMALL MOVES (INTRADAY SCALPS)', small.slice(0, 15));
  printBucket('3% - 5% MEDIUM MOVES (INTRADAY/SWING)', medium.slice(0, 15));
  printBucket('8% - 10% LARGE MOVES (SWING)', large.slice(0, 15));
}

function printBucket(title: string, list: StrategyStat[]) {
  console.log(`\n>>> ${title} (Top ${list.length}) <<<`);
  console.log('Rank | Sym     | TF | Rule                       | Tgt   | Stop     | Train (WR%, E[R])    | Test (WR%, E[R])     | PF');
  console.log('--------------------------------------------------------------------------------------------------------------------');
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    console.log(
      `${String(i + 1).padStart(4)} | ${r.symbol.padEnd(7)} | ${r.tf} | ${r.rule.padEnd(26)} | ` +
      `+${r.target.toFixed(1)}% | ${r.stopType.padEnd(8)} | ` +
      `n=${String(r.trN).padStart(3)} (${r.trWr.toFixed(1)}%, ${r.trR.toFixed(2)}R) | ` +
      `n=${String(r.teN).padStart(3)} (${r.teWr.toFixed(1)}%, ${r.teR.toFixed(2)}R) | ` +
      `PF ${r.pf.toFixed(2)}`
    );
  }
}

if (process.argv[1]?.endsWith('exhaustive-combinatorial-engine.ts')) runEngine();
