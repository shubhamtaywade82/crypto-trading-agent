import { barKnownAt, REJECTION_TIMEFRAMES, type FlowBar, type RejectionEvent, type RejectionTimeframe, type RejectionZone, type ZoneConfluence, type ZoneStrength, type ZoneDirection } from './types.js';

export interface ZoneOptions {
  /** Two rejections merge when the gap between their intervals is at most this many ATR. */
  clusterAtrFraction: number;
  /** A merge is refused when the merged interval would exceed this many ATR. Keeps zones from sprawling. */
  maxZoneWidthAtr: number;
  /** Test count at which a zone becomes WEAKENING. */
  weakeningTests: number;
  /** Bars after creation at which a zone that has not been invalidated expires. */
  maxAgeBars: number;
  /** Used to normalise reversal speed. Matches the detector's confirmBars. */
  confirmBars: number;
}

/** Age budgets per timeframe, in bars of that timeframe (1m: 12h, 5m: 24h, 15m: 2d, 1h: 7d, 4h: 20d). */
export const DEFAULT_MAX_AGE_BARS: Record<RejectionTimeframe, number> = {
  '1m': 720,
  '5m': 288,
  '15m': 192,
  '1h': 168,
  '4h': 120,
};

export const DEFAULT_CLUSTER_ATR_FRACTION = 0.5;
export const DEFAULT_MAX_ZONE_WIDTH_ATR = 3;
export const DEFAULT_WEAKENING_TESTS = 2;

/** Initial component weights (sum of positives = 1). Hypotheses, not validated. */
export const STRENGTH_WEIGHTS = {
  reversal: 0.25,
  volume: 0.2,
  delta: 0.15,
  speed: 0.15,
  confluence: 0.25,
  weakness: 0.5,
} as const;

export function assertZoneOptions(opts: ZoneOptions): void {
  if (!(Number.isFinite(opts.clusterAtrFraction) && opts.clusterAtrFraction >= 0)) {
    throw new Error(`ZoneOptions.clusterAtrFraction must be >= 0, got ${opts.clusterAtrFraction}`);
  }
  if (!(Number.isFinite(opts.maxZoneWidthAtr) && opts.maxZoneWidthAtr > 0)) {
    throw new Error(`ZoneOptions.maxZoneWidthAtr must be > 0, got ${opts.maxZoneWidthAtr}`);
  }
  for (const key of ['weakeningTests', 'maxAgeBars', 'confirmBars'] as const) {
    const v = opts[key];
    if (!Number.isInteger(v) || v < 1) throw new Error(`ZoneOptions.${key} must be an integer >= 1, got ${v}`);
  }
}

interface Tracker {
  zone: RejectionZone;
  /** Whether the previous bar's range touched the zone. A test is counted on each entry, not on each bar inside. */
  inside: boolean;
}

/**
 * Builds rejection zones from CONFIRMED events and advances each zone's lifecycle over the bars.
 *
 * Ordering within bar j: every existing zone first advances on bar j, then events confirmed by bar j are integrated.
 * A rejection can therefore never test itself, and a zone created on bar j is first tested by bar j+1.
 *
 * Lifecycle (all stamps are known-at times):
 * - ACTIVE       created from a confirmed rejection.
 * - TESTED       first entry into the zone after creation.
 * - WEAKENING    entry count reached `weakeningTests`.
 * - BROKEN       a close beyond the far boundary (below DEMAND, above SUPPLY). Invalidation.
 * - RECLAIMED    a close back on the original side after BROKEN.
 * - EXPIRED      `maxAgeBars` after creation. Terminal.
 *
 * Invalidation takes precedence over tests on the same bar, and a BROKEN zone does not accumulate tests.
 * Confirmed events that overlap or sit within `clusterAtrFraction` ATR of a live zone of the same direction merge into
 * it, up to `maxZoneWidthAtr`. A BROKEN or EXPIRED zone never absorbs new evidence.
 */
