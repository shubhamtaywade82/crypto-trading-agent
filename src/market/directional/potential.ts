import type { Side } from '../../types.js';
import { ENTRY_CONTEXTS, type ExpansionContext } from './context.js';
import type { CellReport, TargetTable } from './probability.js';
import type { RoomResult } from './room.js';

/**
 * Directional potential, in three distinct outputs:
 * - moveProbability: chance of reaching a target before the stop, from training and checked on the holdout.
 * - capacity: how far price can travel. Known room to an opposing zone, or a validated capacity model.
 * - tradeExpectancy: mean net return after costs and funding, from the same labels.
 *
 * NO_TRADE unless every gate passes, in this order:
 * 1. The stop is beyond entry and no wider than `maxStopPct`.
 * 2. The context is an entry context.
 * 3. An admitted cell exists for this symbol, side and context.
 * 4. The cell passes the pre-registered holdout criterion. Otherwise no probability is published.
 * 5. Capacity is known. Unknown room is never treated as unlimited: without an opposing zone or a validated capacity
 *    model, every target is blocked.
 * 6. Capacity covers at least one calibrated target.
 */

export type DirectionalDecision = 'LONG' | 'SHORT' | 'NO_TRADE';

export interface MoveProbability {
  /** Training estimate. Published only for cells that pass the holdout criterion. */
  hitBeforeStop: number;
  trainHitRate: number;
  /** Day-clustered bootstrap interval, training split. */
  trainHitInterval: [number, number];
  sampleSize: number;
  days: number;
  holdoutHitRate: number | null;
  holdoutHitInterval: [number, number] | null;
  holdoutSampleSize: number;
  /** Holdout hit rate minus training hit rate. */
  calibrationGap: number | null;
  criterionId: string;
}

export interface TradeExpectancy {
  /** Mean net return after fees, slippage and funding, percent of entry. Training split. */
  netReturnPct: number;
  netReturnCiLowPct: number;
  holdoutNetReturnPct: number | null;
  /** Funding models behind these labels. Mixing a fallback with settlements must be visible. */
  fundingModels: string[];
}

export interface TargetCandidate {
  key: string;
  targetPct: number;
  horizonHours: number;
  moveProbability: MoveProbability;
  tradeExpectancy: TradeExpectancy;
}

export interface MoveCapacity {
  /** Distance to the nearest live opposing zone, percent of entry. Null when none is known. */
  availableRoomPct: number | null;
  /** Capacity used for gating: validated model when supplied, otherwise the opposing-zone room. */
  capacityPct: number | null;
  source: 'OPPOSING_ZONE' | 'VALIDATED_MODEL' | 'UNVERIFIED';
  reachableTargetsPct: number[];
}

export interface DirectionalPotential {
  symbol: string;
  direction: DirectionalDecision;
  context: ExpansionContext;
  contextPath: ExpansionContext[];
  entry?: number;
  stopLoss?: number;
  invalidationReason?: string;
  capacity: MoveCapacity;
  candidates: TargetCandidate[];
  /** Largest reachable calibrated target. */
  expectedMovePct?: number;
  evidence: string[];
  warnings: string[];
}

export interface PotentialInput {
  symbol: string;
  side: Side;
  entry: number;
  stopPrice: number;
  context: ExpansionContext;
  /** Recent context states, oldest first. Shown as evidence. */
  contextPath: ExpansionContext[];
  room: RoomResult;
  table: TargetTable;
  /** Widest acceptable stop, percent of entry. Required: it is a risk parameter, not a default. */
  maxStopPct: number;
  /**
   * Capacity from a validated range or volatility model, in percent of entry. Null or absent means none. Callers must
   * not supply a value without a validation record. This module does not produce one.
   */
  validatedCapacityPct?: number | null;
}

