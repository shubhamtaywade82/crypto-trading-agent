import type { Side } from '../../types.js';
import { computeFeatures } from '../rejection/features.js';
import { TIMEFRAME_MS, barKnownAt, type FlowBar, type RejectionEvent, type ZoneDirection } from '../rejection/types.js';
import { classifyVolatilityPhase } from '../VolatilityPhase.js';
import { confirmedPivots, type Pivot } from './structure.js';

/**
 * Expansion context: a per-bar state machine for one side. A transition is taken only when its evidence holds on the
 * current bar AND the transition is listed in ALLOWED_TRANSITIONS. A bar makes at most one transition, so a sequence
 * such as SWEEP → REJECTION → STRUCTURE → EXPANSION has to unfold bar by bar. Each state also decays to NONE after
 * `maxStateBars` without a transition.
 *
 * Evidence uses bars at or before t only: rejection events are read at their known-at time, and swing pivots at their
 * confirmation bar. Incomplete or non-contiguous bars reset the machine to NONE.
 */

export const EXPANSION_CONTEXTS = [
  'NONE',
  'RANGE_COMPRESSION',
  'LIQUIDITY_SWEEP',
  'ABSORPTION_CANDIDATE',
  'REJECTION_CONFIRMED',
  'STRUCTURE_SHIFT',
  'VOLATILITY_EXPANSION',
  'TREND_CONTINUATION',
  'EXPANSION_EXHAUSTION',
] as const;

export type ExpansionContext = (typeof EXPANSION_CONTEXTS)[number];

export const ALLOWED_TRANSITIONS: Record<ExpansionContext, readonly ExpansionContext[]> = {
  NONE: ['RANGE_COMPRESSION', 'LIQUIDITY_SWEEP', 'ABSORPTION_CANDIDATE'],
  RANGE_COMPRESSION: ['LIQUIDITY_SWEEP', 'ABSORPTION_CANDIDATE', 'VOLATILITY_EXPANSION', 'NONE'],
  LIQUIDITY_SWEEP: ['REJECTION_CONFIRMED', 'ABSORPTION_CANDIDATE', 'NONE'],
  ABSORPTION_CANDIDATE: ['REJECTION_CONFIRMED', 'STRUCTURE_SHIFT', 'NONE'],
  REJECTION_CONFIRMED: ['STRUCTURE_SHIFT', 'VOLATILITY_EXPANSION', 'NONE'],
  STRUCTURE_SHIFT: ['VOLATILITY_EXPANSION', 'TREND_CONTINUATION', 'EXPANSION_EXHAUSTION', 'NONE'],
  VOLATILITY_EXPANSION: ['TREND_CONTINUATION', 'EXPANSION_EXHAUSTION', 'NONE'],
  TREND_CONTINUATION: ['EXPANSION_EXHAUSTION', 'NONE'],
  EXPANSION_EXHAUSTION: ['RANGE_COMPRESSION', 'LIQUIDITY_SWEEP', 'NONE'],
};

/** States in which a trade may be evaluated. Exhaustion, compression and sweeps are watch or avoid states. */
export const ENTRY_CONTEXTS: readonly ExpansionContext[] = [
  'REJECTION_CONFIRMED',
  'STRUCTURE_SHIFT',
  'VOLATILITY_EXPANSION',
  'TREND_CONTINUATION',
];

export interface ContextOptions {
  side: Side;
  atrPeriod: number;
  volumeWindow: number;
  minVolumeHistory: number;
  /** Bars of ATR history for the percentile that drives the volatility phase. */
  percentileWindow: number;
  /** Bars on each side that a swing pivot must dominate. */
  swingK: number;
  /** Displacement, in ATR, that qualifies a bar as expansion (or opposing displacement, for exhaustion). */
  expansionAtr: number;
  minRelativeVolume: number;
  /** Bars a state may persist before it decays to NONE. */
  maxStateBars: number;
}

export const DEFAULT_CONTEXT_OPTIONS: Omit<ContextOptions, 'side'> = {
  atrPeriod: 14,
  volumeWindow: 20,
  minVolumeHistory: 10,
  percentileWindow: 100,
  swingK: 2,
  expansionAtr: 1.5,
  minRelativeVolume: 1.5,
  maxStateBars: 96,
};

export interface ContextTransition {
  /** Known-at time of the bar that caused the transition. */
  at: number;
  index: number;
  from: ExpansionContext;
  to: ExpansionContext;
  reason: string;
}

export interface ContextSeries {
  side: Side;
  states: ExpansionContext[];
  transitions: ContextTransition[];
}

