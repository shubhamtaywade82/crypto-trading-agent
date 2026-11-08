import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ContextThresholds {
  flatSpread: number;
  atrQ33: number;
  atrQ67: number;
  shockQ99: number;
}

export interface StrategyConfig {
  name: string;
  trigger: 'SQUEEZE_EXPANSION' | 'EMA_CROSS' | 'DONCHIAN_BREAK' | 'MACD_CROSS';
  direction: 'LONG' | 'SHORT' | 'BOTH';
  targetR: number;
  stopAtr: number;
  maxHold: number;
  requireVolumeSurge?: boolean;
}

export interface TradeRecord {
  entryIdx: number;
  openTime: number;
  regime: string;
  isTrain: boolean;
  netR: number;
  isWin: boolean;
}

export interface MetricSummary {
  n: number;
  winRate: number;
  meanR: number;
  profitFactor: number;
}

export const CTX_STATES = [
  'UP_LOW', 'UP_NORMAL', 'UP_HIGH',
  'SIDEWAYS_LOW', 'SIDEWAYS_NORMAL', 'SIDEWAYS_HIGH',
  'DOWN_LOW', 'DOWN_NORMAL', 'DOWN_HIGH',
  'SHOCK'
] as const;

export function loadSymbolCandles(symbol: string): Candle[] {
  const dir = path.join(process.cwd(), 'research-data', 'binance-usdm', '4h', symbol);
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('page-') && f.endsWith('.jsonl')).sort();
    const rows: Candle[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        rows.push({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5] ?? 0) });
      }
    }
    if (rows.length > 500) return rows.sort((a, b) => a.openTime - b.openTime);
  }
  const cacheDir = path.join(process.cwd(), 'data', 'cache', 'klines');
  const cacheFile = fs.readdirSync(cacheDir).find(f => f.startsWith(`${symbol}_4h_`));
  if (!cacheFile) throw new Error(`no 4h candle source found for ${symbol}`);
  return JSON.parse(fs.readFileSync(path.join(cacheDir, cacheFile), 'utf8'));
}

export function computeQuantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  return sorted[low]! * (1 - (pos - low)) + sorted[high]! * (pos - low);
}

export function computeEma(values: number[], period: number): Float64Array {
  const out = new Float64Array(values.length);
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i] ?? 0;
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) {
    out[i] = (values[i]! * alpha) + (out[i - 1]! * (1 - alpha));
  }
  return out;
}

export function computeIndicators(candles: Candle[]) {
  const n = candles.length;
  const closes = candles.map(c => c.close);
  const ema20 = computeEma(closes, 20);
  const ema50 = computeEma(closes, 50);
  const ema200 = computeEma(closes, 200);
  const ema12 = computeEma(closes, 12);
  const ema26 = computeEma(closes, 26);
  const macdLine = Array.from({ length: n }, (_, i) => ema12[i]! - ema26[i]!);
  const macdSig = computeEma(macdLine, 9);
  const tr = new Float64Array(n);
  const atr14 = new Float64Array(n);
  const volSma20 = new Float64Array(n);
  tr[0] = candles[0]!.high - candles[0]!.low;
  for (let i = 1; i < n; i++) {
    const c = candles[i]!, prev = candles[i - 1]!;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }
  let sumTr = 0, sumVol = 0;
  for (let i = 0; i < 14; i++) sumTr += tr[i]!;
  atr14[13] = sumTr / 14;
  for (let i = 14; i < n; i++) atr14[i] = (atr14[i - 1]! * 13 + tr[i]!) / 14;
  for (let i = 0; i < 20; i++) sumVol += candles[i]!.volume;
  volSma20[19] = sumVol / 20;
  for (let i = 20; i < n; i++) {
    sumVol += candles[i]!.volume - candles[i - 20]!.volume;
    volSma20[i] = sumVol / 20;
  }
  return { ema20, ema50, ema200, atr14, volSma20, macdLine, macdSig };
}

