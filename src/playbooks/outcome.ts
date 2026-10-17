import type { Candle } from '../types.js';
import type { SMCFrame } from '../strategies/smc-ml/types.js';
import { closeTimeOf, FRAME_MS } from './context.js';
import type { TradeDirection, TradePlan } from './types.js';

/**
 * Resolves what an ENTRY_ELIGIBLE setup actually did, from candles AFTER its trigger closed. The rules are conservative
 * and fixed before any outcome is collected:
 *
 * - Fill: live entries are limits at the plan entry with a short TTL (ENTRY_ORDER_TTL_MS, 120 s, shorter than one 5m bar).
 *   The fill is counted only when the first bar after the trigger OPENS at or better than the limit, at that open. A
 *   bar that opens worse and trades back later in the bar is NOT_FILLED: candles cannot show whether that happened
 *   within the TTL. This undercounts fills, and fill-rate is reported next to the estimate.
 * - Exit: within a bar the stop is tested before the target (the replay engine's rule). A bar that opens beyond the
 *   stop exits at its open. The target fills at the target price.
 * - TIMEOUT: neither level within `horizonBars` bars, counting the fill bar; exits at that bar's close.
 * - UNRESOLVED: the candles end before an outcome or the horizon, or have a gap (the bar after the trigger is missing,
 *   or bars inside the horizon are not contiguous). It is not an outcome and is never counted.
 * - Net R is per unit of filled risk, after taker fee and slippage on both legs. Funding is not modelled (a 4 h horizon
 *   crosses at most one settlement).
 */

export type OutcomeLabel = 'TARGET' | 'STOP' | 'TIMEOUT' | 'NOT_FILLED' | 'UNRESOLVED';

export interface OutcomePolicy {
  /** Bars of the trigger frame, counting the fill bar. */
  horizonBars: number;
  takerFeeRate: number;
  slippageRate: number;
}

/** 48 bars of 5m = 4 h: intraday. A starting value; it is stored with every outcome. */
export const DEFAULT_OUTCOME_POLICY: OutcomePolicy = { horizonBars: 48, takerFeeRate: 0.0004, slippageRate: 0.0002 };

export interface ResolvedOutcome {
  label: OutcomeLabel;
  fillPrice: number | null;
  filledAt: number | null;
  exitPrice: number | null;
  /** When the outcome became known: the close of the exit bar, or the open of the bar that failed to fill. */
  resolvedAt: number | null;
  netR: number | null;
  barsHeld: number | null;
}

export interface OutcomeInput {
  direction: TradeDirection;
  plan: TradePlan;
  /** Close time of the trigger bar: the earliest moment the entry could be sent. */
  triggeredAt: number;
  frame: SMCFrame;
  /** Closed trigger-frame candles; only those opening at or after `triggeredAt` are read. */
  candles: readonly Candle[];
}

const unresolved: ResolvedOutcome = { label: 'UNRESOLVED', fillPrice: null, filledAt: null, exitPrice: null, resolvedAt: null, netR: null, barsHeld: null };

export function resolveOutcome(input: OutcomeInput, policy: OutcomePolicy = DEFAULT_OUTCOME_POLICY): ResolvedOutcome {
  const { plan, frame } = input;
  const dir = input.direction === 'LONG' ? 1 : -1;
  const after = input.candles.filter((c) => c.openTime >= input.triggeredAt).sort((a, b) => a.openTime - b.openTime);
  const first = after[0];
  if (!first || first.openTime !== input.triggeredAt) return unresolved;
  const scanned = after.slice(0, policy.horizonBars);
  if (scanned.some((c, i) => i > 0 && c.openTime - scanned[i - 1].openTime !== FRAME_MS[frame])) return unresolved;
  if ((first.open - plan.entry) * dir > 0) {
    return { ...unresolved, label: 'NOT_FILLED', resolvedAt: first.openTime };
  }

  const fill = first.open;
  const planRisk = (plan.entry - plan.stop) * dir;
  const fillRisk = (fill - plan.stop) * dir;
  // A fill at or beyond the stop has no positive risk of its own; the plan's risk is the unit then
  const unit = fillRisk > 0 ? fillRisk : planRisk;
  const costRate = policy.takerFeeRate + policy.slippageRate;
  const close = (label: OutcomeLabel, exitPrice: number, bar: Candle, barsHeld: number): ResolvedOutcome => ({
    label,
    fillPrice: fill,
    filledAt: first.openTime,
    exitPrice,
    resolvedAt: closeTimeOf(frame, bar.openTime),
    netR: ((exitPrice - fill) * dir - (fill + exitPrice) * costRate) / unit,
    barsHeld,
  });

  for (let i = 0; i < after.length && i < policy.horizonBars; i++) {
    const bar = after[i];
    const stopHit = dir === 1 ? bar.low <= plan.stop : bar.high >= plan.stop;
    if (stopHit) {
      const gapped = (bar.open - plan.stop) * dir <= 0;
      return close('STOP', gapped ? bar.open : plan.stop, bar, i + 1);
    }
    const targetHit = dir === 1 ? bar.high >= plan.target : bar.low <= plan.target;
    if (targetHit) return close('TARGET', plan.target, bar, i + 1);
  }
  if (after.length < policy.horizonBars) return { ...unresolved, fillPrice: fill, filledAt: first.openTime };
  const last = after[policy.horizonBars - 1];
  return close('TIMEOUT', last.close, last, policy.horizonBars);
}
