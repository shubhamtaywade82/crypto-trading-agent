import type { Strategy } from '../../domain/strategy.js';
import type { FeatureRegistry } from '../features/FeatureRegistry.js';

/**
 * Registration and discovery. The engine asks for `list()` and never names a strategy class, so adding or removing a
 * strategy touches the composition root only.
 */
export class StrategyRegistry {
  private readonly strategies = new Map<string, Strategy>();

  constructor(private readonly features: FeatureRegistry) {}

  /** Fails at registration, not at the first bar, when a strategy is malformed or asks for an unknown feature. */
  register(strategy: Strategy): this {
    if (!strategy.id.trim() || !strategy.version.trim()) throw new Error('a strategy needs a non-empty id and version');
    if (this.strategies.has(strategy.id)) throw new Error(`strategy "${strategy.id}" is already registered`);
    const { requirements } = strategy;
    if (!requirements.timeframes.includes(requirements.primaryTimeframe)) {
      throw new Error(`strategy "${strategy.id}": timeframes must include the primary timeframe ${requirements.primaryTimeframe}`);
    }
    if (!Number.isInteger(requirements.warmupBars) || requirements.warmupBars < 1) throw new Error(`strategy "${strategy.id}": warmupBars must be a positive integer`);
    const unknown = requirements.features.filter((key) => !this.features.has(key));
    if (unknown.length > 0) throw new Error(`strategy "${strategy.id}" requires unknown features: ${unknown.join(', ')}`);
    this.strategies.set(strategy.id, strategy);
    return this;
  }

  unregister(id: string): boolean {
    return this.strategies.delete(id);
  }

  get(id: string): Strategy | undefined {
    return this.strategies.get(id);
  }

  /** Sorted by id so evaluation order never depends on registration order. */
  list(): readonly Strategy[] {
    return [...this.strategies.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
