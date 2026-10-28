import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBriefDecision } from '../src/marketBrief/MarketBriefDecision.js';
import type { DataQualityReport } from '../src/marketBrief/types.js';
import type { MarketState } from '../src/market/types.js';
import type { SetupMap, SetupScenario } from '../src/decision/SetupTypes.js';

function createMockMarketState(): MarketState {
  return {
    version: 1,
    symbol: 'SOLUSDT',
    generatedAt: 1_700_000_000_000,
    mark: 100,
    regime: { trendDirection: 'BULLISH', volatility: 'NORMAL', liquidityProfile: 'NORMAL' },
    timeframes: {
      '15m': { timeframe: '15m', atr14: 2.0, rsi14: 55, closedBars: 50 },
      '1h': { timeframe: '1h', atr14: 4.0, rsi14: 60, closedBars: 50 },
      '4h': { timeframe: '4h', atr14: 8.0, rsi14: 62, closedBars: 50 },
    },
    htfStructure: { trend: 'BULLISH', swings: [], breaks: [] },
    ltfStructure: { trend: 'BULLISH', swings: [], breaks: [] },
    liquidity: { htf: { pools: [] }, ltf: { pools: [] } },
    pricing: { high: 110, low: 90, equilibrium: 100, positionPct: 50, premium: false, discount: false },
    zones: [
      { timeframe: '15m', type: 'DEMAND', low: 96, high: 98, sourceBreak: null, mitigationCount: 0, createdAt: 0 },
      { timeframe: '15m', type: 'SUPPLY', low: 104, high: 106, sourceBreak: null, mitigationCount: 0, createdAt: 0 },
    ],
    zoneLedger: [],
    meanReversion: { mean: 100, vwap: 100, zscore: 0, rsi14: 55, bollingerMiddle: 100, bollingerUpper: 105, bollingerLower: 95, deviationPct: 0 },
    crowding: { extreme: false, direction: 'NEUTRAL', percentile: 50 },
  } as unknown as MarketState;
}

const validQuality: DataQualityReport = {
  status: 'VALID',
  reasons: [],
  lastTradeAt: 1_700_000_000_000,
  markPriceAt: 1_700_000_000_000,
  derivativesAt: 1_700_000_000_000,
};

