/**
 * Pre-registered H5 study (docs/research-log.md §12): does the price x open-interest label from MicrostructureState predict
 * continuation? The constants are frozen by the research log. Changing one after seeing outcomes invalidates the test: add
 * a new id instead.
 *
 * Two layers. Extraction (labelEvents, forwardBps, horizonEvents) reads recorded minutes. The statistical core (horizonStats,
 * judgeHorizon, judgeReplication) works on events and day aggregates, so it can be tested without data. The CLI is
 * scripts/regime-event-study.ts.
 */
import type { MinuteRecord } from './MinuteAggregator.js';
import { cleanRecords } from './EventStudy.js';
import { DEFAULT_MICROSTRUCTURE_OPTIONS, microstructureState, type PriceOiRegime } from './MicrostructureState.js';
import { mulberry32, utcDay } from '../research/Bootstrap.js';

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 1440;

// ---- Frozen constants (research log §12, as amended once before any run) ----

export const H5_HORIZONS = [5, 15, 30, 60] as const;
export const H5_COST_BPS = 16;
export const H5_FAMILY_TESTS = 2 * H5_HORIZONS.length;
export const H5_ALPHA = 0.05 / H5_FAMILY_TESTS;
export const H5_REPLICATION_ALPHA = 0.05;
export const H5_BOOTSTRAP_DRAWS = 10_000;
export const H5_BOOTSTRAP_SEED = 1;
export const H5_MIN_GROUP_EVENTS = 30;
export const H5_MIN_USABLE_DAYS = 14;
export const H5_MIN_DAY_COVERAGE = 0.9;
export const H5_MIN_POSITIVE_SYMBOLS = 3;
export const H5_MAX_DROPPED_DRAW_SHARE = 0.01;
/** Contiguous minutes a label needs: the window plus the baseline, as microstructureState requires. */
export const H5_HISTORY_MINUTES = DEFAULT_MICROSTRUCTURE_OPTIONS.windowMinutes + DEFAULT_MICROSTRUCTURE_OPTIONS.baselineMinutes;

export type H5Regime = 'LONG_BUILD' | 'SHORT_BUILD' | 'SHORT_COVER' | 'LONG_LIQUIDATION';
export type H5Role = 'PRIMARY' | 'CONTRAST';
export const H5_REGIMES: readonly H5Regime[] = ['LONG_BUILD', 'SHORT_BUILD', 'SHORT_COVER', 'LONG_LIQUIDATION'];

/** Primary groups predict continuation (sign +1 up, -1 down). Contrast groups differ only in the OI sign on the same price side. */
const GROUP_OF = new Map<PriceOiRegime, { role: H5Role; sign: 1 | -1; regime: H5Regime }>([
  ['LONG_BUILD', { role: 'PRIMARY', sign: 1, regime: 'LONG_BUILD' }],
  ['SHORT_BUILD', { role: 'PRIMARY', sign: -1, regime: 'SHORT_BUILD' }],
  ['SHORT_COVER', { role: 'CONTRAST', sign: 1, regime: 'SHORT_COVER' }],
  ['LONG_LIQUIDATION', { role: 'CONTRAST', sign: -1, regime: 'LONG_LIQUIDATION' }],
]);

// ---- Extraction ----

export interface SymbolSeries {
  symbol: string;
  /** Cleaned minutes for one symbol, ascending. */
  records: readonly MinuteRecord[];
  /** Minute timestamp -> index in `records`. */
  byT: ReadonlyMap<number, number>;
  /** historyOk[i]: the H5_HISTORY_MINUTES minutes ending at i are contiguous. */
  historyOk: readonly boolean[];
}

export function contiguousHistory(records: readonly MinuteRecord[], need: number): boolean[] {
  const ok: boolean[] = [];
  let run = 0;
  let prevT = Number.NaN;
  for (const r of records) {
    run = r.t - prevT === MINUTE_MS ? run + 1 : 1;
    ok.push(run >= need);
    prevT = r.t;
  }
  return ok;
}

