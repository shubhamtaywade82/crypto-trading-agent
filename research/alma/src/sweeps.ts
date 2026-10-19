import type { Candle } from './types.js';

/**
 * Liquidity sweep event definitions — FIXED BEFORE ANY RESULT INSPECTION
 * (RESEARCH_PROTOCOL Phase 1 hygiene). They formalise the ICT "sweep and
 * reclaim" (spring / failed breakdown): price takes out a prior swing point
 * and closes back on the origin side.
 *
 * Causality rules:
 * - A fractal pivot at bar i is only CONFIRMED at bar i + k (k bars must close
 *   on each side). No event may reference a pivot before its confirmIndex.
 * - The signal is the reclaim bar's close; the earliest entry reference is the
 *   next bar's open (forwardOutcome handles the +1 shift).
 */

export interface Pivot {
  /** Bar whose extreme forms the pivot. */
  index: number;
  /** First bar at which the pivot is knowable (index + k). */
  confirmIndex: number;
  level: number;
  kind: 'low' | 'high';
}

/**
 * Fractal pivots: strictly lower low (kind 'low') or strictly higher high
 * (kind 'high') than the k bars on each side. Equal extremes do not pivot.
 */
export function detectPivots(candles: readonly Candle[], k: number): Pivot[] {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error('swing strength k must be a positive integer');
  }
  const out: Pivot[] = [];
  for (let i = k; i < candles.length - k; i++) {
    const bar = candles[i];
    let isLow = true;
    let isHigh = true;
    for (let d = 1; d <= k; d++) {
      if (!(bar.low < candles[i - d].low) || !(bar.low < candles[i + d].low)) isLow = false;
      if (!(bar.high > candles[i - d].high) || !(bar.high > candles[i + d].high)) isHigh = false;
      if (!isLow && !isHigh) break;
    }
    if (isLow) out.push({ index: i, confirmIndex: i + k, level: bar.low, kind: 'low' });
    if (isHigh) out.push({ index: i, confirmIndex: i + k, level: bar.high, kind: 'high' });
  }
  return out;
}

export interface SweepEvent {
  /** Bar whose CLOSE confirms the reclaim. Earliest entry reference is the next bar's open. */
  index: number;
  openTime: number;
  /** 1 = bullish sweep (lows taken, reclaimed -> reversal-up hypothesis), -1 = bearish mirror. */
  direction: 1 | -1;
  pivotIndex: number;
  level: number;
  /** True when the sweep bar itself closed back across the level. */
  sameBarReclaim: boolean;
}

export interface SweepOptions {
  /** Bars after the sweep bar allowed to close back across the level. 0 = same-bar reclaim only. */
  reclaimWithinBars: number;
  /** Minimum bar gap between emitted events (clustering control). */
  cooldownBars: number;
}

/**
 * Sweep-and-reclaim detection over a causal single pass:
 * - The reference level is the MOST RECENT CONFIRMED pivot low/high; it stays
 *   active until a newer pivot confirms.
 * - Bullish: bar j with low[j] < level and a close back above the level on j
 *   (same-bar) or within reclaimWithinBars after j. Bearish mirrors.
 * - If the reclaim candidate is blocked by the cooldown, the whole candidate
 *   is dropped (deterministic).
 * - While a sweep's reclaim window is open on one side, that side starts no
 *   new scan (one sweep episode = at most one event; no duplicate events at
 *   the same reclaim bar).
 * - The pivot level is NOT consumed by an event; only a newer pivot replaces it.
 */
export function detectSweepReclaim(
  candles: readonly Candle[],
  k: number,
  options: SweepOptions,
): SweepEvent[] {
  if (!Number.isInteger(options.reclaimWithinBars) || options.reclaimWithinBars < 0) {
    throw new Error('reclaimWithinBars must be an integer >= 0');
  }
  if (!Number.isInteger(options.cooldownBars) || options.cooldownBars < 0) {
    throw new Error('cooldownBars must be an integer >= 0');
  }

  const pivots = detectPivots(candles, k);
  const events: SweepEvent[] = [];
  let next = 0;
  let lowLevel: number | null = null;
  let lowPivotIndex = -1;
  let highLevel: number | null = null;
  let highPivotIndex = -1;
  let lastEventIndex = -Infinity;
  let lowScansSuppressedUntil = -1;
  let highScansSuppressedUntil = -1;

  const tryEmit = (event: SweepEvent): void => {
    if (event.index - lastEventIndex <= options.cooldownBars) return;
    events.push(event);
    lastEventIndex = event.index;
  };

  for (let j = 0; j < candles.length; j++) {
    while (next < pivots.length && pivots[next].confirmIndex <= j) {
      const pivot = pivots[next];
      if (pivot.kind === 'low') {
        lowLevel = pivot.level;
        lowPivotIndex = pivot.index;
      } else {
        highLevel = pivot.level;
        highPivotIndex = pivot.index;
      }
      next++;
    }
    if (lowLevel === null && highLevel === null) continue;
    const bar = candles[j];

    if (lowLevel !== null && bar.low < lowLevel && j > lowScansSuppressedUntil) {
      const event = finishReclaim(candles, j, lowLevel, 1, lowPivotIndex, options);
      lowScansSuppressedUntil = j + options.reclaimWithinBars;
      if (event) tryEmit(event);
    }
    if (highLevel !== null && bar.high > highLevel && j > highScansSuppressedUntil) {
      const event = finishReclaim(candles, j, highLevel, -1, highPivotIndex, options);
      highScansSuppressedUntil = j + options.reclaimWithinBars;
      if (event) tryEmit(event);
    }
  }
  return events;
}

function finishReclaim(
  candles: readonly Candle[],
  sweepIndex: number,
  level: number,
  direction: 1 | -1,
  pivotIndex: number,
  options: SweepOptions,
): SweepEvent | null {
  const bullish = direction === 1;
  const sweepBar = candles[sweepIndex];
  const reclaimedNow = bullish ? sweepBar.close > level : sweepBar.close < level;
  if (reclaimedNow) {
    return makeEvent(sweepIndex, sweepBar.openTime, direction, pivotIndex, level, true);
  }
  for (let m = sweepIndex + 1; m <= sweepIndex + options.reclaimWithinBars && m < candles.length; m++) {
    const close = candles[m].close;
    if (bullish ? close > level : close < level) {
      return makeEvent(m, candles[m].openTime, direction, pivotIndex, level, false);
    }
  }
  return null;
}

function makeEvent(
  index: number,
  openTime: number,
  direction: 1 | -1,
  pivotIndex: number,
  level: number,
  sameBarReclaim: boolean,
): SweepEvent {
  return { index, openTime, direction, pivotIndex, level, sameBarReclaim };
}
