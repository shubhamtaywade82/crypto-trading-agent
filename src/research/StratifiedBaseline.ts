import type { Candle } from '../types.js';
import type { MarketRegime } from '../market/types.js';
import type { CostRates } from '../risk/rrProfile.js';
import { simulateBracket } from '../learning/HypotheticalOutcome.js';
import { mulberry32 } from './Bootstrap.js';

export interface StratifiedBar {
  candle: Candle;
  regime: MarketRegime;
  atr: number;
}

export interface BaselineConfig {
  seed: number;
  samplesPerStrata: number;
  stopAtrMultiple: number;
  targetRewardRisk: number;
  maxHoldBars: number;
  costs: CostRates;
}

export interface BaselineEntry {
  symbol: string;
  regime: MarketRegime;
  side: 'LONG' | 'SHORT';
  entryTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskDistance: number;
}

export interface BaselineTradeResult {
  entry: BaselineEntry;
  outcome: 'TP' | 'SL' | 'TIMEOUT';
  grossR: number;
  netR: number;
  mfeR: number;
  maeR: number;
  exitTime: number;
  durationMs: number;
}

export interface StrataSummary {
  regime: MarketRegime;
  n: number;
  winRate: number;
  meanNetR: number;
  meanGrossR: number;
  profitFactor: number | null;
}

export const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  seed: 42,
  samplesPerStrata: 50,
  stopAtrMultiple: 1.5,
  targetRewardRisk: 1.5,
  maxHoldBars: 24,
  costs: { feeRate: 0.0004, slippageRate: 0.0002 },
};

/**
 * Samples random entry points uniformly within each market regime stratum.
 * Stratification prevents market-drift bias from skewing null baseline results.
 */
export function sampleStratifiedEntries(
  bars: readonly StratifiedBar[],
  symbol: string,
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
): BaselineEntry[] {
  const groups = groupBarsByRegime(bars);
  const rand = mulberry32(config.seed);
  const entries: BaselineEntry[] = [];

  for (const [regime, stratumBars] of groups) {
    if (stratumBars.length === 0) continue;
    const sampled = sampleFromStratum(stratumBars, config.samplesPerStrata, rand);

    for (const bar of sampled) {
      if (bar.atr <= 0) continue;
      const side = rand() > 0.5 ? 'LONG' : 'SHORT';
      const entry = buildBaselineEntry(bar, symbol, regime, side, config);
      if (entry) entries.push(entry);
    }
  }

  return entries.sort((a, b) => a.entryTime - b.entryTime);
}

function groupBarsByRegime(bars: readonly StratifiedBar[]): Map<MarketRegime, StratifiedBar[]> {
  const map = new Map<MarketRegime, StratifiedBar[]>();
  for (const b of bars) {
    const list = map.get(b.regime) ?? [];
    list.push(b);
    map.set(b.regime, list);
  }
  return map;
}

function sampleFromStratum(
  items: readonly StratifiedBar[],
  count: number,
  rand: () => number,
): StratifiedBar[] {
  const pool = [...items];
  const target = Math.min(count, pool.length);
  const result: StratifiedBar[] = [];

  for (let i = 0; i < target; i += 1) {
    const idx = Math.floor(rand() * pool.length);
    result.push(pool[idx]);
    pool.splice(idx, 1);
  }

  return result;
}

function buildBaselineEntry(
  bar: StratifiedBar,
  symbol: string,
  regime: MarketRegime,
  side: 'LONG' | 'SHORT',
  config: BaselineConfig,
): BaselineEntry | null {
  const entryPrice = bar.candle.close;
  const riskDist = bar.atr * config.stopAtrMultiple;
  if (riskDist <= 0 || entryPrice <= 0) return null;

  const sign = side === 'LONG' ? 1 : -1;
  const stopLoss = entryPrice - sign * riskDist;
  const takeProfit = entryPrice + sign * riskDist * config.targetRewardRisk;

  return {
    symbol,
    regime,
    side,
    entryTime: bar.candle.openTime,
    entryPrice,
    stopLoss,
    takeProfit,
    riskDistance: riskDist,
  };
}

/** Evaluates stratified random entries against real candle price paths under fixed bracket rules. */
export function evaluateBaselineEntries(
  entries: readonly BaselineEntry[],
  candles: readonly Candle[],
  costs: CostRates,
  barDurationMs = 15 * 60_000,
  maxHoldBars = 24,
): BaselineTradeResult[] {
  const results: BaselineTradeResult[] = [];
  const maxHoldMs = maxHoldBars * barDurationMs;

  for (const entry of entries) {
    const sim = simulateBracket(
      {
        side: entry.side,
        entry: entry.entryPrice,
        stopLoss: entry.stopLoss,
        takeProfit: entry.takeProfit,
        from: entry.entryTime,
        maxHoldMs,
      },
      candles,
    );

    if (sim.outcome === 'NO_DATA' || sim.grossR === null || sim.exitTime === null) {
      continue;
    }

    const roundTripCost = (entry.entryPrice * 2 * (costs.feeRate + costs.slippageRate)) / entry.riskDistance;
    const netR = sim.grossR - roundTripCost;

    results.push({
      entry,
      outcome: sim.outcome,
      grossR: sim.grossR,
      netR,
      mfeR: sim.mfeR ?? 0,
      maeR: sim.maeR ?? 0,
      exitTime: sim.exitTime,
      durationMs: sim.exitTime - entry.entryTime,
    });
  }

  return results;
}

/** Aggregates baseline trade results into per-strata performance metrics. */
export function summarizeByStrata(results: readonly BaselineTradeResult[]): Map<MarketRegime, StrataSummary> {
  const groups = new Map<MarketRegime, BaselineTradeResult[]>();
  for (const r of results) {
    const list = groups.get(r.entry.regime) ?? [];
    list.push(r);
    groups.set(r.entry.regime, list);
  }

  const summaries = new Map<MarketRegime, StrataSummary>();
  for (const [regime, list] of groups) {
    summaries.set(regime, computeStrataSummary(regime, list));
  }

  return summaries;
}

function computeStrataSummary(regime: MarketRegime, list: readonly BaselineTradeResult[]): StrataSummary {
  const n = list.length;
  if (n === 0) {
    return { regime, n: 0, winRate: 0, meanNetR: 0, meanGrossR: 0, profitFactor: null };
  }

  const wins = list.filter((r) => r.netR > 0);
  const winRate = wins.length / n;
  const meanNetR = list.reduce((s, r) => s + r.netR, 0) / n;
  const meanGrossR = list.reduce((s, r) => s + r.grossR, 0) / n;

  const grossGains = list.filter((r) => r.grossR > 0).reduce((s, r) => s + r.grossR, 0);
  const grossLosses = Math.abs(list.filter((r) => r.grossR < 0).reduce((s, r) => s + r.grossR, 0));
  const profitFactor = grossLosses > 0 ? grossGains / grossLosses : null;

  return { regime, n, winRate, meanNetR, meanGrossR, profitFactor };
}