/** Minimum ATR history before a percentile is reported. Below it the volatility phase is UNKNOWN. */
const MIN_PERCENTILE_HISTORY = 20;

export function assertContextOptions(o: ContextOptions): void {
  const ints: (keyof ContextOptions)[] = ['atrPeriod', 'volumeWindow', 'minVolumeHistory', 'percentileWindow', 'swingK', 'maxStateBars'];
  for (const key of ints) {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`ContextOptions.${key} must be an integer >= 1, got ${String(v)}`);
  }
  if (o.minVolumeHistory > o.volumeWindow) throw new Error('ContextOptions.minVolumeHistory cannot exceed volumeWindow');
  if (!(Number.isFinite(o.expansionAtr) && o.expansionAtr > 0)) throw new Error('ContextOptions.expansionAtr must be positive');
  if (!(Number.isFinite(o.minRelativeVolume) && o.minRelativeVolume > 0)) throw new Error('ContextOptions.minRelativeVolume must be positive');
}

/** ATR percentile of each bar within its trailing window, or null without enough history. */
export function atrPercentiles(atrs: readonly (number | null)[], window: number): (number | null)[] {
  return atrs.map((atr, t) => {
    if (atr === null) return null;
    let count = 0;
    let atOrBelow = 0;
    for (let j = Math.max(0, t - window + 1); j <= t; j++) {
      const v = atrs[j];
      if (v === null || v === undefined) continue;
      count += 1;
      if (v <= atr) atOrBelow += 1;
    }
    return count >= MIN_PERCENTILE_HISTORY ? (100 * atOrBelow) / count : null;
  });
}

