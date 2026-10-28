import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffMarketBriefs } from '../src/marketBrief/MarketBriefDiff.js';
import type { MarketBrief } from '../src/marketBrief/types.js';

function createStubBrief(action: 'BUY_LONG' | 'SELL_SHORT' | 'NO_TRADE', bias: 'BULLISH' | 'BEARISH' | 'MIXED', price = 100): MarketBrief {
  return {
    schemaVersion: 1,
    briefId: 'brief_1',
    symbol: 'SOLUSDT',
    generatedAt: 1_700_000_000_000,
    dataQuality: { status: 'VALID', reasons: [], lastTradeAt: null, markPriceAt: null, derivativesAt: null },
    market: { lastPrice: price, markPrice: price, indexPrice: price, change24hPct: 0, high24h: 110, low24h: 90 },
    timeframes: {
      '5m': { timeframe: '5m', confirmed: null, forming: null, bias: 'UNKNOWN' },
      '15m': { timeframe: '15m', confirmed: null, forming: null, bias: 'UNKNOWN' },
      '1h': { timeframe: '1h', confirmed: null, forming: null, bias: 'UNKNOWN' },
      '4h': { timeframe: '4h', confirmed: null, forming: null, bias: 'UNKNOWN' },
    },
    derivatives: {
      fundingRate: 0.0001,
      nextFundingAt: 0,
      openInterest: 1000,
      openInterestChangePct: 0,
      globalLongShortRatio: 1.0,
      topTraderAccountLongShortRatio: 1.0,
      topTraderPositionLongShortRatio: 1.0,
      spreadBps: 2.0,
      takerFlowByPeriod: {},
    },
    decision: { bias, action, reasonCodes: ['NO_VALID_SETUP'], evaluatedAt: 1_700_000_000_000 },
    levels: { support: [95, 98], resistance: [102, 105] },
    scenarios: { bullishCondition: 'test bull', bearishCondition: 'test bear' },
  };
}

describe('MarketBriefDiff', () => {
  it('flags material change on the very first brief baseline', () => {
    const brief = createStubBrief('NO_TRADE', 'MIXED');
    const result = diffMarketBriefs(brief, null);

    assert.equal(result.isMaterialChange, true);
    assert.ok(result.changes.includes('initial market baseline established'));
  });

  it('detects action flip as material change', () => {
    const prev = createStubBrief('NO_TRADE', 'BULLISH');
    const curr = createStubBrief('BUY_LONG', 'BULLISH');
    const result = diffMarketBriefs(curr, prev);

    assert.equal(result.isMaterialChange, true);
    assert.ok(result.changes.some((c) => c.includes('action changed: NO_TRADE → BUY_LONG')));
  });

  it('detects structural bias flip as material change', () => {
    const prev = createStubBrief('NO_TRADE', 'BULLISH');
    const curr = createStubBrief('NO_TRADE', 'BEARISH');
    const result = diffMarketBriefs(curr, prev);

    assert.equal(result.isMaterialChange, true);
    assert.ok(result.changes.some((c) => c.includes('bias flipped: BULLISH → BEARISH')));
  });

  it('records significant price shift (> 1%)', () => {
    const prev = createStubBrief('NO_TRADE', 'BULLISH', 100);
    const curr = createStubBrief('NO_TRADE', 'BULLISH', 102.5); // +2.5%
    const result = diffMarketBriefs(curr, prev);

    assert.ok(result.changes.some((c) => c.includes('material price shift: +2.50%')));
  });
});
