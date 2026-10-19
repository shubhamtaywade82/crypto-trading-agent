#!/usr/bin/env node
/**
 * sweep-eval-staged — Stage-D evaluation of the PREDECLARED limit-at-level
 * (retest) execution model for the sweep-and-reclaim family. New study on a
 * fresh branch; the family and gates below were committed BEFORE any Stage-D
 * run touched the data.
 *
 * ============================================================================
 * PREDECLARED FAMILY (frozen; do not extend after seeing results)
 * ============================================================================
 * Motivation (declared): Stages B and C rejected the chase-entry model
 * (next-open after reclaim close) at every stop buffer, with gross edge of
 * only ~0.05-0.14R. The remaining mechanistically distinct variant is the
 * execution model itself: ICT practice enters at the LEVEL with a resting
 * limit (maker, better price) rather than chasing. This changes both the
 * entry price and the fill population: only events whose retest returns to
 * the level are traded (adverse selection included), and the missed rebounds
 * are counted, not silently dropped.
 *
 * Tested family (24 configs, Holm over all of them):
 *   timeframe: 4h only (declared rationale: Stage B/C showed the 1h
 *     uniformly negative for target-based exits; the execution hypothesis is
 *     tested where the underlying event family showed signal)
 *   sides: short AND long (the execution hypothesis is side-neutral; the
 *     long side was never a tested family before, only a mirror diagnostic)
 *   stop buffer beyond sweep-episode extreme (x ATR14): 0.25 / 0.50 / 1.00
 *   retest fill window after reclaim close: 6 / 12 bars (24h / 48h)
 *   exits: stop_or_2R (48-bar time stop after fill)
 *        | stop_or_time48 (no target; exit at close of fill+48)
 *   detection: swing k=3, same-bar reclaim, cooldown 5 (identical to B/C)
 *   costs: entry = maker 2 bps, no slippage (resting limit); exit = taker
 *     4 bps + 2 bps slippage for stop/time exits, maker 2 bps for target
 *     exits. A full-taker-entry sensitivity (entry 4 bps + 2 bps slippage)
 *     is reported alongside as netMeanRTakerEntry.
 *   funding: actual historical settlements (data.binance.vision)
 *   execution: resting limit fills only on a retest of the level; marketable
 *     gaps fill at the open; degenerate fills (at/beyond stop) excluded;
 *     stop fills before target intrabar; gap-through-stop fills at open.
 *
 * GATES (predeclared, identical to Stage C):
 *   TRAIN (584d):  n >= 30 FILLED trades, Holm-significant (alpha 0.05,
 *                  seeded permutation p, 10k iterations, seed 20261021),
 *                  net E[R] > 0, >= 3 of 4 chronological folds > 0.
 *   TEST (146d) / REPLICATION (365d earlier history, both still virgin —
 *                  Stage C had zero survivors so never touched them):
 *                  n >= 30, net E[R] > 0, permutation p < 0.05 (re-Holm
 *                  across survivors if > 1).
 *   PROMOTION: only if the same config passes ALL THREE windows.
 * ============================================================================
 *
 * Usage (one window per invocation):
 *   npx tsx research/alma/scripts/sweep-eval-staged.ts --window-label train \
 *     --raw-dir data/research/alma-train/raw \
 *     --out data/research/alma/events/sweep-eval-staged-train.json
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
import { simulateRetestTrade } from '../src/retest-sim.js';
import { detectSweepReclaim } from '../src/sweeps.js';
import { fundingInR } from '../src/trade-sim.js';
import { NATIVE_TIMEFRAMES, type NativeTimeframe } from '../src/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// --- frozen family constants (see header) ----------------------------------
const BUFFERS = [0.25, 0.5, 1.0];
const FILL_WINDOWS = [6, 12];
const EXITS: Array<{ name: string; targetR: number | null; timeExitBars: number }> = [
  { name: 'stop_or_2R', targetR: 2.0, timeExitBars: 48 },
  { name: 'stop_or_time48', targetR: null, timeExitBars: 48 },
];
const MIN_FILLS = 30;
const MIN_POSITIVE_FOLDS = 3;
const HOLM_ALPHA = 0.05;
const CONFIRM_ALPHA = 0.05;
const FOLDS = 4;

// Predeclared fee schedule (bps per side): maker entry, exit-type dependent.
const MAKER_FEE_BPS = 2;
const TAKER_FEE_BPS = 4;
const SLIPPAGE_BPS = 2;
// Full-taker-entry sensitivity: entry would cost TAKER_FEE_BPS + SLIPPAGE_BPS
// instead of MAKER_FEE_BPS + 0 -> per-trade delta in R:
const TAKER_ENTRY_DELTA_FRAC = (TAKER_FEE_BPS + SLIPPAGE_BPS - MAKER_FEE_BPS) / 10_000;

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

interface StageDRow {
  side: 'short' | 'long';
  bufferAtr: number;
  fillWindowBars: number;
  exit: string;
  events: number;
  filled: number;
  unfilled: number;
  degenerate: number;
  fillRate: number | null;
  n: number;
  netMeanR: number | null;
  netMedianR: number | null;
  netMeanRTakerEntry: number | null;
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
  const outPath = resolve(arg('out', resolve(REPO_ROOT, 'data', 'research', 'alma', 'events', 'sweep-eval-staged-' + windowLabel + '.json')));
  const timeframes = arg('timeframes', '4h').split(',').map((s) => s.trim()) as NativeTimeframe[];
  for (const tf of timeframes) {
    if (!(NATIVE_TIMEFRAMES as readonly string[]).includes(tf)) throw new Error('unsupported timeframe ' + tf);
  }
  const swing = num('swing', 3, 1);
  const cooldownBars = num('cooldown', 5, 0);
  const atrLength = num('atr', 14, 1);
  const seed = num('seed', 20261021, 1);
  const iterations = num('permutations', 10000, 100);

  const rows: StageDRow[] = [];
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
      const sideEvents = events.filter((e) => (side === 'short' ? e.direction === -1 : e.direction === 1));
      for (const bufferAtr of BUFFERS) {
        for (const fillWindowBars of FILL_WINDOWS) {
          for (const exit of EXITS) {
            const netR: number[] = [];
            const takerAdjusted: number[] = [];
            const foldAccum: number[][] = Array.from({ length: FOLDS }, () => []);
            let unfilled = 0;
            let degenerate = 0;
            let grossSum = 0; let costSum = 0; let fundingSum = 0;

            for (const event of sideEvents) {
              const atrValue = atr[event.index];
              if (atrValue === null || atrValue <= 0) continue;
              const bullish = event.direction === 1;
              let extreme = bullish ? Infinity : -Infinity;
              for (let b = event.sweepIndex; b <= event.index; b++) {
                extreme = bullish ? Math.min(extreme, candles[b].low) : Math.max(extreme, candles[b].high);
              }
              const stopPrice = bullish ? extreme - bufferAtr * atrValue : extreme + bufferAtr * atrValue;
              if (!(bullish ? stopPrice < event.level : stopPrice > event.level)) continue; // stop must leave room to the level

              const result = simulateRetestTrade(candles, {
                signalIndex: event.index,
                direction: event.direction,
                level: event.level,
                stopPrice,
                targetR: exit.targetR,
                fillWindowBars,
                timeExitBars: exit.timeExitBars,
              });
              if (!result.filled) { unfilled++; continue; }
              if (result.degenerate) { degenerate++; continue; }
              const risk = result.risk as number;

              const entryFeeFrac = MAKER_FEE_BPS / 10_000;
              const exitFeeFrac = result.outcome === 'target'
                ? MAKER_FEE_BPS / 10_000
                : (TAKER_FEE_BPS + SLIPPAGE_BPS) / 10_000;
              const costsR = (entryFeeFrac + exitFeeFrac) * (result.fillPrice / risk);
              const rates = fundingSumBetween(fundingPoints, candles[result.fillIndex].openTime, candles[result.exitIndex].closeTime);
              const fundingR = fundingInR(event.direction, rates, result.fillPrice, stopPrice);
              const net = result.grossR - costsR + fundingR;
              netR.push(net);
              takerAdjusted.push(net - TAKER_ENTRY_DELTA_FRAC * (result.fillPrice / risk));
              grossSum += result.grossR; costSum += costsR; fundingSum += fundingR;
              foldAccum[Math.min(FOLDS - 1, Math.floor(result.fillIndex / foldSize))].push(net);
            }

            const filledCount = netR.length;
            const s = summarizeR(netR);
            const sTaker = summarizeR(takerAdjusted);
            rows.push({
              side, bufferAtr, fillWindowBars, exit: exit.name,
              events: sideEvents.length,
              filled: filledCount,
              unfilled,
              degenerate,
              fillRate: sideEvents.length > 0 ? filledCount / sideEvents.length : null,
              n: filledCount,
              netMeanR: s.mean, netMedianR: s.median,
              netMeanRTakerEntry: sTaker.mean,
              winRate: s.win, profitFactor: s.pf, maxDrawdownR: s.maxDD,
              foldMeanR: foldAccum.map((acc) => acc.length > 0 ? acc.reduce((sum, r) => sum + r, 0) / acc.length : null),
              grossMeanR: filledCount ? grossSum / filledCount : null,
              costsMeanR: filledCount ? costSum / filledCount : null,
              fundingMeanR: filledCount ? fundingSum / filledCount : null,
              permutationP: filledCount > 0 ? permutationP(netR, seed, iterations) : null,
              holmSignificant: false,
              gatePass: null,
              gateFailures: [],
            });
          }
        }
      }
    }
    datasets[timeframe] = {
      bars: candles.length,
      manifestSha256: manifestSha256(manifestDir, symbol, timeframe),
    };
  }

  const rejects = holmRejects(rows.map((r) => (r.permutationP === null ? 1 : r.permutationP)), HOLM_ALPHA);
  rows.forEach((row, i) => {
    row.holmSignificant = rejects[i];
    const verdict = evalStageCGate(
      { n: row.n, holmSignificant: row.holmSignificant, netMeanR: row.netMeanR, foldMeanR: row.foldMeanR },
      { minFills: MIN_FILLS, minPositiveFolds: MIN_POSITIVE_FOLDS },
    );
    row.gatePass = verdict.pass;
    row.gateFailures = verdict.failures;
  });

  const fmt = (v: number | null, digits = 3): string => v === null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(digits);
  console.log('\nStage-D retest-entry sweep evaluation — window: ' + windowLabel + ' (net R after maker/taker fees/slippage/funding)');
  console.log('tested family: ' + rows.length + ' predeclared configs | Holm alpha ' + HOLM_ALPHA + ' | seed ' + seed);
  for (const row of rows) {
    console.log(
      row.side.padEnd(5) + ' buf' + row.bufferAtr.toFixed(2) + ' W' + String(row.fillWindowBars).padStart(2) + ' ' + row.exit.padEnd(15) +
      ' filled=' + String(row.filled).padStart(3) + '/' + String(row.events).padStart(3) +
      ' (unfilled ' + row.unfilled + ', degen ' + row.degenerate + ')' +
      ' E[R]=' + fmt(row.netMeanR) + ' takerE[R]=' + fmt(row.netMeanRTakerEntry) +
      ' med=' + fmt(row.netMedianR) +
      ' win=' + (row.winRate === null ? 'n/a' : (row.winRate * 100).toFixed(1) + '%') +
      ' PF=' + (row.profitFactor === null ? 'n/a' : row.profitFactor.toFixed(2)) +
      ' DD=' + fmt(row.maxDrawdownR) + 'R' +
      ' folds=' + row.foldMeanR.map((f) => fmt(f, 2)).join('/') +
      (row.permutationP === null ? '' : ' p=' + row.permutationP.toFixed(4)) +
      (row.holmSignificant ? ' HOLM-SIG' : '') +
      (row.gatePass === true ? ' GATE-PASS' : row.gatePass === false ? ' gate:' + row.gateFailures.join('; ') : ''),
    );
  }
  const survivors = rows.filter((r) => r.gatePass);
  console.log('\nTRAIN-GATE SURVIVORS: ' + survivors.length);
  for (const s of survivors) {
    console.log('  ' + s.side + ' buf' + s.bufferAtr.toFixed(2) + ' W' + s.fillWindowBars + ' ' + s.exit + ' E[R]=' + fmt(s.netMeanR) + ' n=' + s.n);
  }

  const report = {
    schemaVersion: 1,
    kind: 'SWEEP_STAGE_D_EVAL',
    generatedAt: new Date().toISOString(),
    window: windowLabel,
    instrument: { symbol, venue: 'BINANCE_USDM_PERPETUAL' },
    config: {
      swingStrength: swing, cooldownBars, atrLength, sameBarReclaimOnly: true,
      timeframes,
      sides: ['short', 'long'],
      buffersAtr: BUFFERS, fillWindowBars: FILL_WINDOWS, exits: EXITS,
      testedFamilySize: rows.length,
      feeScheduleBps: { entryMaker: MAKER_FEE_BPS, entrySlippage: 0, exitTakerStopTime: TAKER_FEE_BPS + SLIPPAGE_BPS, exitMakerTarget: MAKER_FEE_BPS },
      takerEntrySensitivity: TAKER_ENTRY_DELTA_FRAC,
      funding: 'actual historical settlements (data.binance.vision), missing files: ' + (fundingMissing.length ? fundingMissing.join(', ') : 'none'),
      folds: FOLDS,
      permutationIterations: iterations, seed,
      holmAlpha: HOLM_ALPHA,
      trainGate: { minFills: MIN_FILLS, minPositiveFolds: MIN_POSITIVE_FOLDS, holmAlpha: HOLM_ALPHA },
      confirmationGate: { minFills: MIN_FILLS, alpha: CONFIRM_ALPHA },
      execution: 'resting limit at the swept level, fills only on retest within the window; marketable gaps fill at open; degenerate fills excluded; stop before target intrabar; time exit anchored at fill',
    },
    datasets,
    results: rows,
    caveats: [
      'Retest entries trade a SELECTED population: events whose price returns to the level. Missed rebounds are counted (unfilled) but earn nothing — the adverse-selection cost is inside the measured E[R].',
      'Fill-rate and degenerate-fill counts are reported per config; OHLC data cannot resolve intrabar path, so the conservative Stage-B ordering (stop before target) is retained.',
      'The 4h-only timeframe choice is informed by Stage B/C and declared up front; 1h remains excluded from the tested family.',
      'A gate pass is a research candidate, not live admission: the repository promotion/admission gate still applies.',
      'Family and gates were committed to the research/sweep-stage-d branch before any Stage-D run.',
    ],
  };
  const digest = createHash('sha256').update(JSON.stringify(report.config)).digest('hex');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('\nReport written: ' + outPath + ' (config sha256 ' + digest.slice(0, 12) + '…)');
}

main().catch((error: unknown) => {
  console.error('sweep-eval-staged failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
