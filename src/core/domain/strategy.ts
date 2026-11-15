import type { MarketSnapshot, Timeframe } from './market.js';
import type { PortfolioSnapshot } from './portfolio.js';

export type Direction = 'LONG' | 'SHORT';

export interface StrategyRequirements {
  /** The bar whose close triggers an evaluation. */
  readonly primaryTimeframe: Timeframe;
  /** Every timeframe the strategy reads, the primary one included. */
  readonly timeframes: readonly Timeframe[];
  /** Feature keys as `name:period`, e.g. `ema:50`. Computed on the primary timeframe by the feature engine. */
  readonly features: readonly string[];
  /** Closed bars of the primary timeframe needed before the first evaluation. */
  readonly warmupBars: number;
}

/** Indicator series aligned with the primary timeframe's closed candles (same length, NaN while warming up). */
export interface FeatureSnapshot {
  readonly timeframe: Timeframe;
  series(key: string): readonly number[];
  /** Value `offset` bars back from the latest closed bar (0 = latest). Null when missing or not finite. */
  at(key: string, offset?: number): number | null;
}

export interface StrategyContext {
  /** The symbol whose bar closed. */
  readonly market: MarketSnapshot;
  readonly features: FeatureSnapshot;
  /** Every symbol of the run at the same instant, the evaluated one included. Cross-sectional strategies rank over it. */
  readonly universe: Readonly<Record<string, MarketSnapshot>>;
  readonly portfolio: PortfolioSnapshot;
}

/**
 * An entry idea with its own invalidation level. A signal carries no size and no order: sizing belongs to the risk
 * layer and execution to the order handler. A signal without a stop is not a signal.
 */
export interface StrategySignal {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly entry: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  /** 0..1, used only to rank agreeing signals. It is not a probability and never scales size upward. */
  readonly confidence: number;
  readonly reason: string;
  /** openTime of the bar the signal was computed on. */
  readonly barTime: number;
}

export interface Strategy {
  readonly id: string;
  readonly version: string;
  readonly requirements: StrategyRequirements;
  /** The validated parameter set, persisted with every decision and research run. */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Must be deterministic for the same context: no clock, no randomness, no I/O. */
  evaluate(context: StrategyContext): readonly StrategySignal[];
}

/** Why a signal is malformed, or null. Geometry only; whether it is worth taking is the risk layer's question. */
export function signalDefect(signal: StrategySignal): string | null {
  const { entry, stopLoss, takeProfit, confidence, direction } = signal;
  if (![entry, stopLoss, takeProfit].every((v) => Number.isFinite(v) && v > 0)) return 'entry, stopLoss and takeProfit must be positive finite numbers';
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return 'confidence must be within 0..1';
  if (direction === 'LONG' && !(stopLoss < entry && entry < takeProfit)) return 'LONG needs stopLoss < entry < takeProfit';
  if (direction === 'SHORT' && !(takeProfit < entry && entry < stopLoss)) return 'SHORT needs takeProfit < entry < stopLoss';
  return null;
}
