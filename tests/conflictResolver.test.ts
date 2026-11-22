import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Signal } from '../src/types.js';
import type { MarketState } from '../src/market/types.js';
import { fuseSignals } from '../src/decision/SignalFusion.js';
import {
  resolveDirectionalConflict,
  type ConflictCandidate,
} from '../src/decision/ConflictResolver.js';

function makeMockState(overrides: Partial<MarketState> = {}): MarketState {
  const baseTf = {
    timeframe: '15m' as const,
    candleCount: 100,
    lastClose: 100,
    ema20: 100,
    ema50: 100,
    ema200: 100,
    emaSlopePct: 0.1,
    adx14: 30,
    atr14: 2,
    atrPercentile: 50,
    rsi14: 55,
    vwap: 100,
    bollingerMiddle: 100,
    bollingerUpper: 104,
    bollingerLower: 96,
  };

  return {
    version: 1,
    symbol: 'BTCUSDT',
    generatedAt: 1000,
    mark: 100,
    fundingRate: 0.0001,
    regime: {
      regime: 'TREND_UP',
      trendDirection: 'BULLISH',
      trendStrength: 0.8,
      volatility: 'MEDIUM',
      volatilityPercentile: 50,
      adx14: 30,
      emaSlopePct: 0.1,
    },
    timeframes: {
      '15m': baseTf,
      '1h': { ...baseTf, timeframe: '1h' },
      '4h': { ...baseTf, timeframe: '4h' },
    },
    htfStructure: {
      timeframe: '1h',
      trend: 'BULLISH',
      swingHighs: [],
      swingLows: [],
      lastBreak: null,
      protectedHigh: null,
      protectedLow: null,
    },
    ltfStructure: {
      timeframe: '15m',
      trend: 'BULLISH',
      swingHighs: [],
      swingLows: [],
      lastBreak: null,
      protectedHigh: null,
      protectedLow: null,
    },
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] },
      ltf: { timeframe: '15m', pools: [], latestSweeps: [], recentSweeps: [] },
    },
    zones: [],
    pricing: {
      high: 110,
      low: 90,
      equilibrium: 100,
      positionPct: 40,
      premium: false,
      discount: true,
    },
    meanReversion: {
      mean: 100,
      vwap: 100,
      zscore: 0,
      rsi14: 50,
      bollingerMiddle: 100,
      bollingerUpper: 104,
      bollingerLower: 96,
      deviationPct: 0,
      rangeFavorable: false,
      reversionCandidate: 'NONE',
    },
    ...overrides,
  };
}

const longCand: ConflictCandidate = {
  id: 'cand-long',
  side: 'LONG',
  strategy: 'TREND_MOMENTUM',
  evidenceScore: 65,
};

const shortCand: ConflictCandidate = {
  id: 'cand-short',
  side: 'SHORT',
  strategy: 'MEAN_REVERSION',
  evidenceScore: 60,
};

test('TASK-001: ConflictResolver resolves opposing candidates using multi-timeframe matrix', () => {
  // Scenario 1: Strong Trend Regime Dominance
  const trendState = makeMockState();
  const resTrend = resolveDirectionalConflict(longCand, shortCand, trendState);
  assert.equal(resTrend.verdict, 'RESOLVED_LONG');
  assert.equal(resTrend.ruleApplied, 'TREND_REGIME_DOMINANCE');
  assert.equal(resTrend.winner?.id, 'cand-long');

  // Scenario 2: Squeeze Risk Precedence
  const squeezeState = makeMockState({
    crowding: {
      fundingPercentile: 95,
      fundingRegime: 'EXTREME_POSITIVE',
      topTraderVsGlobalBias: -0.2,
      positioningExtreme: 'SHORT_CROWDED',
      takerAggressionRatio: 0.8,
      smartMoneyDivergence: 'SMART_MONEY_LONG',
      squeezeRisk: 'SHORT_SQUEEZE_RISK',
      openInterestExpansion: true,
    },
  });
  const resSqueeze = resolveDirectionalConflict(longCand, shortCand, squeezeState);
  assert.equal(resSqueeze.verdict, 'RESOLVED_LONG');
  assert.equal(resSqueeze.ruleApplied, 'SQUEEZE_CONTRARIAN_OVERRIDE');

  // Scenario 3: Range Regime with Mean-Reversion Priority
  const rangeState = makeMockState({
    regime: {
      regime: 'RANGE',
      trendDirection: 'NEUTRAL',
      trendStrength: 0.2,
      volatility: 'LOW',
      volatilityPercentile: 20,
      adx14: 15,
      emaSlopePct: 0,
    },
    meanReversion: {
      mean: 100,
      vwap: 100,
      zscore: 2.2,
      rsi14: 68,
      bollingerMiddle: 100,
      bollingerUpper: 105,
      bollingerLower: 95,
      deviationPct: 3.5,
      rangeFavorable: true,
      bollingerRsiConfirmation: 'BEARISH_REENTRY',
      reversionCandidate: 'SELL_CANDIDATE',
    },
  });
  const resRange = resolveDirectionalConflict(longCand, shortCand, rangeState);
  assert.equal(resRange.verdict, 'RESOLVED_SHORT');
  assert.equal(resRange.ruleApplied, 'RANGE_MEAN_REVERSION_PRIORITY');

  // Scenario 4: Neutral / Ambiguous Conflict Stand-Down
  const neutralState = makeMockState({
    regime: {
      regime: 'TRANSITION',
      trendDirection: 'NEUTRAL',
      trendStrength: 0.3,
      volatility: 'MEDIUM',
      volatilityPercentile: 50,
      adx14: 18,
      emaSlopePct: 0,
    },
    htfStructure: {
      timeframe: '1h',
      trend: 'NEUTRAL',
      swingHighs: [],
      swingLows: [],
      lastBreak: null,
      protectedHigh: null,
      protectedLow: null,
    },
  });
  const resStandDown = resolveDirectionalConflict(
    { ...longCand, evidenceScore: 55 },
    { ...shortCand, evidenceScore: 54 },
    neutralState,
  );
  assert.equal(resStandDown.verdict, 'STAND_DOWN');
  assert.equal(resStandDown.winner, null);
});

