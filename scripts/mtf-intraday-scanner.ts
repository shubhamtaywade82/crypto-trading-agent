import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Bar, loadBarHistory, computeAllIndicators } from './indicator-matrix-scanner.js';

interface MtfPair {
  bars1h: Bar[];
  bars4h: Bar[];
  trend4h: Int8Array; // 1 for bull, -1 for bear, 0 for neutral
}

function buildMtfPair(symbol: string): MtfPair {
  const bars1h = loadBarHistory(symbol, '1h');
  const bars4h = loadBarHistory(symbol, '4h');
  const ind4h = computeAllIndicators(bars4h);
  const trend4h = new Int8Array(bars1h.length);

  let p4 = 0;
  for (let i = 0; i < bars1h.length; i++) {
    const t = bars1h[i].openTime;
    while (p4 + 1 < bars4h.length && bars4h[p4 + 1].openTime <= t) p4++;
    if (p4 >= 50) {
      if (ind4h.ema20[p4] > ind4h.ema50[p4] && bars4h[p4].close > ind4h.ema50[p4]) trend4h[i] = 1;
      else if (ind4h.ema20[p4] < ind4h.ema50[p4] && bars4h[p4].close < ind4h.ema50[p4]) trend4h[i] = -1;
    }
  }
  return { bars1h, bars4h, trend4h };
}

interface SimSetup {
  dir: 1 | -1;
  stopPrice: number;
  targetPrice: number;
  held: number;
  maxHold: number;
}

function resolveExit(b: Bar, s: SimSetup) {
  const isLong = s.dir === 1;
  if (isLong ? b.open <= s.stopPrice : b.open >= s.stopPrice) return { price: b.open, outcome: 'STOP_GAP' };
  const hitStop = isLong ? b.low <= s.stopPrice : b.high >= s.stopPrice;
  const hitTgt = isLong ? b.high >= s.targetPrice : b.low <= s.targetPrice;
  if (hitStop && hitTgt) return { price: s.stopPrice, outcome: 'STOP_TOUCH' };
  if (hitStop) return { price: s.stopPrice, outcome: 'STOP' };
  if (hitTgt) return { price: s.targetPrice, outcome: 'TARGET' };
  if (s.held >= s.maxHold) return { price: b.close, outcome: 'TIME_STOP' };
  return { price: 0, outcome: '' };
}

interface RunArgs {
  targetPct: number;
  rrRatio: number; // e.g. 1.5 means stop = target / 1.5
  ruleKey: string;
}

function runMtfSimulation(pair: MtfPair, args: RunArgs) {
  const { bars1h, trend4h } = pair;
  const ind1h = computeAllIndicators(bars1h);
  const trades: Array<{ entryIdx: number; netR: number }> = [];
  let inPos = false, posDir: 1 | -1 = 1, entry = 0, stop = 0, target = 0, entryIdx = 0;

  for (let i = 210; i < bars1h.length - 1; i++) {
    const b = bars1h[i];
    if (inPos) {
      const exit = resolveExit(b, { dir: posDir, stopPrice: stop, targetPrice: target, held: i - entryIdx, maxHold: 24 });
      if (exit.price > 0) {
        const netPct = (posDir * (exit.price - entry) / entry) - 0.0015;
        const riskPct = Math.abs(entry - stop) / entry;
        trades.push({ entryIdx, netR: netPct / riskPct });
        inPos = false;
      }
      continue;
    }

    const t4 = trend4h[i];
    let sig: 1 | -1 | 0 = 0;
    if (args.ruleKey === 'MTF_EMA_CROSS') {
      const bull = ind1h.ema9[i] > ind1h.ema20[i] && ind1h.ema9[i - 1] <= ind1h.ema20[i - 1] && t4 === 1;
      const bear = ind1h.ema9[i] < ind1h.ema20[i] && ind1h.ema9[i - 1] >= ind1h.ema20[i - 1] && t4 === -1;
      sig = bull ? 1 : bear ? -1 : 0;
    } else if (args.ruleKey === 'MTF_DONCHIAN_VOL') {
      const surge = bars1h[i].volume > ind1h.volSma20[i] * 1.5;
      const bull = bars1h[i].close > ind1h.donchianHigh20[i - 1] && surge && t4 === 1;
      const bear = bars1h[i].close < ind1h.donchianLow20[i - 1] && surge && t4 === -1;
      sig = bull ? 1 : bear ? -1 : 0;
    } else if (args.ruleKey === 'MTF_BB_SQUEEZE') {
      let minW = Infinity;
      for (let k = i - 20; k < i; k++) if (ind1h.bbWidth[k] < minW) minW = ind1h.bbWidth[k];
      const expanding = ind1h.bbWidth[i - 1] <= minW * 1.05 && ind1h.bbWidth[i] > ind1h.bbWidth[i - 1] * 1.1;
      const bull = expanding && bars1h[i].close > ind1h.ema20[i] && t4 === 1;
      const bear = expanding && bars1h[i].close < ind1h.ema20[i] && t4 === -1;
      sig = bull ? 1 : bear ? -1 : 0;
    }

    if (sig !== 0) {
      entryIdx = i + 1; posDir = sig; entry = bars1h[i + 1].open;
      const targetDist = entry * (args.targetPct / 100);
      const riskDist = targetDist / args.rrRatio;
      stop = entry - sig * riskDist;
      target = entry + sig * targetDist;
      inPos = true;
    }
  }
  return trades;
}