export function buildRejectionZones(
  bars: readonly FlowBar[],
  events: readonly RejectionEvent[],
  opts: ZoneOptions,
): RejectionZone[] {
  assertZoneOptions(opts);
  const confirmed = events.filter((e) => e.status === 'CONFIRMED' && e.resolvedAt !== null);
  const byKnownAt = new Map<number, RejectionEvent[]>();
  for (const ev of confirmed) {
    const at = ev.resolvedAt ?? 0;
    const bucket = byKnownAt.get(at);
    if (bucket) bucket.push(ev);
    else byKnownAt.set(at, [ev]);
  }
  for (const bucket of byKnownAt.values()) bucket.sort(compareEventIds);

  const trackers: Tracker[] = [];
  for (let j = 0; j < bars.length; j++) {
    const bar = bars[j];
    if (!bar || !bar.complete) continue;
    const known = barKnownAt(bar);
    for (const t of trackers) advance(t, bar, j, known, opts);
    for (const ev of byKnownAt.get(known) ?? []) integrate(trackers, ev, j, known, opts);
  }

  return trackers.map((t) => {
    t.zone.strength = scoreZone(t.zone, opts.confirmBars);
    return t.zone;
  });
}

function advance(t: Tracker, bar: FlowBar, j: number, known: number, opts: ZoneOptions): void {
  const z = t.zone;
  if (z.status === 'EXPIRED') return;

  if (j - z.createdIndex >= opts.maxAgeBars) {
    setStatus(z, 'EXPIRED', known, 'AGE_BUDGET');
    z.expiredAt = known;
    t.inside = false;
    return;
  }

  const demand = z.direction === 'DEMAND';
  const throughFarBoundary = demand ? bar.close < z.lowerBound : bar.close > z.upperBound;
  if (throughFarBoundary) {
    if (z.status !== 'BROKEN') {
      setStatus(z, 'BROKEN', known, 'CLOSE_THROUGH_INVALIDATION');
      z.brokenAt = known;
    }
    t.inside = false;
    return;
  }

  // Not through the far boundary means the close is on the original side. After a break, that is a reclaim.
  if (z.status === 'BROKEN') {
    setStatus(z, 'RECLAIMED', known, 'CLOSE_BACK_ON_ORIGINAL_SIDE');
    z.reclaimedAt = known;
  }

  const overlap = bar.low <= z.upperBound && bar.high >= z.lowerBound;
  if (overlap && !t.inside) {
    z.testCount += 1;
    z.lastTestedAt = known;
    if (z.testCount >= opts.weakeningTests) {
      if (z.status !== 'WEAKENING') setStatus(z, 'WEAKENING', known, 'REPEATED_TESTS');
    } else if (z.status === 'ACTIVE' || z.status === 'RECLAIMED') {
      setStatus(z, 'TESTED', known, 'FIRST_TEST');
    }
  }
  t.inside = overlap;
}

function integrate(trackers: Tracker[], ev: RejectionEvent, j: number, known: number, opts: ZoneOptions): void {
  let target: Tracker | null = null;
  let bestGap = Number.POSITIVE_INFINITY;

  for (const t of trackers) {
    const z = t.zone;
    if (z.direction !== ev.direction) continue;
    if (z.status === 'BROKEN' || z.status === 'EXPIRED') continue;
    const gap = Math.max(0, Math.max(z.lowerBound, ev.zoneLow) - Math.min(z.upperBound, ev.zoneHigh));
    if (gap > opts.clusterAtrFraction * ev.atr) continue;
    const width = Math.max(z.upperBound, ev.zoneHigh) - Math.min(z.lowerBound, ev.zoneLow);
    if (width > opts.maxZoneWidthAtr * ev.atr) continue;
    if (gap < bestGap) {
      target = t;
      bestGap = gap;
    }
  }

  if (target) {
    const z = target.zone;
    z.lowerBound = Math.min(z.lowerBound, ev.zoneLow);
    z.upperBound = Math.max(z.upperBound, ev.zoneHigh);
    z.rejectionCount += 1;
    z.lastRejectionAt = known;
    z.events.push(ev);
    return;
  }

  trackers.push({
    inside: false,
    zone: {
      id: `zone|${ev.id}`,
      symbol: ev.symbol,
      timeframe: ev.timeframe,
      direction: ev.direction,
      lowerBound: ev.zoneLow,
      upperBound: ev.zoneHigh,
      status: 'ACTIVE',
      createdAt: known,
      createdIndex: j,
      lastRejectionAt: known,
      rejectionCount: 1,
      testCount: 0,
      lastTestedAt: null,
      brokenAt: null,
      reclaimedAt: null,
      expiredAt: null,
      transitions: [{ status: 'ACTIVE', at: known, reason: 'CONFIRMED_REJECTION' }],
      events: [ev],
      strength: { score: 0, components: { reversal: 0, volume: 0, delta: 0, speed: 0, confluence: 0, weakness: 0 } },
    },
  });
}

