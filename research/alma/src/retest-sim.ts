import type { Candle } from './types.js';
import type { Direction } from './events.js';

/**
 * Retest-entry trade simulation (Stage D).
 *
 * Execution model: instead of chasing the next bar's open after the reclaim
 * close (Stage B/C model), a LIMIT order rests at the swept pivot level and
 * only fills if price trades back to that level within a predeclared window.
 *
 * Causality: the limit is placed after the reclaim bar CLOSES (signalIndex);
 * the earliest fill bar is signalIndex + 1.
 *
 * Fill rules (predeclared, conservative):
 * - Fill bar b: short fills when bar.high >= level (fill price = max(open, level));
 *   long mirrors with bar.low <= level (fill price = min(open, level)).
 *   A marketable open beyond the level fills at the open.
 * - Risk is sized at the fill: |fill - stop|. A degenerate fill (fill at or
 *   beyond the stop, i.e. zero/negative stop distance) cannot be sized and is
 *   flagged `degenerate` for the caller to exclude.
 * - Fill bar: if the stop extreme is also reached, the trade stops immediately
 *   (price must pass the level to reach the stop, so fill -> stop ordering is
 *   forced); otherwise a same-bar target touch is honored (the stop was not
 *   touched, so no ordering ambiguity against the stop exists).
 * - Later bars follow the Stage-B conventions: open gap through the stop fills
 *   at the open; stop fills before target within a bar; time exit at the close
 *   of fillIndex + timeExitBars.
 * - No fill inside the window -> `filled: false` (a missed trade, counted for
 *   fill-rate reporting; this adverse-selection cost is inherent to retest
 *   entries and is part of what the study measures).
 *
 * This is a per-trade R calculator for a predeclared event rule — not a
 * general-purpose backtest engine or a live fill model.
 */

export interface RetestPlan {
  /** Reclaim-close bar; the resting limit is placed after this bar closes. */
  signalIndex: number;
  direction: Direction;
  /** Limit price (the swept pivot level). */
  level: number;
  stopPrice: number;
  /** Target as an R multiple of the fill-time risk. Null = time exit only. */
  targetR: number | null;
  /** Bars (signalIndex, signalIndex + fillWindowBars] allowed to fill. */
  fillWindowBars: number;
  /** Max bars held after the fill bar; time exit fills at that bar's close. */
  timeExitBars: number;
}

export type RetestResult =
  | { filled: false }
  | {
      filled: true;
      degenerate: boolean;
      fillIndex: number;
      fillPrice: number;
      fillLagBars: number;
      exitIndex: number;
      exitPrice: number;
      outcome: 'stop' | 'target' | 'time';
      barsHeld: number;
      /** Direction-adjusted gross R (excludes costs and funding). */
      grossR: number;
      /** Fill-time risk used for sizing/costs (null when degenerate). */
      risk: number | null;
    };

export function simulateRetestTrade(candles: readonly Candle[], plan: RetestPlan): RetestResult {
  const { signalIndex, direction, level, stopPrice, targetR, fillWindowBars, timeExitBars } = plan;
  const bullish = direction === 1;

  if (signalIndex < 0 || signalIndex >= candles.length) return { filled: false };
  if (signalIndex + fillWindowBars < signalIndex + 1) return { filled: false };

  const lastWindow = Math.min(signalIndex + fillWindowBars, candles.length - 1);
  const touched = (bar: Candle): boolean => (bullish ? bar.low <= level : bar.high >= level);

  let fillIndex = -1;
  for (let b = signalIndex + 1; b <= lastWindow; b++) {
    if (touched(candles[b])) { fillIndex = b; break; }
  }
  if (fillIndex < 0) return { filled: false };

  const fillBar = candles[fillIndex];
  const fillPrice = bullish ? Math.min(fillBar.open, level) : Math.max(fillBar.open, level);
  const risk = bullish ? fillPrice - stopPrice : stopPrice - fillPrice;
  const fillLagBars = fillIndex - signalIndex;

  if (!(risk > 0)) {
    // Degenerate: filled at or beyond the stop; the position cannot be sized.
    return {
      filled: true, degenerate: true, fillIndex, fillPrice, fillLagBars,
      exitIndex: fillIndex, exitPrice: fillPrice, outcome: 'stop', barsHeld: 1,
      grossR: 0, risk: null,
    };
  }

  const targetPrice = targetR === null ? null : (bullish ? fillPrice + targetR * risk : fillPrice - targetR * risk);

  // Fill bar: stop check first (forced ordering — price passed the level to
  // reach the stop), then same-bar target (stop untouched, no ambiguity).
  if (bullish ? fillBar.low <= stopPrice : fillBar.high >= stopPrice) {
    return finish(fillIndex, stopPrice, 'stop');
  }
  if (targetPrice !== null && (bullish ? fillBar.high >= targetPrice : fillBar.low <= targetPrice)) {
    return finish(fillIndex, targetPrice as number, 'target');
  }

  const stopTouched = (bar: Candle): boolean => (bullish ? bar.low <= stopPrice : bar.high >= stopPrice);
  const targetTouched = (bar: Candle): boolean =>
    targetPrice !== null && (bullish ? bar.high >= (targetPrice as number) : bar.low <= (targetPrice as number));

  const last = Math.min(fillIndex + timeExitBars, candles.length - 1);
  for (let b = fillIndex + 1; b <= last; b++) {
    const bar = candles[b];
    if (bullish ? bar.open <= stopPrice : bar.open >= stopPrice) return finish(b, bar.open, 'stop');
    if (stopTouched(bar) && targetTouched(bar)) return finish(b, stopPrice, 'stop');
    if (stopTouched(bar)) return finish(b, stopPrice, 'stop');
    if (targetTouched(bar)) return finish(b, targetPrice as number, 'target');
    if (b === last) return finish(b, bar.close, 'time');
  }
  // Unreachable when last >= fillIndex + 1 (timeExitBars >= 1); kept for safety.
  return finish(last, candles[last].close, 'time');

  function finish(exitIndex: number, exitPrice: number, outcome: 'stop' | 'target' | 'time'): RetestResult {
    const grossR = (direction * (exitPrice - fillPrice)) / risk;
    return {
      filled: true, degenerate: false, fillIndex, fillPrice, fillLagBars,
      exitIndex, exitPrice, outcome, barsHeld: exitIndex - fillIndex + 1,
      grossR, risk,
    };
  }
}