test('TASK-003: SignalFusion delegates close directional conflicts to ConflictResolver', () => {
  const rangeState = makeMockState({
    regime: {
      regime: 'RANGE',
      trendDirection: 'NEUTRAL',
      trendStrength: 0.2,
      volatility: 'LOW',
      volatilityPercentile: 20,
      adx14: 15,
      emaSlopePct: 0,
    },
    meanReversion: {
      mean: 100,
      vwap: 100,
      zscore: -2.2,
      rsi14: 32,
      bollingerMiddle: 100,
      bollingerUpper: 105,
      bollingerLower: 95,
      deviationPct: -3.5,
      rangeFavorable: true,
      bollingerRsiConfirmation: 'BULLISH_REENTRY',
      reversionCandidate: 'BUY_CANDIDATE',
    },
    pricing: {
      high: 110,
      low: 90,
      equilibrium: 100,
      positionPct: 50,
      premium: false,
      discount: false,
    },
  });

  const longSig: Signal = {
    id: 'l1',
    agent: 'MEAN-REVERT-θ',
    symbol: 'BTCUSDT',
    type: 'OPEN_LONG',
    confidence: 0.45,
    entry: 100,
    stopLoss: 98,
    takeProfit: 105,
    reason: 'reversion buy',
    ts: 1000,
  };

  const shortSig: Signal = {
    id: 's1',
    agent: 'TREND-ENS-μ',
    symbol: 'BTCUSDT',
    type: 'OPEN_SHORT',
    confidence: 1.0,
    entry: 100,
    stopLoss: 102,
    takeProfit: 95,
    reason: 'trend short',
    ts: 1000,
  };

  const intents = fuseSignals([longSig, shortSig], { BTCUSDT: rangeState });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].side, 'LONG');
});

test('TASK-004: structural reversal with confirmed sweep and CHOCH overrides trend dominance', () => {
  const reversalState = makeMockState({
    regime: {
      regime: 'TREND_UP',
      trendDirection: 'BULLISH',
      trendStrength: 0.8,
      volatility: 'MEDIUM',
      volatilityPercentile: 50,
      adx14: 28,
      emaSlopePct: 0.1,
    },
    ltfStructure: {
      timeframe: '15m',
      trend: 'BEARISH',
      swingHighs: [],
      swingLows: [],
      lastBreak: {
        type: 'CHOCH',
        direction: 'BEARISH',
        level: 102,
        index: 98,
        time: 980,
        distanceAtr: 1.5,
      },
      protectedHigh: null,
      protectedLow: null,
    },
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] },
      ltf: {
        timeframe: '15m',
        pools: [],
        latestSweeps: [{
          direction: 'BUY_SIDE',
          poolType: 'EQUAL_HIGH',
          level: 104,
          sweepPrice: 104.5,
          close: 102.5,
          index: 95,
          time: 950,
          confirmed: true,
        }],
        recentSweeps: [],
      },
    },
  });

  const res = resolveDirectionalConflict(
    { ...longCand, evidenceScore: 45 },
    { ...shortCand, evidenceScore: 65 },
    reversalState,
  );

  assert.equal(res.verdict, 'RESOLVED_SHORT');
  assert.equal(res.ruleApplied, 'STRUCTURAL_REVERSAL_OVERRIDE');
  assert.equal(res.winner?.id, 'cand-short');
});
