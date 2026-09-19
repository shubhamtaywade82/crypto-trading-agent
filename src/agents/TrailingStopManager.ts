import type { Position } from '../types.js';
import { TP_ATR_MULTIPLE, type AdaptiveSuperTrendBar } from '../binance/adaptiveSuperTrend.js';

export interface StopLevels {
  stopLoss: number;
  takeProfit: number;
}

export type TrailState = Pick<AdaptiveSuperTrendBar, 'superTrend' | 'regime' | 'assignedAtr'>;

// Extend the TP once price is within this many assigned ATRs of it, by TP_EXTENSION_ATR.
// The LOW-regime cap reuses it as hysteresis so tick noise cannot re-tighten the TP every loop
const TP_TRIGGER_ATR = 0.5;
const TP_EXTENSION_ATR = 1;

/**
 * Regime-aware trailing stops for a trade opened on an Adaptive SuperTrend flip.
 * Returns the new levels, or null when nothing changes. Pure and idempotent: calling it
 * again with the returned levels yields null. `direction` is +1 for longs, -1 for shorts.
 */
export function nextStops(position: Position, state: TrailState): StopLevels | null {
  const currentStop = Number(position.serverSl);
  const currentTarget = Number(position.serverTp);
  if (!(currentStop > 0) || !(currentTarget > 0)) return null;

  const direction = position.side === 'LONG' ? 1 : -1;
  const tighter = (a: number, b: number) => (direction === 1 ? Math.max(a, b) : Math.min(a, b));
  const { mark, entry } = position;
  const atr = state.assignedAtr;

  let stopLoss = tighter(currentStop, state.superTrend);
  let takeProfit = currentTarget;

  const oneR = position.initialRisk ?? 0;
  if (oneR > 0 && (mark - entry) * direction >= oneR) stopLoss = tighter(stopLoss, entry);

  if ((takeProfit - mark) * direction <= TP_TRIGGER_ATR * atr) {
    stopLoss = tighter(stopLoss, takeProfit - direction * atr);
    takeProfit += direction * TP_EXTENSION_ATR * atr;
  }

  if (state.regime === 'LOW' && (mark - entry) * direction > 0) {
    const cap = mark + direction * TP_ATR_MULTIPLE.LOW * atr;
    if ((takeProfit - cap) * direction > TP_TRIGGER_ATR * atr) takeProfit = cap;
  }

  return stopLoss === currentStop && takeProfit === currentTarget ? null : { stopLoss, takeProfit };
}
