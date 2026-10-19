import { ALMA_SOURCES, NATIVE_TIMEFRAMES, type AlmaSource, type NativeTimeframe } from './types.js';

/**
 * Deterministic stage-1 grid generator for the predeclared search space in
 * config/search-space.v1.json. Pure and side-effect free: the same config and
 * timeframe list always produce the same candidates in the same order, so a
 * candidate's id and position are stable across runs and machines.
 *
 * Stage 1 ("coarse_same_timeframe") axes:
 *   valid (fast < slow) length pairs
 *     x shared offset grid
 *     x shared sigma grid
 *     x source subset (searchSchedule stage 1 pins ["close", "hlc3"])
 *     x every native timeframe
 */

export interface SearchSpaceConfig {
  fastLength: number[];
  slowLength: number[];
  offsetCoarseShared: number[];
  sigmaCoarseShared: number[];
  source: AlmaSource[];
}

export interface FastSlowPair {
  fast: number;
  slow: number;
}

export interface Stage1Candidate {
  /** Stable human-readable id; encodes every axis value. */
  id: string;
  timeframe: NativeTimeframe;
  fastLength: number;
  slowLength: number;
  offset: number;
  sigma: number;
  source: AlmaSource;
}

export interface Stage1Grid {
  candidates: Stage1Candidate[];
  counts: {
    pairs: number;
    offsets: number;
    sigmas: number;
    sources: number;
    timeframes: number;
    total: number;
  };
}

function numberArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('search space field "' + field + '" must be a non-empty array');
  }
  const seen = new Set<number>();
  for (const item of value) {
    const parsed = Number(item);
    if (!Number.isFinite(parsed)) {
      throw new Error('search space field "' + field + '" contains a non-finite value: ' + String(item));
    }
    if (seen.has(parsed)) {
      throw new Error('search space field "' + field + '" contains duplicate value: ' + String(item));
    }
    seen.add(parsed);
  }
  return value.map((item) => Number(item));
}

/** Validates and normalizes the raw JSON config; rejects anything ambiguous. */
export function parseSearchSpace(raw: unknown): SearchSpaceConfig {
  if (!raw || typeof raw !== 'object') throw new Error('search space config must be an object');
  const root = raw as Record<string, unknown>;
  const alma = root.alma;
  if (!alma || typeof alma !== 'object') throw new Error('search space config is missing "alma"');
  const section = alma as Record<string, unknown>;

  const fastLength = numberArray(section.fastLength, 'alma.fastLength');
  const slowLength = numberArray(section.slowLength, 'alma.slowLength');
  const offsetCoarseShared = numberArray(section.offsetCoarseShared, 'alma.offsetCoarseShared');
  const sigmaCoarseShared = numberArray(section.sigmaCoarseShared, 'alma.sigmaCoarseShared');

  const sourceRaw = section.source;
  if (!Array.isArray(sourceRaw) || sourceRaw.length === 0) {
    throw new Error('search space field "alma.source" must be a non-empty array');
  }
  const seenSource = new Set<string>();
  for (const item of sourceRaw) {
    const key = String(item);
    if (!(ALMA_SOURCES as readonly string[]).includes(key)) {
      throw new Error('alma.source contains an unsupported source: ' + key);
    }
    if (seenSource.has(key)) {
      throw new Error('alma.source contains duplicate value: ' + key);
    }
    seenSource.add(key);
  }

  for (const [field, values] of [
    ['alma.fastLength', fastLength],
    ['alma.slowLength', slowLength],
  ] as const) {
    for (const value of values) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(field + ' must contain positive integers, got ' + String(value));
      }
    }
  }
  for (const value of offsetCoarseShared) {
    if (value < 0 || value > 1) {
      throw new Error('alma.offsetCoarseShared values must be within [0, 1], got ' + String(value));
    }
  }
  for (const value of sigmaCoarseShared) {
    if (value <= 0) {
      throw new Error('alma.sigmaCoarseShared values must be > 0, got ' + String(value));
    }
  }

  return {
    fastLength: [...fastLength].sort((a, b) => a - b),
    slowLength: [...slowLength].sort((a, b) => a - b),
    offsetCoarseShared: [...offsetCoarseShared].sort((a, b) => a - b),
    sigmaCoarseShared: [...sigmaCoarseShared].sort((a, b) => a - b),
    source: sourceRaw.map((value) => String(value) as AlmaSource).sort(),
  };
}

/** All fast/slow combinations with fast strictly less than slow, ordered ascending. */
export function validPairs(fastLengths: readonly number[], slowLengths: readonly number[]): FastSlowPair[] {
  const pairs: FastSlowPair[] = [];
  for (const fast of fastLengths) {
    for (const slow of slowLengths) {
      if (fast < slow) pairs.push({ fast, slow });
    }
  }
  return pairs;
}

function formatNumber(value: number): string {
  return String(value);
}

export function candidateId(
  timeframe: NativeTimeframe,
  fast: number,
  slow: number,
  offset: number,
  sigma: number,
  source: AlmaSource,
): string {
  return [
    's1',
    timeframe,
    'f' + formatNumber(fast) + '-s' + formatNumber(slow),
    'o' + formatNumber(offset),
    'g' + formatNumber(sigma),
    source,
  ].join('|');
}

export function enumerateStage1(
  config: SearchSpaceConfig,
  timeframes: readonly NativeTimeframe[] = NATIVE_TIMEFRAMES,
  sourceSubset: readonly AlmaSource[] = ['close', 'hlc3'],
): Stage1Grid {
  if (timeframes.length === 0) throw new Error('at least one timeframe is required');
  for (const timeframe of timeframes) {
    if (!(NATIVE_TIMEFRAMES as readonly string[]).includes(timeframe)) {
      throw new Error('unsupported timeframe: ' + String(timeframe));
    }
  }
  for (const source of sourceSubset) {
    if (!config.source.includes(source)) {
      throw new Error('source subset value ' + source + ' is not part of the declared source axis');
    }
  }

  const pairs = validPairs(config.fastLength, config.slowLength);
  if (pairs.length === 0) throw new Error('no valid fast<slow pairs in the search space');

  const sources = [...sourceSubset].sort();
  const candidates: Stage1Candidate[] = [];
  for (const timeframe of timeframes) {
    for (const pair of pairs) {
      for (const offset of config.offsetCoarseShared) {
        for (const sigma of config.sigmaCoarseShared) {
          for (const source of sources) {
            candidates.push({
              id: candidateId(timeframe, pair.fast, pair.slow, offset, sigma, source),
              timeframe,
              fastLength: pair.fast,
              slowLength: pair.slow,
              offset,
              sigma,
              source,
            });
          }
        }
      }
    }
  }

  return {
    candidates,
    counts: {
      pairs: pairs.length,
      offsets: config.offsetCoarseShared.length,
      sigmas: config.sigmaCoarseShared.length,
      sources: sources.length,
      timeframes: timeframes.length,
      total: candidates.length,
    },
  };
}