export function fitThresholds(candles: Candle[], ind: ReturnType<typeof computeIndicators>, trainCount: number): ContextThresholds {
  const spreads: number[] = [];
  const vols: number[] = [];
  const shocks: number[] = [];
  for (let i = 210; i < trainCount; i++) {
    spreads.push(Math.abs(ind.ema50[i]! / ind.ema200[i]! - 1));
    vols.push(ind.atr14[i]! / candles[i]!.close);
    shocks.push(Math.abs(candles[i]!.close / candles[i - 1]!.close - 1));
  }
  return {
    flatSpread: computeQuantile(spreads, 0.30),
    atrQ33: computeQuantile(vols, 0.33),
    atrQ67: computeQuantile(vols, 0.67),
    shockQ99: computeQuantile(shocks, 0.99)
  };
}

export function classifyBar(c: Candle, prevClose: number, ema50: number, ema200: number, atr: number, th: ContextThresholds): string {
  const shock = Math.abs(c.close / prevClose - 1);
  if (shock > th.shockQ99) return 'SHOCK';
  const spread = ema50 / ema200 - 1;
  const volRatio = atr / c.close;
  const trend = Math.abs(spread) <= th.flatSpread ? 'SIDEWAYS' : (spread > th.flatSpread ? 'UP' : 'DOWN');
  const volPhase = volRatio < th.atrQ33 ? 'LOW' : (volRatio <= th.atrQ67 ? 'NORMAL' : 'HIGH');
  return `${trend}_${volPhase}`;
}

function checkTrigger(candles: Candle[], ind: ReturnType<typeof computeIndicators>, i: number, cfg: StrategyConfig): 1 | -1 | 0 {
  const c = candles[i]!, prev = candles[i - 1]!;
  if (cfg.requireVolumeSurge && !(c.volume > ind.volSma20[i]! * 1.35)) return 0;
  if (cfg.trigger === 'EMA_CROSS') {
    if (ind.ema20[i]! > ind.ema50[i]! && ind.ema20[i - 1]! <= ind.ema50[i - 1]!) return 1;
    if (ind.ema20[i]! < ind.ema50[i]! && ind.ema20[i - 1]! >= ind.ema50[i - 1]!) return -1;
    return 0;
  }
  if (cfg.trigger === 'MACD_CROSS') {
    if (ind.macdLine[i]! > ind.macdSig[i]! && ind.macdLine[i - 1]! <= ind.macdSig[i - 1]!) return 1;
    if (ind.macdLine[i]! < ind.macdSig[i]! && ind.macdLine[i - 1]! >= ind.macdSig[i - 1]!) return -1;
    return 0;
  }
  if (cfg.trigger === 'SQUEEZE_EXPANSION') {
    const band = ind.atr14[i]! * 1.5;
    const wasIn = Math.abs(prev.close - ind.ema20[i - 1]!) < band;
    const isOut = Math.abs(c.close - ind.ema20[i]!) >= band;
    if (wasIn && isOut) return c.close > ind.ema20[i]! ? 1 : -1;
    return 0;
  }
  let hi = -Infinity, lo = Infinity;
  for (let k = i - 24; k < i; k++) {
    if (candles[k]!.high > hi) hi = candles[k]!.high;
    if (candles[k]!.low < lo) lo = candles[k]!.low;
  }
  return c.close > hi ? 1 : (c.close < lo ? -1 : 0);
}

function walkTrade(candles: Candle[], entryIdx: number, dir: 1 | -1, levels: { stop: number; target: number }, maxHold: number) {
  const end = Math.min(candles.length - 1, entryIdx + maxHold);
  for (let i = entryIdx; i <= end; i++) {
    const bar = candles[i]!;
    if (dir === 1) {
      if (bar.low <= levels.stop) return { price: bar.open <= levels.stop ? bar.open : levels.stop };
      if (bar.high >= levels.target) return { price: levels.target };
    } else {
      if (bar.high >= levels.stop) return { price: bar.open >= levels.stop ? bar.open : levels.stop };
      if (bar.low <= levels.target) return { price: levels.target };
    }
  }
  return { price: candles[end]!.close };
}

