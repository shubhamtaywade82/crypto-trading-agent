import { utcDay } from '../src/research/Bootstrap.js';
import type { BarrierLabel } from '../src/market/directional/barriers.js';
import type { RejectionTimeframe, RejectionZone, ZoneDirection } from '../src/market/rejection/types.js';
import type { Side } from '../src/types.js';
import { SYMBOL } from './rejectionFixtures.js';

export const DAY_MS = 86_400_000;

export interface SynthOptions {
  days: number;
  perDay: number;
  /** Share of labels that hit the target. The pattern spreads wins evenly, so the share is exact. */
  winRate: number;
  symbol?: string;
  side?: Side;
  tags?: readonly string[];
  targetPct?: number;
  horizonHours?: number;
  /** First day index, so two blocks of labels can be placed in time order. */
  startDay?: number;
  /** Stop distance used for the loss return. Defaults to 2%. */
  stopPct?: number;
  /** Round-trip cost subtracted from every return. Defaults to 0.12%. */
  roundTripCostPct?: number;
}

/**
 * Deterministic labels: `days × perDay` setups, a `winRate` share of them TARGET and the rest STOP. Net returns are
 * target − cost on a win and −stop − cost on a loss.
 */
export function synthLabels(o: SynthOptions): BarrierLabel[] {
  const targetPct = o.targetPct ?? 1;
  const stopPct = o.stopPct ?? 2;
  const cost = o.roundTripCostPct ?? 0.12;
  const horizonHours = o.horizonHours ?? 1;
  const startDay = o.startDay ?? 0;
  const out: BarrierLabel[] = [];
  let idx = 0;
  for (let d = 0; d < o.days; d++) {
    for (let i = 0; i < o.perDay; i++) {
      const win = Math.floor((idx + 1) * o.winRate) > Math.floor(idx * o.winRate);
      const entryTime = (startDay + d) * DAY_MS + i * 60_000;
      out.push({
        setupId: `s${idx}`,
        symbol: o.symbol ?? SYMBOL,
        side: o.side ?? 'LONG',
        tags: o.tags ?? [],
        entryTime,
        horizonEndsAt: entryTime + horizonHours * 3_600_000,
        day: utcDay(entryTime),
        entryPrice: 100,
        stopPct,
        targetPct,
        horizonHours,
        outcome: win ? 'TARGET' : 'STOP',
        unresolvedReason: null,
        barsToOutcome: 1,
        mfePct: win ? targetPct : 0.5,
        maePct: win ? 0.5 : stopPct,
        grossReturnPct: win ? targetPct : -stopPct,
        feeSlippagePct: cost,
        fundingPct: 0,
        fundingModel: 'CONSTANT_FALLBACK',
        netReturnPct: win ? targetPct - cost : -stopPct - cost,
      });
      idx += 1;
    }
  }
  return out;
}

/** A zone literal for tests that query zones rather than build them. */
export function zone(
  id: string,
  timeframe: RejectionTimeframe,
  direction: ZoneDirection,
  lowerBound: number,
  upperBound: number,
  status: RejectionZone['status'],
  score = 60,
): RejectionZone {
  return {
    id,
    symbol: SYMBOL,
    timeframe,
    direction,
    lowerBound,
    upperBound,
    status,
    createdAt: 0,
    createdIndex: 0,
    lastRejectionAt: 0,
    rejectionCount: 1,
    testCount: 0,
    lastTestedAt: null,
    brokenAt: null,
    reclaimedAt: null,
    expiredAt: null,
    transitions: [],
    events: [],
    strength: { score, components: { reversal: 0, volume: 0, delta: 0, speed: 0, confluence: 0, weakness: 0 } },
  };
}
