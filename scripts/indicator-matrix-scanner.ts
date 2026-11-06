import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Bar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume: number;
}

export interface TradeRecord {
  entryIdx: number;
  direction: 1 | -1;
  entryPrice: number;
  exitPrice: number;
  netR: number; pctGain: number; outcome: string;
}

export interface ScanResult {
  symbol: string;
  ruleName: string;
  targetPct: number;
  stopType: string;
  trainN: number;
  trainMeanR: number;
  trainWinRate: number;
  testN: number;
  testMeanR: number;
  testWinRate: number;
  profitFactor: number;
}

function parseRows(rows: unknown[][], list: Bar[]) {
  for (const r of rows || []) {
    list.push({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]), takerBuyVolume: Number(r[9]) });
  }
}

export function loadBarHistory(symbol: string, timeframe = '4h'): Bar[] {
  const bars: Bar[] = [];
  if (timeframe === '1h') {
    const dir = path.join(process.cwd(), 'research', 'raw-archive', 'binance-usdm-1h');
    for (const p of ['page-00.json', 'page-01.json', 'page-02.json', 'page-03.json']) {
      const full = path.join(dir, p);
      if (fs.existsSync(full)) {
        for (const s of JSON.parse(fs.readFileSync(full, 'utf8')).series || []) if (s.symbol === symbol) parseRows(s.rows, bars);
      }
    }
    for (const f of fs.readdirSync(dir).filter(f => f.includes(`-${symbol}.json`))) {
      parseRows(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).rows, bars);
    }
  } else {
    const dir = path.join(process.cwd(), 'research-data', 'binance-usdm', '4h', symbol);
    if (!fs.existsSync(dir)) return [];
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
      const rows = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      parseRows(rows, bars);
    }
  }
  return bars.sort((a, b) => a.openTime - b.openTime);
}

function ema(values: number[], period: number): Float64Array {
  const n = values.length, out = new Float64Array(n), k = 2 / (period + 1);
  let sum = 0; for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < n; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function rsi(closes: number[], period = 14): Float64Array {
  const n = closes.length, out = new Float64Array(n);
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l += -d;
  }
  let ag = g / period, al = l / period;
  out[period] = al === 0 ? 100 : 100 - (100 / (1 + ag / al));
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - (100 / (1 + ag / al));
  }
  return out;
}

export function computeAllIndicators(bars: Bar[]) {
  const n = bars.length, closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  const ema9 = ema(closes, 9), ema20 = ema(closes, 20), ema50 = ema(closes, 50), ema200 = ema(closes, 200), rsi14 = rsi(closes, 14);

  const tr = new Float64Array(n);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < n; i++) tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  const atr14 = new Float64Array(n);
  let s14 = 0; for (let i = 0; i < 14; i++) s14 += tr[i];
  atr14[13] = s14 / 14;
  for (let i = 14; i < n; i++) atr14[i] = (atr14[i - 1] * 13 + tr[i]) / 14;

  const mFast = ema(closes, 12), mSlow = ema(closes, 26), macd = new Float64Array(n);
  for (let i = 25; i < n; i++) macd[i] = mFast[i] - mSlow[i];
  const macdSig = ema(Array.from(macd), 9), volSma20 = new Float64Array(n);
  let vSum = 0;
  for (let i = 0; i < n; i++) {
    vSum += bars[i].volume;
    if (i >= 20) vSum -= bars[i - 20].volume;
    if (i >= 19) volSma20[i] = vSum / 20;
  }
  const bbWidth = new Float64Array(n), donchianHigh20 = new Float64Array(n), donchianLow20 = new Float64Array(n);
  for (let i = 19; i < n; i++) {
    let m = 0; for (let k = i - 19; k <= i; k++) m += closes[k]; m /= 20;
    let v = 0; for (let k = i - 19; k <= i; k++) v += (closes[k] - m) ** 2;
    bbWidth[i] = (4 * Math.sqrt(v / 20)) / m;
    let maxH = -Infinity, minL = Infinity;
    for (let k = i - 19; k <= i; k++) {
      if (highs[k] > maxH) maxH = highs[k];
      if (lows[k] < minL) minL = lows[k];
    }
    donchianHigh20[i] = maxH; donchianLow20[i] = minL;
  }
  return { closes, highs, lows, ema9, ema20, ema50, ema200, rsi14, atr14, macd, macdSig, volSma20, bbWidth, donchianHigh20, donchianLow20 };
}

type MatrixIndicators = ReturnType<typeof computeAllIndicators>;
type SignalChecker = (i: number, ind: MatrixIndicators, bars: Bar[]) => 1 | -1 | 0;

interface ExitRule {
  dir: 1 | -1;
  stopPrice: number;
  targetPrice: number;
  held: number;
  maxHold: number;
}