export function buildSeries(symbol: string, records: readonly MinuteRecord[]): SymbolSeries {
  const byT = new Map<number, number>();
  records.forEach((r, i) => byT.set(r.t, i));
  return { symbol, records, byT, historyOk: contiguousHistory(records, H5_HISTORY_MINUTES) };
}

export interface LabelledEvent {
  symbol: string;
  /** Index into the series' records. */
  index: number;
  t: number;
  day: string;
  regime: H5Regime;
  role: H5Role;
  sign: 1 | -1;
}

/**
 * Event minutes: minute t where a new OI value landed (openInterest differs from minute t-1). The label is computed from the
 * 255 contiguous minutes ending at t, so no record after t is read. Minutes whose label is NEUTRAL, or whose history is
 * broken, are not events.
 */
export function labelEvents(series: SymbolSeries, isUsableDay: (day: string) => boolean): LabelledEvent[] {
  const { records, historyOk } = series;
  const out: LabelledEvent[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const cur = records[i];
    const prev = records[i - 1];
    if (!cur || !prev) continue;
    if (cur.t - prev.t !== MINUTE_MS) continue;
    if (cur.openInterest === null || prev.openInterest === null || cur.openInterest === prev.openInterest) continue;
    if (historyOk[i] !== true) continue;
    const day = utcDay(cur.t);
    if (!isUsableDay(day)) continue;
    const res = microstructureState(records.slice(i + 1 - H5_HISTORY_MINUTES, i + 1));
    if (res.status !== 'OK') continue;
    const group = GROUP_OF.get(res.state.priceOiRegime);
    if (!group) continue;
    out.push({ symbol: series.symbol, index: i, t: cur.t, day, regime: group.regime, role: group.role, sign: group.sign });
  }
  return out;
}

/**
 * Forward return in bps from the mark at minute t to the mark at t+h. Every minute from t through t+h must be present
 * (no gap), and both marks must exist. Otherwise null, and the event is dropped for this horizon.
 */
export function forwardBps(series: SymbolSeries, index: number, horizon: number): number | null {
  const start = series.records[index];
  if (!start) return null;
  for (let k = 1; k <= horizon; k += 1) {
    if (!series.byT.has(start.t + k * MINUTE_MS)) return null;
  }
  const endIndex = series.byT.get(start.t + horizon * MINUTE_MS);
  const end = endIndex === undefined ? undefined : series.records[endIndex];
  if (!end || start.mark === null || end.mark === null) return null;
  if (!(start.mark > 0) || !Number.isFinite(end.mark)) return null;
  return ((end.mark - start.mark) / start.mark) * 10_000;
}

/** Forward returns of every eligible minute of one symbol (drift basis). Eligible: history, forward path, usable day. */
export function eligibleReturns(series: SymbolSeries, horizon: number, isUsableDay: (day: string) => boolean): number[] {
  const out: number[] = [];
  series.records.forEach((r, i) => {
    if (series.historyOk[i] !== true || !isUsableDay(utcDay(r.t))) return;
    const f = forwardBps(series, i, horizon);
    if (f !== null) out.push(f);
  });
  return out;
}

/** signed = sign x r (the hypothesis' direction). excess = sign x (r - drift): the same quantity as EventStudy's excessBps. */
export function signedAndExcess(sign: 1 | -1, forward: number, drift: number): { signed: number; excess: number } {
  return { signed: sign * forward, excess: sign * (forward - drift) };
}

export interface HorizonEvent {
  symbol: string;
  t: number;
  day: string;
  regime: H5Regime;
  role: H5Role;
  signedBps: number;
  excessBps: number;
}

export interface SymbolEvents {
  series: SymbolSeries;
  labelled: readonly LabelledEvent[];
}

/**
 * Applies the forward path and non-overlap at one horizon. Per symbol and per population (primary, contrast), an event is
 * kept only if it is at least h minutes after the previous kept event of that population. A dropped event (no forward
 * return) does not block later events.
 */
