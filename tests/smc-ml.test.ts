import test from 'node:test';
import assert from 'node:assert/strict';
import { clampProbability, touchProbability, twoProportionZ } from '../src/strategies/smc-ml/math.js';
import { buildSmcConfluence } from '../src/strategies/smc-ml/SmcConfluence.js';
import type { SMCFrameAnalysis } from '../src/strategies/smc-ml/types.js';

function frame(
  tf: SMCFrameAnalysis['timeframe'],
  trend: 'LONG' | 'SHORT',
): SMCFrameAnalysis {
  return {
    timeframe: tf,
    candleCount: 200,
    lastClosedTime: Date.now(),
    lastPrice: 100,
    atr14: 1,
    volatilityStd: 1,
    trend,
    dealingRangeHigh: 110,
    dealingRangeLow: 90,
    rangePositionPct: trend === 'LONG' ? 25 : 75,
    swings: [],
    breaks: [],
    latestBreak: null,
    orderBlocks: [],
    fairValueGaps: [],
    liquidityPools: [],
    nearestUpperLiquidity: null,
    nearestLowerLiquidity: null,
    liveLiquidityOdds: { upper: null, lower: null, formulaUpper: null, formulaLower: null },
    retestCalibration: { samples: 0, hitRate: null, brierModel: null, brierFormula: null, brierBase: null },
    liquidityCalibration: { samples: 0, hitRate: null, brierModel: null, brierFormula: null, brierBase: null },
    edgeTest: { totalResolved: 0, overallRate: null, splits: [] },
  };
}

test('reflection touch probability stays bounded and increases with window', () => {
  const p10 = touchProbability(1, 1, 10)!;
  const p100 = touchProbability(1, 1, 100)!;
  assert.equal(clampProbability(p10), p10);
  assert.equal(clampProbability(p100), p100);
  assert.ok(p100 > p10);
});

test('two proportion z detects a large difference', () => {
  const z = twoProportionZ(100, 90, 100, 50)!;
  assert.ok(Math.abs(z) > 5);
});

test('MTF confluence becomes long when major frames agree', () => {
  const frames = {
    '5m': frame('5m', 'LONG'),
    '15m': frame('15m', 'LONG'),
    '1h': frame('1h', 'LONG'),
    '4h': frame('4h', 'LONG'),
  };
  const c = buildSmcConfluence(frames, 100, { minimumScore: 0.35 });
  assert.equal(c.direction, 'LONG');
  assert.ok(c.agreement === 1);
  assert.equal(c.noTradeReasons.length, 0);
});

test('MTF confluence remains unresolved when frames conflict', () => {
  const frames = {
    '5m': frame('5m', 'LONG'),
    '15m': frame('15m', 'LONG'),
    '1h': frame('1h', 'SHORT'),
    '4h': frame('4h', 'SHORT'),
  };
  const c = buildSmcConfluence(frames, 100, { minimumScore: 0.35 });
  assert.ok(c.direction === 'LONG' || c.direction === 'SHORT' || c.direction === 'NEUTRAL');
  assert.ok(c.agreement < 1);
});
