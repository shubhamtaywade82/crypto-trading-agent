/**
 * stagee-lib — pure helpers for Stage E, the PREDECLARED cross-asset (BTC+ETH
 * pooled) replication of the two previously frozen sweep-and-reclaim families
 * (Stage B market-entry and Stage D retest-entry).
 *
 * Nothing here runs data; every function is deterministic and unit-tested.
 * The family, windows, pooling rules and gates are declared in this module and
 * in scripts/sweep-eval-stagee.ts, which must be committed and pushed BEFORE
 * any Stage-E run touches BTC/ETH data.
 *
 * Replication framing (declared): the tested configs are byte-identical to the
 * previously frozen Stage-B (24) and Stage-D (24) families, applied to FRESH
 * instruments (BTCUSDT + ETHUSDT — never consumed by any prior stage). No new
 * parameter was chosen after seeing cross-asset data. Holm is applied across
 * all 48 configs jointly.
 */
import type { Candle, NativeTimeframe } from './types.js';
import type { Direction } from './events.js';
import { evalStageCGate, evalConfirmationGate, type GateVerdict } from './eval-lib.js';

// ---------------------------------------------------------------------------
// Predeclared window boundaries (UTC, hard). These mirror the SOLUSDT windows
// used by Stages B/C/D to the day: train 584d, test 146d, replication 365d.
// ---------------------------------------------------------------------------

export interface WindowBounds { label: string; fromMs: number; toMs: number }

export const STAGE_E_WINDOWS: Record<'train' | 'test' | 'replication', WindowBounds> = {
  train: { label: 'train', fromMs: Date.UTC(2024, 9, 18), toMs: Date.UTC(2026, 4, 25) },
  test: { label: 'test', fromMs: Date.UTC(2026, 4, 25), toMs: Date.UTC(2026, 9, 18) },
  replication: { label: 'replication', fromMs: Date.UTC(2023, 9, 19), toMs: Date.UTC(2024, 9, 18) },
};

const TF_MS: Partial<Record<NativeTimeframe, number>> = {
  '1h': 3_600_000,
  '4h': 14_400_000,
};

/**
 * Keep only bars whose open time lies inside [fromMs, toMs). Fail-closed: if
 * the first/last bar does not tile the window edge-to-edge (within one bar
 * slot), throw — a partially covered window must never be silently analyzed.
 */
export function sliceWindow(candles: readonly Candle[], bounds: WindowBounds, timeframe: NativeTimeframe): Candle[] {
  const tfMs = TF_MS[timeframe];
  if (tfMs === undefined) throw new Error('unsupported timeframe for Stage E: ' + timeframe);
  const sliced = candles.filter((c) => c.openTime >= bounds.fromMs && c.openTime < bounds.toMs);
  if (sliced.length === 0) throw new Error('window ' + bounds.label + ': no bars inside [' + bounds.fromMs + ', ' + bounds.toMs + ')');
  if (sliced[0].openTime > bounds.fromMs + tfMs - 1) {
    throw new Error('window ' + bounds.label + ': first bar (' + sliced[0].openTime + ') does not cover the window start');
  }
  if (sliced[sliced.length - 1].closeTime < bounds.toMs - 1) {
    throw new Error('window ' + bounds.label + ': last bar does not cover the window end');
  }
  return sliced;
}

// ---------------------------------------------------------------------------
// Frozen family enumeration (48 tested configs)
// ---------------------------------------------------------------------------

export interface StageEMarketConfig {
  family: 'market';
  timeframe: NativeTimeframe;
  side: 'short' | 'long';
  bufferAtr: number;
  exitName: string;
  targetR: number | null;
  horizonBars: number;
}

export interface StageERetestConfig {
  family: 'retest';
  timeframe: '4h';
  side: 'short' | 'long';
  bufferAtr: number;
  fillWindowBars: number;
  exitName: string;
  targetR: number | null;
  timeExitBars: number;
}

export type StageEConfig = StageEMarketConfig | StageERetestConfig;

/** Stage-B market-entry family, replicated verbatim: {4h,1h} x {short,long} x buf {0.25,0.5} x {time6, stop_or_2R, stop_or_1.5R} = 24. */
export function enumerateMarketFamily(): StageEMarketConfig[] {
  const configs: StageEMarketConfig[] = [];
  for (const timeframe of ['4h', '1h'] as const) {
    for (const side of ['short', 'long'] as const) {
      for (const bufferAtr of [0.25, 0.5]) {
        for (const exit of [
          { exitName: 'time6', targetR: null, horizonBars: 6 },
          { exitName: 'stop_or_2R', targetR: 2.0, horizonBars: 48 },
          { exitName: 'stop_or_1.5R', targetR: 1.5, horizonBars: 48 },
        ]) {
          configs.push({ family: 'market', timeframe, side, bufferAtr, ...exit });
        }
      }
    }
  }
  return configs;
}

/** Stage-D retest-entry family, replicated verbatim: 4h x {short,long} x buf {0.25,0.5,1.0} x W {6,12} x {stop_or_2R, stop_or_time48} = 24. */
export function enumerateRetestFamily(): StageERetestConfig[] {
  const configs: StageERetestConfig[] = [];
  for (const side of ['short', 'long'] as const) {
    for (const bufferAtr of [0.25, 0.5, 1.0]) {
      for (const fillWindowBars of [6, 12]) {
        for (const exit of [
          { exitName: 'stop_or_2R', targetR: 2.0, timeExitBars: 48 },
          { exitName: 'stop_or_time48', targetR: null, timeExitBars: 48 },
        ]) {
          configs.push({ family: 'retest', timeframe: '4h', side, bufferAtr, fillWindowBars, ...exit });
        }
      }
    }
  }
  return configs;
}