export function horizonEvents(
  bySymbol: readonly SymbolEvents[],
  horizon: number,
  isUsableDay: (day: string) => boolean,
): { events: HorizonEvent[]; drift: Record<string, number> } {
  const events: HorizonEvent[] = [];
  const drift: Record<string, number> = {};
  for (const { series, labelled } of bySymbol) {
    const eligible = eligibleReturns(series, horizon, isUsableDay);
    const d = eligible.length > 0 ? eligible.reduce((a, b) => a + b, 0) / eligible.length : 0;
    drift[series.symbol] = d;
    const blockedUntil: Record<H5Role, number> = { PRIMARY: Number.NEGATIVE_INFINITY, CONTRAST: Number.NEGATIVE_INFINITY };
    for (const ev of labelled) {
      const forward = forwardBps(series, ev.index, horizon);
      if (forward === null) continue;
      if (ev.t < blockedUntil[ev.role]) continue;
      blockedUntil[ev.role] = ev.t + horizon * MINUTE_MS;
      const { signed, excess } = signedAndExcess(ev.sign, forward, d);
      events.push({ symbol: ev.symbol, t: ev.t, day: ev.day, regime: ev.regime, role: ev.role, signedBps: signed, excessBps: excess });
    }
  }
  return { events, drift };
}

// ---- Day usage (coverage) ----

export interface StudySymbolInput {
  symbol: string;
  records: readonly MinuteRecord[];
}

export interface DayUsage {
  usableDays: string[];
  excludedDays: string[];
  /** Lowest per-symbol coverage of each day (0..1). */
  minCoverage: Map<string, number>;
}

/** A UTC day is excluded for all symbols when any symbol has less than H5_MIN_DAY_COVERAGE of its minutes that day. */
export function usableDaysOf(symbols: readonly StudySymbolInput[]): DayUsage {
  const perSymbol = symbols.map(({ records }) => {
    const minutesByDay = new Map<string, Set<number>>();
    for (const r of records) {
      const day = utcDay(r.t);
      const set = minutesByDay.get(day) ?? new Set<number>();
      set.add(r.t);
      minutesByDay.set(day, set);
    }
    return minutesByDay;
  });
  const allDays = new Set<string>();
  for (const m of perSymbol) for (const day of m.keys()) allDays.add(day);
  const usableDays: string[] = [];
  const excludedDays: string[] = [];
  const minCoverage = new Map<string, number>();
  for (const day of [...allDays].sort()) {
    let worst = 1;
    for (const m of perSymbol) worst = Math.min(worst, (m.get(day)?.size ?? 0) / MINUTES_PER_DAY);
    minCoverage.set(day, worst);
    if (worst >= H5_MIN_DAY_COVERAGE) usableDays.push(day);
    else excludedDays.push(day);
  }
  return { usableDays, excludedDays, minCoverage };
}

// ---- Statistical core ----

export interface DayAggregate {
  day: string;
  nPrimary: number;
  sumSignedPrimary: number;
  sumExcessPrimary: number;
  nContrast: number;
  sumSignedContrast: number;
}

export interface BootstrapDraws {
  /** Sorted. Each array holds the statistic of every valid draw. */
  meanExcess: number[];
  delta: number[];
  net: number[];
  draws: number;
  dropped: number;
}

/**
 * Day-clustered bootstrap: resample UTC days with replacement. A draw with no primary or no contrast event is dropped
 * (amendment 1, item 4).
 */