export function assessDirectionalPotential(input: PotentialInput): DirectionalPotential {
  const { symbol, side, entry, stopPrice, context, contextPath, room, table } = input;
  if (!(Number.isFinite(input.maxStopPct) && input.maxStopPct > 0)) throw new Error('maxStopPct must be positive');

  const validated = input.validatedCapacityPct ?? null;
  const capacityPct = validated ?? room.roomPct;
  const capacitySource: MoveCapacity['source'] = validated !== null ? 'VALIDATED_MODEL' : room.roomPct !== null ? 'OPPOSING_ZONE' : 'UNVERIFIED';
  const evidence: string[] = [];
  const warnings: string[] = [];
  const capacity = (reachable: number[]): MoveCapacity => ({
    availableRoomPct: room.roomPct,
    capacityPct,
    source: capacitySource,
    reachableTargetsPct: reachable,
  });
  const noTrade = (reason: string, reachable: number[] = []): DirectionalPotential => ({
    symbol,
    direction: 'NO_TRADE',
    context,
    contextPath,
    invalidationReason: reason,
    capacity: capacity(reachable),
    candidates: [],
    evidence,
    warnings,
  });

  const sign = side === 'LONG' ? 1 : -1;
  const stopPct = (sign * (entry - stopPrice) / entry) * 100;
  if (!(stopPct > 0)) return noTrade('STOP_NOT_BEYOND_ENTRY');
  if (stopPct > input.maxStopPct) return noTrade(`STOP_TOO_WIDE ${stopPct.toFixed(3)}% > ${input.maxStopPct}%`);
  evidence.push(`stop ${stopPct.toFixed(3)}% from entry`);

  if (!ENTRY_CONTEXTS.includes(context)) return noTrade(`CONTEXT_NOT_ENTRY ${context}`);
  evidence.push(`context ${context} (path: ${contextPath.join(' → ') || 'none'})`);

  const admitted = table.cells.filter((c) => c.admitted && c.symbol === symbol && c.side === side && c.tag === context);
  if (admitted.length === 0) return noTrade('NO_ADMITTED_PROBABILITY_FOR_CONTEXT');

  const calibrated = admitted.filter((c) => c.holdoutAccepted);
  for (const c of admitted) {
    if (!c.holdoutAccepted) warnings.push(`HOLDOUT_REJECTED ${c.key}: ${c.holdoutReasons.join('; ')}`);
  }
  if (calibrated.length === 0) return noTrade('HOLDOUT_CALIBRATION_FAILED');

  if (capacityPct === null) {
    return noTrade('ROOM_UNVERIFIED: no opposing zone and no validated capacity model');
  }
  evidence.push(`capacity ${capacityPct.toFixed(3)}% (${capacitySource})`);

  const reachable = calibrated.filter((c) => c.targetPct <= capacityPct);
  for (const c of calibrated) {
    if (c.targetPct > capacityPct) warnings.push(`CAPACITY_BELOW_TARGET ${c.targetPct}% > ${capacityPct.toFixed(3)}%`);
  }
  if (reachable.length === 0) return noTrade('CAPACITY_BELOW_ALL_CALIBRATED_TARGETS', []);

  reachable.sort((a, b) => a.targetPct - b.targetPct || a.horizonHours - b.horizonHours);
  const candidates: TargetCandidate[] = reachable.flatMap((c) => toCandidate(c, table.criterionId));
  for (const cand of candidates) {
    const mp = cand.moveProbability;
    evidence.push(`${cand.targetPct}% in ${cand.horizonHours}h: p=${mp.hitBeforeStop.toFixed(3)} `
      + `train CI[${mp.trainHitInterval[0].toFixed(3)}, ${mp.trainHitInterval[1].toFixed(3)}] n=${mp.sampleSize}; `
      + `holdout p=${mp.holdoutHitRate?.toFixed(3) ?? 'n/a'} gap=${mp.calibrationGap?.toFixed(3) ?? 'n/a'}`);
  }

  return {
    symbol,
    direction: side,
    context,
    contextPath,
    entry,
    stopLoss: stopPrice,
    capacity: capacity(reachable.map((c) => c.targetPct)),
    candidates,
    expectedMovePct: Math.max(...reachable.map((c) => c.targetPct)),
    evidence,
    warnings,
  };
}

function toCandidate(c: CellReport, criterionId: string): TargetCandidate[] {
  const h = c.holdout;
  if (!h) return [];
  const t = c.train;
  const trainInterval = t.hitInterval ?? { low: 0, high: 1 };
  const holdoutInterval = h.hitInterval;
  return [{
    key: c.key,
    targetPct: c.targetPct,
    horizonHours: c.horizonHours,
    moveProbability: {
      hitBeforeStop: t.hitRate ?? 0,
      trainHitRate: t.hitRate ?? 0,
      trainHitInterval: [trainInterval.low, trainInterval.high],
      sampleSize: t.n,
      days: t.days,
      holdoutHitRate: h.hitRate,
      holdoutHitInterval: holdoutInterval ? [holdoutInterval.low, holdoutInterval.high] : null,
      holdoutSampleSize: h.n,
      calibrationGap: h.hitRate !== null && t.hitRate !== null ? h.hitRate - t.hitRate : null,
      criterionId,
    },
    tradeExpectancy: {
      netReturnPct: t.netMeanPct ?? 0,
      netReturnCiLowPct: t.netSummary?.ciLow ?? Number.NEGATIVE_INFINITY,
      holdoutNetReturnPct: h.netMeanPct,
      fundingModels: t.fundingModels,
    },
  }];
}
