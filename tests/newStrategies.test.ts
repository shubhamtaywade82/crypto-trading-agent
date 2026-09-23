import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { StructureTrendAgent } from '../src/agents/StructureTrendAgent.js';
import { MeanReversionAgent } from '../src/agents/MeanReversionAgent.js';
import { CrowdingAgent } from '../src/agents/CrowdingAgent.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import type { MarketState } from '../market/types.js';

const dummyService = {} as BinanceService;

function mockMarketState(overrides: Partial<MarketState> = {}): MarketState {
  const baseTf = {
    timeframe: '15m' as const,
    candleCount: 100,
    lastClose: 100,
    ema20: 100,
    ema50: 100,
    ema200: 100,
    emaSlopePct: 0,
    adx14: 15,
    atr14: 2,
    atrPercentile: 50,
    rsi14: 50,
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
      regime: 'RANGE',
      trendDirection: 'NEUTRAL',
      trendStrength: 0,
      volatility: 'MEDIUM',
      volatilityPercentile: 50,
      adx14: 15,
      emaSlopePct: 0,
    },
    timeframes: { '15m': baseTf, '1h': { ...baseTf, timeframe: '1h' }, '4h': { ...baseTf, timeframe: '4h' } },
    htfStructure: {
      timeframe: '1h',
      trend: 'NEUTRAL',
      swingHighs: [],
      swingLows: [],
      lastBreak: null,
      protectedHigh: null,
      protectedLow: null,
    },
    ltfStructure: {
      timeframe: '15m',
      trend: 'NEUTRAL',
      swingHighs: [],
      swingLows: [],
      lastBreak: null,
      protectedHigh: null,
      protectedLow: null,
    },
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [] },
      ltf: { timeframe: '15m', pools: [], latestSweeps: [] },
    },
    zones: [],
    pricing: {
      high: 110,
      low: 90,
      equilibrium: 100,
      positionPct: 50,
      premium: false,
      discount: false,
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
    },
    derivatives: null,
    crowding: null,
    ...overrides,
  };
}

function context(state: MarketState): MarketContext {
  return {
    candles: {},
    funding: { [state.symbol]: state.fundingRate },
    marks: { [state.symbol]: state.mark },
    spot: {},
    equity: 100_000,
    marketState: { [state.symbol]: state },
  };
}

test('StructureTrendAgent emits OPEN_LONG in discount with bullish HTF and LTF break', async () => {
  const state = mockMarketState({
    mark: 94,
    htfStructure: { ...mockMarketState().htfStructure, trend: 'BULLISH' },
    pricing: { high: 110, low: 90, equilibrium: 100, positionPct: 20, premium: false, discount: true },
    ltfStructure: {
      ...mockMarketState().ltfStructure,
      lastBreak: { type: 'CHOCH', direction: 'BULLISH', level: 93, index: 5, time: 1000, distanceAtr: 1 },
      protectedLow: { index: 3, time: 900, price: 91, type: 'LOW' },
    },
  });

  const agent = new StructureTrendAgent(dummyService);
  const signals = await agent.run(context(state));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, 'OPEN_LONG');
  assert.equal(signals[0].entry, 94);
  assert.equal(signals[0].stopLoss, 91);
  assert.ok(signals[0].takeProfit! >= 100);
});

test('MeanReversionAgent emits OPEN_LONG on extreme negative Z-score in RANGE regime', async () => {
  const state = mockMarketState({
    mark: 95,
    regime: { ...mockMarketState().regime, regime: 'RANGE', adx14: 14 },
    meanReversion: {
      ...mockMarketState().meanReversion,
      zscore: -2.3,
      rsi14: 30,
      vwap: 100,
      bollingerLower: 96,
    },
  });

  const agent = new MeanReversionAgent(dummyService);
  const signals = await agent.run(context(state));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, 'OPEN_LONG');
  assert.equal(signals[0].takeProfit, 100);
});

test('MeanReversionAgent ignores setups in trending regimes', async () => {
  const state = mockMarketState({
    regime: { ...mockMarketState().regime, regime: 'TREND_UP', adx14: 35 },
    meanReversion: {
      ...mockMarketState().meanReversion,
      zscore: -2.5,
      rsi14: 25,
    },
  });

  const agent = new MeanReversionAgent(dummyService);
  const signals = await agent.run(context(state));
  assert.equal(signals.length, 0);
});

test('CrowdingAgent fades LONG_CROWDED at premium after buy-side liquidity sweep', async () => {
  const state = mockMarketState({
    mark: 108,
    pricing: { high: 110, low: 90, equilibrium: 100, positionPct: 90, premium: true, discount: false },
    crowding: {
      fundingPercentile: 95,
      topTraderVsGlobalBias: 1.8,
      positioningExtreme: 'LONG_CROWDED',
      takerAggressionRatio: 1.5,
      openInterestExpansion: true,
    },
    liquidity: {
      htf: { timeframe: '1h', pools: [], latestSweeps: [] },
      ltf: {
        timeframe: '15m',
        pools: [],
        latestSweeps: [{
          poolType: 'EQUAL_HIGH',
          direction: 'BUY_SIDE',
          level: 107.5,
          sweepPrice: 111,
          close: 108,
          index: 10,
          time: 1000,
          confirmed: true,
        }],
      },
    },
  });

  const agent = new CrowdingAgent(dummyService);
  const signals = await agent.run(context(state));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, 'OPEN_SHORT');
  assert.equal(signals[0].entry, 108);
  assert.equal(signals[0].stopLoss, 111);
  assert.equal(signals[0].takeProfit, 100);
});
