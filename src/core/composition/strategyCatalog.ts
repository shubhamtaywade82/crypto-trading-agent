import type { Strategy } from '../domain/strategy.js';
import { CrossSectionalMomentumStrategy, MeanReversionStrategy, MomentumStrategy, RangeBreakoutStrategy } from '../strategies/index.js';

/**
 * The one place that names concrete strategy classes. Adding a strategy means adding a line here; the engine, the
 * risk pipeline and the adapters are not touched.
 */
export const STRATEGY_CATALOG: Readonly<Record<string, (parameters?: unknown) => Strategy>> = Object.freeze({
  'momentum-ema-cross': (p) => new MomentumStrategy(p as ConstructorParameters<typeof MomentumStrategy>[0]),
  'range-breakout': (p) => new RangeBreakoutStrategy(p as ConstructorParameters<typeof RangeBreakoutStrategy>[0]),
  'mean-reversion-zscore': (p) => new MeanReversionStrategy(p as ConstructorParameters<typeof MeanReversionStrategy>[0]),
  'cross-sectional-momentum': (p) => new CrossSectionalMomentumStrategy(p as ConstructorParameters<typeof CrossSectionalMomentumStrategy>[0]),
});

export function buildStrategies(ids: readonly string[], parameters: Readonly<Record<string, unknown>> = {}): Strategy[] {
  const unknown = ids.filter((id) => !Object.hasOwn(STRATEGY_CATALOG, id));
  if (unknown.length > 0) throw new Error(`unknown strategies: ${unknown.join(', ')}. Known: ${Object.keys(STRATEGY_CATALOG).join(', ')}`);
  const orphaned = Object.keys(parameters).filter((id) => !ids.includes(id));
  if (orphaned.length > 0) throw new Error(`parameters given for strategies that are not enabled: ${orphaned.join(', ')}`);
  return ids.map((id) => STRATEGY_CATALOG[id](parameters[id]));
}
