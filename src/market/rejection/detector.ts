import { computeFeatures } from './features.js';
import {
  TIMEFRAME_MS, barKnownAt,
  type FlowBar, type RejectionConfig, type RejectionEvent, type RejectionEventStatus, type ZoneDirection,
} from './types.js';

/** Initial research hypotheses from the design note. They are not validated; change them only through an experiment. */
export const DEFAULT_REJECTION_CONFIG: RejectionConfig = {
  atrPeriod: 14,
  volumeWindow: 20,
  minVolumeHistory: 10,
  lookbackBars: 20,
  minRelativeVolume: 1.5,
  minWickRatio: 0.45,
  confirmBars: 3,
  minReversalAtr: 0.5,
};

/**
 * Fails fast on values that would silently change the meaning of the rules. For example `volumeWindow: 0` would
 * make `slice(-0)` return the whole history as the baseline, and `confirmBars: 0` divides by zero in the speed term.
 */
export function assertRejectionConfig(cfg: RejectionConfig): void {
  const integers: (keyof RejectionConfig)[] = ['atrPeriod', 'volumeWindow', 'minVolumeHistory', 'lookbackBars', 'confirmBars'];
  for (const key of integers) {
    const v = cfg[key];
    if (!Number.isInteger(v) || v < 1) throw new Error(`RejectionConfig.${key} must be an integer >= 1, got ${v}`);
  }
  if (cfg.minVolumeHistory > cfg.volumeWindow) {
    throw new Error(`RejectionConfig.minVolumeHistory (${cfg.minVolumeHistory}) cannot exceed volumeWindow (${cfg.volumeWindow})`);
  }
  for (const key of ['minRelativeVolume', 'minReversalAtr'] as const) {
    const v = cfg[key];
    if (!(Number.isFinite(v) && v > 0)) throw new Error(`RejectionConfig.${key} must be a positive finite number, got ${v}`);
  }
  if (!(Number.isFinite(cfg.minWickRatio) && cfg.minWickRatio >= 0 && cfg.minWickRatio <= 1)) {
    throw new Error(`RejectionConfig.minWickRatio must be in [0, 1], got ${cfg.minWickRatio}`);
  }
}

interface Resolution {
  status: RejectionEventStatus;
  failReason: string | null;
  resolvedAt: number | null;
  reversalAtr: number | null;
  reversalBars: number | null;
}

/**
 * Detects sweep-and-reclaim rejections on one timeframe's bars.
 *
 * Bullish (DEMAND) at bar i, all of which must hold:
 *   - bar i's low takes out the lowest low of the prior `lookbackBars` bars (the reference level);
 *   - bar i closes back above that level (the reclaim);
 *   - the lower wick is at least `minWickRatio` of the bar's range;
 *   - relative volume is at least `minRelativeVolume`.
 * It is then CONFIRMED when the close-to-high displacement reaches `minReversalAtr` ATR within `confirmBars` bars.
 * It FAILS if a later close loses the reference level (RECLAIM_LOST), if the window is broken by a missing or
 * incomplete bar (INCOMPLETE_WINDOW), or if the displacement never arrives (NO_FOLLOW_THROUGH). It stays CANDIDATE
 * when the data ends before the window does. SUPPLY mirrors every rule.
 *
 * Causality: the event at bar i reads bars up to i + confirmBars only, and its outcome is stamped with the known-at
 * time of the bar that resolved it. A same-direction candidate is suppressed for `confirmBars` bars after one starts,
 * so one multi-bar rejection yields one event.
 */
