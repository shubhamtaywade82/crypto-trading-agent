import { aggregateMinutes, ingestMinutes, type IngestReport } from './bars.js';
import { DEFAULT_REJECTION_CONFIG, assertRejectionConfig, detectRejections } from './detector.js';
import {
  DEFAULT_CLUSTER_ATR_FRACTION, DEFAULT_MAX_AGE_BARS, DEFAULT_MAX_ZONE_WIDTH_ATR, DEFAULT_WEAKENING_TESTS,
  assertZoneOptions, buildRejectionZones, findZoneConfluence, type ZoneOptions,
} from './zones.js';
import {
  REJECTION_TIMEFRAMES, TIMEFRAME_MS,
  type FlowBar, type MinuteInput, type RejectionConfig, type RejectionEvent, type RejectionTimeframe,
  type RejectionZone, type ZoneConfluence,
} from './types.js';

export interface RejectionEngineOptions {
  /** Timeframes to analyse. Defaults to every supported timeframe. */
  timeframes?: readonly RejectionTimeframe[];
  rejection?: Partial<RejectionConfig>;
  zone?: Partial<Omit<ZoneOptions, 'confirmBars'>>;
  /** Overrides the default age budget for specific timeframes. */
  maxAgeBars?: Partial<Record<RejectionTimeframe, number>>;
}

export interface ResolvedEngineConfig {
  rejection: RejectionConfig;
  zoneFor: (timeframe: RejectionTimeframe) => ZoneOptions;
}

export function resolveEngineConfig(opts: RejectionEngineOptions = {}): ResolvedEngineConfig {
  const rejection: RejectionConfig = { ...DEFAULT_REJECTION_CONFIG, ...opts.rejection };
  assertRejectionConfig(rejection);
  const zoneFor = (timeframe: RejectionTimeframe): ZoneOptions => {
    const zone: ZoneOptions = {
      clusterAtrFraction: opts.zone?.clusterAtrFraction ?? DEFAULT_CLUSTER_ATR_FRACTION,
      maxZoneWidthAtr: opts.zone?.maxZoneWidthAtr ?? DEFAULT_MAX_ZONE_WIDTH_ATR,
      weakeningTests: opts.zone?.weakeningTests ?? DEFAULT_WEAKENING_TESTS,
      maxAgeBars: opts.maxAgeBars?.[timeframe] ?? DEFAULT_MAX_AGE_BARS[timeframe],
      confirmBars: rejection.confirmBars,
    };
    assertZoneOptions(zone);
    return zone;
  };
  return { rejection, zoneFor };
}

export interface TimeframeAnalysis {
  timeframe: RejectionTimeframe;
  /** Aggregated bars, including incomplete ones. The still-forming final bucket is excluded. */
  bars: number;
  completeBars: number;
  incompleteBars: number;
  events: RejectionEvent[];
  zones: RejectionZone[];
}

export interface RejectionSnapshot {
  symbol: string;
  /** Known-at time of the last accepted 1m bar. Null when nothing was accepted. */
  asOf: number | null;
  ingest: Omit<IngestReport, 'bars'> & { accepted: number };
  timeframes: Partial<Record<RejectionTimeframe, TimeframeAnalysis>>;
  confluence: ZoneConfluence[];
}

/**
 * Detects and clusters rejections on one timeframe's bars. The input must be strictly ascending and single-timeframe.
 * Anything else is a caller bug, so it throws instead of guessing.
 */
export function analyzeTimeframe(
  bars: readonly FlowBar[],
  timeframe: RejectionTimeframe,
  config: ResolvedEngineConfig,
): TimeframeAnalysis {
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;
    if (bar.timeframe !== timeframe) throw new Error(`analyzeTimeframe(${timeframe}) received a ${bar.timeframe} bar`);
    const prev = bars[i - 1];
    if (prev && bar.openTime <= prev.openTime) throw new Error(`analyzeTimeframe(${timeframe}) requires strictly ascending bars`);
  }

  const events = detectRejections(bars, config.rejection);
  const zones = buildRejectionZones(bars, events, config.zoneFor(timeframe));
  const incompleteBars = bars.filter((b) => !b.complete).length;
  return { timeframe, bars: bars.length, completeBars: bars.length - incompleteBars, incompleteBars, events, zones };
}

/**
 * Full pipeline for one symbol: validate and de-duplicate raw 1m klines, aggregate each timeframe from those minutes,
 * run detection and zone building per timeframe, then report bands where live zones from several timeframes agree.
 *
 * Deterministic and clock-free. The same inputs always produce the same snapshot, so a historical run and a live
 * run over the same data agree.
 */
export function buildRejectionSnapshot(
  symbol: string,
  minutes: readonly MinuteInput[],
  options: RejectionEngineOptions = {},
): RejectionSnapshot {
  const config = resolveEngineConfig(options);
  const ingest = ingestMinutes(symbol, minutes);
  const timeframes = options.timeframes ?? REJECTION_TIMEFRAMES;

  const analyses: Partial<Record<RejectionTimeframe, TimeframeAnalysis>> = {};
  const allZones: RejectionZone[] = [];
  for (const tf of timeframes) {
    const bars = aggregateMinutes(ingest.bars, tf);
    const analysis = analyzeTimeframe(bars, tf, config);
    analyses[tf] = analysis;
    allZones.push(...analysis.zones);
  }

  const last = ingest.bars[ingest.bars.length - 1];
  const { bars: acceptedBars, ...ingestSummary } = ingest;
  return {
    symbol,
    asOf: last ? last.openTime + TIMEFRAME_MS['1m'] : null,
    ingest: { ...ingestSummary, accepted: acceptedBars.length },
    timeframes: analyses,
    confluence: findZoneConfluence(allZones),
  };
}
