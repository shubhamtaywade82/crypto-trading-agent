import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeatureEngine } from '../src/core/application/features/FeatureEngine.js';
import { defaultFeatureRegistry, parseFeatureKey } from '../src/core/application/features/FeatureRegistry.js';
import { StrategyRegistry } from '../src/core/application/strategies/StrategyRegistry.js';
import { StrategyRunner } from '../src/core/application/strategies/StrategyRunner.js';
import { barClosedEvent, type Candle, type MarketSnapshot, type Timeframe } from '../src/core/domain/market.js';
import { signalDefect, type Strategy, type StrategyContext, type StrategySignal } from '../src/core/domain/strategy.js';
import { CrossSectionalMomentumStrategy, MeanReversionStrategy, MomentumStrategy, RangeBreakoutStrategy } from '../src/core/strategies/index.js';
import { candlesFromCloses, flat, portfolioOf, ramp, signalOf, snapshotOf } from './support/coreFixtures.js';

const features = defaultFeatureRegistry();
const engine = new FeatureEngine(features);

function evaluate(strategy: Strategy, candles: Candle[], universe?: Record<string, MarketSnapshot>, symbol = 'BTCUSDT'): readonly StrategySignal[] {
  const timeframe = strategy.requirements.primaryTimeframe;
  const market = snapshotOf(symbol, candles, timeframe);
  return strategy.evaluate({ market, features: engine.compute(timeframe, candles, strategy.requirements.features), universe: universe ?? { [symbol]: market }, portfolio: portfolioOf() });
}

const stub = (id: string, body: (ctx: StrategyContext) => readonly StrategySignal[], overrides: Partial<Strategy['requirements']> = {}): Strategy => ({
  id, version: '1.0.0', parameters: {}, evaluate: body,
  requirements: { primaryTimeframe: '15m', timeframes: ['15m'], features: ['ema:5'], warmupBars: 10, ...overrides },
});

test('feature series align with their candles and donchian excludes the current bar', () => {
  const candles = candlesFromCloses([...flat(10, 100), 105]);
  for (const key of ['ema:5', 'sma:5', 'rsi:5', 'atr:5', 'donchianHigh:5', 'donchianLow:5', 'zscore:5', 'roc:5']) {
    assert.equal(features.compute(key, candles).length, candles.length, key);
  }
  const snapshot = engine.compute('15m', candles, ['donchianHigh:5', 'donchianLow:5', 'sma:5', 'roc:5']);
  assert.equal(snapshot.at('donchianHigh:5'), 100.5); // the 105 bar's own high (105.5) is not in its range
  assert.equal(snapshot.at('donchianLow:5'), 99.5);
  assert.equal(snapshot.at('sma:5'), 101);
  assert.ok(Math.abs(snapshot.at('roc:5')! - 0.05) < 1e-12);
  assert.equal(engine.compute('15m', candles.slice(0, 3), ['sma:5']).at('sma:5'), null); // warming up reads as null, not NaN
  assert.throws(() => snapshot.series('ema:9'), /not declared/);
  assert.throws(() => parseFeatureKey('ema'), /invalid feature key/);
  assert.throws(() => parseFeatureKey('ema:0'), /invalid feature key/);
  assert.throws(() => features.compute('nope:5', candles), /not registered/);
  assert.throws(() => defaultFeatureRegistry().register('ema', () => []), /already registered/);
});

test('momentum: a close crossing its EMA up goes long with an ATR bracket; down goes short', () => {
  const strategy = new MomentumStrategy({ emaPeriod: 5, stopAtr: 2, targetAtr: 4 });
  const [long] = evaluate(strategy, candlesFromCloses([...ramp(20, 100, -0.2), 99]));
  assert.equal(long.direction, 'LONG');
  assert.equal(long.entry, 99);
  assert.equal(signalDefect(long), null);
  assert.ok(Math.abs((long.takeProfit - long.entry) / (long.entry - long.stopLoss) - 2) < 1e-9);
  const [short] = evaluate(strategy, candlesFromCloses([...ramp(20, 100, 0.2), 101]));
  assert.equal(short.direction, 'SHORT');
  assert.equal(signalDefect(short), null);
  assert.deepEqual(evaluate(new MomentumStrategy({ emaPeriod: 5, allowShort: false }), candlesFromCloses([...ramp(20, 100, 0.2), 101])), []);
});