export function classifyExpansionContext(
  bars: readonly FlowBar[],
  events: readonly RejectionEvent[],
  opts: ContextOptions,
): ContextSeries {
  assertContextOptions(opts);
  const s = opts.side === 'LONG' ? 1 : -1;
  const sweepDirection: ZoneDirection = opts.side === 'LONG' ? 'DEMAND' : 'SUPPLY';

  const bySweep = new Map<number, RejectionEvent[]>();
  const byResolve = new Map<number, RejectionEvent[]>();
  for (const e of events) {
    if (e.direction !== sweepDirection) continue;
    const sweepBucket = bySweep.get(e.sweepOpenTime) ?? [];
    sweepBucket.push(e);
    bySweep.set(e.sweepOpenTime, sweepBucket);
    if (e.resolvedAt !== null) {
      const resolveBucket = byResolve.get(e.resolvedAt) ?? [];
      resolveBucket.push(e);
      byResolve.set(e.resolvedAt, resolveBucket);
    }
  }

  const n = bars.length;
  const feats = computeFeatures(bars, {
    atrPeriod: opts.atrPeriod,
    volumeWindow: opts.volumeWindow,
    minVolumeHistory: opts.minVolumeHistory,
  });
  const valid: boolean[] = bars.map((b, i) => {
    if (!b.complete) return false;
    if (i === 0) return true;
    const prev = bars[i - 1];
    return prev !== undefined && prev.complete && b.openTime - prev.openTime === TIMEFRAME_MS[b.timeframe];
  });
  const xHigh = bars.map((b) => (s > 0 ? b.high : -b.low));
  const xLow = bars.map((b) => (s > 0 ? b.low : -b.high));
  const xOpen = bars.map((b) => s * b.open);
  const xClose = bars.map((b) => s * b.close);
  const pivots = confirmedPivots(xHigh, xLow, valid, opts.swingK);
  const pct = atrPercentiles(feats.map((f) => f?.atr ?? null), opts.percentileWindow);

  const states: ExpansionContext[] = [];
  const transitions: ContextTransition[] = [];
  let state: ExpansionContext = 'NONE';
  let since = 0;
  let breakLevel: number | null = null;
  let breakIndex = -1;
  const consumedHighs = new Set<number>();
  let hiKnown = 0;
  let loKnown = 0;

  const record = (t: number, bar: FlowBar, from: ExpansionContext, to: ExpansionContext, reason: string): void => {
    transitions.push({ at: barKnownAt(bar), index: t, from, to, reason });
  };

  for (let t = 0; t < n; t++) {
    const bar = bars[t];
    if (!bar) {
      states.push(state);
      continue;
    }
    if (!valid[t]) {
      if (state !== 'NONE') record(t, bar, state, 'NONE', 'INVALID_BAR');
      state = 'NONE';
      since = 0;
      breakLevel = null;
      states.push(state);
      continue;
    }

    while (hiKnown < pivots.highs.length && (pivots.highs[hiKnown] as Pivot).confirmedAt <= t) hiKnown += 1;
    while (loKnown < pivots.lows.length && (pivots.lows[loKnown] as Pivot).confirmedAt <= t) loKnown += 1;

    // Structure: the most recent confirmed high is a lower high, and this bar closes through it for the first time.
    const lastHigh = hiKnown >= 1 ? pivots.highs[hiKnown - 1] : undefined;
    const priorHigh = hiKnown >= 2 ? pivots.highs[hiKnown - 2] : undefined;
    const prevValid = t >= 1 && valid[t - 1] === true;
    let structureBreak = false;
    if (lastHigh && priorHigh && prevValid && lastHigh.price < priorHigh.price && !consumedHighs.has(lastHigh.index)) {
      const closedThrough = (xClose[t] as number) > lastHigh.price && (xClose[t - 1] as number) <= lastHigh.price;
      if (closedThrough) {
        structureBreak = true;
        consumedHighs.add(lastHigh.index);
        breakLevel = lastHigh.price;
        breakIndex = t;
      }
    }

    // Trend: a higher low, formed after the break, while the close holds above the broken level.
    const lastLow = loKnown >= 1 ? pivots.lows[loKnown - 1] : undefined;
    const priorLow = loKnown >= 2 ? pivots.lows[loKnown - 2] : undefined;
    const trendHold = breakLevel !== null && lastLow !== undefined && priorLow !== undefined
      && lastLow.price > priorLow.price && lastLow.index > breakIndex && (xClose[t] as number) > breakLevel;

    const f = feats[t];
    const atr = f?.atr ?? null;
    const rel = f?.relativeVolume ?? null;
    const range = bar.high - bar.low;
    const big = atr !== null && rel !== null && range >= opts.expansionAtr * atr && rel >= opts.minRelativeVolume;
    const up = (xClose[t] as number) > (xOpen[t] as number);
    const expansion = big && up;
    const opposing = big && !up;
    const breakLost = breakLevel !== null && (xClose[t] as number) < breakLevel;

    const sweeps = bySweep.get(bar.openTime) ?? [];
    const resolves = byResolve.get(barKnownAt(bar)) ?? [];
    const sweep = sweeps.length > 0;
    const absorb = sweeps.some((e) => e.kind === 'ABSORPTION_LIKE');
    const confirm = resolves.some((e) => e.status === 'CONFIRMED');
    const failed = resolves.some((e) => e.status === 'FAILED');
    const compressed = classifyVolatilityPhase(pct[t] ?? null) === 'COMPRESSED';
    const inStructureFamily = state === 'STRUCTURE_SHIFT' || state === 'VOLATILITY_EXPANSION' || state === 'TREND_CONTINUATION';

    // Priority order. The first candidate whose evidence holds and whose edge is allowed is taken.
    const candidates: [ExpansionContext, boolean, string][] = [
      ['NONE', failed && (state === 'LIQUIDITY_SWEEP' || state === 'ABSORPTION_CANDIDATE'), 'SWEEP_FAILED_WITHOUT_RECLAIM'],
      ['EXPANSION_EXHAUSTION', inStructureFamily && (opposing || breakLost), 'OPPOSING_DISPLACEMENT_OR_LEVEL_LOST'],
      ['TREND_CONTINUATION', inStructureFamily && trendHold, 'HIGHER_LOW_HELD_ABOVE_BREAK'],
      ['VOLATILITY_EXPANSION', expansion, 'DIRECTIONAL_EXPANSION'],
      ['STRUCTURE_SHIFT', structureBreak, 'LOWER_HIGH_BROKEN'],
      ['REJECTION_CONFIRMED', confirm, 'RECLAIM_CONFIRMED'],
      ['ABSORPTION_CANDIDATE', absorb, 'SELL_FLOW_ABSORBED_AT_SWEEP'],
      ['LIQUIDITY_SWEEP', sweep, 'LIQUIDITY_SWEPT'],
      ['RANGE_COMPRESSION', compressed, 'ATR_COMPRESSED'],
      ['NONE', state !== 'NONE' && since >= opts.maxStateBars, 'STALE'],
    ];

    let moved = false;
    for (const [to, cond, reason] of candidates) {
      if (!cond || to === state) continue;
      if (!ALLOWED_TRANSITIONS[state].includes(to)) continue;
      record(t, bar, state, to, reason);
      state = to;
      since = 0;
      if (to === 'NONE') breakLevel = null;
      moved = true;
      break;
    }
    if (!moved) since += 1;
    states.push(state);
  }

  return { side: opts.side, states, transitions };
}
