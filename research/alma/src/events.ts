import type { Candle } from './types.js';

export type Direction = 1 | -1;

export interface CrossEvent {
  /** Bar index whose CLOSE confirms the cross. Earliest entry is the next bar's open. */
  index: number;
  /** Bar open time when candles are supplied; bar index otherwise. */
  openTime: number;
  /** 1 = bullish (fast crossed above slow), -1 = bearish (fast crossed below slow). */
  direction: Direction;
}

export interface CrossoverOptions {
  /** Require the slow line's slope over `slopeLookbackBars` to agree with the cross direction. */
  requireSlowSlopeAgreement?: boolean;
  /** Bars used to measure the slow line's slope. Default 1. */
  slopeLookbackBars?: number;
}

/** Slope of `series` at `index` measured over `lookback` bars: series[index] - series[index - lookback]. */
export function slopeAt(
  series: ReadonlyArray<number | null>,
  index: number,
  lookback = 1,
): number | null {
  if (!Number.isInteger(lookback) || lookback < 1) {
    throw new Error('slope lookback must be a positive integer');
  }
  if (index >= series.length || index - lookback < 0) return null;
  const now = series[index];
  const before = series[index - lookback];
  return now === null || before === null ? null : now - before;
}

/**
 * CROSS definitions (fixed before any result inspection, per RESEARCH_PROTOCOL Phase 1):
 * - bullish: previous defined bar fast < slow AND current bar fast > slow (strict).
 * - bearish: previous defined bar fast > slow AND current bar fast < slow (strict).
 * Bars where either line is null (warm-up) break consecutiveness: a cross must
 * form between two adjacent defined bars. `cross_with_slope` additionally
 * requires the slow line's slope at the cross bar to agree with the direction.
 */
export function detectCrossovers(
  fast: ReadonlyArray<number | null>,
  slow: ReadonlyArray<number | null>,
  candles?: readonly Candle[],
  options: CrossoverOptions = {},
): CrossEvent[] {
  const events: CrossEvent[] = [];
  const slopeLookback = options.slopeLookbackBars ?? 1;
  let previousIndex = -1;
  let previousDiff = 0;

  const push = (index: number, direction: Direction): void => {
    if (options.requireSlowSlopeAgreement) {
      const slope = slopeAt(slow, index, slopeLookback);
      if (slope === null) return;
      if (direction === 1 && slope <= 0) return;
      if (direction === -1 && slope >= 0) return;
    }
    events.push({
      index,
      openTime: candles ? candles[index].openTime : index,
      direction,
    });
  };

  const last = Math.min(fast.length, slow.length);
  for (let i = 0; i < last; i++) {
    const fastValue = fast[i];
    const slowValue = slow[i];
    if (fastValue === null || slowValue === null) continue;
    const diff = fastValue - slowValue;
    if (previousIndex === i - 1) {
      if (previousDiff < 0 && diff > 0) push(i, 1);
      else if (previousDiff > 0 && diff < 0) push(i, -1);
    }
    previousIndex = i;
    previousDiff = diff;
  }
  return events;
}

export interface PullbackOptions {
  /** Minimum excursion beyond the line, in ATR units, before a pullback may count. */
  extendAtr: number;
  /** Distance around the line, in ATR units, that counts as a touch. */
  touchTolAtr: number;
  /** Confirmation must happen within this many bars after the cross bar. */
  maxBarsAfterCross: number;
  /** Require the slow line's slope to agree with the cross direction at the confirmation bar. */
  requireSlowSlope: boolean;
  /** Bars used to measure the slow line's slope. */
  slopeLookbackBars: number;
}

export interface PullbackEvent {
  /** Bar index whose CLOSE confirms the rejection. Earliest entry is the next bar's open. */
  index: number;
  openTime: number;
  crossIndex: number;
  direction: Direction;
  /** Which ALMA series the pullback referenced. */
  line: 'fast' | 'slow';
}

/**
 * PULLBACK-REJECT state machine (fixed before any result inspection), bullish
 * case (bearish mirrors every comparison):
 *   1. EXTEND  high >= line + extendAtr * ATR
 *   2. TOUCH   low  <= line + touchTolAtr * ATR        (only after EXTEND)
 *   3. REJECT  close > line, on the touch bar or any later bar within the
 *              window; optionally slow-slope agreement at the confirmation bar.
 * The first confirmation wins; at most one event per cross. A single bar may
 * satisfy several steps at once (steps are evaluated top-to-bottom, which is
 * deterministic). `line` may point at the fast or the slow ALMA series; `slow`
 * is always the slow ALMA and is used for the slope filter.
 */
