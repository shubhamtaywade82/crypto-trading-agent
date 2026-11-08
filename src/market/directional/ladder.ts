import type { Side } from '../../types.js';
import { feeSlippageRoundTripPct, type CostModel } from './barriers.js';

/**
 * Scale-out plan: prices and fractions only. It does not place or move orders. The trailing engine
 * (src/trailing) owns the stop ratchet, the partial-fill lifecycle and execution. This module fixes the geometry, so a
 * historical study can measure each rung against the same entries.
 *
 * - Each rung books `fraction` of the original position at `targetPct` from entry.
 * - The runner is what remains after all rungs. It has no fixed target and is handed to a trailing policy.
 * - After the first rung, the stop moves to entry plus a buffer covering round-trip fees and slippage. Funding is
 *   excluded from the buffer, since it depends on the hold and is priced by the replay, not by geometry.
 *   The stop never moves against the position.
 */

export interface LadderRung {
  targetPct: number;
  fraction: number;
  price: number;
}

export interface ScaleOutPlan {
  side: Side;
  entry: number;
  stopPrice: number;
  rungs: LadderRung[];
  runnerFraction: number;
  /** Stop after the first rung fills: entry plus round-trip fees and slippage, in the side's direction. */
  stopAfterFirstRung: number;
  runnerPolicy: 'DELEGATE_TO_TRAILING_ENGINE';
}

export interface ScaleOutInput {
  side: Side;
  entry: number;
  stopPrice: number;
  rungs: readonly { targetPct: number; fraction: number }[];
  costs: Pick<CostModel, 'feeBpsPerSide' | 'slippageBpsPerSide'>;
}

export function planScaleOut(input: ScaleOutInput): ScaleOutPlan {
  const { side, entry, stopPrice, rungs } = input;
  if (!(Number.isFinite(entry) && entry > 0)) throw new Error('entry must be a positive price');
  const sign = side === 'LONG' ? 1 : -1;
  if (!(sign * (entry - stopPrice) > 0)) throw new Error(`stop ${stopPrice} is not beyond entry ${entry} for ${side}`);
  if (rungs.length === 0) throw new Error('a scale-out plan needs at least one rung');

  let previous = 0;
  let booked = 0;
  for (const r of rungs) {
    if (!(Number.isFinite(r.targetPct) && r.targetPct > previous)) {
      throw new Error('rung targets must be positive and strictly ascending');
    }
    if (!(Number.isFinite(r.fraction) && r.fraction > 0 && r.fraction < 1)) {
      throw new Error(`rung fraction must be in (0, 1), got ${r.fraction}`);
    }
    booked += r.fraction;
    previous = r.targetPct;
  }
  if (!(booked < 1)) throw new Error(`rung fractions sum to ${booked}; a runner must remain`);

  const buffer = feeSlippageRoundTripPct(input.costs) / 100;
  return {
    side,
    entry,
    stopPrice,
    rungs: rungs.map((r) => ({ targetPct: r.targetPct, fraction: r.fraction, price: entry * (1 + (sign * r.targetPct) / 100) })),
    runnerFraction: 1 - booked,
    stopAfterFirstRung: entry * (1 + sign * buffer),
    runnerPolicy: 'DELEGATE_TO_TRAILING_ENGINE',
  };
}
