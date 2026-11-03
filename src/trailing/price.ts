import type { Candle } from '../types.js';
import { wilderAtr } from '../binance/indicators.js';
import type { PolicyContext, StopCandidate, TrailingPolicy, TrailingState } from './types.js';

/**
 * Price-domain trailing methods (spec §6 #1, #2). Both share the directional form from spec §3:
 * the candidate stop is `F − k·ATR` in X coordinates, where F is the favorable extreme since
 * entry (the engine updates it before evaluators run). MARK-domain variants (#14/#15) arrive in
 * phase 2 and call the same helper against mark bars.
 */

/** Wilder ATR of closed candles, or null while warming up / non-positive (no candidate on warmup). */
export function atrOf(candles: Candle[], period: number): number | null {
  const series = wilderAtr(candles, period);
  const last = series.at(-1);
  return last !== undefined && Number.isFinite(last) && last > 0 ? last : null;
}

// Pure math between the state's extreme and the candle ATR; a tf mismatch refuses silently.
function extremeAtrStop(policy: TrailingPolicy, ctx: PolicyContext, state: TrailingState, spec: { periodKey: string; reasonBase: string }): StopCandidate | null {
  const period = policy.params[spec.periodKey] as number;
  const k = policy.params.k as number;
  const tf = policy.params.tf as string;
  if (tf !== ctx.tf || !(period > 0) || !(k > 0)) return null;
  const atr = atrOf(ctx.candles, period);
  if (atr === null) return null;
  const levelZ = state.favorableExtremeX - k * atr;
  return { policyId: policy.id, levelZ, priceReference: policy.priceReference, reason: `${spec.reasonBase}:${spec.periodKey}${period}-k${k}` };
}

export const atrTrail = (policy: TrailingPolicy, ctx: PolicyContext, state: TrailingState): StopCandidate | null => (
  extremeAtrStop(policy, ctx, state, { periodKey: 'period', reasonBase: 'atr-trail' })
);

export const chandelier = (policy: TrailingPolicy, ctx: PolicyContext, state: TrailingState): StopCandidate | null => (
  extremeAtrStop(policy, ctx, state, { periodKey: 'n', reasonBase: 'chandelier' })
);
