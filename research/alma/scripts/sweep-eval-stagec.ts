#!/usr/bin/env node
/**
 * sweep-eval-stagec — Stage-C evaluation of the PREDECLARED wider-stop
 * sweep-and-reclaim family. This is a NEW study created after Stage B
 * rejected the narrow-stop family; it follows the same predeclaration
 * hygiene: the family and gates below were committed BEFORE any Stage-C
 * run touched the data.
 *
 * ============================================================================
 * PREDECLARED FAMILY (frozen; do not extend after seeing results)
 * ============================================================================
 * Motivation (declared): Stage B showed 4h short sweep-and-reclaim cells at
 * buffers 0.25/0.50 ATR positive-but-not-significant, consistent with the
 * mechanism hypothesis that sweep wicks overshoot the episode extreme and
 * tag a tight structure stop before the reversal plays out. Stage C widens
 * the stop into the noise band. DECLARED CONTAMINATION: this hypothesis was
 * SELECTED using the full 730d sample (Stage B pooled train+test), so the
 * primary read is the TRAIN window with family-wise correction, and any
 * survivor must additionally pass the untouched 146d TEST window AND a fresh
 * 365d earlier-history REPLICATION window that no prior stage ever loaded.
 *
 * Tested family (30 configs, Holm over all of them):
 *   timeframes: 4h, 1h
 *   side: short only (fade of swept highs)
 *   stop buffer beyond sweep-episode extreme (x ATR14): 0.50 / 0.75 / 1.00 / 1.50 / 2.00
 *   exits: stop_or_2R (48-bar time stop) | stop_or_1.5R (48-bar)
 *        | stop_or_time48 (no target; exit at close of bar 48)
 *   detection: swing k=3, same-bar reclaim, cooldown 5 (identical to Stage B)
 *   entry: next bar open after the reclaim close
 *   costs: taker 4 bps + slippage 2 bps per side (12 bps round trip)
 *   funding: actual historical settlements (data.binance.vision)
 *   execution: stop fills before target intrabar; gap-through fills at open
 *
 * Mirror diagnostic (NOT tested, NOT in the Holm family): the long side is
 * reported with statistics only, p-values omitted, to keep the tested family
 * size at the predeclared 30.
 *
 * GATES (predeclared):
 *   TRAIN (584d):  n >= 30 fills, Holm-significant (alpha 0.05, seeded
 *                  permutation p, 10k iterations, seed 20261021), net E[R] > 0,
 *                  >= 3 of 4 chronological folds strictly positive.
 *   TEST  (146d) / REPLICATION (365d earlier history): n >= 30, net E[R] > 0,
 *                  permutation p < 0.05 (re-Holm across survivors if > 1).
 *   PROMOTION: only if the same config passes ALL THREE windows. Anything
 *   less is recorded as a null result.
 * ============================================================================
 *
 * Usage (one window per invocation):
 *   npx tsx research/alma/scripts/sweep-eval-stagec.ts --window-label train \
 *     --raw-dir data/research/alma-train/raw \
 *     --out data/research/alma/events/sweep-eval-stagec-train.json
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atrWilder } from '../src/atr.js';
import {
  evalStageCGate,
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

// --- frozen family constants (see header) ----------------------------------
const BUFFERS = [0.5, 0.75, 1.0, 1.5, 2.0];
const EXITS: Array<{ name: string; targetR: number | null; horizonBars: number }> = [
  { name: 'stop_or_2R', targetR: 2.0, horizonBars: 48 },
  { name: 'stop_or_1.5R', targetR: 1.5, horizonBars: 48 },
  { name: 'stop_or_time48', targetR: null, horizonBars: 48 },
];
const TESTED_SIDE = 'short' as const;
const MIN_FILLS = 30;
const MIN_POSITIVE_FOLDS = 3;
const HOLM_ALPHA = 0.05;
const CONFIRM_ALPHA = 0.05;
const FOLDS = 4;

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

interface StageCRow {
  timeframe: NativeTimeframe;
  side: 'short' | 'long';
  tested: boolean;
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
  permutationP: number | null;
  holmSignificant: boolean;
  gatePass: boolean | null;
  gateFailures: string[];
}

async function main(): Promise<void> {
  const symbol = arg('symbol', 'SOLUSDT').toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('invalid --symbol');
  const windowLabel = arg('window-label', 'unlabeled');
  const rawDir = resolve(arg('raw-dir', resolve(REPO_ROOT, 'data', 'research', 'alma', 'raw')));
  const manifestDir = resolve(arg('manifest-dir', rawDir.replace(/raw$/, 'manifests')));
  const outPath = resolve(arg('out', resolve(REPO_ROOT, 'data', 'research', 'alma', 'events', 'sweep-eval-stagec-' + windowLabel + '.json')));
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

  const rows: StageCRow[] = [];
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
    for (const side of ['short', 'long'] as const) {
      const tested = side === TESTED_SIDE;
      const sideEvents = events.filter((e) => (side === 'short' ? e.direction === -1 : e.direction === 1));
      for (const bufferAtr of BUFFERS) {
        for (const exit of EXITS) {
          const netR: number[] = [];
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

          const foldMeanR: (number | null)[] = foldAccum.map((acc) => acc.length > 0 ? acc.reduce((s, r) => s + r, 0) / acc.length : null);
          const s = summarizeR(netR);
          rows.push({
            timeframe, side, tested, bufferAtr, exit: exit.name,
            n: netR.length, excluded,
            netMeanR: s.mean, netMedianR: s.median, winRate: s.win, profitFactor: s.pf, maxDrawdownR: s.maxDD,
            foldMeanR,
            grossMeanR: netR.length ? grossSum / netR.length : null,
            costsMeanR: netR.length ? costSum / netR.length : null,
            fundingMeanR: netR.length ? fundingSum / netR.length : null,
            permutationP: null,
            holmSignificant: false,
            gatePass: null,
            gateFailures: [],
          });
          if (tested && netR.length > 0) {
            rows[rows.length - 1].permutationP = permutationP(netR, seed, iterations);
          }
        }
      }
    }
    datasets[timeframe] = {
      bars: candles.length,
      manifestSha256: manifestSha256(manifestDir, symbol, timeframe),
    };
  }

  // Holm across the predeclared 30 tested (short) configs only.
  const testedRows = rows.filter((r) => r.tested && r.permutationP !== null);
  const rejects = holmRejects(testedRows.map((r) => r.permutationP as number), HOLM_ALPHA);
  testedRows.forEach((row, i) => {
    row.holmSignificant = rejects[i];
    const verdict = evalStageCGate(
      { n: row.n, holmSignificant: row.holmSignificant, netMeanR: row.netMeanR, foldMeanR: row.foldMeanR },
      { minFills: MIN_FILLS, minPositiveFolds: MIN_POSITIVE_FOLDS },
    );
    row.gatePass = verdict.pass;
    row.gateFailures = verdict.failures;
  });

  const fmt = (v: number | null, digits = 3): string => v === null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(digits);
  console.log('\nStage-C wider-stop sweep evaluation — window: ' + windowLabel + ' (net R after fees/slippage/funding)');
  console.log('tested family: ' + testedRows.length + ' predeclared short configs | Holm alpha ' + HOLM_ALPHA + ' | seed ' + seed);
  for (const row of rows) {
    const tag = row.tested ? '' : ' MIRROR';
    console.log(
      row.timeframe.padEnd(3) + ' ' + row.side.padEnd(5) + ' buf' + row.bufferAtr.toFixed(2) + ' ' + row.exit.padEnd(15) +
      ' n=' + String(row.n).padStart(4) + ' (excl ' + row.excluded + ')' +
      ' E[R]=' + fmt(row.netMeanR) + ' med=' + fmt(row.netMedianR) +
      ' win=' + (row.winRate === null ? 'n/a' : (row.winRate * 100).toFixed(1) + '%') +
      ' PF=' + (row.profitFactor === null ? 'n/a' : row.profitFactor.toFixed(2)) +
      ' DD=' + fmt(row.maxDrawdownR) + 'R' +
      ' folds=' + row.foldMeanR.map((f) => fmt(f, 2)).join('/') +
      (row.permutationP === null ? '' : ' p=' + row.permutationP.toFixed(4)) +
      (row.holmSignificant ? ' HOLM-SIG' : '') +
      (row.gatePass === true ? ' GATE-PASS' : row.gatePass === false ? ' gate:' + row.gateFailures.join('; ') : '') +
      tag,
    );
  }
  const survivors = testedRows.filter((r) => r.gatePass);
  console.log('\nTRAIN-GATE SURVIVORS: ' + survivors.length);
  for (const s of survivors) {
    console.log('  ' + s.timeframe + ' short buf' + s.bufferAtr.toFixed(2) + ' ' + s.exit + ' E[R]=' + fmt(s.netMeanR) + ' n=' + s.n);
  }

  const report = {
    schemaVersion: 1,
    kind: 'SWEEP_STAGE_C_EVAL',
    generatedAt: new Date().toISOString(),
    window: windowLabel,
    instrument: { symbol, venue: 'BINANCE_USDM_PERPETUAL' },
    config: {
      swingStrength: swing, cooldownBars, atrLength, sameBarReclaimOnly: true,
      testedSide: TESTED_SIDE,
      buffersAtr: BUFFERS, exits: EXITS,
      testedFamilySize: testedRows.length,
      mirrorSideReportedNotTested: true,
      feeBpsPerSide: feeBps, slippageBpsPerSide: slipBps,
      funding: 'actual historical settlements (data.binance.vision), missing files: ' + (fundingMissing.length ? fundingMissing.join(', ') : 'none'),
      folds: FOLDS,
      permutationIterations: iterations, seed,
      holmAlpha: HOLM_ALPHA,
      trainGate: { minFills: MIN_FILLS, minPositiveFolds: MIN_POSITIVE_FOLDS, holmAlpha: HOLM_ALPHA },
      confirmationGate: { minFills: MIN_FILLS, alpha: CONFIRM_ALPHA },
      execution: 'next-bar-open entry; stop fills before target within a bar; open gaps fill at open',
    },
    datasets,
    results: rows,
    caveats: [
      'Hypothesis contamination declared up front: the wider-buffer family was selected after Stage B ran on the pooled 730d sample, so train-window significance alone is NOT sufficient; survivors must also pass the untouched test window and the fresh earlier-history replication window.',
      'Long side is a mirror diagnostic only: no permutation test, no gate, not part of the Holm family. A promising-looking mirror cell is post-hoc bait and must not be chased.',
      'Kline data carries no observed spread; the spread/slippage figures are assumptions.',
      'Conservative intrabar ordering (stop before target) biases results downward.',
      'Any gate pass is a research candidate, not live admission: the repository promotion/admission gate still applies.',
    ],
  };
  const digest = createHash('sha256').update(JSON.stringify(report.config)).digest('hex');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('\nReport written: ' + outPath + ' (config sha256 ' + digest.slice(0, 12) + '…)');
}

main().catch((error: unknown) => {
  console.error('sweep-eval-stagec failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
