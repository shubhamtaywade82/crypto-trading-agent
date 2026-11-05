import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Candle4h {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ContextThresholds {
  flatSpread: number;
  atrQ33: number;
  atrQ67: number;
  shockQ99: number;
}

export interface TradeResult {
  entryIdx: number;
  direction: 1 | -1;
  regime: string;
  netR: number;
  outcome: string;
}

export interface SplitStats {
  n: number;
  winRate: string;
  meanR: string;
  byRegime: Record<string, { n: number; winRate: string; meanR: string }>;
}

export function loadCandles(symbol: string, startMs = 1600070400000, endMs = 1793793600000): Candle4h[] {
  const dir = path.join(process.cwd(), 'research-data', 'binance-usdm', '4h', symbol);
  const files = fs.readdirSync(dir).filter(f => f.startsWith('page-') && f.endsWith('.jsonl')).sort();
  const candles: Candle4h[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n');
    for (const l of lines) {
      if (!l.trim()) continue;
      const r = JSON.parse(l);
      const t = Number(r[0]);
      if (t >= startMs && t <= endMs) {
        candles.push({ openTime: t, open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) });
      }
    }
  }
  return candles.sort((a, b) => a.openTime - b.openTime);
}

export function quantile(arr: number[], q: number): number {
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  return s[low] * (1 - (pos - low)) + s[high] * (pos - low);
}

export function computeIndicators(candles: Candle4h[]) {
  const n = candles.length;
  const closes = candles.map(x => x.close);
  const highs = candles.map(x => x.high);
  const lows = candles.map(x => x.low);

  const ema20 = new Float64Array(n);
  const ema50 = new Float64Array(n);
  const ema200 = new Float64Array(n);
  const tr = new Float64Array(n);
  const atr14 = new Float64Array(n);

  let sum20 = 0, sum50 = 0, sum200 = 0, sum14 = 0;
  for (let i = 0; i < 20; i++) sum20 += closes[i];
  for (let i = 0; i < 50; i++) sum50 += closes[i];
  for (let i = 0; i < 200; i++) sum200 += closes[i];
  ema20[19] = sum20 / 20; ema50[49] = sum50 / 50; ema200[199] = sum200 / 200;

  for (let i = 20; i < n; i++) ema20[i] = closes[i] * (2 / 21) + ema20[i - 1] * (19 / 21);
  for (let i = 50; i < n; i++) ema50[i] = closes[i] * (2 / 51) + ema50[i - 1] * (49 / 51);
  for (let i = 200; i < n; i++) ema200[i] = closes[i] * (2 / 201) + ema200[i - 1] * (199 / 201);

  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  for (let i = 0; i < 14; i++) sum14 += tr[i];
  atr14[13] = sum14 / 14;
  for (let i = 14; i < n; i++) atr14[i] = (atr14[i - 1] * 13 + tr[i]) / 14;

  return { ema20, ema50, ema200, atr14 };
}

export function fitThresholds(candles: Candle4h[], ind: ReturnType<typeof computeIndicators>, warmup = 210, trainRows = 9270): ContextThresholds {
  const trainSpread: number[] = [];
  const trainVol: number[] = [];
  const trainShock: number[] = [];
  for (let i = warmup; i < warmup + trainRows; i++) {
    trainSpread.push(Math.abs(ind.ema50[i] / ind.ema200[i] - 1));
    trainVol.push(ind.atr14[i] / candles[i].close);
    trainShock.push(Math.abs(candles[i].close / candles[i - 1].close - 1));
  }
  return {
    flatSpread: quantile(trainSpread, 0.3),
    atrQ33: quantile(trainVol, 0.33),
    atrQ67: quantile(trainVol, 0.67),
    shockQ99: quantile(trainShock, 0.99)
  };
}

function resolveExit(b: Candle4h, dir: 1 | -1, stop: number, target: number, held: number) {
  if (dir === 1) {
    if (b.open <= stop) return { price: b.open, outcome: 'STOP_GAP' };
    if (b.low <= stop && b.high >= target) return { price: stop, outcome: 'STOP_TOUCH' };
    if (b.low <= stop) return { price: stop, outcome: 'STOP' };
    if (b.high >= target) return { price: target, outcome: 'TARGET' };
  } else {
    if (b.open >= stop) return { price: b.open, outcome: 'STOP_GAP' };
    if (b.high >= stop && b.low <= target) return { price: stop, outcome: 'STOP_TOUCH' };
    if (b.high >= stop) return { price: stop, outcome: 'STOP' };
    if (b.low <= target) return { price: target, outcome: 'TARGET' };
  }
  if (held >= 12) return { price: b.close, outcome: 'TIME_STOP' };
  return { price: 0, outcome: '' };
}