function setStatus(z: RejectionZone, status: RejectionZone['status'], at: number, reason: string): void {
  z.status = status;
  z.transitions.push({ status, at, reason });
}

/** Strength is computed from the zone's own evidence and final state. Each component is kept next to the score. */
export function scoreZone(z: RejectionZone, confirmBars: number): ZoneStrength {
  const evs = z.events;
  const n = Math.max(1, evs.length);
  const mean = (f: (e: RejectionEvent) => number): number => evs.reduce((acc, e) => acc + f(e), 0) / n;

  const components = {
    reversal: clamp01(mean((e) => e.reversalAtr ?? 0) / 2),
    volume: clamp01(mean((e) => e.relativeVolume) / 3),
    delta: clamp01(mean((e) => Math.abs(e.deltaRatio))),
    speed: clamp01(mean((e) => 1 - ((e.reversalBars ?? confirmBars) - 1) / confirmBars)),
    confluence: clamp01((z.rejectionCount - 1) / 3),
    weakness: z.status === 'BROKEN' ? 1 : clamp01(Math.max(0, z.testCount - 1) / 3),
  };

  const w = STRENGTH_WEIGHTS;
  const raw = w.reversal * components.reversal
    + w.volume * components.volume
    + w.delta * components.delta
    + w.speed * components.speed
    + w.confluence * components.confluence
    - w.weakness * components.weakness;

  return { score: Math.round(clamp01(raw) * 1000) / 10, components };
}

/**
 * Bands where live zones from two or more timeframes overlap. Overlap is chained, so a run of intersecting zones forms
 * one band. The result reports which timeframes agree. It does not add them up into a score, because they are built
 * from the same price data.
 */
export function findZoneConfluence(zones: readonly RejectionZone[]): ZoneConfluence[] {
  const live = zones.filter((z) => z.status !== 'BROKEN' && z.status !== 'EXPIRED');
  const out: ZoneConfluence[] = [];

  const flush = (direction: ZoneDirection, group: readonly RejectionZone[]): void => {
    if (group.length === 0) return;
    const present = new Set(group.map((z) => z.timeframe));
    if (present.size < 2) return;
    out.push({
      direction,
      lowerBound: Math.min(...group.map((z) => z.lowerBound)),
      upperBound: Math.max(...group.map((z) => z.upperBound)),
      timeframes: REJECTION_TIMEFRAMES.filter((tf) => present.has(tf)),
      zoneIds: group.map((z) => z.id).sort(),
    });
  };

  for (const direction of ['DEMAND', 'SUPPLY'] as const) {
    const sorted = live.filter((z) => z.direction === direction).sort((a, b) => a.lowerBound - b.lowerBound || compareIds(a.id, b.id));
    let group: RejectionZone[] = [];
    let hi = Number.NEGATIVE_INFINITY;
    for (const z of sorted) {
      if (group.length > 0 && z.lowerBound <= hi) {
        group.push(z);
        hi = Math.max(hi, z.upperBound);
      } else {
        flush(direction, group);
        group = [z];
        hi = z.upperBound;
      }
    }
    flush(direction, group);
  }

  return out;
}

export interface NearbyZone {
  zone: RejectionZone;
  /** 0 when the price is inside the zone, otherwise the distance to the nearer boundary in price units. */
  distance: number;
}

/** Live zones (not BROKEN or EXPIRED) ordered by distance from `price`. */
export function nearestZones(zones: readonly RejectionZone[], price: number, limit: number): NearbyZone[] {
  return zones
    .filter((z) => z.status !== 'BROKEN' && z.status !== 'EXPIRED')
    .map((zone) => {
      const inside = price >= zone.lowerBound && price <= zone.upperBound;
      const distance = inside ? 0 : Math.min(Math.abs(price - zone.lowerBound), Math.abs(price - zone.upperBound));
      return { zone, distance };
    })
    .sort((a, b) => a.distance - b.distance || compareIds(a.zone.id, b.zone.id))
    .slice(0, Math.max(0, limit));
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEventIds(a: RejectionEvent, b: RejectionEvent): number {
  return compareIds(a.id, b.id);
}
