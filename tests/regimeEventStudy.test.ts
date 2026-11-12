import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MinuteRecord } from '../src/marketdata/MinuteAggregator.js';
import {
  buildSeries, clusterBootstrap, eligibleReturns, forwardBps, H5_ALPHA, H5_BOOTSTRAP_DRAWS, H5_BOOTSTRAP_SEED, H5_COST_BPS,
  H5_FAMILY_TESTS, H5_HISTORY_MINUTES, H5_HORIZONS, H5_MAX_DROPPED_DRAW_SHARE, H5_MIN_DAY_COVERAGE, H5_MIN_GROUP_EVENTS,
  H5_MIN_POSITIVE_SYMBOLS, H5_MIN_USABLE_DAYS, H5_REPLICATION_ALPHA, horizonEvents, horizonStats, judgeHorizon, judgeReplication,
  labelEvents, lowerBound, runH5Study, signedAndExcess, usableDaysOf, type DayAggregate, type H5Regime, type H5Role,
  type HorizonEvent, type HorizonStats, type LabelledEvent, type SymbolSeries,
} from '../src/marketdata/RegimeEventStudy.js';
import { mulberry32, utcDay } from '../src/research/Bootstrap.js';

const MIN = 60_000;
const DAY0 = Date.UTC(2026, 9, 1);
const MINUTES_PER_DAY = 1440;
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const anyDay = (): boolean => true;
const dayOf = (i: number): string => utcDay(DAY0 + i * MINUTES_PER_DAY * MIN);

const rec = (symbol: string, t: number, over: Partial<MinuteRecord> = {}): MinuteRecord => ({
  t, symbol, trades: 100, buyQty: 1, sellQty: 1, buyQuote: 100, sellQuote: 100, liqLongQty: 0, liqShortQty: 0, liqCount: 0,
  spreadBps: 0.1, bookImbalance: 0, bookSamples: 1, mark: 100, index: 100, funding: 0, openInterest: 1_000, takerRatio: 1, ...over,
});

/** Random-walk mark and OI, both changing every minute, so every minute is an OI event. */
function noisy(symbol: string, n: number, seed: number, startT = DAY0): MinuteRecord[] {
  const r = mulberry32(seed);
  const out: MinuteRecord[] = [];
  let mark = 100;
  let oi = 1_000_000;
  for (let i = 0; i < n; i += 1) {
    mark *= 1 + (r() - 0.5) * 0.0008;
    oi *= 1 + (r() - 0.5) * 0.0008;
    out.push(rec(symbol, startT + i * MIN, { mark, index: mark, openInterest: oi }));
  }
  return out;
}

/** A labelled event at `index` of `s`, with the given group. */
function ev(s: SymbolSeries, index: number, regime: H5Regime, role: H5Role, sign: 1 | -1): LabelledEvent {
  return { symbol: s.symbol, index, t: s.records[index]?.t ?? 0, day: utcDay(s.records[index]?.t ?? 0), regime, role, sign };
}

/** Balanced synthetic events: primary excess and signed returns +25/+35 (continuation), contrast +/-10 (mean zero). */
function syntheticEvents(days: number, perDayPerGroup: number, primary: (k: number, sym: string) => number = (k) => (k % 2 ? 35 : 25)): HorizonEvent[] {
  const out: HorizonEvent[] = [];
  for (let d = 0; d < days; d += 1) {
    for (let k = 0; k < perDayPerGroup; k += 1) {
      const sym = SYMS[(d + k) % SYMS.length] ?? 'BTCUSDT';
      const p = primary(k, sym);
      const c = k % 2 ? 10 : -10;
      const day = dayOf(d);
      out.push({ symbol: sym, t: DAY0 + d * MINUTES_PER_DAY * MIN, day, regime: 'LONG_BUILD', role: 'PRIMARY', signedBps: p, excessBps: p });
      out.push({ symbol: sym, t: DAY0 + d * MINUTES_PER_DAY * MIN, day, regime: 'SHORT_BUILD', role: 'PRIMARY', signedBps: p, excessBps: p });
      out.push({ symbol: sym, t: DAY0 + d * MINUTES_PER_DAY * MIN, day, regime: 'SHORT_COVER', role: 'CONTRAST', signedBps: c, excessBps: c });
      out.push({ symbol: sym, t: DAY0 + d * MINUTES_PER_DAY * MIN, day, regime: 'LONG_LIQUIDATION', role: 'CONTRAST', signedBps: -c, excessBps: -c });
    }
  }
  return out;
}