export function simulateTrades(
  candles: Candle[],
  ind: ReturnType<typeof computeIndicators>,
  th: ContextThresholds,
  cfg: StrategyConfig,
  trainCount: number
): TradeRecord[] {
  const trades: TradeRecord[] = [];
  let nextFree = 210;
  for (let i = 210; i < candles.length - cfg.maxHold - 1; i++) {
    if (i < nextFree) continue;
    const rawSig = checkTrigger(candles, ind, i, cfg);
    if (rawSig === 0) continue;
    if (cfg.direction === 'LONG' && rawSig !== 1) continue;
    if (cfg.direction === 'SHORT' && rawSig !== -1) continue;

    const entryIdx = i + 1;
    const entryPrice = candles[entryIdx]!.open;
    const risk = ind.atr14[i]! * cfg.stopAtr;
    if (!(risk > 0)) continue;
    const stop = entryPrice - rawSig * risk;
    const target = entryPrice + rawSig * (risk * cfg.targetR);
    const exit = walkTrade(candles, entryIdx, rawSig, { stop, target }, cfg.maxHold);
    const grossReturn = (rawSig * (exit.price - entryPrice)) / entryPrice;
    const netReturn = grossReturn - 0.0015; // 15 bps round-trip fee
    const riskPct = risk / entryPrice;
    const netR = netReturn / riskPct;
    const regime = classifyBar(candles[i]!, candles[i - 1]!.close, ind.ema50[i]!, ind.ema200[i]!, ind.atr14[i]!, th);

    trades.push({ entryIdx, openTime: candles[entryIdx]!.openTime, regime, isTrain: entryIdx < trainCount, netR, isWin: netR > 0 });
    nextFree = entryIdx + cfg.maxHold;
  }
  return trades;
}