test('momentum: no cross, an already-crossed trend, or an overextended RSI yields nothing', () => {
  const strategy = new MomentumStrategy({ emaPeriod: 5 });
  assert.deepEqual(evaluate(strategy, candlesFromCloses(ramp(21, 100, 0.2))), []); // above the EMA all along
  assert.deepEqual(evaluate(strategy, candlesFromCloses(flat(21, 100))), []);
  // A vertical cross: RSI is pinned high, the entry is refused as extended
  assert.deepEqual(evaluate(new MomentumStrategy({ emaPeriod: 5, rsiCeiling: 50 }), candlesFromCloses([...ramp(20, 100, -0.2), 99])), []);
});

test('breakout: the first close outside the range signals; the next bar outside does not', () => {
  const strategy = new RangeBreakoutStrategy({ rangeBars: 10, atrPeriod: 5, timeframe: '15m' });
  const range = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 0.3 : -0.3));
  const [long] = evaluate(strategy, candlesFromCloses([...range, 103]));
  assert.equal(long.direction, 'LONG');
  assert.equal(signalDefect(long), null);
  assert.deepEqual(evaluate(strategy, candlesFromCloses([...range, 103, 103.2])), []); // already outside on the previous close
  const [short] = evaluate(strategy, candlesFromCloses([...range, 97]));
  assert.equal(short.direction, 'SHORT');
  assert.deepEqual(evaluate(strategy, candlesFromCloses([...range, 100.2])), []);
});

test('mean reversion: fades a stretched close once it turns back, targeting the mean', () => {
  const strategy = new MeanReversionStrategy({ lookback: 20, entryZ: 2, atrPeriod: 5 });
  const [long] = evaluate(strategy, candlesFromCloses([...flat(40, 100), 97, 99]));
  assert.equal(long.direction, 'LONG');
  assert.ok(Math.abs(long.takeProfit - 99.8) < 1e-9); // the 20-bar mean
  assert.ok(long.stopLoss < 99);
  assert.equal(signalDefect(long), null);
  const [short] = evaluate(strategy, candlesFromCloses([...flat(40, 100), 103, 101]));
  assert.equal(short.direction, 'SHORT');
  assert.deepEqual(evaluate(strategy, candlesFromCloses([...flat(40, 100), 97])), []); // still stretched: no turn yet
  assert.deepEqual(evaluate(strategy, candlesFromCloses([...flat(40, 100), 97, 100.5])), []); // overshot the mean already
});

test('cross-sectional: only the leader goes long and the laggard short, over an aligned universe', () => {
  const strategy = new CrossSectionalMomentumStrategy({ lookback: 5, atrPeriod: 5, timeframe: '15m', minUniverse: 4 });
  const series: Record<string, Candle[]> = {
    AAA: candlesFromCloses(ramp(40, 100, 1)), BBB: candlesFromCloses(ramp(40, 100, 0.2)),
    CCC: candlesFromCloses(ramp(40, 100, -0.1)), DDD: candlesFromCloses(ramp(40, 100, -1)),
  };
  const universe = Object.fromEntries(Object.entries(series).map(([symbol, candles]) => [symbol, snapshotOf(symbol, candles)]));
  const direction = (symbol: string, u = universe) => evaluate(strategy, series[symbol], u, symbol).map((s) => s.direction);
  assert.deepEqual(direction('AAA'), ['LONG']);
  assert.deepEqual(direction('DDD'), ['SHORT']);
  assert.deepEqual(direction('BBB'), []);
  assert.deepEqual(direction('CCC'), []);
  // A peer whose latest bar is older is dropped from the ranking, which leaves too few symbols to rank
  const stale = { ...universe, CCC: snapshotOf('CCC', series.CCC.slice(0, -1)) };
  assert.deepEqual(direction('AAA', stale), []);
  // A "leader" that is merely the least negative is not momentum
  const falling = Object.fromEntries(['AAA', 'BBB', 'CCC', 'DDD'].map((symbol, i) => [symbol, snapshotOf(symbol, candlesFromCloses(ramp(40, 100, -0.1 * (i + 1))))]));
  assert.deepEqual(evaluate(strategy, candlesFromCloses(ramp(40, 100, -0.1)), falling, 'AAA'), []);
});

