import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MarketBriefService } from '../src/marketBrief/MarketBriefService.js';
import { BinanceMarketBriefDataProvider, type SdkFuturesClient } from '../src/marketBrief/MarketBriefDataProvider.js';
import { MarketStateBuilder } from '../src/market/MarketStateBuilder.js';

describe('MarketBriefService', () => {
  it('generates a full validated MarketBrief matching the Zod contract schema', async () => {
    const baseTime = 1_700_000_000_000;
    const now = baseTime + 100 * 900_000 + 300_000;

    const generateBars = (count: number, spanMs: number) =>
      Array.from({ length: count }, (_, i) => ({
        openTime: baseTime + i * spanMs,
        open: 100 + i * 0.1,
        high: 101 + i * 0.1,
        low: 99 + i * 0.1,
        close: 100.5 + i * 0.1,
        volume: 1000,
      }));

    const mockKlines: Record<string, any[]> = {
      '5m': generateBars(100, 300_000),
      '15m': generateBars(100, 900_000),
      '1h': generateBars(50, 3_600_000),
      '4h': generateBars(30, 14_400_000),
    };

    const mockClient: SdkFuturesClient = {
      market: {
        klines: async (_s, tf) => mockKlines[tf] ?? [],
        ticker24hr: async () => ({ lastPrice: '110.5', priceChangePercent: '5.2', highPrice: '112.0', lowPrice: '98.0', closeTime: now }),
        depth: async () => ({ bids: [['110.4', '10']], asks: [['110.6', '10']] }),
      },
      data: {
        premiumIndex: async () => ({ markPrice: '110.5', indexPrice: '110.45', lastFundingRate: '0.0001', nextFundingTime: now + 3600000, time: now }),
        openInterest: async () => ({ openInterest: '80000' }),
        openInterestHist: async () => [{ sumOpenInterest: '75000', timestamp: now - 900000 }, { sumOpenInterest: '80000', timestamp: now }],
        globalLongShortAccountRatio: async () => [{ longShortRatio: '1.25', timestamp: now }],
        topLongShortAccountRatio: async () => [{ longShortRatio: '1.40', timestamp: now }],
        topLongShortPositionRatio: async () => [{ longShortRatio: '1.30', timestamp: now }],
        takerLongShortRatio: async (_s, period) => [{ period, buyVol: '6000', sellVol: '4000', buySellRatio: '1.5', timestamp: now }],
      },
    };

    const provider = new BinanceMarketBriefDataProvider(mockClient);
    const service = new MarketBriefService(provider);

    const brief = await service.generateBrief('SOLUSDT', now);

    assert.equal(brief.schemaVersion, 1);
    assert.equal(brief.symbol, 'SOLUSDT');
    assert.equal(brief.generatedAt, now);
    assert.equal(brief.dataQuality.status, 'VALID');
    assert.equal(brief.market.markPrice, 110.5);
    assert.ok(['BULLISH', 'BEARISH', 'MIXED'].includes(brief.decision.bias));
    assert.ok(['BUY_LONG', 'SELL_SHORT', 'NO_TRADE'].includes(brief.decision.action));
    assert.ok(brief.scenarios.bullishCondition.length > 0);
    assert.ok(brief.scenarios.bearishCondition.length > 0);
  });
});