const usableDaysList = (n: number): string[] => Array.from({ length: n }, (_, i) => dayOf(i));

test('frozen constants match research log section 12 and amendment 1', () => {
  assert.deepEqual([...H5_HORIZONS], [5, 15, 30, 60]);
  assert.equal(H5_COST_BPS, 16);
  assert.equal(H5_FAMILY_TESTS, 8);
  assert.equal(H5_ALPHA, 0.00625);
  assert.equal(H5_REPLICATION_ALPHA, 0.05);
  assert.equal(H5_BOOTSTRAP_DRAWS, 10_000);
  assert.equal(H5_BOOTSTRAP_SEED, 1);
  assert.equal(H5_MIN_GROUP_EVENTS, 30);
  assert.equal(H5_MIN_USABLE_DAYS, 14);
  assert.equal(H5_MIN_DAY_COVERAGE, 0.9);
  assert.equal(H5_MIN_POSITIVE_SYMBOLS, 3);
  assert.equal(H5_MAX_DROPPED_DRAW_SHARE, 0.01);
  assert.equal(H5_HISTORY_MINUTES, 255);
});

test('a minute is an event only when OI changed from the previous minute', () => {
  const flat = noisy('BTCUSDT', 400, 2).map((r) => ({ ...r, openInterest: 1_000 }));
  assert.equal(labelEvents(buildSeries('BTCUSDT', flat), anyDay).length, 0);
});

test('labels use only the minutes up to the event minute', () => {
  const records = noisy('BTCUSDT', 600, 3);
  const base = labelEvents(buildSeries('BTCUSDT', records), anyDay);
  const pick = base[Math.floor(base.length / 2)];
  assert.ok(pick, 'expected events in the synthetic series');
  const tampered = records.map((r, i) => (i > pick.index ? { ...r, mark: (r.mark ?? 0) * 5, openInterest: 1, buyQuote: 1e9 } : r));
  const again = labelEvents(buildSeries('BTCUSDT', tampered), anyDay).find((e) => e.index === pick.index);
  assert.equal(again?.regime, pick.regime);
});

test('roles and signs follow the hypothesis: build regimes are primary, cover and liquidation are contrast', () => {
  const base = labelEvents(buildSeries('BTCUSDT', noisy('BTCUSDT', 600, 3)), anyDay);
  for (const e of base) {
    if (e.regime === 'LONG_BUILD') assert.deepEqual([e.role, e.sign], ['PRIMARY', 1]);
    if (e.regime === 'SHORT_BUILD') assert.deepEqual([e.role, e.sign], ['PRIMARY', -1]);
    if (e.regime === 'SHORT_COVER') assert.deepEqual([e.role, e.sign], ['CONTRAST', 1]);
    if (e.regime === 'LONG_LIQUIDATION') assert.deepEqual([e.role, e.sign], ['CONTRAST', -1]);
  }
  assert.ok(new Set(base.map((e) => e.regime)).size >= 3);
});