describe('MarketBriefDecision', () => {
  it('forces NO_TRADE with DATA_QUALITY_BLOCKED when data quality is INVALID', () => {
    const invalidQuality: DataQualityReport = {
      status: 'INVALID',
      reasons: ['corrupted candle on 15m'],
      lastTradeAt: null,
      markPriceAt: null,
      derivativesAt: null,
    };

    const state = createMockMarketState();
    const { decision } = evaluateBriefDecision(invalidQuality, state, null);

    assert.equal(decision.action, 'NO_TRADE');
    assert.ok(decision.reasonCodes.includes('DATA_QUALITY_BLOCKED'));
    assert.ok(decision.reasonCodes.includes('corrupted candle on 15m'));
  });

  it('forces NO_TRADE with NO_VALID_SETUP when setup map has no scenarios', () => {
    const state = createMockMarketState();
    const emptyMap = {
      symbol: 'SOLUSDT',
      generatedAt: 1_700_000_000_000,
      state: 'NO_TRADE',
      bias: 'BULLISH',
      htfTrend: 'BULLISH',
      ltfTrend: 'BULLISH',
      location: 'EQUILIBRIUM',
      scenarios: [],
    } as unknown as SetupMap;

    const { decision } = evaluateBriefDecision(validQuality, state, emptyMap);
    assert.equal(decision.action, 'NO_TRADE');
    assert.ok(decision.reasonCodes.includes('NO_VALID_SETUP'));
  });

  it('forces NO_TRADE with INSUFFICIENT_CONFIRMATION when candidate is not TRIGGERED', () => {
    const state = createMockMarketState();
    const unconfirmedScenario: SetupScenario = {
      id: 'scen_1',
      kind: 'BREAKOUT_RETEST',
      direction: 'LONG',
      state: 'ARMED', // not TRIGGERED yet
      timeframe: '15m',
      entryLow: 101,
      entryHigh: 101,
      stopLoss: 97,
      target1: 108,
      rewardRisk: 1.75,
      trigger: 'Confirmed 15m close above 101',
      invalidation: 'Confirmed 15m close below 97',
      flowHypothesis: 'Aggressive taker buying',
      expectedMove: { minMinutes: 15, maxMinutes: 60, thesisExpiryMinutes: 120, distanceAtr: 1.5 },
      sourceTime: 1_700_000_000_000,
    };

    const map = {
      symbol: 'SOLUSDT',
      generatedAt: 1_700_000_000_000,
      state: 'ARMED',
      bias: 'BULLISH',
      htfTrend: 'BULLISH',
      ltfTrend: 'BULLISH',
      location: 'DISCOUNT',
      scenarios: [unconfirmedScenario],
    } as unknown as SetupMap;

    const { decision } = evaluateBriefDecision(validQuality, state, map);
    assert.equal(decision.action, 'NO_TRADE');
    assert.ok(decision.reasonCodes.includes('INSUFFICIENT_CONFIRMATION'));
  });

  it('emits BUY_LONG when candidate is TRIGGERED, ENTRY_ELIGIBLE, and structurally aligned', () => {
    const state = createMockMarketState();
    const eligibleScenario: SetupScenario = {
      id: 'scen_long_1',
      kind: 'BREAKOUT_RETEST',
      direction: 'LONG',
      state: 'TRIGGERED',
      timeframe: '15m',
      entryLow: 102,
      entryHigh: 102,
      stopLoss: 98,
      target1: 110,
      rewardRisk: 2.0,
      trigger: 'Triggered at $102.00',
      invalidation: 'Invalidated beyond $98.00',
      flowHypothesis: 'Strong taker volume',
      expectedMove: { minMinutes: 15, maxMinutes: 60, thesisExpiryMinutes: 120, distanceAtr: 2.0 },
      sourceTime: 1_700_000_000_000,
      quality: {
        verdict: 'ENTRY_ELIGIBLE',
        effectiveRr: 1.8,
        checks: { structure: 'PASS', location: 'PASS', trigger: 'PASS', evidence: 'PASS', flow: 'PASS', rr: 'PASS', freshness: 'PASS' },
        reasons: [],
      },
    };

    const map = {
      symbol: 'SOLUSDT',
      generatedAt: 1_700_000_000_000,
      state: 'TRIGGERED',
      bias: 'BULLISH',
      htfTrend: 'BULLISH',
      ltfTrend: 'BULLISH',
      location: 'DISCOUNT',
      scenarios: [eligibleScenario],
    } as unknown as SetupMap;

    const { decision, levels, scenarios } = evaluateBriefDecision(validQuality, state, map);
    assert.equal(decision.action, 'BUY_LONG');
    assert.equal(decision.bias, 'BULLISH');
    assert.equal(decision.scenarioId, 'scen_long_1');
    assert.ok(decision.confirmedTrigger?.includes('102.00'));

    assert.deepEqual(levels.support, [96, 98]);
    assert.deepEqual(levels.resistance, [104, 106]);
    assert.ok(scenarios.bullishCondition.includes('$104.00–$106.00'));
    assert.ok(scenarios.bearishCondition.includes('$96.00–$98.00'));
  });

  it('blocks entry with CONFLICTING_EVIDENCE when candidate direction opposes macro bias', () => {
    const state = createMockMarketState();
    // Force macro structure to BEARISH
    state.htfStructure.trend = 'BEARISH';
    state.ltfStructure.trend = 'BEARISH';
    state.regime.trendDirection = 'BEARISH';

    const longScenario: SetupScenario = {
      id: 'scen_counter',
      kind: 'BREAKOUT_RETEST',
      direction: 'LONG', // LONG counter to BEARISH bias
      state: 'TRIGGERED',
      timeframe: '15m',
      entryLow: 102,
      entryHigh: 102,
      stopLoss: 98,
      target1: 110,
      rewardRisk: 2.0,
      trigger: 'Triggered at $102.00',
      invalidation: 'Invalidated beyond $98.00',
      flowHypothesis: 'Counter-trend flow',
      expectedMove: { minMinutes: 15, maxMinutes: 60, thesisExpiryMinutes: 120, distanceAtr: 2.0 },
      sourceTime: 1_700_000_000_000,
      quality: {
        verdict: 'ENTRY_ELIGIBLE',
        effectiveRr: 1.8,
        checks: { structure: 'PASS', location: 'PASS', trigger: 'PASS', evidence: 'PASS', flow: 'PASS', rr: 'PASS', freshness: 'PASS' },
        reasons: [],
      },
    };

    const map = {
      symbol: 'SOLUSDT',
      generatedAt: 1_700_000_000_000,
      state: 'TRIGGERED',
      bias: 'BEARISH',
      htfTrend: 'BEARISH',
      ltfTrend: 'BEARISH',
      location: 'PREMIUM',
      scenarios: [longScenario],
    } as unknown as SetupMap;

    const { decision } = evaluateBriefDecision(validQuality, state, map);
    assert.equal(decision.action, 'NO_TRADE');
    assert.ok(decision.reasonCodes.includes('CONFLICTING_EVIDENCE'));
  });
});
