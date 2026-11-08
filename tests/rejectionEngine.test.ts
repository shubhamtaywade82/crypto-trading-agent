import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeTimeframe, buildRejectionSnapshot, resolveEngineConfig } from '../src/market/rejection/engine.js';
import { TIMEFRAME_MS, type RejectionConfig } from '../src/market/rejection/types.js';
import {
  FLAT, FOLLOW, SWEEP_DEMAND, SYMBOL, flowSeries, minuteKlines, type Px,
} from './rejectionFixtures.js';

/** 25 flat minutes, a sweep-and-reclaim at minute 25, its follow-through at 26, then flat. */
const PATTERN_1M: Px[] = [...Array.from({ length: 25 }, () => FLAT), SWEEP_DEMAND, FOLLOW, FLAT, FLAT];
const M1 = TIMEFRAME_MS['1m'];

test('a 1m sweep-and-reclaim in raw klines is detected through ingestion, aggregation and zone building', () => {
  const klines = minuteKlines(PATTERN_1M);
  const snap = buildRejectionSnapshot(SYMBOL, klines);

  assert.equal(snap.symbol, SYMBOL);
  assert.equal(snap.ingest.accepted, PATTERN_1M.length);
  assert.deepEqual(snap.ingest.rejected, []);
  assert.deepEqual(snap.ingest.gaps, []);
  assert.equal(snap.asOf, klines[klines.length - 1]!.openTime + M1);

  const oneM = snap.timeframes['1m']!;
  assert.equal(oneM.events.length, 1);
  assert.equal(oneM.events[0]!.status, 'CONFIRMED');
  assert.equal(oneM.events[0]!.kind, 'ABSORPTION_LIKE');
  assert.equal(oneM.zones.length, 1);
  assert.equal(oneM.zones[0]!.lowerBound, 97);
  assert.equal(oneM.zones[0]!.upperBound, 99);
  assert.equal(oneM.zones[0]!.transitions[0]!.status, 'ACTIVE');
});

test('the snapshot is deterministic: the same klines always produce the same JSON', () => {
  const klines = minuteKlines(PATTERN_1M);
  const a = JSON.stringify(buildRejectionSnapshot(SYMBOL, klines));
  const b = JSON.stringify(buildRejectionSnapshot(SYMBOL, klines.map((k) => ({ ...k }))));
  assert.equal(a, b);
});

test('a missing minute inside the 20-bar reference window blocks the sweep, and is reported as a gap', () => {
  const klines = minuteKlines(PATTERN_1M).filter((_, i) => i !== 10);
  const snap = buildRejectionSnapshot(SYMBOL, klines);

  assert.equal(snap.ingest.gaps.length, 1);
  assert.equal(snap.ingest.gaps[0]!.missingMinutes, 1);
  assert.equal(snap.timeframes['1m']!.events.length, 0, 'the reference level spans the gap, so it is not known');
  assert.ok(snap.timeframes['5m']!.incompleteBars >= 1, 'the 5m bucket that holds the gap is marked incomplete');
});

test('conflicting duplicate minutes are excluded and reported, not silently resolved', () => {
  const klines = minuteKlines(PATTERN_1M);
  const conflicting = { ...klines[12]!, close: 100.1 };
  const snap = buildRejectionSnapshot(SYMBOL, [...klines, conflicting]);
  assert.deepEqual(snap.ingest.conflicts, [klines[12]!.openTime]);
  assert.equal(snap.ingest.accepted, PATTERN_1M.length - 1);
});

test('timeframes can be restricted, and only the requested ones appear in the snapshot', () => {
  const snap = buildRejectionSnapshot(SYMBOL, minuteKlines(PATTERN_1M), { timeframes: ['1m', '5m'] });
  assert.deepEqual(Object.keys(snap.timeframes).sort(), ['1m', '5m']);
});

test('analyzeTimeframe refuses unsorted or foreign-timeframe bars rather than guessing', () => {
  const config = resolveEngineConfig();
  const bars = flowSeries('5m', [FLAT, FLAT, FLAT]);
  assert.throws(() => analyzeTimeframe([bars[1]!, bars[0]!, bars[2]!], '5m', config), /strictly ascending/);
  assert.throws(() => analyzeTimeframe(bars, '15m', config), /received a 5m bar/);
});

test('engine config applies per-timeframe age budgets and ties the speed window to confirmBars', () => {
  const cfg = resolveEngineConfig({ rejection: { confirmBars: 5 }, maxAgeBars: { '5m': 10 } });
  assert.equal(cfg.zoneFor('5m').maxAgeBars, 10);
  assert.equal(cfg.zoneFor('1h').maxAgeBars, 168);
  assert.equal(cfg.zoneFor('5m').confirmBars, 5);
  const rejection: RejectionConfig = cfg.rejection;
  assert.equal(rejection.minWickRatio, 0.45);
});
