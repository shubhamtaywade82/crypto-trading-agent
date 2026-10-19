import { FRAME_MS } from '../../playbooks/context.js';
import type { PlaybookDecisionRecord } from '../../playbooks/journal.js';
import { resolveOutcome, type OutcomePolicy } from '../../playbooks/outcome.js';
import type { SMCFrame } from '../../strategies/smc-ml/types.js';
import type { Candle } from '../../types.js';
import { mulberry32, quantileSorted } from '../Bootstrap.js';
import type { ExperimentConfig, SegmentName, TradeRecord } from './types.js';

/**
 * Segment split and negative controls.
 *
 * The split is chronological on the decision timeline, with boundaries floored to UTC day starts, so every variant is
 * judged on the same periods. The controls are the standard nulls for a strategy family whose components were searched:
 * a mirror (flip) null, a sign-flip permutation test, delayed entries and a cost curve. None of them tune anything;
 * they only re-read decisions the causal replay already took.
 */

export interface Segment {
  name: SegmentName;
  /** Inclusive start on the decision timeline. */
  start: number;
  /** Exclusive end on the decision timeline. */
  end: number;
}

const DAY = 24 * 60 * 60_000;
const floorToDay = (t: number): number => Math.floor(t / DAY) * DAY;

export function segmentBounds(from: number, to: number, splits: ExperimentConfig['splits']): Segment[] {
  const sum = splits.train + splits.validation + splits.holdout;
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`splits must sum to 1, got ${sum}`);
  if (splits.train <= 0 || splits.validation <= 0 || splits.holdout <= 0) throw new Error('every split fraction must be positive');
  const t1 = floorToDay(from + splits.train * (to - from));
  const t2 = floorToDay(from + (splits.train + splits.validation) * (to - from));
  if (!(t1 > from && t2 > t1 && to > t2)) throw new Error('splits too small for the window: a segment is empty');
  return [
    { name: 'train', start: from, end: t1 },
    { name: 'validation', start: t1, end: t2 },
    { name: 'holdout', start: t2, end: to + 1 },
  ];
}

export const segmentOf = (decidedAt: number, segments: readonly Segment[]): SegmentName | null =>
  segments.find((s) => decidedAt >= s.start && decidedAt < s.end)?.name ?? null;

/** Mirror null: the mean R of the same filled trades with every direction flipped. */
export function flipMeanR(trades: readonly TradeRecord[]): number | null {
  const rs = trades.filter((t) => t.netR !== null).map((t) => t.netR!);
  if (rs.length === 0) return null;
  return -rs.reduce((a, b) => a + b, 0) / rs.length;
}

export interface PermutationResult {
  iterations: number;
  seed: number;
  observedMeanR: number | null;
  /** Empirical one-sided p for H0: the sign of each trade carries no information (mean of sign-flipped sample >= observed). */
  pValue: number | null;
  /** 95th percentile of the null distribution of the mean, for the report. */
  nullP95R: number | null;
}

/** Sign-flip permutation test: under H0 each trade is equally likely to have been taken in either direction. */
export function permutationTest(netRs: readonly number[], iterations: number, seed: number): Omit<PermutationResult, 'observedMeanR'> {
  if (netRs.length === 0) return { iterations, seed, pValue: null, nullP95R: null };
  const rand = mulberry32(seed);
  const observed = netRs.reduce((a, b) => a + b, 0) / netRs.length;
  const nulls: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (const r of netRs) sum += rand() < 0.5 ? r : -r;
    nulls.push(sum / netRs.length);
  }
  const atLeast = nulls.filter((m) => m >= observed).length;
  return { iterations, seed, pValue: (atLeast + 1) / (iterations + 1), nullP95R: quantileSorted([...nulls].sort((a, b) => a - b), 0.95) };
}

/** Mean net R of the variant's filled decisions when the same plan is resolved `bars` trigger bars later. */
export function delayedExpectancy(
  decisions: readonly PlaybookDecisionRecord[],
  triggerFrame: SMCFrame,
  candles: readonly Candle[],
  policy: OutcomePolicy,
  bars: number,
): { bars: number; n: number; evR: number | null } {
  const shifted = decisions.map((d) => ({
    direction: d.direction,
    plan: d.plan,
    triggeredAt: d.decidedAt + bars * FRAME_MS[triggerFrame],
    frame: triggerFrame,
    candles,
  }));
  const rs: number[] = [];
  for (const input of shifted) {
    const o = resolveOutcome(input, policy);
    if (o.label !== 'NOT_FILLED' && o.label !== 'UNRESOLVED' && o.netR !== null) rs.push(o.netR);
  }
  return { bars, n: rs.length, evR: rs.length === 0 ? null : rs.reduce((a, b) => a + b, 0) / rs.length };
}

/** Mean net R when outcomes are re-priced at multiplied fee+slippage. Decision gates are not re-run. */
export function costCurve(
  decisions: readonly PlaybookDecisionRecord[],
  triggerFrame: SMCFrame,
  candles: readonly Candle[],
  policy: OutcomePolicy,
  multipliers: readonly number[],
): { multiplier: number; n: number; evR: number | null }[] {
  return multipliers.map((multiplier) => {
    const priced: OutcomePolicy = { ...policy, takerFeeRate: policy.takerFeeRate * multiplier, slippageRate: policy.slippageRate * multiplier };
    const rs: number[] = [];
    for (const d of decisions) {
      const o = resolveOutcome({ direction: d.direction, plan: d.plan, triggeredAt: d.decidedAt, frame: triggerFrame, candles }, priced);
      if (o.label !== 'NOT_FILLED' && o.label !== 'UNRESOLVED' && o.netR !== null) rs.push(o.netR);
    }
    return { multiplier, n: rs.length, evR: rs.length === 0 ? null : rs.reduce((a, b) => a + b, 0) / rs.length };
  });
}