export function clusterBootstrap(days: readonly DayAggregate[], draws: number, seed: number, costBps: number): BootstrapDraws {
  const rng = mulberry32(seed);
  const meanExcess: number[] = [];
  const delta: number[] = [];
  const net: number[] = [];
  let dropped = 0;
  for (let b = 0; b < draws; b += 1) {
    let nP = 0;
    let sP = 0;
    let xP = 0;
    let nC = 0;
    let sC = 0;
    for (let k = 0; k < days.length; k += 1) {
      const d = days[Math.floor(rng() * days.length)];
      if (!d) continue;
      nP += d.nPrimary;
      sP += d.sumSignedPrimary;
      xP += d.sumExcessPrimary;
      nC += d.nContrast;
      sC += d.sumSignedContrast;
    }
    if (nP === 0 || nC === 0) {
      dropped += 1;
      continue;
    }
    meanExcess.push(xP / nP);
    delta.push(sP / nP - sC / nC);
    net.push(sP / nP - costBps);
  }
  const ascending = (a: number, b: number): number => a - b;
  return { meanExcess: meanExcess.sort(ascending), delta: delta.sort(ascending), net: net.sort(ascending), draws, dropped };
}

/** Lower bound at one-sided `alpha`: sorted[floor(alpha x valid)]. Null (not evaluable) when too many draws were dropped. */
export function lowerBound(sorted: readonly number[], alpha: number, draws: number): number | null {
  if (sorted.length < draws * (1 - H5_MAX_DROPPED_DRAW_SHARE)) return null;
  const v = sorted[Math.floor(alpha * sorted.length)];
  return v === undefined ? null : v;
}

export interface HorizonStats {
  horizon: number;
  usableDays: number;
  counts: Record<H5Regime, number>;
  /** Test A point estimate: mean drift-adjusted excess over pooled primary events, bps. */
  meanExcess: number | null;
  /** Test B point estimate: mean signed primary minus mean signed contrast, bps. */
  delta: number | null;
  /** Mean net signed primary return (after H5_COST_BPS), bps. */
  netMean: number | null;
  sideExcess: { LONG_BUILD: number | null; SHORT_BUILD: number | null };
  symbolExcess: Record<string, number | null>;
  bounds: {
    meanExcess: { family: number | null; replication: number | null };
    delta: { family: number | null; replication: number | null };
    net: { family: number | null };
  };
  bootstrap: { draws: number; dropped: number };
}

export function horizonStats(
  events: readonly HorizonEvent[],
  usableDays: readonly string[],
  horizon: number,
  symbols: readonly string[],
  draws: number = H5_BOOTSTRAP_DRAWS,
  seed: number = H5_BOOTSTRAP_SEED,
): HorizonStats {
  const position = new Map(usableDays.map((day, i) => [day, i] as const));
  const days: DayAggregate[] = usableDays.map((day) => ({
    day, nPrimary: 0, sumSignedPrimary: 0, sumExcessPrimary: 0, nContrast: 0, sumSignedContrast: 0,
  }));
  const counts: Record<H5Regime, number> = { LONG_BUILD: 0, SHORT_BUILD: 0, SHORT_COVER: 0, LONG_LIQUIDATION: 0 };
  const side = { LONG_BUILD: { n: 0, sum: 0 }, SHORT_BUILD: { n: 0, sum: 0 } };
  const bySymbol = new Map<string, { n: number; sum: number }>();

  for (const e of events) {
    const k = position.get(e.day);
    const d = k === undefined ? undefined : days[k];
    if (!d) throw new Error(`H5 event on an unusable day ${e.day}`);
    counts[e.regime] += 1;
    if (e.role === 'PRIMARY') {
      d.nPrimary += 1;
      d.sumSignedPrimary += e.signedBps;
      d.sumExcessPrimary += e.excessBps;
      if (e.regime === 'LONG_BUILD' || e.regime === 'SHORT_BUILD') {
        side[e.regime].n += 1;
        side[e.regime].sum += e.excessBps;
      }
      const s = bySymbol.get(e.symbol) ?? { n: 0, sum: 0 };
      s.n += 1;
      s.sum += e.excessBps;
      bySymbol.set(e.symbol, s);
    } else {
      d.nContrast += 1;
      d.sumSignedContrast += e.signedBps;
    }
  }

  const tot = days.reduce(
    (a, d) => ({
      nP: a.nP + d.nPrimary, sP: a.sP + d.sumSignedPrimary, xP: a.xP + d.sumExcessPrimary,
      nC: a.nC + d.nContrast, sC: a.sC + d.sumSignedContrast,
    }),
    { nP: 0, sP: 0, xP: 0, nC: 0, sC: 0 },
  );
  const meanExcess = tot.nP > 0 ? tot.xP / tot.nP : null;
  const delta = tot.nP > 0 && tot.nC > 0 ? tot.sP / tot.nP - tot.sC / tot.nC : null;
  const netMean = tot.nP > 0 ? tot.sP / tot.nP - H5_COST_BPS : null;

  const boot = clusterBootstrap(days, draws, seed, H5_COST_BPS);
  const sideMean = (x: { n: number; sum: number }): number | null => (x.n > 0 ? x.sum / x.n : null);
  const symbolExcess: Record<string, number | null> = {};
  for (const sym of symbols) {
    const s = bySymbol.get(sym);
    symbolExcess[sym] = s ? sideMean(s) : null;
  }

  return {
    horizon,
    usableDays: usableDays.length,
    counts,
    meanExcess,
    delta,
    netMean,
    sideExcess: { LONG_BUILD: sideMean(side.LONG_BUILD), SHORT_BUILD: sideMean(side.SHORT_BUILD) },
    symbolExcess,
    bounds: {
      meanExcess: {
        family: lowerBound(boot.meanExcess, H5_ALPHA, draws),
        replication: lowerBound(boot.meanExcess, H5_REPLICATION_ALPHA, draws),
      },
      delta: {
        family: lowerBound(boot.delta, H5_ALPHA, draws),
        replication: lowerBound(boot.delta, H5_REPLICATION_ALPHA, draws),
      },
      net: { family: lowerBound(boot.net, H5_ALPHA, draws) },
    },
    bootstrap: { draws: boot.draws, dropped: boot.dropped },
  };
}

