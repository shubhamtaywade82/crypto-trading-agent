import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MarketBriefNarrator, type NarratorClient } from '../src/marketBrief/MarketBriefNarrator.js';
import type { MarketBrief } from '../src/marketBrief/types.js';

describe('MarketBriefNarrator', () => {
  const mockBrief: MarketBrief = {
    schemaVersion: 1,
    briefId: 'narrative_test',
    symbol: 'SOLUSDT',
    generatedAt: Date.now(),
    dataQuality: { status: 'VALID', reasons: [], lastTradeAt: null, markPriceAt: null, derivativesAt: null },
    market: { lastPrice: 102.0, markPrice: 102.0, indexPrice: 102.0, change24hPct: 2.3, high24h: 105, low24h: 98 },
    timeframes: {
      '5m': { timeframe: '5m', confirmed: null, forming: null, bias: 'BULLISH' },
      '15m': { timeframe: '15m', confirmed: null, forming: null, bias: 'MIXED' },
      '1h': { timeframe: '1h', confirmed: null, forming: null, bias: 'BULLISH' },
      '4h': { timeframe: '4h', confirmed: null, forming: null, bias: 'BULLISH' },
    },
    derivatives: {
      fundingRate: 0.0001,
      nextFundingAt: 0,
      openInterest: 1000,
      openInterestChangePct: 1.0,
      globalLongShortRatio: 2.0,
      topTraderAccountLongShortRatio: 2.5,
      topTraderPositionLongShortRatio: 2.0,
      spreadBps: 1.0,
      takerFlowByPeriod: {},
    },
    decision: { bias: 'BULLISH', action: 'NO_TRADE', reasonCodes: ['NO_VALID_SETUP'], evaluatedAt: Date.now() },
    levels: { support: [96, 98], resistance: [104, 106] },
    scenarios: { bullishCondition: 'test', bearishCondition: 'test' },
  };

  it('parses valid structured narrative response from Ollama client', async () => {
    const mockClient: NarratorClient = {
      generateText: async () => JSON.stringify({
        summary: 'Market in bullish consolidation without confirmed trigger.',
        bullishConditions: ['15m close above 104'],
        bearishConditions: ['15m close below 96'],
        unresolvedConflicts: ['HTF trend bullish but LTF momentum pausing'],
        dataLimitations: [],
      }),
    };

    const narrator = new MarketBriefNarrator(mockClient, 'test-model');
    const narrative = await narrator.narrateBrief(mockBrief);

    assert.ok(narrative);
    assert.equal(narrative?.summary, 'Market in bullish consolidation without confirmed trigger.');
    assert.equal(narrative?.bullishConditions.length, 1);
  });

  it('falls back to null gracefully on network failure or malformed JSON', async () => {
    const mockFailingClient: NarratorClient = {
      generateText: async () => 'Malformed non-JSON output from LLM',
    };

    const narrator = new MarketBriefNarrator(mockFailingClient, 'test-model');
    const narrative = await narrator.narrateBrief(mockBrief);

    assert.equal(narrative, null);
  });
});
