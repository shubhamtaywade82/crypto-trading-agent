import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Trade {
  entryIdx: number;
  direction: 1 | -1;
  entryPrice: number;
  exitPrice: number;
  netR: number;
  pctGain: number;
  outcome: string;
}

export interface StrategyResult {
  name: string;
  symbol: string;
  targetPct: number;
  stopAtr: number;
  trainN: number;
  trainMeanR: number;
  trainWinRate: number;
  testN: number;
  testMeanR: number;
  testWinRate: number;
  profitFactor: number;
}

export function loadCandles(symbol: string, timeframe = '4h'): Candle[] {
  if (timeframe === '1h') return load1hCandles(symbol);
  const dir = path.join(process.cwd(), 'research-data', 'binance-usdm', '4h', symbol);
  if (!fs.existsSync(dir)) return [];
  const candles: Candle[] = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    const rows = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    parseRows(rows, candles);
  }
  return candles.sort((a, b) => a.openTime - b.openTime);
}

function parseRows(rows: unknown[][], candles: Candle[]): void {
  for (const r of rows || []) {
    candles.push({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) });
  }
}

function load1hCandles(symbol: string): Candle[] {
  const dir = path.join(process.cwd(), 'research', 'raw-archive', 'binance-usdm-1h');
  if (!fs.existsSync(dir)) return [];
  const candles: Candle[] = [];
  for (const p of ['page-00.json', 'page-01.json', 'page-02.json', 'page-03.json']) {
    const full = path.join(dir, p);
    if (!fs.existsSync(full)) continue;
    const d = JSON.parse(fs.readFileSync(full, 'utf8'));
    for (const s of d.series || []) if (s.symbol === symbol) parseRows(s.rows, candles);
  }
  const symFiles = fs.readdirSync(dir).filter(f => f.startsWith('page-') && f.includes(`-${symbol}.json`));
  for (const f of symFiles) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    parseRows(d.rows, candles);
  }
  return candles.sort((a, b) => a.openTime - b.openTime);
}

function calcEma(values: number[], period: number): Float64Array {
  const n = values.length;
  const ema = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  ema[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  return ema;
}

function calcRsi(closes: number[], period = 14): Float64Array {
  const n = closes.length;
  const rsi = new Float64Array(n);
  let gSum = 0, lSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gSum += diff; else lSum += -diff;
  }
  let avgG = gSum / period, avgL = lSum / period;
  rsi[period] = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
  for (let i = period + 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgL = (avgL * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rsi[i] = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
  }
  return rsi;
}

export function computeIndicators(candles: Candle[]) {
  const n = candles.length;
  const closes = candles.map(x => x.close);
  const highs = candles.map(x => x.high), lows = candles.map(x => x.low);
  const ema20 = calcEma(closes, 20), ema50 = calcEma(closes, 50), ema200 = calcEma(closes, 200), rsi14 = calcRsi(closes, 14);

  const tr = new Float64Array(n);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < n; i++) tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  const atr14 = new Float64Array(n);
  let s14 = 0; for (let i = 0; i < 14; i++) s14 += tr[i];
  atr14[13] = s14 / 14;
  for (let i = 14; i < n; i++) atr14[i] = (atr14[i - 1] * 13 + tr[i]) / 14;

  const macdFast = calcEma(closes, 12), macdSlow = calcEma(closes, 26), macd = new Float64Array(n);
  for (let i = 25; i < n; i++) macd[i] = macdFast[i] - macdSlow[i];
  const macdSig = calcEma(Array.from(macd), 9);

  return { closes, highs, lows, ema20, ema50, ema200, rsi14, atr14, macd, macdSig };
}

interface IntrabarCtx {
  dir: 1 | -1;
  stop: number;
  target: number;
  held: number;
  maxHold: number;
}

interface SimConfig {
  sigFn: SignalFn;
  targetPct: number;
  stopAtr: number;
  maxHold: number;
}

function resolveIntrabar(b: Candle, ctx: IntrabarCtx) {
  const { dir, stop, target, held, maxHold } = ctx;
  const isLong = dir === 1;
  if (isLong ? b.open <= stop : b.open >= stop) return { price: b.open, outcome: 'STOP_GAP' };
  const hitStop = isLong ? b.low <= stop : b.high >= stop;
  const hitTgt = isLong ? b.high >= target : b.low <= target;
  if (hitStop && hitTgt) return { price: stop, outcome: 'STOP_TOUCH' };
  if (hitStop) return { price: stop, outcome: 'STOP' };
  if (hitTgt) return { price: target, outcome: 'TARGET' };
  if (held >= maxHold) return { price: b.close, outcome: 'TIME_STOP' };
  return { price: 0, outcome: '' };
}

