import type { Side } from '../../types.js';
import type { RejectionZone } from '../rejection/types.js';

/**
 * Room to the nearest meaningful opposing zone, in percent of entry. A LONG looks up at SUPPLY zones and a SHORT looks
 * down at DEMAND zones. Only live zones count (not BROKEN or EXPIRED). The caller supplies zones from the timeframe
 * that defines "meaningful", and `minZoneScore` drops weak zones.
 */

export interface RoomResult {
  /** Percent of entry to the nearest opposing zone. 0 when entry is inside one. Null when no opposing zone exists. */
  roomPct: number | null;
  blocking: RejectionZone | null;
  reason: 'OPPOSING_ZONE_AHEAD' | 'INSIDE_OPPOSING_ZONE' | 'NO_OPPOSING_ZONE';
}

export function availableRoom(
  side: Side,
  entry: number,
  zones: readonly RejectionZone[],
  minZoneScore = 0,
): RoomResult {
  if (!(Number.isFinite(entry) && entry > 0)) throw new Error(`entry must be a positive price, got ${entry}`);
  const opposing = side === 'LONG' ? 'SUPPLY' : 'DEMAND';
  const live = zones.filter((z) =>
    z.direction === opposing && z.status !== 'BROKEN' && z.status !== 'EXPIRED' && z.strength.score >= minZoneScore);

  const inside = live.find((z) => entry >= z.lowerBound && entry <= z.upperBound);
  if (inside) return { roomPct: 0, blocking: inside, reason: 'INSIDE_OPPOSING_ZONE' };

  if (side === 'LONG') {
    const ahead = live.filter((z) => z.lowerBound > entry).sort((a, b) => a.lowerBound - b.lowerBound || a.id.localeCompare(b.id));
    const nearest = ahead[0];
    if (!nearest) return { roomPct: null, blocking: null, reason: 'NO_OPPOSING_ZONE' };
    return { roomPct: ((nearest.lowerBound - entry) / entry) * 100, blocking: nearest, reason: 'OPPOSING_ZONE_AHEAD' };
  }

  const ahead = live.filter((z) => z.upperBound < entry).sort((a, b) => b.upperBound - a.upperBound || a.id.localeCompare(b.id));
  const nearest = ahead[0];
  if (!nearest) return { roomPct: null, blocking: null, reason: 'NO_OPPOSING_ZONE' };
  return { roomPct: ((entry - nearest.upperBound) / entry) * 100, blocking: nearest, reason: 'OPPOSING_ZONE_AHEAD' };
}