test('an OI gap at a window boundary drops the events that read it', () => {
  const j = 400;
  const records = noisy('BTCUSDT', 700, 4).map((r, i) => (i === j ? { ...r, openInterest: null } : r));
  const idx = labelEvents(buildSeries('BTCUSDT', records), anyDay).map((e) => e.index);
  assert.ok(!idx.includes(j), 'the null minute itself is not an event');
  assert.ok(!idx.includes(j + 1), 'the minute after the null has no previous OI');
  assert.ok(!idx.includes(j + 14), 'a 15-minute window starting on the null minute is unusable');
  assert.ok(idx.some((i) => i > j + 14), 'events after the gap still exist');
});

test('a gap in the history drops every event whose 255-minute history spans it', () => {
  const gap = 500;
  const records = noisy('BTCUSDT', 900, 5).filter((_, i) => i !== gap);
  const idx = labelEvents(buildSeries('BTCUSDT', records), anyDay).map((e) => e.index);
  assert.ok(idx.every((i) => i < gap || i >= gap + H5_HISTORY_MINUTES - 1), 'no event inside the broken history');
  assert.ok(idx.some((i) => i >= gap + H5_HISTORY_MINUTES - 1), 'events after the history is contiguous again');
});

test('a missing minute on the forward path drops the event for every horizon that crosses it', () => {
  const s = buildSeries('BTCUSDT', noisy('BTCUSDT', 200, 9).filter((_, i) => i !== 110));
  assert.equal(forwardBps(s, 100, 15), null, 'path 100..115 crosses the gap at original minute 110');
  assert.notEqual(forwardBps(s, 100, 5), null, 'path 100..105 does not');
  const after = s.records.findIndex((r) => r.t === DAY0 + 111 * MIN);
  assert.notEqual(forwardBps(s, after, 15), null, 'path 111..126 is clear');
});

test('eligible minutes need history and a forward path, and never a label', () => {
  const s = buildSeries('BTCUSDT', noisy('BTCUSDT', 300, 10));
  const r15 = eligibleReturns(s, 15, anyDay);
  // history starts at index 254; the forward path needs index + 15 <= 299
  assert.equal(r15.length, 300 - 15 - 254);
});

test('a day is excluded for every symbol when any symbol covers under 90% of it', () => {
  const a = noisy('BTCUSDT', 3 * MINUTES_PER_DAY, 11);
  const b = [...noisy('ETHUSDT', 2 * MINUTES_PER_DAY, 12), ...noisy('ETHUSDT', 1000, 13, DAY0 + 2 * MINUTES_PER_DAY * MIN)];
  const usage = usableDaysOf([{ symbol: 'BTCUSDT', records: a }, { symbol: 'ETHUSDT', records: b }]);
  assert.deepEqual(usage.usableDays, [dayOf(0), dayOf(1)]);
  assert.deepEqual(usage.excludedDays, [dayOf(2)]);
});

test('a day with no records for one symbol is excluded for all', () => {
  const usage = usableDaysOf([
    { symbol: 'BTCUSDT', records: noisy('BTCUSDT', MINUTES_PER_DAY, 14) },
    { symbol: 'ETHUSDT', records: [] },
  ]);
  assert.deepEqual(usage.usableDays, []);
  assert.deepEqual(usage.excludedDays, [dayOf(0)]);
});

test('events on an unusable day are not labelled', () => {
  assert.equal(labelEvents(buildSeries('BTCUSDT', noisy('BTCUSDT', 600, 15)), () => false).length, 0);
});

test('non-overlap is per population, and a dropped event does not block', () => {
  const s = buildSeries('BTCUSDT', noisy('BTCUSDT', 200, 16).filter((_, i) => i !== 110));
  // Original minutes: 100 (path crosses the gap, dropped), 111, 116, 126. Horizon 15.
  const labelled: LabelledEvent[] = [
    ev(s, 100, 'LONG_BUILD', 'PRIMARY', 1),
    ev(s, 110, 'LONG_BUILD', 'PRIMARY', 1), // original 111: 11 min after the dropped event, must be kept
    ev(s, 115, 'SHORT_BUILD', 'PRIMARY', -1), // original 116: 5 min after a kept primary, blocked
    ev(s, 115, 'SHORT_COVER', 'CONTRAST', 1), // contrast cursor is separate, kept
    ev(s, 125, 'LONG_BUILD', 'PRIMARY', 1), // original 126: exactly 15 min after the kept primary, kept
  ];
  const { events } = horizonEvents([{ series: s, labelled }], 15, anyDay);
  assert.deepEqual(events.map((e) => [e.t, e.role, e.regime]), [
    [DAY0 + 111 * MIN, 'PRIMARY', 'LONG_BUILD'],
    [DAY0 + 116 * MIN, 'CONTRAST', 'SHORT_COVER'],
    [DAY0 + 126 * MIN, 'PRIMARY', 'LONG_BUILD'],
  ]);
});