export function calcMetrics(trades: TradeRecord[]): MetricSummary {
  if (!trades.length) return { n: 0, winRate: 0, meanR: 0, profitFactor: 0 };
  const wins = trades.filter(t => t.netR > 0);
  const winRate = (wins.length / trades.length) * 100;
  const meanR = trades.reduce((acc, t) => acc + t.netR, 0) / trades.length;
  const grossProfit = wins.reduce((acc, t) => acc + t.netR, 0);
  const grossLoss = Math.abs(trades.filter(t => t.netR <= 0).reduce((acc, t) => acc + t.netR, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 99 : 0) : grossProfit / grossLoss;
  return { n: trades.length, winRate: Number(winRate.toFixed(1)), meanR: Number(meanR.toFixed(3)), profitFactor: Number(profitFactor.toFixed(2)) };
}

export function runSliceAnalysis(symbol: string, cfg: StrategyConfig) {
  const candles = loadSymbolCandles(symbol);
  const ind = computeIndicators(candles);
  const trainCount = Math.floor(candles.length * 0.7);
  const th = fitThresholds(candles, ind, trainCount);
  const trades = simulateTrades(candles, ind, th, cfg, trainCount);
  const trainTrades = trades.filter(t => t.isTrain);
  const testTrades = trades.filter(t => !t.isTrain);

  const trainMatrix: Record<string, MetricSummary> = {};
  const testMatrix: Record<string, MetricSummary> = {};
  for (const st of CTX_STATES) {
    trainMatrix[st] = calcMetrics(trainTrades.filter(t => t.regime === st));
    testMatrix[st] = calcMetrics(testTrades.filter(t => t.regime === st));
  }
  const favoredRegimes = CTX_STATES.filter(st => (trainMatrix[st]?.meanR ?? -1) > 0.05 && (trainMatrix[st]?.n ?? 0) >= 3);
  const trainFiltered = calcMetrics(trainTrades.filter(t => favoredRegimes.includes(t.regime as any)));
  const testFiltered = calcMetrics(testTrades.filter(t => favoredRegimes.includes(t.regime as any)));

  return { symbol, strategy: cfg.name, thresholds: th, baseline: { train: calcMetrics(trainTrades), test: calcMetrics(testTrades) }, filtered: { train: trainFiltered, test: testFiltered, favoredRegimes }, trainMatrix, testMatrix };
}

export function main() {
  const testConfigs: Array<{ symbol: string; cfg: StrategyConfig }> = [
    { symbol: 'ETHUSDT', cfg: { name: 'ETH Squeeze Expansion + VolSurge', trigger: 'SQUEEZE_EXPANSION', direction: 'BOTH', targetR: 2.0, stopAtr: 1.5, maxHold: 16, requireVolumeSurge: true } },
    { symbol: 'SOLUSDT', cfg: { name: 'SOL 4h EMA Cross Trend', trigger: 'EMA_CROSS', direction: 'LONG', targetR: 1.5, stopAtr: 1.5, maxHold: 20 } },
    { symbol: 'BTCUSDT', cfg: { name: 'BTC 4h Donchian Breakout + VolSurge', trigger: 'DONCHIAN_BREAK', direction: 'BOTH', targetR: 2.0, stopAtr: 1.5, maxHold: 24, requireVolumeSurge: true } },
    { symbol: 'XRPUSDT', cfg: { name: 'XRP 4h EMA Cross Trend', trigger: 'EMA_CROSS', direction: 'LONG', targetR: 2.0, stopAtr: 1.5, maxHold: 24 } },
    { symbol: 'SOLUSDT', cfg: { name: 'SOL 4h MACD Cross + VolSurge (LLM-V1)', trigger: 'MACD_CROSS', direction: 'BOTH', targetR: 1.5, stopAtr: 1.5, maxHold: 16, requireVolumeSurge: true } },
    { symbol: 'ETHUSDT', cfg: { name: 'ETH 4h MACD Cross + VolSurge (LLM-V1)', trigger: 'MACD_CROSS', direction: 'BOTH', targetR: 1.5, stopAtr: 1.5, maxHold: 16, requireVolumeSurge: true } }
  ];

  console.log('================================================================================');
  console.log('CTX-v2 10-STATE MACRO REGIME PERFORMANCE SLICE ANALYSIS (4H BARS)');
  console.log('================================================================================\n');

  for (const item of testConfigs) {
    const res = runSliceAnalysis(item.symbol, item.cfg);
    console.log(`\n>>> [${res.symbol}] ${res.strategy} <<<`);
    console.log(`Thresholds: FlatSpread=${(res.thresholds.flatSpread * 100).toFixed(2)}% | ATR_Q33=${(res.thresholds.atrQ33 * 100).toFixed(2)}% | ATR_Q67=${(res.thresholds.atrQ67 * 100).toFixed(2)}% | ShockQ99=${(res.thresholds.shockQ99 * 100).toFixed(2)}%`);
    console.log(`UNFILTERED BASELINE -> Train (N=${res.baseline.train.n}, WR=${res.baseline.train.winRate}%, MeanR=${res.baseline.train.meanR}, PF=${res.baseline.train.profitFactor}) | Test (N=${res.baseline.test.n}, WR=${res.baseline.test.winRate}%, MeanR=${res.baseline.test.meanR}, PF=${res.baseline.test.profitFactor})`);
    console.log(`CTX-v2 FILTERED     -> Train (N=${res.filtered.train.n}, WR=${res.filtered.train.winRate}%, MeanR=${res.filtered.train.meanR}, PF=${res.filtered.train.profitFactor}) | Test (N=${res.filtered.test.n}, WR=${res.filtered.test.winRate}%, MeanR=${res.filtered.test.meanR}, PF=${res.filtered.test.profitFactor})`);
    console.log(`Favored Regimes: [${res.filtered.favoredRegimes.join(', ')}]`);
    console.log('\n--- CTX-v2 10-State Breakdown (TEST SET OUT-OF-SAMPLE) ---');
    console.log('State           |   N | Win Rate | Mean Net R | Profit Factor');
    console.log('----------------|-----|----------|------------|--------------');
    for (const st of CTX_STATES) {
      const s = res.testMatrix[st]!;
      console.log(`${st.padEnd(16)}| ${String(s.n).padStart(3)} | ${s.winRate.toFixed(1).padStart(7)}% | ${s.meanR.toFixed(3).padStart(10)} | ${s.profitFactor.toFixed(2).padStart(13)}`);
    }
  }
}

if (process.argv[1]?.endsWith('ctx-v2-slice-analyzer.ts')) {
  main();
}