function checkIntrabarExit(b: Bar, r: ExitRule) {
  const isLong = r.dir === 1;
  if (isLong ? b.open <= r.stopPrice : b.open >= r.stopPrice) return { price: b.open, outcome: 'STOP_GAP' };
  const hitStop = isLong ? b.low <= r.stopPrice : b.high >= r.stopPrice;
  const hitTarget = isLong ? b.high >= r.targetPrice : b.low <= r.targetPrice;
  if (hitStop && hitTarget) return { price: r.stopPrice, outcome: 'STOP_TOUCH' };
  if (hitStop) return { price: r.stopPrice, outcome: 'STOP' };
  if (hitTarget) return { price: r.targetPrice, outcome: 'TARGET' };
  if (r.held >= r.maxHold) return { price: b.close, outcome: 'TIME_STOP' };
  return { price: 0, outcome: '' };
}

interface RunConfig {
  sigFn: SignalChecker;
  targetPct: number;
  stopType: 'ATR_1.0' | 'ATR_1.5' | 'RR_1.5' | 'RR_2.0';
  maxHold: number;
}

function simulateRun(bars: Bar[], ind: MatrixIndicators, cfg: RunConfig): TradeRecord[] {
  const trades: TradeRecord[] = [];
  let inPos = false, dir: 1 | -1 = 1, entry = 0, stop = 0, target = 0, entryIdx = 0;

  for (let i = 210; i < bars.length - 1; i++) {
    const b = bars[i];
    if (inPos) {
      const exit = checkIntrabarExit(b, { dir, stopPrice: stop, targetPrice: target, held: i - entryIdx, maxHold: cfg.maxHold });
      if (exit.price > 0) {
        const netPct = (dir * (exit.price - entry) / entry) - 0.0015;
        const riskPct = Math.abs(entry - stop) / entry;
        trades.push({ entryIdx, direction: dir, entryPrice: entry, exitPrice: exit.price, netR: netPct / riskPct, pctGain: netPct * 100, outcome: exit.outcome });
        inPos = false;
      }
      continue;
    }
    const sig = cfg.sigFn(i, ind, bars);
    if (sig !== 0) {
      entryIdx = i + 1; dir = sig; entry = bars[i + 1].open;
      const targetDist = entry * (cfg.targetPct / 100);
      const mult = cfg.stopType === 'ATR_1.5' ? 1.5 : 1.0;
      const riskDist = cfg.stopType.startsWith('RR_') ? targetDist / Number(cfg.stopType.slice(3)) : mult * ind.atr14[i];
      stop = entry - sig * riskDist;
      target = entry + sig * targetDist;
      inPos = true;
    }
  }
  return trades;
}

function computeStats(trades: TradeRecord[]) {
  if (!trades.length) return { n: 0, meanR: 0, winRate: 0, pf: 0 };
  const wins = trades.filter(t => t.netR > 0);
  const winRate = (wins.length / trades.length) * 100;
  const meanR = trades.reduce((s, t) => s + t.netR, 0) / trades.length;
  const winSum = wins.reduce((s, t) => s + t.netR, 0);
  const lossSum = Math.abs(trades.filter(t => t.netR < 0).reduce((s, t) => s + t.netR, 0));
  const pf = lossSum > 0 ? winSum / lossSum : (winSum > 0 ? 99 : 0);
  return { n: trades.length, meanR, winRate, pf };
}

