#!/usr/bin/env node
/**
 * sweep-eval-stagee — Stage E: PREDECLARED cross-asset (BTCUSDT + ETHUSDT
 * pooled) replication of the two previously frozen sweep-and-reclaim families.
 * Committed and pushed BEFORE any Stage-E run touches BTC/ETH data.
 *
 * ============================================================================
 * MOTIVATION (declared)
 * ============================================================================
 * All four SOLUSDT stages (A/B/C/D) failed their predeclared gates. The one
 * legitimate direction left for this event family was cross-sectional
 * replication with a mechanistic reason: sweep-and-reclaim fades exploit
 * stop-run / liquidation cascades beyond prior pivot extremes — a
 * market-mechanism that should exist in ANY deep USDT-perp order book, not a
 * SOLUSDT quirk. BTC and ETH are the two deepest perpetual markets; if the
 * effect is real but was underpowered on SOL, pooling BTC+ETH (~2x events)
 * sharpens inference; if the SOL results were noise, nothing replicates.
 *
 * ============================================================================
 * PREDECLARED FAMILY (frozen; 48 tested configs, Holm over all of them)
 * ============================================================================
 * Replicated VERBATIM from the previously frozen families — no new parameters:
 *
 *  A. Market-entry (Stage-B family): {4h,1h} x {short,long} x
 *     buffer {0.25, 0.5} x ATR14 x exits {time6, stop_or_2R, stop_or_1.5R}
 *     (48-bar time stop) = 24 configs. Next-bar-open entry after the reclaim
 *     close; taker 4 bps + slippage 2 bps per side; conservative intrabar
 *     ordering (stop before target); gap-through-stop fills at open.
 *  B. Retest-entry (Stage-D family): 4h x {short,long} x buffer
 *     {0.25, 0.5, 1.0} x fill window {6, 12} bars x exits {stop_or_2R,
 *     stop_or_time48} = 24 configs. Resting limit at the swept level fills
 *     only on retest within the window; marketable gaps fill at open;
 *     degenerate fills excluded; unfilled counted. Maker 2 bps entry;
 *     taker 4+2 stop/time; maker 2 target. A full-taker-entry sensitivity is
 *     reported per config.
 *  Detection identical to B/C/D: swing k=3, same-bar reclaim, cooldown 5,
 *  ATR14 structure stops anchored at the sweep-episode extreme.
 *  Funding: actual historical settlements per symbol (data.binance.vision).
 *
 * ============================================================================
 * POOLING RULES (declared)
 * ============================================================================
 *  - Events are detected and simulated per symbol on its own bars; the pooled
 *    set is the union of both symbols' filled trades for a config.
 *  - Permutation (seeded sign-flip, 10k, seed 20261021, one-sided mean > 0)
 *    is order-invariant, so pooling is the plain union of trade R values.
 *  - Chronological folds: the pooled trades are sorted by entry/fill time
 *    (shared UTC timeline; ties broken by symbol name, then insertion order)
 *    and split into 4 contiguous, near-equal folds.
 *  - Per-symbol splits (BTC-only, ETH-only) are reported as DIAGNOSTICS and
 *    are NOT gated.
 *
 * ============================================================================
 * GATES (predeclared; identical to Stage C/D plus one clause)
 * ============================================================================
 *  TRAIN (584d, BTC+ETH pooled): n >= 30 FILLED trades, Holm-significant
 *    (alpha 0.05 across all 48), net E[R] > 0, >= 3 of 4 chronological folds
 *    > 0 — AND for retest configs the net E[R] must ALSO be > 0 under the
 *    PESSIMISTIC fill-bar convention (same-bar target after fill NOT honored;
 *    the clause learned from the Stage-D sensitivity audit, now predeclared).
 *  TEST (146d) / REPLICATION (365d, both virgin on BTC/ETH): n >= 30, net
 *    E[R] > 0, permutation p < 0.05 (re-Holm across survivors if > 1), same
 *    pessimistic clause for retest configs.
 *  PROMOTION: only if the same config passes ALL THREE windows.
 *  ZERO train survivors -> the other windows are NOT fetched or evaluated.
 *
 * Declared caveats: BTC and ETH events are cross-correlated (shared market
 * moves), so the pooled permutation treats trades as more exchangeable than
 * they truly are; family selection is informed by SOL history — this is a
 * confirmatory replication of frozen families on fresh instruments, not a
 * fresh exploratory search.
 *
 * Usage (one window per invocation):
 *   npx tsx research/alma/scripts/sweep-eval-stagee.ts --window-label train \
 *     --raw-dir data/research/alma-xasset/raw \
 *     --out data/research/alma/events/sweep-eval-stagee-train.json
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
import { simulateRetestTrade } from '../src/retest-sim.js';
import { detectSweepReclaim } from '../src/sweeps.js';
import { costsInR, fundingInR, simulateTrade } from '../src/trade-sim.js';
import {
  STAGE_E_WINDOWS,
  configId,
  enumerateStageEFamily,
  pessimisticRetestOutcome,
  pooledTimeFolds,
  sliceWindow,
  evalStageETrainGate,
  evalStageEConfirmGate,
  type StageEConfig,
} from '../src/stagee-lib.js';
import type { Candle, NativeTimeframe } from '../src/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// --- frozen constants (see header) ------------------------------------------
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;
const MIN_FILLS = 30;
const MIN_POSITIVE_FOLDS = 3;
const HOLM_ALPHA = 0.05;
const CONFIRM_ALPHA = 0.05;
const FOLDS = 4;
const SWING = 3;
const COOLDOWN_BARS = 5;
const ATR_LENGTH = 14;
const SEED = 20261021;
const ITERATIONS = 10_000;

// Fee schedules, byte-identical to the replicated families.
// Market-entry (Stage-B): taker 4 bps + slippage 2 bps per side.
const MARKET_FEE_BPS = 4;
const MARKET_SLIP_BPS = 2;
// Retest-entry (Stage-D): maker 2 entry; taker 4+2 stop/time; maker 2 target.
const MAKER_FEE_BPS = 2;
const TAKER_FEE_BPS = 4;
const SLIPPAGE_BPS = 2;
const TAKER_ENTRY_DELTA_FRAC = (TAKER_FEE_BPS + SLIPPAGE_BPS - MAKER_FEE_BPS) / 10_000;

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

interface PooledTrade {
  symbol: string;
  entryTime: number;
  netR: number;
  /** Retest configs only: net R with the entry charged at taker 4+2 bps instead of maker 2. Market rows are already taker. */
  netRTakerEntry: number;
  netRPessimistic: number | null;
  grossR: number;
  costsR: number;
  fundingR: number;
}

