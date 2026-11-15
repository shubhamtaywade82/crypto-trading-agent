import type { BarClosedEvent, MarketSnapshot } from '../../domain/market.js';
import type { PortfolioSnapshot } from '../../domain/portfolio.js';
import { signalDefect, type StrategySignal } from '../../domain/strategy.js';
import type { FeatureEngine } from '../features/FeatureEngine.js';
import type { StrategyRegistry } from './StrategyRegistry.js';

export interface StrategyFailure {
  readonly strategyId: string;
  readonly error: string;
}

export interface StrategyRunResult {
  readonly signals: readonly StrategySignal[];
  readonly failures: readonly StrategyFailure[];
  /** Strategies that evaluated this bar, with the parameters they ran on. */
  readonly parameters: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export class StrategyRunner {
  constructor(private readonly registry: StrategyRegistry, private readonly features: FeatureEngine) {}

  /** One strategy's exception or malformed signal is recorded as a failure and cannot stop the others. */
  run(event: BarClosedEvent, universe: Readonly<Record<string, MarketSnapshot>>, portfolio: PortfolioSnapshot): StrategyRunResult {
    const market = universe[event.symbol];
    const signals: StrategySignal[] = [];
    const failures: StrategyFailure[] = [];
    const parameters: Record<string, Readonly<Record<string, unknown>>> = {};
    if (!market) return { signals, failures: [{ strategyId: '*', error: `no snapshot for ${event.symbol}` }], parameters };

    for (const strategy of this.registry.list()) {
      const { requirements } = strategy;
      if (requirements.primaryTimeframe !== event.timeframe) continue;
      const candles = market.candles[requirements.primaryTimeframe] ?? [];
      if (candles.length < requirements.warmupBars) continue;
      parameters[strategy.id] = strategy.parameters;
      try {
        const features = this.features.compute(requirements.primaryTimeframe, candles, requirements.features);
        for (const signal of strategy.evaluate({ market, features, universe, portfolio })) {
          const defect = signalDefect(signal)
            ?? (signal.symbol !== event.symbol ? `signal is for ${signal.symbol}, the event is for ${event.symbol}` : null)
            ?? (signal.barTime !== event.bar.openTime ? 'signal was not computed on the triggering bar' : null)
            ?? (signal.strategyId !== strategy.id || signal.strategyVersion !== strategy.version ? 'signal does not carry its strategy id and version' : null);
          if (defect) failures.push({ strategyId: strategy.id, error: `malformed signal: ${defect}` });
          else signals.push(Object.freeze({ ...signal }));
        }
      } catch (error) {
        failures.push({ strategyId: strategy.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { signals, failures, parameters };
  }

  /** Bars and timeframes the registered strategies need, so the engine requests exactly that much data. */
  dataRequirements(): { timeframes: string[]; bars: number } {
    const strategies = this.registry.list();
    return {
      timeframes: [...new Set(strategies.flatMap((s) => s.requirements.timeframes))].sort(),
      bars: Math.max(0, ...strategies.map((s) => s.requirements.warmupBars)),
    };
  }
}