export function detectPullbackAfterCross(
  candles: readonly Candle[],
  line: ReadonlyArray<number | null>,
  slow: ReadonlyArray<number | null>,
  atr: ReadonlyArray<number | null>,
  cross: CrossEvent,
  lineKind: 'fast' | 'slow',
  options: PullbackOptions,
): PullbackEvent | null {
  const bullish = cross.direction === 1;
  const end = Math.min(cross.index + options.maxBarsAfterCross, candles.length - 1);
  let extended = false;
  let touched = false;

  for (let i = cross.index + 1; i <= end; i++) {
    const level = line[i];
    const bar = candles[i];
    const atrValue = atr[i];
    if (level === null || atrValue === null || atrValue <= 0) continue;

    if (!extended) {
      const beyond = bullish
        ? bar.high >= level + options.extendAtr * atrValue
        : bar.low <= level - options.extendAtr * atrValue;
      if (beyond) extended = true;
    }
    if (extended && !touched) {
      const backAtLine = bullish
        ? bar.low <= level + options.touchTolAtr * atrValue
        : bar.high >= level - options.touchTolAtr * atrValue;
      if (backAtLine) touched = true;
    }
    if (!touched) continue;

    const rejected = bullish ? bar.close > level : bar.close < level;
    if (!rejected) continue;

    if (options.requireSlowSlope) {
      const slope = slopeAt(slow, i, options.slopeLookbackBars);
      if (slope === null) continue;
      if (bullish && slope <= 0) continue;
      if (!bullish && slope >= 0) continue;
    }
    return {
      index: i,
      openTime: bar.openTime,
      crossIndex: cross.index,
      direction: cross.direction,
      line: lineKind,
    };
  }
  return null;
}

export interface Outcome {
  /** Direction-adjusted return: direction * (close[exit] / open[entry] - 1). */
  pct: number;
  /** Best direction-adjusted excursion vs entry within the window (>= 0). */
  mfePct: number;
  /** Worst direction-adjusted excursion vs entry within the window (>= 0). */
  maePct: number;
}

/**
 * Forward directional outcome of an event bar.
 * The signal is confirmed on the event bar's close; the earliest possible
 * reference price is the NEXT bar's open. The window runs `horizon` bars from
 * that entry bar (entry bar counts as bar 1). Returns null when the window
 * would run past the end of the dataset — callers count these separately
 * instead of silently truncating.
 */
export function forwardOutcome(
  candles: readonly Candle[],
  eventIndex: number,
  direction: Direction,
  horizon: number,
): Outcome | null {
  if (!Number.isInteger(horizon) || horizon < 1) {
    throw new Error('outcome horizon must be a positive integer');
  }
  const entryIndex = eventIndex + 1;
  const exitIndex = entryIndex + horizon - 1;
  if (exitIndex > candles.length - 1) return null;

  const entryPrice = candles[entryIndex].open;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  const exitPrice = candles[exitIndex].close;
  const bullish = direction === 1;

  let mfe = 0;
  let mae = 0;
  for (let i = entryIndex; i <= exitIndex; i++) {
    const favorable = bullish
      ? candles[i].high / entryPrice - 1
      : 1 - candles[i].low / entryPrice;
    const adverse = bullish
      ? 1 - candles[i].low / entryPrice
      : candles[i].high / entryPrice - 1;
    if (favorable > mfe) mfe = favorable;
    if (adverse > mae) mae = adverse;
  }
  return {
    pct: (bullish ? 1 : -1) * (exitPrice / entryPrice - 1),
    mfePct: mfe,
    maePct: mae,
  };
}

export interface ScoredEvent {
  direction: Direction;
  /** Null when the outcome window ran past the dataset tail. */
  outcome: Outcome | null;
}

export interface EventStats {
  events: number;
  longs: number;
  shorts: number;
  scored: number;
  excludedTail: number;
  hits: number;
  hitRate: number | null;
  medianPct: number | null;
  meanPct: number | null;
  p25Pct: number | null;
  p75Pct: number | null;
  minPct: number | null;
  maxPct: number | null;
  meanMfePct: number | null;
  meanMaePct: number | null;
}

/** Nearest-rank quantile of an ascending-sorted array. */
export function quantileOf(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.floor(q * (sorted.length - 1))];
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return quantileOf(sorted, 0.5);
}

/** A hit is a strictly positive direction-adjusted outcome. Zero counts as a miss. */
export function summarizeEvents(scored: readonly ScoredEvent[]): EventStats {
  const scoredOutcomes = scored
    .filter((event): event is ScoredEvent & { outcome: Outcome } => event.outcome !== null);
  const pcts = scoredOutcomes.map((event) => event.outcome.pct).sort((a, b) => a - b);
  const hits = pcts.filter((pct) => pct > 0).length;
  const longs = scored.filter((event) => event.direction === 1).length;
  const shorts = scored.length - longs;
  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    events: scored.length,
    longs,
    shorts,
    scored: pcts.length,
    excludedTail: scored.length - pcts.length,
    hits,
    hitRate: pcts.length > 0 ? hits / pcts.length : null,
    medianPct: quantileOf(pcts, 0.5),
    meanPct: mean(pcts),
    p25Pct: quantileOf(pcts, 0.25),
    p75Pct: quantileOf(pcts, 0.75),
    minPct: pcts.length > 0 ? pcts[0] : null,
    maxPct: pcts.length > 0 ? pcts[pcts.length - 1] : null,
    meanMfePct: mean(scoredOutcomes.map((event) => event.outcome.mfePct)),
    meanMaePct: mean(scoredOutcomes.map((event) => event.outcome.maePct)),
  };
}