type SignalFn = (i: number, ind: ReturnType<typeof computeIndicators>, candles: Candle[]) => 1 | -1 | 0;

function simulateStrategy(candles: Candle[], ind: ReturnType<typeof computeIndicators>, cfg: SimConfig): Trade[] {
  const trades: Trade[] = [];
  let inPos = false, posDir: 1 | -1 = 1, posEntry = 0, posStop = 0, posTarget = 0, entryIdx = 0;

  for (let i = 210; i < candles.length - 1; i++) {
    const b = candles[i];
    if (inPos) {
      const exit = resolveIntrabar(b, { dir: posDir, stop: posStop, target: posTarget, held: i - entryIdx, maxHold: cfg.maxHold });
      if (exit.price > 0) {
        const grossPct = posDir * (exit.price - posEntry) / posEntry;
        const netPct = grossPct - 0.0015;
        const riskPct = Math.abs(posEntry - posStop) / posEntry;
        trades.push({ entryIdx, direction: posDir, entryPrice: posEntry, exitPrice: exit.price, netR: netPct / riskPct, pctGain: netPct * 100, outcome: exit.outcome });
        inPos = false;
      }
      continue;
    }
    const sig = cfg.sigFn(i, ind, candles);
    if (sig !== 0) {
      entryIdx = i + 1; posDir = sig; posEntry = candles[i + 1].open;
      const risk = cfg.stopAtr * ind.atr14[i];
      posStop = posEntry - sig * risk;
      posTarget = posEntry * (1 + sig * (cfg.targetPct / 100));
      inPos = true;
    }
  }
  return trades;
}

function statsOf(trades: Trade[]) {
  if (!trades.length) return { n: 0, meanR: 0, winRate: 0, pf: 0 };
  const wins = trades.filter(t => t.netR > 0);
  const winRate = (wins.length / trades.length) * 100;
  const meanR = trades.reduce((s, t) => s + t.netR, 0) / trades.length;
  const totalWinR = wins.reduce((s, t) => s + t.netR, 0);
  const totalLossR = Math.abs(trades.filter(t => t.netR < 0).reduce((s, t) => s + t.netR, 0));
  const pf = totalLossR > 0 ? totalWinR / totalLossR : (totalWinR > 0 ? 99 : 0);
  return { n: trades.length, meanR, winRate, pf };
}

export function getSignalRules(): Record<string, SignalFn> {
  return {
    'EMA_CROSS_20_50': (i, ind) => {
      const bull = ind.ema20[i] > ind.ema50[i] && ind.ema20[i - 1] <= ind.ema50[i - 1];
      const bear = ind.ema20[i] < ind.ema50[i] && ind.ema20[i - 1] >= ind.ema50[i - 1];
      return bull ? 1 : bear ? -1 : 0;
    },
    'EMA_PULLBACK_TREND': (i, ind, c) => {
      const up = ind.ema50[i] > ind.ema200[i] && c[i].close > ind.ema50[i];
      const down = ind.ema50[i] < ind.ema200[i] && c[i].close < ind.ema50[i];
      if (up && c[i].low <= ind.ema20[i] && c[i].close > ind.ema20[i] && c[i - 1].close <= ind.ema20[i - 1]) return 1;
      if (down && c[i].high >= ind.ema20[i] && c[i].close < ind.ema20[i] && c[i - 1].close >= ind.ema20[i - 1]) return -1;
      return 0;
    },
    'RSI_MOMENTUM_CROSS': (i, ind) => {
      const bull = ind.rsi14[i] > 55 && ind.rsi14[i - 1] <= 55 && ind.ema50[i] > ind.ema200[i];
      const bear = ind.rsi14[i] < 45 && ind.rsi14[i - 1] >= 45 && ind.ema50[i] < ind.ema200[i];
      return bull ? 1 : bear ? -1 : 0;
    },
    'MACD_ZERO_CROSS': (i, ind) => {
      const bull = ind.macd[i] > 0 && ind.macd[i - 1] <= 0 && ind.macd[i] > ind.macdSig[i];
      const bear = ind.macd[i] < 0 && ind.macd[i - 1] >= 0 && ind.macd[i] < ind.macdSig[i];
      return bull ? 1 : bear ? -1 : 0;
    },
    'DONCHIAN_20_BREAKOUT': (i, ind, c) => {
      let maxH = -Infinity, minL = Infinity;
      for (let k = i - 20; k < i; k++) {
        if (c[k].high > maxH) maxH = c[k].high;
        if (c[k].low < minL) minL = c[k].low;
      }
      return c[i].close > maxH ? 1 : c[i].close < minL ? -1 : 0;
    },
    'VOLATILITY_EXPANSION': (i, ind, c) => {
      const surge = (ind.atr14[i] / c[i].close) > (ind.atr14[i - 1] / c[i - 1].close) * 1.15;
      const bull = surge && c[i].close > ind.ema20[i] && c[i - 1].close <= ind.ema20[i - 1];
      const bear = surge && c[i].close < ind.ema20[i] && c[i - 1].close >= ind.ema20[i - 1];
      return bull ? 1 : bear ? -1 : 0;
    }
  };
}