/** P1 sample sufficiency. These are not failures: they make the horizon not evaluable. */
function sampleProblems(s: HorizonStats): string[] {
  const problems: string[] = [];
  if (s.usableDays < H5_MIN_USABLE_DAYS) problems.push(`usable days ${s.usableDays} < ${H5_MIN_USABLE_DAYS}`);
  for (const r of H5_REGIMES) {
    if (s.counts[r] < H5_MIN_GROUP_EVENTS) problems.push(`${r} ${s.counts[r]} events < ${H5_MIN_GROUP_EVENTS}`);
  }
  return problems;
}

export type H5Verdict = 'LEAD' | 'NO_LEAD' | 'NOT_EVALUABLE';
export type H5ReplicationVerdict = 'REPLICATED' | 'NOT_REPLICATED' | 'NOT_EVALUABLE';

export interface Judgement<V extends string> {
  horizon: number;
  verdict: V;
  failed: string[];
}

/** A horizon is a lead only if P1 to P6 all hold (research log §12). */
export function judgeHorizon(s: HorizonStats, symbols: readonly string[]): Judgement<H5Verdict> {
  const problems = sampleProblems(s);
  const b = s.bounds;
  if (problems.length > 0 || b.meanExcess.family === null || b.delta.family === null || b.net.family === null) {
    if (b.meanExcess.family === null || b.delta.family === null || b.net.family === null) problems.push('bootstrap not evaluable');
    return { horizon: s.horizon, verdict: 'NOT_EVALUABLE', failed: problems };
  }
  const failed: string[] = [];
  if (!(b.meanExcess.family > 0)) failed.push('P2 Test A (continuation) lower bound <= 0');
  if (!(b.delta.family > 0)) failed.push('P3 Test B (OI isolates the effect) lower bound <= 0');
  if (!(b.net.family > 0)) failed.push('P4 net of costs lower bound <= 0');
  const { LONG_BUILD: longSide, SHORT_BUILD: shortSide } = s.sideExcess;
  if (!(longSide !== null && longSide > 0 && shortSide !== null && shortSide > 0)) failed.push('P5 a side is not positive');
  const positive = symbols.filter((sym) => (s.symbolExcess[sym] ?? 0) > 0).length;
  if (positive < H5_MIN_POSITIVE_SYMBOLS) failed.push(`P6 ${positive} of ${symbols.length} symbols positive, need ${H5_MIN_POSITIVE_SYMBOLS}`);
  return { horizon: s.horizon, verdict: failed.length === 0 ? 'LEAD' : 'NO_LEAD', failed };
}

