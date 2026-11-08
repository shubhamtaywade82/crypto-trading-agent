import { utcDay } from '../../research/Bootstrap.js';
import { TIMEFRAME_MS, type FlowBar, type MinuteInput, type OhlcvInput, type RejectionTimeframe } from './types.js';

export const MINUTE_MS = TIMEFRAME_MS['1m'];
const VOLUME_TOLERANCE = 1e-9;

export type OhlcvValidation = { ok: true } | { ok: false; reason: string };

/** Structural checks on one kline. Anything failing here never reaches the canonical store. */
export function validateOhlcv(bar: OhlcvInput, timeframe: RejectionTimeframe): OhlcvValidation {
  const tfMs = TIMEFRAME_MS[timeframe];
  if (!Number.isSafeInteger(bar.openTime) || bar.openTime < 0 || bar.openTime % tfMs !== 0) {
    return { ok: false, reason: 'OPEN_TIME_NOT_ALIGNED' };
  }
  const prices = [bar.open, bar.high, bar.low, bar.close];
  if (!prices.every(Number.isFinite)) return { ok: false, reason: 'NON_FINITE_PRICE' };
  if (!(bar.low > 0)) return { ok: false, reason: 'NON_POSITIVE_PRICE' };
  if (bar.high < bar.low) return { ok: false, reason: 'HIGH_BELOW_LOW' };
  if (bar.open > bar.high || bar.open < bar.low || bar.close > bar.high || bar.close < bar.low) {
    return { ok: false, reason: 'OHLC_OUTSIDE_RANGE' };
  }
  const volumes = [bar.baseVolume, bar.quoteVolume, bar.takerBuyBaseVolume];
  if (!volumes.every((v) => Number.isFinite(v) && v >= 0)) return { ok: false, reason: 'NEGATIVE_OR_NON_FINITE_VOLUME' };
  if (bar.takerBuyBaseVolume > bar.baseVolume * (1 + VOLUME_TOLERANCE) + VOLUME_TOLERANCE) {
    return { ok: false, reason: 'TAKER_BUY_EXCEEDS_VOLUME' };
  }
  if (!Number.isSafeInteger(bar.trades) || bar.trades < 0) return { ok: false, reason: 'INVALID_TRADE_COUNT' };
  return { ok: true };
}

const SAME_FIELDS = [
  'symbol', 'openTime', 'open', 'high', 'low', 'close', 'baseVolume', 'quoteVolume', 'takerBuyBaseVolume', 'trades',
] as const;

const sameInput = (a: OhlcvInput, b: OhlcvInput): boolean => SAME_FIELDS.every((k) => a[k] === b[k]);

export interface MinuteGap {
  /** openTime of the last accepted minute before the gap. */
  fromOpenTime: number;
  /** openTime of the first accepted minute after the gap. */
  toOpenTime: number;
  missingMinutes: number;
}

export interface IngestReport {
  symbol: string;
  /** Accepted 1m bars, strictly ascending, all complete. */
  bars: FlowBar[];
  rejected: { openTime: number; reason: string }[];
  /** openTimes with conflicting duplicate copies. Both copies are excluded, so the minute counts as missing. */
  conflicts: number[];
  /** Identical duplicate copies collapsed into one. */
  duplicates: number;
  gaps: MinuteGap[];
}

/**
 * Builds the canonical 1m store for one symbol from a batch of raw 1m klines.
 *
 * Rules, applied in this order:
 * 1. Inputs for another symbol or failing `validateOhlcv` are rejected and reported.
 * 2. Identical duplicates collapse into one bar. Conflicting duplicates exclude the minute entirely (fail closed).
 * 3. Gaps between accepted minutes are reported. They are never filled.
 */
export function ingestMinutes(symbol: string, inputs: readonly MinuteInput[]): IngestReport {
  const rejected: IngestReport['rejected'] = [];
  const groups = new Map<number, MinuteInput[]>();

  for (const input of inputs) {
    if (input.symbol !== symbol) {
      rejected.push({ openTime: input.openTime, reason: 'SYMBOL_MISMATCH' });
      continue;
    }
    const check = validateOhlcv(input, '1m');
    if (!check.ok) {
      rejected.push({ openTime: input.openTime, reason: check.reason });
      continue;
    }
    const group = groups.get(input.openTime);
    if (group) group.push(input);
    else groups.set(input.openTime, [input]);
  }

  const bars: FlowBar[] = [];
  const conflicts: number[] = [];
  let duplicates = 0;

  for (const openTime of [...groups.keys()].sort((a, b) => a - b)) {
    const copies = groups.get(openTime) ?? [];
    const first = copies[0];
    if (!first) continue;
    if (copies.some((c) => !sameInput(c, first))) {
      conflicts.push(openTime);
      continue;
    }
    duplicates += copies.length - 1;
    bars.push(toFlowBar(first, '1m', 1));
  }

  const gaps: MinuteGap[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (!prev || !cur) continue;
    const step = (cur.openTime - prev.openTime) / MINUTE_MS;
    if (step > 1) gaps.push({ fromOpenTime: prev.openTime, toOpenTime: cur.openTime, missingMinutes: step - 1 });
  }

  return { symbol, bars, rejected, conflicts, duplicates, gaps };
}

