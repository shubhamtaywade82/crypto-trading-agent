import type { Candle } from './types.js';
import type { Direction } from './events.js';

/**
 * Minimal causal trade simulation for event-graduation studies (Stage B).
 *
 * Conventions (match the repository's execution assumptions, see
 * research/alma/config/experiment.v1.json):
 * - Signal on a closed candle; the position acts from the NEXT bar's open.
 * - An open gap beyond the stop fills at the open (worse than the stop price).
 * - If stop and target are both touched inside one bar, the STOP fills first
 *   (conservative; kline data cannot resolve the intrabar path).
 * - Time exits fill at the close of the time-exit bar.
 * - Costs are charged round-trip on notional; funding uses ACTUAL historical
 *   settlement rates supplied by the caller (shorts receive positive rates).
 *
 * This is a per-trade R calculator for predeclared event rules — not a
 * general-purpose backtest engine, and not a fill model for live execution.
 */

export interface TradePlan {
  /** First bar the position acts on (signal bar + 1). */
  entryIndex: number;
  direction: Direction;
  entryPrice: number;
  stopPrice: number;
  /** Null = time exit only. */
  targetPrice: number | null;
  /** Last bar allowed; its close fills a time exit. */
  timeExitIndex: number;
}

export interface TradeOutcome {
  exitIndex: number;
  exitPrice: number;
  outcome: 'stop' | 'target' | 'time';
  barsHeld: number;
  /** Direction-adjusted gross R (excludes costs and funding). */
  grossR: number;
}

export function simulateTrade(
  candles: readonly Candle[],
  plan: TradePlan,
): TradeOutcome | null {
  const { entryIndex, direction, entryPrice, stopPrice, targetPrice, timeExitIndex } = plan;
  const bullish = direction === 1;
  // Risk must be on the correct side of the entry for the direction.
  const risk = bullish ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (!(entryPrice > 0) || !(risk > 0)) return null;
  if (targetPrice !== null) {
    const targetRisk = bullish ? targetPrice - entryPrice : entryPrice - targetPrice;
    if (!(targetRisk > 0)) return null;
  }
  if (entryIndex < 0 || entryIndex >= candles.length) return null;
  const last = Math.min(timeExitIndex, candles.length - 1);
  if (last < entryIndex) return null;

  // A long stop is touched on lows; a short stop on highs. Targets mirror.
  const stopTouched = (bar: Candle): boolean => (bullish ? bar.low <= stopPrice : bar.high >= stopPrice);
  const targetTouched = (bar: Candle): boolean =>
    targetPrice !== null && (bullish ? bar.high >= (targetPrice as number) : bar.low <= (targetPrice as number));

  for (let b = entryIndex; b <= last; b++) {
    const bar = candles[b];

    // Open gap through the stop fills at the open (worse than the stop price).
    if (bullish ? bar.open <= stopPrice : bar.open >= stopPrice) {
      return finish(b, bar.open, 'stop');
    }
    if (stopTouched(bar) && targetTouched(bar)) {
      // Conservative ordering: the stop is tested before the target.
      return finish(b, stopPrice, 'stop');
    }
    if (stopTouched(bar)) {
      return finish(b, stopPrice, 'stop');
    }
    if (targetTouched(bar)) {
      return finish(b, targetPrice as number, 'target');
    }
    if (b === last) {
      return finish(b, bar.close, 'time');
    }
  }
  return null;

  function finish(exitIndex: number, exitPrice: number, outcome: TradeOutcome['outcome']): TradeOutcome {
    const grossR = (direction * (exitPrice - entryPrice)) / risk;
    return { exitIndex, exitPrice, outcome, barsHeld: exitIndex - entryIndex + 1, grossR };
  }
}

/** Round-trip fee+slippage expressed in R, given the risk fraction of notional. */
export function costsInR(entryPrice: number, stopPrice: number, feeBpsPerSide: number, slippageBpsPerSide: number): number {
  const risk = Math.abs(entryPrice - stopPrice);
  if (!(entryPrice > 0) || !(risk > 0)) return 0;
  const roundTripCostFraction = (2 * (feeBpsPerSide + slippageBpsPerSide)) / 10_000;
  return roundTripCostFraction * (entryPrice / risk);
}

/**
 * Historical funding in R for a hold.
 * rates: settlement rates (fraction of notional; positive = longs pay shorts).
 * Shorts RECEIVE positive rates; longs pay them. Holding window is
 * (entryOpenTime, exitCloseTime].
 */
export function fundingInR(
  direction: Direction,
  rates: readonly number[],
  entryPrice: number,
  stopPrice: number,
): number {
  const risk = Math.abs(entryPrice - stopPrice);
  if (rates.length === 0 || !(entryPrice > 0) || !(risk > 0)) return 0;
  const sum = rates.reduce((acc, rate) => acc + rate, 0);
  const signed = direction === 1 ? -sum : sum;
  return signed * (entryPrice / risk);
}