interface SymbolDiag {
  n: number;
  netMeanR: number | null;
  netMedianR: number | null;
  winRate: number | null;
  permutationP: number | null;
}

interface StageERow {
  configId: string;
  family: 'market' | 'retest';
  timeframe: NativeTimeframe;
  side: 'short' | 'long';
  bufferAtr: number;
  fillWindowBars: number | null;
  exit: string;
  events: number;
  filled: number;
  unfilled: number;
  degenerate: number;
  n: number;
  netMeanR: number | null;
  netMedianR: number | null;
  netMeanRPessimistic: number | null;
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
  perSymbol: Record<string, SymbolDiag>;
}

function stopExtremeFor(candles: readonly Candle[], sweepIndex: number, index: number, direction: 1 | -1): number {
  const bullish = direction === 1;
  let extreme = bullish ? Infinity : -Infinity;
  for (let b = sweepIndex; b <= index; b++) {
    extreme = bullish ? Math.min(extreme, candles[b].low) : Math.max(extreme, candles[b].high);
  }
  return extreme;
}

function symbolDiagOf(trades: readonly PooledTrade[], symbol: string, iterations: number): SymbolDiag {
  const rs = trades.filter((t) => t.symbol === symbol).map((t) => t.netR);
  const s = summarizeR(rs);
  return {
    n: rs.length,
    netMeanR: s.mean,
    netMedianR: s.median,
    winRate: s.win,
    permutationP: rs.length > 0 ? permutationP(rs, SEED, iterations) : null,
  };
}