/** Replication (only after a lead): P1, P5, and Tests A and B at one-sided 0.05, same sign. */
export function judgeReplication(s: HorizonStats): Judgement<H5ReplicationVerdict> {
  const problems = sampleProblems(s);
  const b = s.bounds;
  if (problems.length > 0 || b.meanExcess.replication === null || b.delta.replication === null) {
    if (b.meanExcess.replication === null || b.delta.replication === null) problems.push('bootstrap not evaluable');
    return { horizon: s.horizon, verdict: 'NOT_EVALUABLE', failed: problems };
  }
  const failed: string[] = [];
  if (!(b.meanExcess.replication > 0)) failed.push(`Test A lower bound at ${H5_REPLICATION_ALPHA} <= 0`);
  if (!(b.delta.replication > 0)) failed.push(`Test B lower bound at ${H5_REPLICATION_ALPHA} <= 0`);
  const { LONG_BUILD: longSide, SHORT_BUILD: shortSide } = s.sideExcess;
  if (!(longSide !== null && longSide > 0 && shortSide !== null && shortSide > 0)) failed.push('P5 a side is not positive');
  return { horizon: s.horizon, verdict: failed.length === 0 ? 'REPLICATED' : 'NOT_REPLICATED', failed };
}

// ---- Run ----

export interface H5Horizon {
  horizon: number;
  drift: Record<string, number>;
  stats: HorizonStats;
  judgement: Judgement<H5Verdict>;
  replication: Judgement<H5ReplicationVerdict>;
}

export type H5Run =
  | { status: 'NOT_RUN'; reason: string; dataCutoff: number | null; usableDays: string[]; excludedDays: string[] }
  | { status: 'RUN'; dataCutoff: number | null; usableDays: string[]; excludedDays: string[]; horizons: H5Horizon[] };

/**
 * Runs the frozen study on the given records. `after` keeps only records strictly later than that time: use the previous
 * run's dataCutoff for a replication run, so the sample is recorded after the lead.
 */
export function runH5Study(input: { symbols: readonly StudySymbolInput[]; after?: number }): H5Run {
  const after = input.after;
  const filtered = input.symbols.map(({ symbol, records }) => ({
    symbol,
    records: after === undefined ? records : records.filter((r) => r.t > after),
  }));
  let dataCutoff: number | null = null;
  for (const { records } of filtered) {
    for (const r of records) if (dataCutoff === null || r.t > dataCutoff) dataCutoff = r.t;
  }
  const { usableDays, excludedDays } = usableDaysOf(filtered);
  if (usableDays.length < H5_MIN_USABLE_DAYS) {
    return {
      status: 'NOT_RUN',
      reason: `usable days ${usableDays.length} < ${H5_MIN_USABLE_DAYS} (excluded ${excludedDays.length})`,
      dataCutoff, usableDays, excludedDays,
    };
  }
  const usable = new Set(usableDays);
  const isUsableDay = (day: string): boolean => usable.has(day);
  const bySymbol: SymbolEvents[] = filtered.map(({ symbol, records }) => {
    const series = buildSeries(symbol, cleanRecords(records));
    return { series, labelled: labelEvents(series, isUsableDay) };
  });
  const symbols = filtered.map((s) => s.symbol);
  const horizons: H5Horizon[] = H5_HORIZONS.map((h) => {
    const { events, drift } = horizonEvents(bySymbol, h, isUsableDay);
    const stats = horizonStats(events, usableDays, h, symbols);
    return { horizon: h, drift, stats, judgement: judgeHorizon(stats, symbols), replication: judgeReplication(stats) };
  });
  return { status: 'RUN', dataCutoff, usableDays, excludedDays, horizons };
}