export function classifyBar(c: Candle4h, prevClose: number, ema50: number, ema200: number, atr: number, th: ContextThresholds): string {
  const shock = Math.abs(c.close / prevClose - 1);
  if (shock > th.shockQ99) return 'SHOCK';
  const spread = ema50 / ema200 - 1;
  const vol = atr / c.close;
  const trend = Math.abs(spread) <= th.flatSpread ? 'SIDEWAYS' : (spread > th.flatSpread ? 'UP' : 'DOWN');
  const volPhase = vol < th.atrQ33 ? 'LOW' : (vol <= th.atrQ67 ? 'NORMAL' : 'HIGH');
  return `${trend}_${volPhase}`;
}

function checkSignal(b: Candle4h, prev: Candle4h, ema20: number, prevEma20: number, regime: string): 1 | -1 | 0 {
  const isUp = regime === 'UP_LOW' || regime === 'UP_NORMAL';
  const isDown = regime === 'DOWN_LOW' || regime === 'DOWN_NORMAL';
  if (isUp && b.low <= ema20 && b.close > ema20 && prev.close <= prevEma20) return 1;
  if (isDown && b.high >= ema20 && b.close < ema20 && prev.close >= prevEma20) return -1;
  return 0;
}

export function simulatePullback(candles: Candle4h[], th: ContextThresholds, ind: ReturnType<typeof computeIndicators>): TradeResult[] {
  const trades: TradeResult[] = [];
  let inPos = false, posDir: 1 | -1 = 1, posEntry = 0, posStop = 0, posTarget = 0, entryIdx = 0, posRegime = '';

  for (let i = 210; i < candles.length - 1; i++) {
    const b = candles[i];
    if (inPos) {
      const { price: exitPrice, outcome } = resolveExit(b, posDir, posStop, posTarget, i - entryIdx);
      if (exitPrice > 0) {
        const netPct = (posDir * (exitPrice - posEntry) / posEntry) - 0.0015;
        const riskPct = Math.abs(posEntry - posStop) / posEntry;
        trades.push({ entryIdx, direction: posDir, regime: posRegime, netR: netPct / riskPct, outcome });
        inPos = false;
      }
      continue;
    }
    const regime = classifyBar(b, candles[i - 1].close, ind.ema50[i], ind.ema200[i], ind.atr14[i], th);
    const sig = checkSignal(b, candles[i - 1], ind.ema20[i], ind.ema20[i - 1], regime);
    if (sig !== 0) {
      entryIdx = i + 1; posDir = sig; posEntry = candles[i + 1].open;
      const risk = 1.5 * ind.atr14[i];
      posStop = posEntry - sig * risk; posTarget = posEntry + sig * 2 * risk;
      posRegime = regime; inPos = true;
    }
  }
  return trades;
}

export function compileStats(trades: TradeResult[]): SplitStats {
  if (!trades.length) return { n: 0, winRate: '0.0%', meanR: '0.000', byRegime: {} };
  const wins = trades.filter(t => t.netR > 0).length;
  const meanR = trades.reduce((s, t) => s + t.netR, 0) / trades.length;
  const byRegime: Record<string, { n: number; winRate: string; meanR: string }> = {};
  for (const reg of ['UP_LOW', 'UP_NORMAL', 'DOWN_LOW', 'DOWN_NORMAL']) {
    const sub = trades.filter(t => t.regime === reg);
    if (sub.length) {
      const swins = sub.filter(t => t.netR > 0).length;
      const smean = sub.reduce((s, t) => s + t.netR, 0) / sub.length;
      byRegime[reg] = { n: sub.length, winRate: (swins / sub.length * 100).toFixed(1) + '%', meanR: smean.toFixed(3) };
    }
  }
  return { n: trades.length, winRate: (wins / trades.length * 100).toFixed(1) + '%', meanR: meanR.toFixed(3), byRegime };
}

export function evaluateSymbol(symbol: string) {
  const candles = loadCandles(symbol);
  const ind = computeIndicators(candles);
  const th = fitThresholds(candles, ind);
  const trades = simulatePullback(candles, th, ind);
  const trainTrades = trades.filter(t => t.entryIdx < 210 + 9270);
  const testTrades = trades.filter(t => t.entryIdx >= 210 + 9270);
  return { symbol, thresholds: th, train: compileStats(trainTrades), test: compileStats(testTrades) };
}

function main() {
  const symbols = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT'];
  console.log('=== CONTEXT STRATEGY RESEARCH: TREND PULLBACK CONTINUATION ===');
  for (const s of symbols) {
    const res = evaluateSymbol(s);
    console.log(`\nSymbol: ${res.symbol}`);
    console.log(`  Train (n=${res.train.n}): winRate=${res.train.winRate}, meanR=${res.train.meanR}`);
    console.log(`  Test  (n=${res.test.n}): winRate=${res.test.winRate}, meanR=${res.test.meanR}`);
    for (const [r, v] of Object.entries(res.test.byRegime)) {
      console.log(`    Test ${r} (n=${v.n}): winRate=${v.winRate}, meanR=${v.meanR}`);
    }
  }
}

if (process.argv[1]?.endsWith('context-strategy-harness.ts')) {
  main();
}