test('excess is drift-adjusted: a move equal to the symbol drift has zero excess', () => {
  const recs = Array.from({ length: 300 }, (_, i) => rec('BTCUSDT', DAY0 + i * MIN, { mark: 100 * 1.0005 ** i, openInterest: 1_000 + i }));
  const s = buildSeries('BTCUSDT', recs);
  const labelled = [ev(s, 260, 'LONG_BUILD', 'PRIMARY', 1), ev(s, 270, 'SHORT_BUILD', 'PRIMARY', -1)];
  const { events, drift } = horizonEvents([{ series: s, labelled }], 5, anyDay);
  assert.ok(Math.abs((drift.BTCUSDT ?? 0) - (1.0005 ** 5 - 1) * 10_000) < 1e-6);
  assert.equal(events.length, 2);
  for (const e of events) assert.ok(Math.abs(e.excessBps) < 1e-6);
});

test('signed and excess returns follow the sign convention', () => {
  assert.deepEqual(signedAndExcess(-1, 10, 4), { signed: -10, excess: -6 });
  assert.deepEqual(signedAndExcess(1, -3, 1), { signed: -3, excess: -4 });
});

test('the lower bound is the sorted value at index floor(alpha x draws)', () => {
  const sorted = Array.from({ length: 10_000 }, (_, i) => i + 1);
  assert.equal(lowerBound(sorted, H5_ALPHA, 10_000), 63);
  assert.equal(lowerBound(sorted, H5_REPLICATION_ALPHA, 10_000), 501);
});

test('the bootstrap is reproducible, and a bound is not evaluable when many draws are empty', () => {
  const days: DayAggregate[] = usableDaysList(15).map((day, i) => ({
    day, nPrimary: i === 0 ? 5 : 0, sumSignedPrimary: i === 0 ? 150 : 0, sumExcessPrimary: i === 0 ? 150 : 0, nContrast: 5, sumSignedContrast: 0,
  }));
  const a = clusterBootstrap(days, 500, 1, H5_COST_BPS);
  const b = clusterBootstrap(days, 500, 1, H5_COST_BPS);
  assert.deepEqual(a, b);
  // Only day 0 has primary events, so about 35% of draws have none: far above the 1% limit.
  assert.ok(a.dropped / a.draws > H5_MAX_DROPPED_DRAW_SHARE);
  assert.equal(lowerBound(a.meanExcess, H5_ALPHA, a.draws), null);
});

test('a consistent continuation effect is a lead', () => {
  const stats = horizonStats(syntheticEvents(20, 2), usableDaysList(20), 15, SYMS);
  const verdict = judgeHorizon(stats, SYMS);
  assert.equal(verdict.verdict, 'LEAD', verdict.failed.join('; '));
  assert.deepEqual(verdict.failed, []);
});

test('no effect is not a lead, and the failure names the condition', () => {
  const events = syntheticEvents(20, 2, (k) => (k % 2 ? 20 : -20));
  const verdict = judgeHorizon(horizonStats(events, usableDaysList(20), 15, SYMS), SYMS);
  assert.equal(verdict.verdict, 'NO_LEAD');
  assert.ok(verdict.failed.some((f) => f.startsWith('P2')));
});