function calcStats(trades: Array<{ entryIdx: number; netR: number }>) {
  if (!trades.length) return { n: 0, meanR: 0, winRate: 0, pf: 0 };
  const wins = trades.filter(t => t.netR > 0);
  const winRate = (wins.length / trades.length) * 100;
  const meanR = trades.reduce((s, t) => s + t.netR, 0) / trades.length;
  const winSum = wins.reduce((s, t) => s + t.netR, 0);
  const lossSum = Math.abs(trades.filter(t => t.netR < 0).reduce((s, t) => s + t.netR, 0));
  const pf = lossSum > 0 ? winSum / lossSum : (winSum > 0 ? 99 : 0);
  return { n: trades.length, meanR, winRate, pf };
}

function runMtfScanner() {
  const symbols = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT', 'BTCUSDT'];
  const rules = ['MTF_EMA_CROSS', 'MTF_DONCHIAN_VOL', 'MTF_BB_SQUEEZE'];
  const targets = [1.0, 1.5, 2.0, 3.0, 5.0];
  const rrs = [1.5, 2.0];

  console.log('=== MULTI-TIMEFRAME (4H TREND + 1H TRIGGER) INTRADAY SCANNER ===');
  const allResults: Array<{
    symbol: string; rule: string; target: number; rr: number;
    trN: number; trWr: number; trR: number;
    teN: number; teWr: number; teR: number; pf: number;
  }> = [];

  for (const sym of symbols) {
    const pair = buildMtfPair(sym);
    const splitIdx = Math.floor(pair.bars1h.length * 0.7);
    for (const rule of rules) {
      for (const target of targets) {
        for (const rr of rrs) {
          const trades = runMtfSimulation(pair, { targetPct: target, rrRatio: rr, ruleKey: rule });
          const trStat = calcStats(trades.filter(t => t.entryIdx < splitIdx));
          const teStat = calcStats(trades.filter(t => t.entryIdx >= splitIdx));
          allResults.push({
            symbol: sym, rule, target, rr,
            trN: trStat.n, trWr: trStat.winRate, trR: trStat.meanR,
            teN: teStat.n, teWr: teStat.winRate, teR: teStat.meanR, pf: teStat.pf
          });
        }
      }
    }
  }

  const viable = allResults.filter(r => r.teN >= 25 && r.teR > 0 && r.trR > 0);
  viable.sort((a, b) => b.teR - a.teR);
  console.log(`\nViable MTF Setups (n>=25 OOS, Train E[R]>0, Test E[R]>0): ${viable.length}/${allResults.length}`);
  console.log('Rank | Sym     | Rule              | Tgt   | RR  | Train (WR%, E[R])    | Test (WR%, E[R])     | PF');
  console.log('-------------------------------------------------------------------------------------------------');
  for (let i = 0; i < Math.min(viable.length, 25); i++) {
    const r = viable[i];
    console.log(
      `${String(i + 1).padStart(4)} | ${r.symbol.padEnd(7)} | ${r.rule.padEnd(17)} | ` +
      `+${r.target.toFixed(1)}% | 1:${r.rr.toFixed(1)} | ` +
      `n=${String(r.trN).padStart(3)} (${r.trWr.toFixed(1)}%, ${r.trR.toFixed(2)}R) | ` +
      `n=${String(r.teN).padStart(3)} (${r.teWr.toFixed(1)}%, ${r.teR.toFixed(2)}R) | ` +
      `PF ${r.pf.toFixed(2)}`
    );
  }
}

if (process.argv[1]?.endsWith('mtf-intraday-scanner.ts')) runMtfScanner();
