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

import { validateDecision } from '../src/strategies/smc-ml/SmcExecutionAdvisor.js';
import type { SMCAnalysis, SMCDecisionContext } from '../src/strategies/smc-ml/types.js';

function decisionContext(
  portfolioState: SMCDecisionContext['portfolioState'] = 'NO_POSITION',
  noTradeReasons: string[] = [],
): SMCDecisionContext {
  const candidate = {
    direction: 'LONG' as const,
    entrySource: 'MARKET' as const,
    entryPrice: 100,
    protectedSwing: 98,
    atr14: 1,
    stopLoss: 97,
    tp1: 103,
    tp2: 106,
    riskPerUnit: 3,
    riskAtr: 3,
    sourceBreak: {
      type: 'BOS' as const,
      timeframe: '1h' as const,
      level: 99,
      time: 1,
      retestProbability: 0.6,
    },
  };

  const analysis: SMCAnalysis = {
    symbol: 'BTCUSDT',
    generatedAt: 2,
    price: 100,
    timeframes: {},
    confluence: {
      direction: 'LONG',
      score: 0.8,
      frameScores: [],
      agreement: 1,
      reasons: ['1h: BOS bullish'],
      noTradeReasons,
    },
    candidates: [candidate],
  };

  return {
    analysis,
    portfolioState,
    positionQty: portfolioState === 'NO_POSITION' ? 0 : 1,
    currentEntry: portfolioState === 'NO_POSITION' ? undefined : 100,
    currentMark: 100,
  };
}

test('validator fails closed when confluence contains a no-trade reason', () => {
  const context = decisionContext('NO_POSITION', ['fewer than three analysed timeframes']);
  const result = validateDecision(
    { action: 'OPEN', side: 'LONG', entrySource: 'MARKET', reason: 'open' },
    context,
  );
  assert.equal(result.action, 'HOLD');
  assert.equal(result.side, 'NONE');
  assert.equal(result.entrySource, null);
});

test('validator accepts only an existing candidate for an otherwise admissible OPEN', () => {
  const context = decisionContext();
  const result = validateDecision(
    { action: 'OPEN', side: 'LONG', entrySource: 'MARKET', reason: 'open' },
    context,
  );
  assert.equal(result.action, 'OPEN');
  assert.equal(result.side, 'LONG');
  assert.equal(result.entrySource, 'MARKET');
});

test('validator rejects ADD when confluence is opposite to the open position', () => {
  const context = decisionContext('SHORT');
  const result = validateDecision(
    { action: 'ADD', side: 'SHORT', entrySource: 'MARKET', reason: 'add' },
    context,
  );
  assert.equal(result.action, 'HOLD');
  assert.equal(result.side, 'NONE');
  assert.equal(result.entrySource, null);
});

test('validator strips entry source from EXIT decisions', () => {
  const context = decisionContext('LONG');
  const result = validateDecision(
    { action: 'EXIT', side: 'LONG', entrySource: 'MARKET', reason: 'exit' },
    context,
  );
  assert.equal(result.action, 'EXIT');
  assert.equal(result.side, 'LONG');
  assert.equal(result.entrySource, null);
});