export function buildStrategyRules(): Record<string, SignalChecker> {
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
    'DONCHIAN_VOL_SURGE': (i, ind, b) => {
      const volSurge = b[i].volume > ind.volSma20[i] * 1.5;
      if (b[i].close > ind.donchianHigh20[i - 1] && volSurge) return 1;
      if (b[i].close < ind.donchianLow20[i - 1] && volSurge) return -1;
      return 0;
    },
    'DONCHIAN_TAKER_FLOW': (i, ind, b) => {
      const takerRatio = b[i].volume > 0 ? b[i].takerBuyVolume / b[i].volume : 0.5;
      if (b[i].close > ind.donchianHigh20[i - 1] && takerRatio > 0.53) return 1;
      if (b[i].close < ind.donchianLow20[i - 1] && takerRatio < 0.47) return -1;
      return 0;
    },
    'BB_SQUEEZE_EXPANSION': (i, ind, b) => {
      let minW = Infinity;
      for (let k = i - 20; k < i; k++) if (ind.bbWidth[k] < minW) minW = ind.bbWidth[k];
      const expanding = ind.bbWidth[i - 1] <= minW * 1.05 && ind.bbWidth[i] > ind.bbWidth[i - 1] * 1.1;
      return expanding && b[i].close > ind.ema20[i] ? 1 : expanding && b[i].close < ind.ema20[i] ? -1 : 0;
    },
    'TREND_PULLBACK_RSI': (i, ind, b) => {
      if (ind.ema50[i] > ind.ema200[i] && ind.rsi14[i] < 45 && b[i].low <= ind.ema20[i] && b[i].close > ind.ema20[i]) return 1;
      if (ind.ema50[i] < ind.ema200[i] && ind.rsi14[i] > 55 && b[i].high >= ind.ema20[i] && b[i].close < ind.ema20[i]) return -1;
      return 0;
    },
    'MACD_MOMENTUM_ALIGN': (i, ind) => {
      if (ind.macd[i] > ind.macdSig[i] && ind.macd[i - 1] <= ind.macdSig[i - 1] && ind.rsi14[i] > 50 && ind.ema20[i] > ind.ema50[i]) return 1;
      if (ind.macd[i] < ind.macdSig[i] && ind.macd[i - 1] >= ind.macdSig[i - 1] && ind.rsi14[i] < 50 && ind.ema20[i] < ind.ema50[i]) return -1;
      return 0;
    },
    'RSI_EXTREME_REVERSAL': (i, ind, b) => {
      if (ind.rsi14[i - 1] < 30 && ind.rsi14[i] >= 30 && b[i].close > b[i].open) return 1;
      if (ind.rsi14[i - 1] > 70 && ind.rsi14[i] <= 70 && b[i].close < b[i].open) return -1;
      return 0;
    }
  };
}

export function scanSymbolMatrix(symbol: string, tf: '1h' | '4h'): ScanResult[] {
  const bars = loadBarHistory(symbol, tf);
  if (bars.length < 500) return [];
  const splitIdx = Math.floor(bars.length * 0.7);
  const ind = computeAllIndicators(bars);
  const rules = buildStrategyRules();
  const targets = tf === '1h' ? [1.0, 1.5, 2.0, 3.0, 5.0] : [2.0, 3.0, 5.0, 8.0, 10.0];
  const stopTypes: Array<RunConfig['stopType']> = ['ATR_1.0', 'ATR_1.5', 'RR_1.5', 'RR_2.0'];
  const maxHold = tf === '1h' ? 24 : 18;
  const results: ScanResult[] = [];

  for (const [rName, sigFn] of Object.entries(rules)) {
    for (const tgt of targets) {
      for (const st of stopTypes) {
        const trades = simulateRun(bars, ind, { sigFn, targetPct: tgt, stopType: st, maxHold });
        const trStat = computeStats(trades.filter(t => t.entryIdx < splitIdx));
        const teStat = computeStats(trades.filter(t => t.entryIdx >= splitIdx));
        results.push({
          symbol, ruleName: rName, targetPct: tgt, stopType: st,
          trainN: trStat.n, trainMeanR: trStat.meanR, trainWinRate: trStat.winRate,
          testN: teStat.n, testMeanR: teStat.meanR, testWinRate: teStat.winRate, profitFactor: teStat.pf
        });
      }
    }
  }
  return results;
}

function runMatrix() {
  const tf = process.argv.includes('--1h') ? '1h' : '4h';
  const symbols = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT', 'BTCUSDT'];
  console.log(`=== DEEP INDICATOR MATRIX SCANNER (${tf.toUpperCase()}) ===`);
  const all: ScanResult[] = [];
  for (const s of symbols) all.push(...scanSymbolMatrix(s, tf));

  const viable = all.filter(r => r.testN >= 30 && r.testMeanR > 0 && r.trainMeanR > 0);
  viable.sort((a, b) => b.testMeanR - a.testMeanR);
  console.log(`\nViable configurations (n>=30 OOS, Train E[R]>0, Test E[R]>0): ${viable.length}/${all.length}`);
  console.log('Rank | Sym     | Rule                     | Tgt   | Stop    | Train (WR%, E[R])    | Test (WR%, E[R])     | PF');
  console.log('-------------------------------------------------------------------------------------------------------------');
  for (let i = 0; i < Math.min(viable.length, 30); i++) {
    const r = viable[i];
    console.log(
      `${String(i + 1).padStart(4)} | ${r.symbol.padEnd(7)} | ${r.ruleName.padEnd(24)} | ` +
      `+${r.targetPct.toFixed(1)}% | ${r.stopType.padEnd(7)} | ` +
      `n=${String(r.trainN).padStart(3)} (${r.trainWinRate.toFixed(1)}%, ${r.trainMeanR.toFixed(2)}R) | ` +
      `n=${String(r.testN).padStart(3)} (${r.testWinRate.toFixed(1)}%, ${r.testMeanR.toFixed(2)}R) | ` +
      `PF ${r.profitFactor.toFixed(2)}`
    );
  }
}

if (process.argv[1]?.endsWith('indicator-matrix-scanner.ts')) runMatrix();
