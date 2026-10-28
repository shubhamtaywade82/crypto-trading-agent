import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatMarketBriefCard, formatMarketBriefMessage } from '../src/marketBrief/MarketBriefFormatter.js';
import type { MarketBrief } from '../src/marketBrief/types.js';

describe('MarketBriefFormatter', () => {
  it('formats Telegram HTML card matching the target brief specification', () => {
    const brief: MarketBrief = {
      schemaVersion: 1,
      briefId: 'brief_sol_1',
      symbol: 'SOLUSDT',
      generatedAt: Date.UTC(2026, 9, 28, 10, 30, 0),
      dataQuality: { status: 'VALID', reasons: [], lastTradeAt: null, markPriceAt: null, derivativesAt: null },
      market: { lastPrice: 105.20, markPrice: 105.25, indexPrice: 105.15, change24hPct: 2.50, high24h: 110.0, low24h: 98.0 },
      timeframes: {
        '5m': { timeframe: '5m', confirmed: null, forming: null, bias: 'BEARISH' },
        '15m': { timeframe: '15m', confirmed: null, forming: null, bias: 'MIXED' },
        '1h': { timeframe: '1h', confirmed: null, forming: null, bias: 'BULLISH' },
        '4h': { timeframe: '4h', confirmed: null, forming: null, bias: 'BULLISH' },
      },
      derivatives: {
        fundingRate: 0.0001,
        nextFundingAt: 0,
        openInterest: 50000,
        openInterestChangePct: 4.17,
        globalLongShortRatio: 1.25,
        topTraderAccountLongShortRatio: 1.40,
        topTraderPositionLongShortRatio: 1.30,
        spreadBps: 2.0,
        takerFlowByPeriod: {
          '5m': { period: '5m', buyVolume: 600, sellVolume: 400, buySellRatio: 1.5, timestamp: 0 },
          '15m': { period: '15m', buyVolume: 6000, sellVolume: 4000, buySellRatio: 1.5, timestamp: 0 },
        },
      },
      decision: {
        bias: 'MIXED',
        action: 'NO_TRADE',
        reasonCodes: ['Conflicting short-term flow', 'neither entry trigger is confirmed'],
        evaluatedAt: 0,
      },
      levels: {
        support: [96.00, 98.00],
        resistance: [104.00, 106.00],
      },
      scenarios: {
        bullishCondition: 'Confirmed 15m reclaim and successful retest above the specified resistance.',
        bearishCondition: 'Confirmed 15m close below support and failed reclaim.',
      },
    };

    const card = formatMarketBriefCard(brief);

    assert.ok(card.includes('<b>## SOLUSDT · USDⓈ-M</b>'));
    assert.ok(card.includes('<b>NO TRADE</b>'));
    assert.ok(card.includes('Generated at 10:30 UTC · Data quality: <b>VALID</b>'));
    assert.ok(card.includes('Price: <b>$105.20</b> · 24h: <b>+2.50%</b>'));
    assert.ok(card.includes('Structure: 5m bearish · 15m mixed · 1h bullish · 4h bullish'));
    assert.ok(card.includes('Derivatives: Funding +0.0100% · OI Δ +4.17% · Global L/S 1.25'));
    assert.ok(card.includes('Flow: 5m buy-dominant · 15m buy-dominant · 1h unavailable'));
    assert.ok(card.includes('Key levels: Support $96.00–$98.00 · Resistance $104.00–$106.00'));
    assert.ok(card.includes('<b>Why no trade:</b> Conflicting short-term flow; neither entry trigger is confirmed'));

    const msg = formatMarketBriefMessage(brief);
    assert.ok(msg.entities.length >= 6);
    assert.ok(!msg.text.includes('<b>'));
    assert.ok(msg.text.includes('Price: $105.20 · 24h: +2.50%'));
  });
});
