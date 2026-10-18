import type { Candle } from '../types.js';
import type { SMCFrame } from '../strategies/smc-ml/types.js';
import { closeTimeOf, FRAME_MS } from './context.js';
import type { TradeDirection, TradePlan } from './types.js';

/**
 * Resolves what an ENTRY_ELIGIBLE setup actually did, from candles AFTER its trigger closed. The rules are conservative
 * and fixed before any outcome is collected:
 *
 * - Entry (registry v3): a limit at the plan entry, the zone's near edge, resting for `entryTtlBars` bars from the
 *   trigger close. A bar that opens at or through the limit fills at its open. Otherwise the limit fills at its price only
 *   on a strict trade-through (a LONG needs a low below it; a touch is not a fill).
 * - Missed move: a bar that reaches the target before any fill makes the setup NOT_FILLED, even if it also traded through
 *   the limit: candles cannot show the order, and a move we did not catch must never count as a win.
 * - Exit: within a bar the stop is tested before the target (the replay engine's rule), including the bar that filled
 *   intrabar. A bar that opens beyond the stop exits at its open. The target fills at the target price.
 * - TIMEOUT: neither level within `horizonBars` bars, counting the fill bar; exits at that bar's close.
 * - NOT_FILLED: no fill within the TTL. It is known at the close of the last TTL bar, or of the bar that hit the target.
 * - UNRESOLVED: the candles end before an outcome, or have a gap (the bar after the trigger is missing, or bars are not
 *   contiguous). It is not an outcome and is never counted.
 * - Net R is per unit of filled risk, after taker fee and slippage on both legs (a resting limit may fill as maker; taker
 *   is the conservative assumption). Funding is not modelled (a 4 h horizon crosses at most one settlement).
 */

export type OutcomeLabel = 'TARGET' | 'STOP' | 'TIMEOUT' | 'NOT_FILLED' | 'UNRESOLVED';

export interface OutcomePolicy {
  /** Trigger-frame bars the entry limit rests for, counting the first bar after the trigger. */
  entryTtlBars: number;
  /** Bars of the trigger frame, counting the fill bar. */
  horizonBars: number;
  takerFeeRate: number;
  slippageRate: number;
}

/**
 * The limit rests 6 bars of 5m (30 min, the approved trigger window); a trade lasts at most 48 bars of 5m (4 h).
 * Starting values; the policy is stored with every outcome.
 */
export const DEFAULT_OUTCOME_POLICY: OutcomePolicy = { entryTtlBars: 6, horizonBars: 48, takerFeeRate: 0.0004, slippageRate: 0.0002 };

export interface ResolvedOutcome {
  label: OutcomeLabel;
  fillPrice: number | null;
  filledAt: number | null;
  exitPrice: number | null;
  /** When the outcome became known: the close of the exit bar, or of the bar that ended the entry without a fill. */
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
  const scanned = after.slice(0, policy.entryTtlBars + policy.horizonBars);
  if (scanned.some((c, i) => i > 0 && c.openTime - scanned[i - 1].openTime !== FRAME_MS[frame])) return unresolved;

  let fillIndex = -1;
  let fill = Number.NaN;
  for (let i = 0; i < Math.min(policy.entryTtlBars, after.length); i++) {
    const bar = after[i];
    if ((bar.open - plan.entry) * dir <= 0) { fillIndex = i; fill = bar.open; break; }
    const targetReached = dir === 1 ? bar.high >= plan.target : bar.low <= plan.target;
    if (targetReached) return { ...unresolved, label: 'NOT_FILLED', resolvedAt: closeTimeOf(frame, bar.openTime) };
    const tradedThrough = dir === 1 ? bar.low < plan.entry : bar.high > plan.entry;
    if (tradedThrough) { fillIndex = i; fill = plan.entry; break; }
  }
  if (fillIndex < 0) {
    if (after.length < policy.entryTtlBars) return unresolved;
    return { ...unresolved, label: 'NOT_FILLED', resolvedAt: closeTimeOf(frame, after[policy.entryTtlBars - 1].openTime) };
  }

  const fillBar = after[fillIndex];
  const planRisk = (plan.entry - plan.stop) * dir;
  const fillRisk = (fill - plan.stop) * dir;
  // A fill at or beyond the stop has no positive risk of its own; the plan's risk is the unit then
  const unit = fillRisk > 0 ? fillRisk : planRisk;
  const costRate = policy.takerFeeRate + policy.slippageRate;
  const close = (label: OutcomeLabel, exitPrice: number, bar: Candle, barsHeld: number): ResolvedOutcome => ({
    label,
    fillPrice: fill,
    filledAt: fillBar.openTime,
    exitPrice,
    resolvedAt: closeTimeOf(frame, bar.openTime),
    netR: ((exitPrice - fill) * dir - (fill + exitPrice) * costRate) / unit,
    barsHeld,
  });

  for (let j = 0; j < policy.horizonBars; j++) {
    const bar = after[fillIndex + j];
    if (!bar) return { ...unresolved, fillPrice: fill, filledAt: fillBar.openTime };
    const stopHit = dir === 1 ? bar.low <= plan.stop : bar.high >= plan.stop;
    if (stopHit) {
      const gapped = (bar.open - plan.stop) * dir <= 0;
      return close('STOP', gapped ? bar.open : plan.stop, bar, j + 1);
    }
    const targetHit = dir === 1 ? bar.high >= plan.target : bar.low <= plan.target;
    if (targetHit) return close('TARGET', plan.target, bar, j + 1);
  }
  const last = after[fillIndex + policy.horizonBars - 1];
  return close('TIMEOUT', last.close, last, policy.horizonBars);
}
