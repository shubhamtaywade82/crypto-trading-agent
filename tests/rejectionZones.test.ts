import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectRejections } from '../src/market/rejection/detector.js';
import {
  buildRejectionZones, findZoneConfluence, nearestZones, scoreZone, type ZoneOptions,
} from '../src/market/rejection/zones.js';
import {
  barKnownAt,
  type RejectionEvent, type RejectionTimeframe, type RejectionZone, type RejectionZoneStatus, type ZoneDirection,
} from '../src/market/rejection/types.js';
import {
  FLAT, SMALL_CONFIG, SYMBOL, flowSeries, knownAt, makeEvent, randomWalk, type Px,
} from './rejectionFixtures.js';

const OPTS: ZoneOptions = { clusterAtrFraction: 0.5, maxZoneWidthAtr: 3, weakeningTests: 2, maxAgeBars: 288, confirmBars: 3 };
const px = (o: number, h: number, l: number, c: number): Px => ({ o, h, l, c });

/**
 * Bars 0-2 are flat; the rejection confirms on bar 2 (zone 97..99, ATR 2). Then: bar 3 enters the zone (first test),
 * bar 4 leaves, bar 5 enters again (second test), bar 6 closes through 97 (break), bar 7 closes back at 98 (reclaim)
 * and enters again (third test).
 */
const LIFECYCLE: Px[] = [
  FLAT, FLAT, FLAT,
  px(100, 100, 98.5, 99.2),
  px(99.5, 100.5, 99.5, 100.2),
  px(99.5, 99.5, 98, 98.8),
  px(98.8, 98.8, 96, 96.5),
  px(96.5, 98.5, 97.5, 98),
];

const demandAt = (id: string, bars: ReturnType<typeof flowSeries>, i: number, lo: number, hi: number, atr = 2) =>
  makeEvent({ id, direction: 'DEMAND', zoneLow: lo, zoneHigh: hi, resolvedAt: knownAt(bars, i), atr });

test('a zone moves ACTIVE → TESTED → WEAKENING → BROKEN → RECLAIMED → WEAKENING, each stamped with its known-at time', () => {
  const bars = flowSeries('5m', LIFECYCLE);
  const [z] = buildRejectionZones(bars, [demandAt('e1', bars, 2, 97, 99)], OPTS);
  assert.ok(z);
  assert.deepEqual(z.transitions.map((t) => t.status), ['ACTIVE', 'TESTED', 'WEAKENING', 'BROKEN', 'RECLAIMED', 'WEAKENING']);
  assert.equal(z.createdIndex, 2);
  assert.equal(z.createdAt, knownAt(bars, 2));
  assert.equal(z.testCount, 3);
  assert.equal(z.lastTestedAt, knownAt(bars, 7));
  assert.equal(z.brokenAt, knownAt(bars, 6));
  assert.equal(z.reclaimedAt, knownAt(bars, 7));
  assert.equal(z.status, 'WEAKENING');
});

test('the rejection bar cannot test its own zone: the first test is the next bar that enters', () => {
  const bars = flowSeries('5m', LIFECYCLE);
  const [z] = buildRejectionZones(bars, [demandAt('e1', bars, 2, 97, 99)], OPTS);
  // Bar 2 itself overlaps 97..99, but the zone is created after bar 2's lifecycle step.
  assert.equal(z?.transitions[1]?.at, knownAt(bars, 3));
  assert.equal(z?.transitions[1]?.status, 'TESTED');
});

test('an untouched zone expires maxAgeBars after creation, and expiry is terminal', () => {
  const far = px(105, 106, 105, 105.5);
  const bars = flowSeries('5m', [FLAT, FLAT, FLAT, far, far, far, far]);
  const [z] = buildRejectionZones(bars, [demandAt('e1', bars, 2, 97, 99)], { ...OPTS, maxAgeBars: 3 });
  assert.ok(z);
  assert.equal(z.status, 'EXPIRED');
  assert.equal(z.expiredAt, knownAt(bars, 5));
  assert.equal(z.testCount, 0);
  assert.equal(z.transitions.at(-1)?.reason, 'AGE_BUDGET');
});

test('a second rejection within clusterAtrFraction × ATR merges into the zone and widens the band', () => {
  const bars = flowSeries('5m', [FLAT, FLAT, FLAT, FLAT, FLAT, FLAT]);
  const zones = buildRejectionZones(bars, [demandAt('e1', bars, 2, 97, 99), demandAt('e2', bars, 4, 98, 99.5)], OPTS);
  assert.equal(zones.length, 1);
  const z = zones[0]!;
  assert.equal(z.lowerBound, 97);
  assert.equal(z.upperBound, 99.5);
  assert.equal(z.rejectionCount, 2);
  assert.deepEqual(z.events.map((e) => e.id), ['e1', 'e2']);
  assert.equal(z.lastRejectionAt, knownAt(bars, 4));
});

