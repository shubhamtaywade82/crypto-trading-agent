import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MarketBriefScheduler } from '../src/marketBrief/MarketBriefScheduler.js';
import type { MarketBriefService } from '../src/marketBrief/MarketBriefService.js';
import type { MarketBrief } from '../src/marketBrief/types.js';

describe('MarketBriefScheduler', () => {
  it('executes tick for symbol and emits formatted card', async () => {
    const testDir = path.resolve('data/test-market-briefs');
    fs.rmSync(testDir, { recursive: true, force: true });

    const mockBrief: MarketBrief = {
      schemaVersion: 1,
      briefId: 'test_1',
      symbol: 'SOLUSDT',
      generatedAt: Date.now(),
      dataQuality: { status: 'VALID', reasons: [], lastTradeAt: null, markPriceAt: null, derivativesAt: null },
      market: { lastPrice: 100, markPrice: 100, indexPrice: 100, change24hPct: 0, high24h: 105, low24h: 95 },
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
      decision: { bias: 'BULLISH', action: 'NO_TRADE', reasonCodes: ['NO_VALID_SETUP'], evaluatedAt: Date.now() },
      levels: { support: [90, 95], resistance: [105, 110] },
      scenarios: { bullishCondition: 'bull', bearishCondition: 'bear' },
    };

    const mockService = {
      generateBrief: async () => mockBrief,
    } as unknown as MarketBriefService;

    let emittedCard = '';
    const scheduler = new MarketBriefScheduler(mockService, {
      symbols: ['SOLUSDT'],
      intervalMs: 1000,
      journalDir: testDir,
      onBriefEmitted: (_b, card) => { emittedCard = card; },
    });

    await scheduler.tick();

    assert.ok(emittedCard.includes('SOLUSDT · USDⓈ-M'));
    assert.ok(emittedCard.includes('NO TRADE'));

    const journalFile = path.join(testDir, 'SOLUSDT.jsonl');
    assert.ok(fs.existsSync(journalFile));

    fs.rmSync(testDir, { recursive: true, force: true });
  });
});