test('too few events in one group is not evaluable, not a failure', () => {
  const verdict = judgeHorizon(horizonStats(syntheticEvents(20, 1), usableDaysList(20), 15, SYMS), SYMS);
  assert.equal(verdict.verdict, 'NOT_EVALUABLE');
  assert.ok(verdict.failed.some((f) => f.includes('< 30')));
});

test('fewer than 14 usable days is not evaluable', () => {
  const verdict = judgeHorizon(horizonStats(syntheticEvents(10, 3), usableDaysList(10), 15, SYMS), SYMS);
  assert.equal(verdict.verdict, 'NOT_EVALUABLE');
  assert.ok(verdict.failed.some((f) => f.startsWith('usable days 10')));
});

test('P6 fails when only two of four symbols are positive', () => {
  const events = syntheticEvents(20, 2, (_k, sym) => (sym === 'BTCUSDT' || sym === 'ETHUSDT' ? 60 : -10));
  const verdict = judgeHorizon(horizonStats(events, usableDaysList(20), 15, SYMS), SYMS);
  assert.equal(verdict.verdict, 'NO_LEAD');
  assert.ok(verdict.failed.some((f) => f.startsWith('P6')), verdict.failed.join('; '));
});

test('replication uses one-sided 0.05 where the family test uses 0.00625', () => {
  const stats: HorizonStats = {
    horizon: 15, usableDays: 20,
    counts: { LONG_BUILD: 40, SHORT_BUILD: 40, SHORT_COVER: 40, LONG_LIQUIDATION: 40 },
    meanExcess: 10, delta: 10, netMean: 5,
    sideExcess: { LONG_BUILD: 10, SHORT_BUILD: 10 },
    symbolExcess: { BTCUSDT: 1, ETHUSDT: 1, SOLUSDT: 1, XRPUSDT: 1 },
    bounds: { meanExcess: { family: -1, replication: 2 }, delta: { family: -1, replication: 2 }, net: { family: -1 } },
    bootstrap: { draws: 10_000, dropped: 0 },
  };
  assert.equal(judgeHorizon(stats, SYMS).verdict, 'NO_LEAD');
  assert.equal(judgeReplication(stats).verdict, 'REPLICATED');
});

test('the study does not run with fewer than 14 usable days', () => {
  const out = runH5Study({ symbols: [{ symbol: 'BTCUSDT', records: noisy('BTCUSDT', 2 * MINUTES_PER_DAY, 21) }] });
  assert.equal(out.status, 'NOT_RUN');
  if (out.status === 'NOT_RUN') assert.match(out.reason, /usable days 2 < 14/);
});

test('the after filter keeps only records strictly later than the cutoff', () => {
  const records = noisy('BTCUSDT', 3 * MINUTES_PER_DAY, 22);
  const cutoff = records[records.length - 1]?.t ?? 0;
  const out = runH5Study({ symbols: [{ symbol: 'BTCUSDT', records }], after: cutoff });
  assert.equal(out.status, 'NOT_RUN');
  assert.equal(out.dataCutoff, null);
});

test('a full run over 14 usable days reports every horizon and its sample', () => {
  const records = noisy('BTCUSDT', 14 * MINUTES_PER_DAY, 23);
  const out = runH5Study({ symbols: [{ symbol: 'BTCUSDT', records }] });
  assert.equal(out.status, 'RUN');
  if (out.status !== 'RUN') return;
  assert.equal(out.usableDays.length, 14);
  assert.equal(out.excludedDays.length, 0);
  assert.deepEqual(out.horizons.map((h) => h.horizon), [5, 15, 30, 60]);
  for (const h of out.horizons) {
    assert.equal(h.stats.usableDays, 14);
    assert.equal(h.stats.bootstrap.draws, H5_BOOTSTRAP_DRAWS);
  }
  assert.equal(out.dataCutoff, records[records.length - 1]?.t ?? null);
});