test('a rejection farther than clusterAtrFraction × ATR from every live zone starts a separate zone', () => {
  const bars = flowSeries('5m', [FLAT, FLAT, FLAT, FLAT, FLAT, FLAT]);
  const zones = buildRejectionZones(bars, [demandAt('e1', bars, 2, 97, 99), demandAt('e2', bars, 4, 90, 92)], OPTS);
  assert.equal(zones.length, 2);
  assert.notEqual(zones[0]!.id, zones[1]!.id);
});

test('a merge that would widen the band beyond maxZoneWidthAtr is refused and starts a new zone', () => {
  const bars = flowSeries('5m', [FLAT, FLAT, FLAT, FLAT, FLAT, FLAT]);
  const zones = buildRejectionZones(bars, [demandAt('e1', bars, 2, 97, 99), demandAt('e2', bars, 4, 80, 99)], OPTS);
  assert.equal(zones.length, 2, 'overlap alone is not enough: 19 points exceeds 3 × ATR 2');
});

test('a broken zone never absorbs new evidence, so a rejection on the same level starts a fresh zone', () => {
  const bars = flowSeries('5m', [
    FLAT, FLAT, FLAT,
    px(98.8, 98.8, 96, 96.5),
    px(96.5, 97.5, 96, 96.8),
  ]);
  const zones = buildRejectionZones(bars, [demandAt('e1', bars, 2, 97, 99), makeEvent({
    id: 'e2', direction: 'DEMAND', zoneLow: 97.2, zoneHigh: 98.4, resolvedAt: knownAt(bars, 4), atr: 2,
  })], OPTS);
  assert.equal(zones.length, 2);
  assert.equal(zones[0]!.status, 'BROKEN');
  assert.equal(zones[1]!.status, 'ACTIVE');
});

test('only CONFIRMED events create zones; CANDIDATE and FAILED evidence is kept by the detector, never zoned', () => {
  const bars = flowSeries('5m', LIFECYCLE);
  const zones = buildRejectionZones(bars, [
    makeEvent({ id: 'f', direction: 'DEMAND', zoneLow: 97, zoneHigh: 99, resolvedAt: knownAt(bars, 2), atr: 2, status: 'FAILED' }),
    makeEvent({ id: 'c', direction: 'DEMAND', zoneLow: 97, zoneHigh: 99, resolvedAt: null, atr: 2, status: 'CANDIDATE' }),
  ], OPTS);
  assert.deepEqual(zones, []);
});

test('strength keeps each component and combines them with the design weights', () => {
  const ev = makeEvent({ id: 'e', direction: 'DEMAND', zoneLow: 97, zoneHigh: 99, resolvedAt: 1, atr: 2, reversalAtr: 1, reversalBars: 1, relativeVolume: 3, deltaRatio: -0.4 });
  const zone = lit('z', '5m', 'DEMAND', 97, 99, 'ACTIVE', [ev]);
  const s = scoreZone(zone, 3);
  // reversal 1/2, volume 3/3, delta 0.4, speed 1, confluence 0, weakness 0
  assert.deepEqual(s.components, { reversal: 0.5, volume: 1, delta: 0.4, speed: 1, confluence: 0, weakness: 0 });
  assert.equal(s.score, 53.5);
});

test('speed falls with the bar at which the displacement arrived, and a broken zone scores far lower', () => {
  const late = makeEvent({ id: 'e', direction: 'DEMAND', zoneLow: 97, zoneHigh: 99, resolvedAt: 1, atr: 2, reversalBars: 3 });
  assert.ok(Math.abs(scoreZone(lit('z', '5m', 'DEMAND', 97, 99, 'ACTIVE', [late]), 3).components.speed - 1 / 3) < 1e-12);

  const ev = makeEvent({ id: 'e', direction: 'DEMAND', zoneLow: 97, zoneHigh: 99, resolvedAt: 1, atr: 2, reversalAtr: 1, reversalBars: 1, relativeVolume: 3, deltaRatio: -0.4 });
  const active = scoreZone(lit('z', '5m', 'DEMAND', 97, 99, 'ACTIVE', [ev]), 3).score;
  const broken = scoreZone(lit('z', '5m', 'DEMAND', 97, 99, 'BROKEN', [ev]), 3).score;
  assert.ok(broken < active, `broken ${broken} should score below active ${active}`);
  assert.equal(scoreZone(lit('z', '5m', 'DEMAND', 97, 99, 'BROKEN', [ev]), 3).components.weakness, 1);
});

test('findZoneConfluence joins overlapping live zones from different timeframes and lists the agreeing timeframes', () => {
  const groups = findZoneConfluence([
    lit('a', '5m', 'DEMAND', 97, 99, 'ACTIVE'),
    lit('b', '15m', 'DEMAND', 98, 100, 'TESTED'),
    lit('c', '1h', 'SUPPLY', 98, 100, 'ACTIVE'),
  ]);
  assert.equal(groups.length, 1);
  const g = groups[0]!;
  assert.equal(g.direction, 'DEMAND');
  assert.equal(g.lowerBound, 97);
  assert.equal(g.upperBound, 100);
  assert.deepEqual(g.timeframes, ['5m', '15m']);
  assert.deepEqual(g.zoneIds, ['a', 'b']);
});