export function scanSymbol(symbol: string, timeframe = '4h'): StrategyResult[] {
  const candles = loadCandles(symbol, timeframe);
  if (candles.length < 500) return [];
  const splitIdx = Math.floor(candles.length * 0.7);
  const ind = computeIndicators(candles);
  const rules = getSignalRules();
  const targets = timeframe === '1h' ? [1.0, 1.5, 2.0, 3.0, 5.0] : [1.5, 3.0, 5.0, 8.0, 10.0];
  const stops = [1.0, 1.5, 2.0];
  const maxHold = timeframe === '1h' ? 24 : 18;
  const results: StrategyResult[] = [];

  for (const [rName, rFn] of Object.entries(rules)) {
    for (const tgt of targets) {
      for (const stp of stops) {
        const trades = simulateStrategy(candles, ind, { sigFn: rFn, targetPct: tgt, stopAtr: stp, maxHold });
        const trainTrades = trades.filter(t => t.entryIdx < splitIdx);
        const testTrades = trades.filter(t => t.entryIdx >= splitIdx);
        const trStat = statsOf(trainTrades);
        const teStat = statsOf(testTrades);
        results.push({
          name: rName, symbol, targetPct: tgt, stopAtr: stp,
          trainN: trStat.n, trainMeanR: trStat.meanR, trainWinRate: trStat.winRate,
          testN: teStat.n, testMeanR: teStat.meanR, testWinRate: teStat.winRate, profitFactor: teStat.pf
        });
      }
    }
  }
  return results;
}

function runScanner() {
  const tf = process.argv.includes('--1h') ? '1h' : '4h';
  const symbols = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT', 'BTCUSDT'];
  console.log(`=== COMBINATORIAL STRATEGY SCANNER (${tf.toUpperCase()}) ===`);
  const allResults: StrategyResult[] = [];
  for (const sym of symbols) {
    const res = scanSymbol(sym, tf);
    allResults.push(...res);
  }
  const viable = allResults.filter(r => r.testN >= 30 && r.testMeanR > 0 && r.trainMeanR > 0);
  viable.sort((a, b) => b.testMeanR - a.testMeanR);

  console.log(`\nViable configurations (n>=30 OOS, Train E[R]>0, Test E[R]>0): ${viable.length}/${allResults.length}`);
  console.log('Rank | Symbol | Rule | Target | StopATR | Train N (WR%, E[R]) | Test N (WR%, E[R]) | Test PF');
  console.log('-----------------------------------------------------------------------------------------------');
  for (let i = 0; i < Math.min(viable.length, 25); i++) {
    const r = viable[i];
    console.log(
      `${String(i + 1).padStart(4)} | ${r.symbol.padEnd(7)} | ${r.name.padEnd(25)} | ` +
      `+${r.targetPct.toFixed(1)}% | ${r.stopAtr.toFixed(1)}x | ` +
      `n=${String(r.trainN).padStart(3)} (${r.trainWinRate.toFixed(1)}%, ${r.trainMeanR.toFixed(2)}R) | ` +
      `n=${String(r.testN).padStart(3)} (${r.testWinRate.toFixed(1)}%, ${r.testMeanR.toFixed(2)}R) | ` +
      `PF ${r.profitFactor.toFixed(2)}`
    );
  }
}

if (process.argv[1]?.endsWith('combinatorial-strategy-scanner.ts')) {
  runScanner();
}
