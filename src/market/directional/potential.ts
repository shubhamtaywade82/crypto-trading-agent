import type { Side } from '../../types.js';
import { ENTRY_CONTEXTS, type ExpansionContext } from './context.js';
import type { CellReport, TargetTable } from './probability.js';
import type { RoomResult } from './room.js';

/**
 * Directional potential: the decision is NO_TRADE unless every gate passes. A probability is reported only when it
 * comes from an admitted cell whose holdout confirms it. Nothing is derived from a zone score.
 *
 * Gates, in order:
 * 1. The stop is beyond entry and no wider than `maxStopPct`.
 * 2. The expansion context is an entry context.
 * 3. An admitted cell exists for this symbol, side and context.
 * 4. The holdout confirms the cell: at least `minHoldoutSample` resolved outcomes and a positive mean net return.
 * 5. Known room covers the target. With no opposing zone known, the target is allowed and a warning is recorded.
 */

export type DirectionalDecision = 'LONG' | 'SHORT' | 'NO_TRADE';

export interface TargetProbability {
  targetPct: number;
  horizonHours: number;
  /** Target reached before the stop within the horizon. Timeouts count as misses. */
  hitBeforeStopProbability: number;
  /** Wilson interval at the table's confidence level. */
  confidenceInterval: [number, number];
  sampleSize: number;
  days: number;
  /** Mean net return (after costs) of the cell's training labels, percent of entry. */
  expectedNetReturnPct: number;
  /** Lower bound of the bootstrap interval on that mean. Admission requires it to be positive. */
  expectedNetReturnCiLowPct: number;
  holdout: { n: number; hitRate: number | null; netMeanPct: number | null };
}

export interface DirectionalPotential {
  symbol: string;
  direction: DirectionalDecision;
  context: ExpansionContext;
  contextPath: ExpansionContext[];
  probabilities: TargetProbability[];
  entry?: number;
  stopLoss?: number;
  invalidationReason?: string;
  availableRoomPct: number | null;
  /** Largest reachable target among the reported probabilities. */
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
  /** Resolved holdout outcomes required before the holdout can confirm a cell. */
  minHoldoutSample: number;
}

export function assessDirectionalPotential(input: PotentialInput): DirectionalPotential {
  const { symbol, side, entry, stopPrice, context, contextPath, room, table } = input;
  if (!(Number.isFinite(input.maxStopPct) && input.maxStopPct > 0)) throw new Error('maxStopPct must be positive');
  const evidence: string[] = [];
  const warnings: string[] = [];
  const base = { symbol, context, contextPath, availableRoomPct: room.roomPct, evidence, warnings };
  const noTrade = (reason: string): DirectionalPotential => ({
    ...base,
    direction: 'NO_TRADE',
    probabilities: [],
    invalidationReason: reason,
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

  const confirmed = admitted.filter((c) => c.holdout !== null
    && c.holdout.n >= input.minHoldoutSample
    && c.holdout.netMeanPct !== null
    && c.holdout.netMeanPct > 0);
  for (const c of admitted) {
    if (!confirmed.includes(c)) warnings.push(`HOLDOUT_NOT_CONFIRMED ${c.key}`);
  }
  if (confirmed.length === 0) return noTrade('HOLDOUT_DID_NOT_CONFIRM');

  const reachable: CellReport[] = [];
  for (const c of confirmed) {
    if (room.roomPct === null) {
      reachable.push(c);
      warnings.push('NO_OPPOSING_ZONE_KNOWN: room is not bounded by known structure');
    } else if (room.roomPct >= c.targetPct) {
      reachable.push(c);
    } else {
      warnings.push(`ROOM_BELOW_TARGET ${c.targetPct}% > ${room.roomPct.toFixed(3)}%`);
    }
  }
  if (reachable.length === 0) return noTrade('ROOM_BELOW_ALL_ADMITTED_TARGETS');

  reachable.sort((a, b) => a.targetPct - b.targetPct || a.horizonHours - b.horizonHours);
  const probabilities: TargetProbability[] = reachable.map((c) => {
    const train = c.train;
    const interval = train.hitInterval;
    return {
      targetPct: c.targetPct,
      horizonHours: c.horizonHours,
      hitBeforeStopProbability: train.hitRate ?? 0,
      confidenceInterval: [interval?.low ?? 0, interval?.high ?? 1],
      sampleSize: train.n,
      days: train.days,
      expectedNetReturnPct: train.netMeanPct ?? 0,
      expectedNetReturnCiLowPct: train.netSummary?.ciLow ?? Number.NEGATIVE_INFINITY,
      holdout: {
        n: c.holdout?.n ?? 0,
        hitRate: c.holdout?.hitRate ?? null,
        netMeanPct: c.holdout?.netMeanPct ?? null,
      },
    };
  });

  for (const p of probabilities) {
    evidence.push(`${p.targetPct}% in ${p.horizonHours}h: p=${p.hitBeforeStopProbability.toFixed(3)} `
      + `CI[${p.confidenceInterval[0].toFixed(3)}, ${p.confidenceInterval[1].toFixed(3)}] n=${p.sampleSize} days=${p.days}`);
  }

  return {
    ...base,
    direction: side,
    entry,
    stopLoss: stopPrice,
    probabilities,
    expectedMovePct: Math.max(...reachable.map((c) => c.targetPct)),
  };
}