test('confluence needs two distinct timeframes, and a broken zone does not count', () => {
  assert.deepEqual(findZoneConfluence([
    lit('a', '5m', 'DEMAND', 97, 99, 'ACTIVE'),
    lit('b', '5m', 'DEMAND', 98, 100, 'ACTIVE'),
  ]), []);
  assert.deepEqual(findZoneConfluence([
    lit('a', '5m', 'DEMAND', 97, 99, 'ACTIVE'),
    lit('b', '15m', 'DEMAND', 98, 100, 'BROKEN'),
  ]), []);
});

test('nearestZones ranks live zones by distance, puts a containing zone at 0, and skips broken or expired zones', () => {
  const zones = [
    lit('a', '5m', 'DEMAND', 97, 99, 'ACTIVE'),
    lit('b', '1h', 'SUPPLY', 110, 112, 'WEAKENING'),
    lit('c', '15m', 'DEMAND', 100, 101, 'BROKEN'),
    lit('d', '4h', 'DEMAND', 60, 70, 'EXPIRED'),
  ];
  assert.deepEqual(nearestZones(zones, 98, 5).map((n) => [n.zone.id, n.distance]), [['a', 0], ['b', 12]]);
  assert.deepEqual(nearestZones(zones, 105, 5).map((n) => n.zone.id), ['b', 'a']);
  assert.equal(nearestZones(zones, 105, 1).length, 1);
});

test('invalid zone options fail fast', () => {
  const bars = flowSeries('5m', LIFECYCLE);
  const events = [demandAt('e1', bars, 2, 97, 99)];
  assert.throws(() => buildRejectionZones(bars, events, { ...OPTS, maxAgeBars: 0 }), /maxAgeBars must be an integer >= 1/);
  assert.throws(() => buildRejectionZones(bars, events, { ...OPTS, maxZoneWidthAtr: 0 }), /maxZoneWidthAtr must be > 0/);
  assert.throws(() => buildRejectionZones(bars, events, { ...OPTS, clusterAtrFraction: -1 }), /clusterAtrFraction must be >= 0/);
});

/**
 * Zone append-stability: every transition stamped at or before a cutoff is identical in a prefix run and in the full
 * run, and the same zones exist at the cutoff. This is the property the design calls out, so a historical backtest
 * cannot use information that was not yet known.
 */
test('zone lifecycle is append-stable: transitions up to a cutoff never change when more data arrives', () => {
  const dense = { ...SMALL_CONFIG, lookbackBars: 3, minRelativeVolume: 1.0, minWickRatio: 0.3 };
  const opts: ZoneOptions = { ...OPTS, maxAgeBars: 120 };
  const bars = randomWalk('5m', 400, 11);
  const full = buildRejectionZones(bars, detectRejections(bars, dense), opts);
  assert.ok(full.length >= 2, `property needs real zones, got ${full.length}`);

  for (const z of full) {
    assert.ok(z.strength.score >= 0 && z.strength.score <= 100);
    for (const v of Object.values(z.strength.components)) assert.ok(v >= 0 && v <= 1, `component ${v} outside [0,1]`);
  }

  for (const k of [60, 150, 260, 400]) {
    const cutoff = barKnownAt(bars[k - 1]!);
    const head = bars.slice(0, k);
    const prefix = buildRejectionZones(head, detectRejections(head, dense), opts);
    assert.deepEqual(
      prefix.map((z) => z.id).sort(),
      full.filter((z) => z.createdAt <= cutoff).map((z) => z.id).sort(),
      `zones known at prefix ${k} diverged`,
    );
    for (const z of prefix) {
      const reference = full.find((f) => f.id === z.id);
      assert.ok(reference);
      assert.deepEqual(z.transitions, reference.transitions.filter((t) => t.at <= cutoff), `transitions diverged at prefix ${k}`);
    }
  }
});

/** A zone literal for tests that exercise queries over zones rather than the lifecycle. */
function lit(
  id: string,
  timeframe: RejectionTimeframe,
  direction: ZoneDirection,
  lowerBound: number,
  upperBound: number,
  status: RejectionZoneStatus,
  events: RejectionEvent[] = [],
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
    rejectionCount: Math.max(1, events.length),
    testCount: 0,
    lastTestedAt: null,
    brokenAt: null,
    reclaimedAt: null,
    expiredAt: null,
    transitions: [],
    events,
    strength: { score: 0, components: { reversal: 0, volume: 0, delta: 0, speed: 0, confluence: 0, weakness: 0 } },
  };
}