function toFlowBar(input: OhlcvInput, timeframe: RejectionTimeframe, minuteCount: number): FlowBar {
  return {
    symbol: input.symbol,
    timeframe,
    openTime: input.openTime,
    open: input.open,
    high: input.high,
    low: input.low,
    close: input.close,
    baseVolume: input.baseVolume,
    quoteVolume: input.quoteVolume,
    takerBuyBaseVolume: input.takerBuyBaseVolume,
    trades: input.trades,
    minuteCount,
    complete: true,
  };
}

/**
 * Aggregates a sorted, de-duplicated 1m series into `timeframe` bars.
 *
 * - A bucket with the full count of aligned minutes is complete.
 * - A bucket with missing minutes is kept but marked incomplete. Detectors must not use it.
 * - The final bucket is dropped when incomplete: with no later data it may still be forming, so it is not yet known.
 *
 * Aggregation is causal: a bar's fields depend only on minutes inside its own bucket.
 */
export function aggregateMinutes(minutes: readonly FlowBar[], timeframe: RejectionTimeframe): FlowBar[] {
  for (const m of minutes) {
    if (m.timeframe !== '1m') throw new Error(`aggregateMinutes expects 1m bars, got ${m.timeframe}`);
  }
  if (timeframe === '1m') return minutes.map((m) => ({ ...m }));

  const tfMs = TIMEFRAME_MS[timeframe];
  const expected = tfMs / MINUTE_MS;
  const buckets = new Map<number, FlowBar[]>();
  for (const m of minutes) {
    const start = Math.floor(m.openTime / tfMs) * tfMs;
    const bucket = buckets.get(start);
    if (bucket) bucket.push(m);
    else buckets.set(start, [m]);
  }

  const starts = [...buckets.keys()].sort((a, b) => a - b);
  const out: FlowBar[] = [];
  starts.forEach((start, idx) => {
    const members = (buckets.get(start) ?? []).sort((a, b) => a.openTime - b.openTime);
    const first = members[0];
    const last = members[members.length - 1];
    if (!first || !last) return;
    const complete = members.length === expected;
    if (!complete && idx === starts.length - 1) return;
    out.push({
      symbol: first.symbol,
      timeframe,
      openTime: start,
      open: first.open,
      high: Math.max(...members.map((m) => m.high)),
      low: Math.min(...members.map((m) => m.low)),
      close: last.close,
      baseVolume: sum(members, (m) => m.baseVolume),
      quoteVolume: sum(members, (m) => m.quoteVolume),
      takerBuyBaseVolume: sum(members, (m) => m.takerBuyBaseVolume),
      trades: sum(members, (m) => m.trades),
      minuteCount: members.length,
      complete,
    });
  });
  return out;
}

const sum = (xs: readonly FlowBar[], f: (x: FlowBar) => number): number => xs.reduce((acc, x) => acc + f(x), 0);

/** Validates one closed kline and returns it as a complete FlowBar of the given timeframe. */
export function flowBarFromInput(
  input: OhlcvInput,
  timeframe: RejectionTimeframe,
): { ok: true; bar: FlowBar } | { ok: false; reason: string } {
  const check = validateOhlcv(input, timeframe);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, bar: toFlowBar(input, timeframe, TIMEFRAME_MS[timeframe] / MINUTE_MS) };
}

/**
 * Converts an exchange kline that is already closed (for example a native 5m/15m/1h bar from a recorded file) into a
 * complete FlowBar. Returns a validation reason instead of throwing, so one bad record cannot abort a replay.
 */
export function flowBarFromKline(
  symbol: string,
  timeframe: RejectionTimeframe,
  raw: { openTime: number; open: string | number; high: string | number; low: string | number; close: string | number;
    volume: string | number; quoteVolume: string | number; takerBuyBase: string | number; trades: number },
): { ok: true; bar: FlowBar } | { ok: false; reason: string } {
  const input: OhlcvInput = {
    symbol,
    openTime: raw.openTime,
    open: Number(raw.open),
    high: Number(raw.high),
    low: Number(raw.low),
    close: Number(raw.close),
    baseVolume: Number(raw.volume),
    quoteVolume: Number(raw.quoteVolume),
    takerBuyBaseVolume: Number(raw.takerBuyBase),
    trades: raw.trades,
  };
  const check = validateOhlcv(input, timeframe);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, bar: toFlowBar(input, timeframe, TIMEFRAME_MS[timeframe] / MINUTE_MS) };
}

export interface DayCoverage {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  present: number;
  /** Minutes in the day: 1440. */
  expected: number;
  coverage: number;
  /** Gaps that begin on this day, each a run of one or more missing minutes. */
  gaps: number;
}

/**
 * Per-day completeness of a 1m series, for the "complete, validated, replayable" criterion. A day with coverage below
 * 1 should not be used for an experiment without an explicit decision.
 */
export function minuteCoverageByDay(minutes: readonly FlowBar[]): DayCoverage[] {
  const byDay = new Map<string, { present: number; gaps: number }>();
  let prev: FlowBar | undefined;
  for (const m of minutes) {
    if (m.timeframe !== '1m') throw new Error(`minuteCoverageByDay expects 1m bars, got ${m.timeframe}`);
    const day = utcDay(m.openTime);
    const entry = byDay.get(day) ?? { present: 0, gaps: 0 };
    entry.present += 1;
    if (prev && m.openTime - prev.openTime > MINUTE_MS) entry.gaps += 1;
    byDay.set(day, entry);
    prev = m;
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([day, v]) => ({
    day,
    present: v.present,
    expected: 1440,
    coverage: v.present / 1440,
    gaps: v.gaps,
  }));
}