async function main(): Promise<void> {
  const windowLabel = arg('window-label', 'train');
  const bounds = STAGE_E_WINDOWS[windowLabel as keyof typeof STAGE_E_WINDOWS];
  if (!bounds) throw new Error('--window-label must be one of train | test | replication');
  const rawDir = resolve(arg('raw-dir', resolve(REPO_ROOT, 'data', 'research', 'alma-xasset', 'raw')));
  const manifestDir = resolve(arg('manifest-dir', rawDir.replace(/raw$/, 'manifests')));
  const outPath = resolve(arg('out', resolve(REPO_ROOT, 'data', 'research', 'alma', 'events', 'sweep-eval-stagee-' + windowLabel + '.json')));

  const configs = enumerateStageEFamily();
  if (configs.length !== 48) throw new Error('frozen family size drifted: ' + configs.length + ' != 48');

  // Load per symbol x timeframe once, sliced to the declared window.
  const candlesBy = new Map<string, Candle[]>();
  const eventsBy = new Map<string, ReturnType<typeof detectSweepReclaim>>();
  const atrBy = new Map<string, ReturnType<typeof atrWilder>>();
  const fundingBy = new Map<string, { points: FundingPoint[]; missingFiles: string[] }>();
  const datasets: Record<string, object> = {};

  for (const timeframe of ['4h', '1h'] as const) {
    for (const symbol of SYMBOLS) {
      const key = symbol + '|' + timeframe;
      const all = loadSnapshot(resolve(rawDir, symbol + '-' + timeframe + '.json'), timeframe, symbol);
      const candles = sliceWindow(all, bounds, timeframe);
      candlesBy.set(key, candles);
      eventsBy.set(key, detectSweepReclaim(candles, SWING, { reclaimWithinBars: 0, cooldownBars: COOLDOWN_BARS }));
      atrBy.set(key, atrWilder(candles, ATR_LENGTH));
      fundingBy.set(symbol, await loadFundingHistory(symbol, bounds.fromMs, bounds.toMs - 1));
      datasets[symbol + '-' + timeframe] = {
        barsAllFile: all.length,
        barsInWindow: candles.length,
        manifestSha256: manifestSha256(manifestDir, symbol, timeframe),
      };
    }
  }

  const rows: StageERow[] = [];

  for (const config of configs) {
    const timeframe = config.timeframe;
    const rows_out: PooledTrade[] = [];
    let events = 0;
    let unfilled = 0;
    let degenerate = 0;

    for (const symbol of SYMBOLS) {
      const key = symbol + '|' + timeframe;
      const candles = candlesBy.get(key) as Candle[];
      const eventsAll = eventsBy.get(key) as ReturnType<typeof detectSweepReclaim>;
      const atr = atrBy.get(key) as ReturnType<typeof atrWilder>;
      const funding = fundingBy.get(symbol) as { points: FundingPoint[]; missingFiles: string[] };
      const sideEvents = eventsAll.filter((e) => (config.side === 'short' ? e.direction === -1 : e.direction === 1));
      events += sideEvents.length;

      for (const event of sideEvents) {
        const atrValue = atr[event.index];
        if (atrValue === null || atrValue <= 0) { unfilled++; continue; }
        const bullish = event.direction === 1;
        const extreme = stopExtremeFor(candles, event.sweepIndex, event.index, event.direction);
        const stopPrice = bullish ? extreme - config.bufferAtr * atrValue : extreme + config.bufferAtr * atrValue;

        if (config.family === 'market') {
          const entryIndex = event.index + 1;
          if (entryIndex >= candles.length) { unfilled++; continue; }
          const entryPrice = candles[entryIndex].open;
          const risk = bullish ? entryPrice - stopPrice : stopPrice - entryPrice;
          if (!(risk > 0)) { unfilled++; continue; }
          const targetPrice = config.targetR === null ? null : (bullish ? entryPrice + config.targetR * risk : entryPrice - config.targetR * risk);
          const timeExitIndex = event.index + config.horizonBars;
          const outcome = simulateTrade(candles, { entryIndex, direction: event.direction, entryPrice, stopPrice, targetPrice, timeExitIndex });
          if (outcome === null) { unfilled++; continue; }
          const costsR = costsInR(entryPrice, stopPrice, MARKET_FEE_BPS, MARKET_SLIP_BPS);
          const rates = fundingSumBetween(funding.points, candles[entryIndex].openTime, candles[outcome.exitIndex].closeTime);
          const fundingR = fundingInR(event.direction, rates, entryPrice, stopPrice);
          rows_out.push({
            symbol, entryTime: candles[entryIndex].openTime,
            netR: outcome.grossR - costsR + fundingR, netRTakerEntry: outcome.grossR - costsR + fundingR, netRPessimistic: null,
            grossR: outcome.grossR, costsR, fundingR,
          });
        } else {
          if (!(bullish ? stopPrice < event.level : stopPrice > event.level)) { unfilled++; continue; }
          const result = simulateRetestTrade(candles, {
            signalIndex: event.index, direction: event.direction, level: event.level, stopPrice,
            targetR: config.targetR, fillWindowBars: config.fillWindowBars, timeExitBars: config.timeExitBars,
          });
          if (!result.filled) { unfilled++; continue; }
          if (result.degenerate) { degenerate++; continue; }
          const risk = result.risk as number;
          const entryFeeFrac = MAKER_FEE_BPS / 10_000;
          const exitFeeFrac = result.outcome === 'target' ? MAKER_FEE_BPS / 10_000 : (TAKER_FEE_BPS + SLIPPAGE_BPS) / 10_000;
          const costsR = (entryFeeFrac + exitFeeFrac) * (result.fillPrice / risk);
          const rates = fundingSumBetween(funding.points, candles[result.fillIndex].openTime, candles[result.exitIndex].closeTime);
          const fundingR = fundingInR(event.direction, rates, result.fillPrice, stopPrice);
          const net = result.grossR - costsR + fundingR;

          // Pessimistic convention from the SAME fill: fill-bar target exits
          // are not honored (only the fill-bar stop is).
          const targetPrice = config.targetR === null ? null : (bullish ? result.fillPrice + config.targetR * risk : result.fillPrice - config.targetR * risk);
          const rpess = pessimisticRetestOutcome(candles, {
            fillIndex: result.fillIndex, fillPrice: result.fillPrice, direction: event.direction,
            stopPrice, targetPrice, timeExitBars: config.timeExitBars,
          });
          const exitFeePess = rpess.outcome === 'target' ? MAKER_FEE_BPS / 10_000 : (TAKER_FEE_BPS + SLIPPAGE_BPS) / 10_000;
          const costsPess = (entryFeeFrac + exitFeePess) * (result.fillPrice / risk);
          const ratesPess = fundingSumBetween(funding.points, candles[result.fillIndex].openTime, candles[rpess.exitIndex].closeTime);
          const fundingPess = fundingInR(event.direction, ratesPess, result.fillPrice, stopPrice);
          const grossPess = (event.direction * (rpess.exitPrice - result.fillPrice)) / risk;

          rows_out.push({
            symbol, entryTime: candles[result.fillIndex].openTime,
            netR: net,
            netRTakerEntry: net - TAKER_ENTRY_DELTA_FRAC * (result.fillPrice / risk),
            netRPessimistic: grossPess - costsPess + fundingPess,
            grossR: result.grossR, costsR, fundingR,
          });
        }
      }
    }

    const filledTrades = rows_out;
    const n = filledTrades.length;
    const netR = filledTrades.map((t) => t.netR);
    const s = summarizeR(netR);
    const foldAssign = pooledTimeFolds(filledTrades.map((t) => ({ symbol: t.symbol, entryTime: t.entryTime })), FOLDS);
    const foldAccum: number[][] = Array.from({ length: FOLDS }, () => []);
    const foldAccumPess: number[][] = Array.from({ length: FOLDS }, () => []);
    let grossSum = 0; let costSum = 0; let fundingSum = 0;
    filledTrades.forEach((t, i) => {
      foldAccum[foldAssign[i]].push(t.netR);
      if (t.netRPessimistic !== null) foldAccumPess[foldAssign[i]].push(t.netRPessimistic);
      grossSum += t.grossR; costSum += t.costsR; fundingSum += t.fundingR;
    });
    const foldMeanR = foldAccum.map((acc) => (acc.length > 0 ? acc.reduce((sum, r) => sum + r, 0) / acc.length : null));
    const pessR = filledTrades.map((t) => t.netRPessimistic).filter((r): r is number => r !== null);
    const sPess = summarizeR(pessR);
    const sTaker = summarizeR(filledTrades.map((t) => t.netRTakerEntry));

    rows.push({
      configId: configId(config),
      family: config.family,
      timeframe,
      side: config.side,
      bufferAtr: config.bufferAtr,
      fillWindowBars: config.family === 'retest' ? config.fillWindowBars : null,
      exit: config.exitName,
      events,
      filled: n,
      unfilled,
      degenerate,
      n,
      netMeanR: s.mean,
      netMedianR: s.median,
      netMeanRPessimistic: config.family === 'retest' ? sPess.mean : null,
      netMeanRTakerEntry: config.family === 'retest' ? sTaker.mean : s.mean,
      winRate: s.win,
      profitFactor: s.pf,
      maxDrawdownR: s.maxDD,
      foldMeanR,
      grossMeanR: n ? grossSum / n : null,
      costsMeanR: n ? costSum / n : null,
      fundingMeanR: n ? fundingSum / n : null,
      permutationP: n > 0 ? permutationP(netR, SEED, ITERATIONS) : null,
      holmSignificant: false,
      gatePass: null,
      gateFailures: [],
      perSymbol: Object.fromEntries(SYMBOLS.map((sym) => [sym, symbolDiagOf(filledTrades, sym, ITERATIONS)])),
    });
  }

  const rejects = holmRejects(rows.map((r) => (r.permutationP === null ? 1 : r.permutationP)), HOLM_ALPHA);
  rows.forEach((row, i) => {
    row.holmSignificant = rejects[i];
    const verdict = evalStageETrainGate(
      {
        n: row.n, holmSignificant: row.holmSignificant, netMeanR: row.netMeanR,
        foldMeanR: row.foldMeanR, pessimisticMeanR: row.netMeanRPessimistic ?? undefined,
      },
      { minFills: MIN_FILLS, minPositiveFolds: MIN_POSITIVE_FOLDS },
    );
    row.gatePass = verdict.pass;
    row.gateFailures = verdict.failures;
  });

  const fmt = (v: number | null, digits = 3): string => v === null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(digits);
  console.log('\nStage-E cross-asset (BTC+ETH pooled) sweep evaluation — window: ' + windowLabel);
  console.log('tested family: ' + rows.length + ' predeclared configs | Holm alpha ' + HOLM_ALPHA + ' | seed ' + SEED);
  for (const row of rows) {
    const pess = row.netMeanRPessimistic === null ? '' : ' pessE[R]=' + fmt(row.netMeanRPessimistic);
    console.log(
      row.configId.padEnd(42) +
      ' filled=' + String(row.filled).padStart(4) + '/' + String(row.events).padStart(4) +
      ' (unfill ' + row.unfilled + ', degen ' + row.degenerate + ')' +
      ' E[R]=' + fmt(row.netMeanR) + pess +
      ' med=' + fmt(row.netMedianR) +
      ' win=' + (row.winRate === null ? 'n/a' : (row.winRate * 100).toFixed(1) + '%') +
      ' DD=' + fmt(row.maxDrawdownR) + 'R' +
      ' folds=' + row.foldMeanR.map((f) => fmt(f, 2)).join('/') +
      (row.permutationP === null ? '' : ' p=' + row.permutationP.toFixed(4)) +
      (row.holmSignificant ? ' HOLM-SIG' : '') +
      (row.gatePass === true ? ' GATE-PASS' : row.gatePass === false ? ' gate:' + row.gateFailures.join('; ') : ''),
    );
  }
  const survivors = rows.filter((r) => r.gatePass);
  console.log('\nTRAIN-GATE SURVIVORS: ' + survivors.length);
  for (const s of survivors) console.log('  ' + s.configId + ' E[R]=' + fmt(s.netMeanR) + ' n=' + s.n);

  const report = {
    schemaVersion: 1,
    kind: 'SWEEP_STAGE_E_XASSET_EVAL',
    generatedAt: new Date().toISOString(),
    window: bounds,
    instruments: { symbols: SYMBOLS, venue: 'BINANCE_USDM_PERPETUAL' },
    config: {
      swingStrength: SWING, cooldownBars: COOLDOWN_BARS, atrLength: ATR_LENGTH, sameBarReclaimOnly: true,
      testedFamilySize: rows.length,
      marketFamily: 'Stage-B verbatim: {4h,1h} x {short,long} x buf {0.25,0.5} x {time6, stop_or_2R, stop_or_1.5R}',
      retestFamily: 'Stage-D verbatim: 4h x {short,long} x buf {0.25,0.5,1.0} x W {6,12} x {stop_or_2R, stop_or_time48}',
      feeScheduleBps: {
        market: { perSideTaker: MARKET_FEE_BPS, perSideSlippage: MARKET_SLIP_BPS },
        retest: { entryMaker: MAKER_FEE_BPS, exitTakerStopTime: TAKER_FEE_BPS + SLIPPAGE_BPS, exitMakerTarget: MAKER_FEE_BPS },
      },
      funding: 'actual historical settlements per symbol (data.binance.vision)',
      pooling: {
        permutation: 'pooled union of filled-trade R values (order-invariant seeded sign-flip)',
        folds: FOLDS + ' contiguous chronological folds over the pooled trades; ties by symbol name then insertion order',
        perSymbolSplits: 'reported as diagnostics, NOT gated',
      },
      pessimisticClause: 'retest configs must also show net E[R] > 0 with same-bar fill->target exits not honored (fill-bar stop still honored), at every window',
      permutationIterations: ITERATIONS, seed: SEED,
      holmAlpha: HOLM_ALPHA,
      trainGate: { minFills: MIN_FILLS, minPositiveFolds: MIN_POSITIVE_FOLDS, holmAlpha: HOLM_ALPHA },
      confirmationGate: { minFills: MIN_FILLS, alpha: CONFIRM_ALPHA },
    },
    datasets,
    results: rows,
    caveats: [
      'BTC and ETH events are cross-correlated through shared market moves; the pooled permutation overstates exchangeability, so effective sample size is smaller than n.',
      'Family selection is informed by SOLUSDT history: this is a confirmatory replication of previously frozen families on fresh instruments, not an exploratory search.',
      'Kline data cannot resolve intrabar path; the pessimistic fill-bar clause is predeclared precisely because the Stage-D near-miss was convention-fragile.',
      'A gate pass is a research candidate, not live admission: the repository promotion/admission gate still applies.',
      'Family, windows, pooling rules and gates were committed to research/sweep-crossasset before any Stage-E run.',
    ],
  };
  const digest = createHash('sha256').update(JSON.stringify(report.config)).digest('hex');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('\nReport written: ' + outPath + ' (config sha256 ' + digest.slice(0, 12) + '…)');
}

main().catch((error: unknown) => {
  console.error('sweep-eval-stagee failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