test('strategies are deterministic and declare everything they read', () => {
  const candles = candlesFromCloses([...ramp(20, 100, -0.2), 99]);
  const strategy = new MomentumStrategy({ emaPeriod: 5 });
  assert.deepEqual(evaluate(strategy, candles), evaluate(strategy, candles));
  for (const s of [new MomentumStrategy(), new RangeBreakoutStrategy(), new MeanReversionStrategy(), new CrossSectionalMomentumStrategy()]) {
    assert.ok(s.requirements.timeframes.includes(s.requirements.primaryTimeframe), s.id);
    assert.ok(s.requirements.features.every((key) => features.has(key)), s.id);
    assert.ok(s.requirements.warmupBars > 0, s.id);
    assert.ok(Object.isFrozen(s.parameters), s.id);
    assert.match(s.version, /^\d+\.\d+\.\d+$/);
  }
});

test('the registry validates at registration and lists in a stable order', () => {
  const registry = new StrategyRegistry(features);
  registry.register(stub('b', () => [])).register(stub('a', () => []));
  assert.deepEqual(registry.list().map((s) => s.id), ['a', 'b']);
  assert.throws(() => registry.register(stub('a', () => [])), /already registered/);
  assert.throws(() => registry.register(stub('c', () => [], { features: ['hurst:20'] })), /unknown features: hurst:20/);
  assert.throws(() => registry.register(stub('d', () => [], { timeframes: ['1h'] })), /must include the primary timeframe/);
  assert.throws(() => registry.register(stub('e', () => [], { warmupBars: 0 })), /warmupBars/);
  assert.throws(() => registry.register(stub(' ', () => [])), /non-empty id/);
  assert.equal(registry.unregister('a'), true);
  assert.deepEqual(registry.list().map((s) => s.id), ['b']);
});

test('the runner isolates a failing strategy, rejects malformed signals and honours warm-up and timeframe', () => {
  const candles = candlesFromCloses(flat(20, 100));
  const last = candles[candles.length - 1];
  const good = (id: string) => signalOf({ strategyId: id, barTime: last.openTime });
  const registry = new StrategyRegistry(features)
    .register(stub('good', () => [good('good')]))
    .register(stub('throws', () => { throw new Error('bad maths'); }))
    .register(stub('no-stop', () => [{ ...good('no-stop'), stopLoss: Number.NaN }]))
    .register(stub('wrong-symbol', () => [{ ...good('wrong-symbol'), symbol: 'ETHUSDT' }]))
    .register(stub('old-bar', () => [{ ...good('old-bar'), barTime: last.openTime - 900_000 }]))
    .register(stub('impostor', () => [good('good')]))
    .register(stub('cold', () => [good('cold')], { warmupBars: 500 }))
    .register(stub('hourly', () => [good('hourly')], { primaryTimeframe: '1h' as Timeframe, timeframes: ['1h'] }));
  const runner = new StrategyRunner(registry, engine);
  const result = runner.run(barClosedEvent('BTCUSDT', '15m', last), { BTCUSDT: snapshotOf('BTCUSDT', candles) }, portfolioOf());

  assert.deepEqual(result.signals.map((s) => s.strategyId), ['good']);
  assert.ok(Object.isFrozen(result.signals[0]));
  assert.deepEqual(Object.fromEntries(result.failures.map((f) => [f.strategyId, f.error])), {
    throws: 'bad maths',
    'no-stop': 'malformed signal: entry, stopLoss and takeProfit must be positive finite numbers',
    'wrong-symbol': 'malformed signal: signal is for ETHUSDT, the event is for BTCUSDT',
    'old-bar': 'malformed signal: signal was not computed on the triggering bar',
    impostor: 'malformed signal: signal does not carry its strategy id and version',
  });
  // Warm-up and timeframe are not failures: those strategies simply did not run
  assert.ok(!('cold' in result.parameters) && !('hourly' in result.parameters));
  assert.deepEqual(runner.dataRequirements(), { timeframes: ['15m', '1h'], bars: 500 });
  assert.deepEqual(runner.run(barClosedEvent('ETHUSDT', '15m', last), {}, portfolioOf()).failures, [{ strategyId: '*', error: 'no snapshot for ETHUSDT' }]);
});