export function detectRejections(bars: readonly FlowBar[], cfg: RejectionConfig = DEFAULT_REJECTION_CONFIG): RejectionEvent[] {
  assertRejectionConfig(cfg);
  const features = computeFeatures(bars, {
    atrPeriod: cfg.atrPeriod,
    volumeWindow: cfg.volumeWindow,
    minVolumeHistory: cfg.minVolumeHistory,
  });
  const events: RejectionEvent[] = [];
  const cooldownUntil: Record<ZoneDirection, number> = { DEMAND: -1, SUPPLY: -1 };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const f = features[i];
    if (!bar || !f || !bar.complete) continue;
    if (f.atr === null || !(f.atr > 0)) continue;
    if (f.relativeVolume === null || f.relativeVolume < cfg.minRelativeVolume) continue;
    if (!contiguousComplete(bars, i - cfg.lookbackBars, i)) continue;

    let refLow = Number.POSITIVE_INFINITY;
    let refHigh = Number.NEGATIVE_INFINITY;
    for (let k = i - cfg.lookbackBars; k < i; k++) {
      const prior = bars[k];
      if (!prior) continue;
      refLow = Math.min(refLow, prior.low);
      refHigh = Math.max(refHigh, prior.high);
    }

    for (const direction of ['DEMAND', 'SUPPLY'] as const) {
      if (i <= cooldownUntil[direction]) continue;
      const demand = direction === 'DEMAND';
      const level = demand ? refLow : refHigh;
      const swept = demand ? bar.low < level : bar.high > level;
      const reclaimed = demand ? bar.close > level : bar.close < level;
      const wick = demand ? f.lowerWickRatio : f.upperWickRatio;
      if (!swept || !reclaimed || wick === null || f.closeLocation === null) continue;
      if (wick < cfg.minWickRatio) continue;

      const resolution = resolveCandidate(bars, i, demand, level, f.atr, cfg);
      const extreme = demand ? bar.low : bar.high;
      const deltaAgainst = demand ? f.deltaRatio < 0 : f.deltaRatio > 0;
      const kind = deltaAgainst ? 'ABSORPTION_LIKE' : 'REJECTION';
      const evidence = [
        `${direction} sweep: ${demand ? 'low' : 'high'} ${extreme} ${demand ? '<' : '>'} ref ${level}`,
        `reclaim: close ${bar.close} ${demand ? '>' : '<'} ref ${level}`,
        `wick ${wick.toFixed(3)} >= ${cfg.minWickRatio}`,
        `relVol ${f.relativeVolume.toFixed(2)} >= ${cfg.minRelativeVolume}`,
        `delta ratio ${f.deltaRatio.toFixed(3)} (${kind})`,
        resolution.status === 'CONFIRMED'
          ? `CONFIRMED: displacement ${resolution.reversalAtr?.toFixed(2)} ATR in ${resolution.reversalBars} bar(s)`
          : resolution.status === 'FAILED'
            ? `FAILED: ${resolution.failReason}`
            : 'CANDIDATE: window not yet complete',
      ];

      events.push({
        id: `${bar.symbol}|${bar.timeframe}|${direction}|${bar.openTime}`,
        symbol: bar.symbol,
        timeframe: bar.timeframe,
        direction,
        kind,
        status: resolution.status,
        failReason: resolution.failReason,
        sweepOpenTime: bar.openTime,
        resolvedAt: resolution.resolvedAt,
        referenceLevel: level,
        extreme,
        zoneLow: demand ? extreme : level,
        zoneHigh: demand ? level : extreme,
        reclaimClose: bar.close,
        atr: f.atr,
        relativeVolume: f.relativeVolume,
        volumeDelta: f.volumeDelta,
        deltaRatio: f.deltaRatio,
        wickRatio: wick,
        closeLocation: f.closeLocation,
        reversalAtr: resolution.reversalAtr,
        reversalBars: resolution.reversalBars,
        evidence,
      });
      cooldownUntil[direction] = i + cfg.confirmBars;
    }
  }

  return events;
}

/** Walks the confirmation window after the sweep bar. Pure: reads only bars[i+1 .. i+confirmBars]. */
function resolveCandidate(
  bars: readonly FlowBar[],
  i: number,
  demand: boolean,
  level: number,
  atr: number,
  cfg: RejectionConfig,
): Resolution {
  const sweep = bars[i];
  if (!sweep) throw new Error(`resolveCandidate: missing sweep bar at ${i}`);
  const tfMs = TIMEFRAME_MS[sweep.timeframe];
  let best = 0;

  for (let j = i + 1; j <= i + cfg.confirmBars; j++) {
    const bar = bars[j];
    if (!bar) {
      return { status: 'CANDIDATE', failReason: null, resolvedAt: null, reversalAtr: best / atr, reversalBars: null };
    }
    const prev = bars[j - 1];
    const contiguous = prev !== undefined && bar.openTime - prev.openTime === tfMs;
    if (!bar.complete || !contiguous) {
      return { status: 'FAILED', failReason: 'INCOMPLETE_WINDOW', resolvedAt: barKnownAt(bar), reversalAtr: best / atr, reversalBars: j - i };
    }
    const lost = demand ? bar.close < level : bar.close > level;
    if (lost) {
      return { status: 'FAILED', failReason: 'RECLAIM_LOST', resolvedAt: barKnownAt(bar), reversalAtr: best / atr, reversalBars: j - i };
    }
    const displacement = demand ? bar.high - sweep.close : sweep.close - bar.low;
    best = Math.max(best, displacement);
    if (best / atr >= cfg.minReversalAtr) {
      return { status: 'CONFIRMED', failReason: null, resolvedAt: barKnownAt(bar), reversalAtr: best / atr, reversalBars: j - i };
    }
  }

  const last = bars[i + cfg.confirmBars];
  return {
    status: 'FAILED',
    failReason: 'NO_FOLLOW_THROUGH',
    resolvedAt: last ? barKnownAt(last) : null,
    reversalAtr: best / atr,
    reversalBars: cfg.confirmBars,
  };
}

/** True when bars[from..to] exist, are all complete, and are contiguous in time. */
function contiguousComplete(bars: readonly FlowBar[], from: number, to: number): boolean {
  if (from < 0) return false;
  for (let k = from; k <= to; k++) {
    const bar = bars[k];
    if (!bar || !bar.complete) return false;
    if (k > from) {
      const prev = bars[k - 1];
      if (!prev || bar.openTime - prev.openTime !== TIMEFRAME_MS[bar.timeframe]) return false;
    }
  }
  return true;
}
