#!/usr/bin/env node
/**
 * sweep-eval — Stage-B cost-adjusted evaluation of the predeclared
 * sweep-and-reclaim trade family (graduation from the descriptive sweep study).
 *
 * Predeclared family (frozen before this run; do not extend after seeing results):
 *   timeframes: 4h, 1h          sides: short, long
 *   stop buffer: 0.25 / 0.50 ATR(14) beyond the sweep-episode extreme
 *   exits: time6 (close of event+6) | stop-or-2R (48-bar time stop)
 *        | stop-or-1.5R (48-bar time stop)
 *   entry: next bar open after the reclaim close; same-bar reclaim variant only
 *   costs: taker 4 bps + slippage 2 bps per side (round trip = 12 bps of notional)
 *   funding: ACTUAL historical settlements from data.binance.vision
 *   intrabar: stop fills before target; open gaps through the stop fill at the open
 *
 * Statistics: per-config net E[R] with a seeded sign-flip permutation p-value
 * (one-sided, mean > 0), Holm step-down across the whole family, and E[R] per
 * chronological quarter (4 folds) as the continuity check.
 *
 * Data/statistics plumbing now lives in src/eval-lib.ts (shared with Stage C);
 * this file keeps the frozen Stage-B family and report shape unchanged.
 *
 * Usage:
 *   npx tsx research/alma/scripts/sweep-eval.ts --symbol SOLUSDT \
 *     --timeframes 4h,1h --raw-dir data/research/alma/raw
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atrWilder } from '../src/atr.js';
import {
  fundingSumBetween,
  holmRejects,
  loadFundingHistory,
  loadSnapshot,
  manifestSha256,
  permutationP,
  summarizeR,
  type FundingPoint,
} from '../src/eval-lib.js';
import { detectSweepReclaim } from '../src/sweeps.js';
import { costsInR, fundingInR, simulateTrade } from '../src/trade-sim.js';
import { NATIVE_TIMEFRAMES, type NativeTimeframe } from '../src/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function num(name: string, fallback: number, min: number): number {
  const raw = arg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new Error('--' + name + ' must be >= ' + min);
  return value;
}

interface ConfigRow {
  timeframe: NativeTimeframe;
  side: 'short' | 'long';
  bufferAtr: number;
  exit: string;
  n: number;
  excluded: number;
  netMeanR: number | null;
  netMedianR: number | null;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  foldMeanR: (number | null)[];
  grossMeanR: number | null;
  costsMeanR: number | null;
  fundingMeanR: number | null;
  permutationP: number;
  holmSignificant: boolean;
}

const FOLDS = 4;

async function main(): Promise<void> {
  const symbol = arg('symbol', 'SOLUSDT').toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('invalid --symbol');
  const rawDir = resolve(arg('raw-dir', resolve(REPO_ROOT, 'data', 'research', 'alma', 'raw')));
  const manifestDir = resolve(arg('manifest-dir', rawDir.replace(/raw$/, 'manifests')));
  const outPath = resolve(arg('out', resolve(REPO_ROOT, 'data', 'research', 'alma', 'events', 'sweep-eval.json')));
  const timeframes = arg('timeframes', '4h,1h').split(',').map((s) => s.trim()) as NativeTimeframe[];
  for (const tf of timeframes) {
    if (!(NATIVE_TIMEFRAMES as readonly string[]).includes(tf)) throw new Error('unsupported timeframe ' + tf);
  }
  const swing = num('swing', 3, 1);
  const cooldownBars = num('cooldown', 5, 0);
  const atrLength = num('atr', 14, 1);
  const feeBps = num('fee-bps', 4, 0);
  const slipBps = num('slip-bps', 2, 0);
  const seed = num('seed', 20261021, 1);
  const iterations = num('permutations', 10000, 100);
  const timeStopBars = num('time-stop-bars', 48, 1);

  // Predeclared exits.
  const exits: Array<{ name: string; targetR: number | null; horizonBars: number }> = [
    { name: 'time6', targetR: null, horizonBars: 6 },
    { name: 'stop_or_2R', targetR: 2.0, horizonBars: timeStopBars },
    { name: 'stop_or_1.5R', targetR: 1.5, horizonBars: timeStopBars },
  ];
  const buffers = [0.25, 0.5];
  const sides: Array<'short' | 'long'> = ['short', 'long'];

  const rows: ConfigRow[] = [];
  const datasets: Record<string, object> = {};
  let fundingPoints: FundingPoint[] = [];
  let fundingMissing: string[] = [];

  for (const timeframe of timeframes) {
    const candles = loadSnapshot(resolve(rawDir, symbol + '-' + timeframe + '.json'), timeframe, symbol);
    const events = detectSweepReclaim(candles, swing, { reclaimWithinBars: 0, cooldownBars });
    const atr = atrWilder(candles, atrLength);

    if (fundingPoints.length === 0) {
      const loaded = await loadFundingHistory(symbol, candles[0].openTime, candles[candles.length - 1].closeTime);
      fundingPoints = loaded.points;
      fundingMissing = loaded.missingFiles;
    }

    const foldSize = Math.ceil(candles.length / FOLDS);
    for (const side of sides) {
      const sideEvents = events.filter((e) => (side === 'short' ? e.direction === -1 : e.direction === 1));
      for (const bufferAtr of buffers) {
        for (const exit of exits) {
          const netR: number[] = [];
          const foldR: (number | null)[] = Array.from({ length: FOLDS }, () => null);
          const foldAccum: number[][] = Array.from({ length: FOLDS }, () => []);
          let excluded = 0;
          let grossSum = 0; let costSum = 0; let fundingSum = 0;

          for (const event of sideEvents) {
            const entryIndex = event.index + 1;
            if (entryIndex >= candles.length) { excluded++; continue; }
            const atrValue = atr[event.index];
            if (atrValue === null || atrValue <= 0) { excluded++; continue; }
            const bullish = event.direction === 1;
            const entryPrice = candles[entryIndex].open;
            let extreme = bullish ? Infinity : -Infinity;
            for (let b = event.sweepIndex; b <= event.index; b++) {
              extreme = bullish ? Math.min(extreme, candles[b].low) : Math.max(extreme, candles[b].high);
            }
            const stopPrice = bullish ? extreme - bufferAtr * atrValue : extreme + bufferAtr * atrValue;
            const risk = bullish ? entryPrice - stopPrice : stopPrice - entryPrice;
            if (!(risk > 0)) { excluded++; continue; }
            const targetPrice = exit.targetR === null ? null : (bullish ? entryPrice + exit.targetR * risk : entryPrice - exit.targetR * risk);
            const timeExitIndex = event.index + exit.horizonBars;
            const outcome = simulateTrade(candles, {
              entryIndex, direction: event.direction, entryPrice, stopPrice, targetPrice, timeExitIndex,
            });
            if (outcome === null) { excluded++; continue; }
            const costsR = costsInR(entryPrice, stopPrice, feeBps, slipBps);
            const rates = fundingSumBetween(fundingPoints, candles[entryIndex].openTime, candles[outcome.exitIndex].closeTime);
            const fundingR = fundingInR(event.direction, rates, entryPrice, stopPrice);
            const net = outcome.grossR - costsR + fundingR;
            netR.push(net);
            grossSum += outcome.grossR; costSum += costsR; fundingSum += fundingR;
            foldAccum[Math.min(FOLDS - 1, Math.floor(entryIndex / foldSize))].push(net);
          }

          for (let f = 0; f < FOLDS; f++) {
            foldR[f] = foldAccum[f].length > 0 ? foldAccum[f].reduce((s, r) => s + r, 0) / foldAccum[f].length : null;
          }
          const s = summarizeR(netR);
          rows.push({
            timeframe, side, bufferAtr, exit: exit.name,
            n: netR.length, excluded,
            netMeanR: s.mean, netMedianR: s.median, winRate: s.win, profitFactor: s.pf, maxDrawdownR: s.maxDD,
            foldMeanR: foldR,
            grossMeanR: netR.length ? grossSum / netR.length : null,
            costsMeanR: netR.length ? costSum / netR.length : null,
            fundingMeanR: netR.length ? fundingSum / netR.length : null,
            permutationP: permutationP(netR, seed, iterations),
            holmSignificant: false,
          });
        }
      }
    }
    datasets[timeframe] = {
      bars: candles.length,
      manifestSha256: manifestSha256(manifestDir, symbol, timeframe),
    };
  }

  const rejects = holmRejects(rows.map((r) => r.permutationP));
  rows.forEach((row, i) => { row.holmSignificant = rejects[i]; });

  const fmt = (v: number | null, digits = 3): string => v === null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(digits);
  console.log('\nSweep-reclaim cost-adjusted evaluation (net R after fees/slippage/funding)');
  console.log('family: ' + rows.length + ' predeclared configs | Holm alpha 0.05 | permutation seed ' + seed);
  for (const row of rows) {
    console.log(
      row.timeframe.padEnd(3) + ' ' + row.side.padEnd(5) + ' buf' + row.bufferAtr.toFixed(2) + ' ' + row.exit.padEnd(11) +
      ' n=' + String(row.n).padStart(4) + ' (excl ' + row.excluded + ')' +
      ' E[R]=' + fmt(row.netMeanR) + ' med=' + fmt(row.netMedianR) +
      ' win=' + (row.winRate === null ? 'n/a' : (row.winRate * 100).toFixed(1) + '%') +
      ' PF=' + (row.profitFactor === null ? 'n/a' : row.profitFactor.toFixed(2)) +
      ' DD=' + fmt(row.maxDrawdownR) + 'R' +
      ' folds=' + row.foldMeanR.map((f) => fmt(f, 2)).join('/') +
      ' p=' + row.permutationP.toFixed(4) + (row.holmSignificant ? ' HOLM-SIG' : ''),
    );
  }

  const report = {
    schemaVersion: 1,
    kind: 'SWEEP_RECLAIM_COST_ADJUSTED_EVAL',
    generatedAt: new Date().toISOString(),
    instrument: { symbol, venue: 'BINANCE_USDM_PERPETUAL' },
    config: {
      swingStrength: swing, cooldownBars, atrLength, sameBarReclaimOnly: true,
      buffersAtr: buffers, exits, timeStopBars,
      feeBpsPerSide: feeBps, slippageBpsPerSide: slipBps,
      funding: 'actual historical settlements (data.binance.vision), missing files: ' + (fundingMissing.length ? fundingMissing.join(', ') : 'none'),
      folds: FOLDS, permutationIterations: iterations, seed,
      familySize: rows.length,
      execution: 'next-bar-open entry; stop fills before target within a bar; open gaps fill at open',
    },
    datasets,
    results: rows,
    caveats: [
      'Kline data carries no observed spread; the spread/slippage figures are assumptions.',
      'Conservative intrabar ordering (stop before target) biases results downward.',
      'A HOLM-SIG verdict is a research candidate, not live admission: the repository admission gate still applies.',
      'The family was predeclared before running; any post-hoc addition is a new study and a new holdout read.',
    ],
  };
  const digest = createHash('sha256').update(JSON.stringify(report.config)).digest('hex');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('\nReport written: ' + outPath + ' (config sha256 ' + digest.slice(0, 12) + '…)');
}

main().catch((error: unknown) => {
  console.error('sweep-eval failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