export function enumerateStageEFamily(): StageEConfig[] {
  return [...enumerateMarketFamily(), ...enumerateRetestFamily()];
}

export function configId(config: StageEConfig): string {
  return config.family === 'market'
    ? 'market|' + config.timeframe + '|' + config.side + '|buf' + config.bufferAtr + '|' + config.exitName
    : 'retest|' + config.timeframe + '|' + config.side + '|buf' + config.bufferAtr + '|W' + config.fillWindowBars + '|' + config.exitName;
}

// ---------------------------------------------------------------------------
// Pessimistic retest convention (declared after the Stage-D sensitivity audit,
// now part of the gate instead of a post-hoc footnote): on the FILL bar only
// the stop may trigger (forced fill->stop ordering is unambiguous); a same-bar
// target touch is NOT honored because the intrabar path is unresolvable.
// Later bars follow the Stage-B conventions.
// ---------------------------------------------------------------------------

export interface PessimisticOutcome { exitIndex: number; exitPrice: number; outcome: 'stop' | 'target' | 'time' }

export function pessimisticRetestOutcome(
  candles: readonly Candle[],
  opts: { fillIndex: number; fillPrice: number; direction: Direction; stopPrice: number; targetPrice: number | null; timeExitBars: number },
): PessimisticOutcome {
  const { fillIndex, fillPrice, direction, stopPrice, targetPrice, timeExitBars } = opts;
  const bullish = direction === 1;
  const fillBar = candles[fillIndex];
  const stopTouched = (bar: Candle): boolean => (bullish ? bar.low <= stopPrice : bar.high >= stopPrice);
  const targetTouched = (bar: Candle): boolean =>
    targetPrice !== null && (bullish ? bar.high >= (targetPrice as number) : bar.low <= (targetPrice as number));

  if (bullish ? fillBar.low <= stopPrice : fillBar.high >= stopPrice) {
    return { exitIndex: fillIndex, exitPrice: stopPrice, outcome: 'stop' };
  }
  const last = Math.min(fillIndex + timeExitBars, candles.length - 1);
  for (let b = fillIndex + 1; b <= last; b++) {
    const bar = candles[b];
    if (bullish ? bar.open <= stopPrice : bar.open >= stopPrice) return { exitIndex: b, exitPrice: bar.open, outcome: 'stop' };
    if (stopTouched(bar) && targetTouched(bar)) return { exitIndex: b, exitPrice: stopPrice, outcome: 'stop' };
    if (stopTouched(bar)) return { exitIndex: b, exitPrice: stopPrice, outcome: 'stop' };
    if (targetTouched(bar)) return { exitIndex: b, exitPrice: targetPrice as number, outcome: 'target' };
    if (b === last) return { exitIndex: b, exitPrice: bar.close, outcome: 'time' };
  }
  return { exitIndex: last, exitPrice: candles[last].close, outcome: 'time' };
}

// ---------------------------------------------------------------------------
// Pooled chronological folds. Trades from both symbols share one UTC timeline;
// folds are contiguous in fill/entry time with a deterministic tie-break
// (entryTime, then symbol name, then per-symbol insertion order).
// ---------------------------------------------------------------------------

export function pooledTimeFolds(trades: ReadonlyArray<{ symbol: string; entryTime: number }>, folds: number): number[] {
  const order = trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.entryTime - b.t.entryTime || (a.t.symbol < b.t.symbol ? -1 : a.t.symbol > b.t.symbol ? 1 : 0) || a.i - b.i);
  const assign = new Array<number>(trades.length).fill(0);
  order.forEach((o, rank) => {
    assign[o.i] = Math.min(folds - 1, Math.floor((rank * folds) / order.length));
  });
  return assign;
}

// ---------------------------------------------------------------------------
// Gates: the Stage-C train/confirmation gates plus the predeclared pessimistic
// convention clause for retest configs (applies at EVERY window).
// ---------------------------------------------------------------------------

export interface StageETrainGateInput {
  n: number;
  holmSignificant: boolean;
  netMeanR: number | null;
  foldMeanR: readonly (number | null)[];
  pessimisticMeanR?: number | null;
}

export interface StageEConfirmGateInput {
  n: number;
  netMeanR: number | null;
  permutationP: number | null;
  pessimisticMeanR?: number | null;
}

export function evalStageETrainGate(
  input: StageETrainGateInput,
  options: { minFills: number; minPositiveFolds: number },
): GateVerdict {
  const base = evalStageCGate(
    { n: input.n, holmSignificant: input.holmSignificant, netMeanR: input.netMeanR, foldMeanR: input.foldMeanR },
    options,
  );
  const failures = [...base.failures];
  if (input.pessimisticMeanR !== undefined && (input.pessimisticMeanR === null || !(input.pessimisticMeanR > 0))) {
    failures.push('pessimistic-convention E[R] not > 0');
  }
  return { pass: failures.length === 0, failures };
}

export function evalStageEConfirmGate(
  input: StageEConfirmGateInput,
  options: { minFills: number; alpha: number },
): GateVerdict {
  const base = evalConfirmationGate(
    { n: input.n, netMeanR: input.netMeanR, permutationP: input.permutationP },
    options,
  );
  const failures = [...base.failures];
  if (input.pessimisticMeanR !== undefined && (input.pessimisticMeanR === null || !(input.pessimisticMeanR > 0))) {
    failures.push('pessimistic-convention E[R] not > 0');
  }
  return { pass: failures.length === 0, failures };
}
