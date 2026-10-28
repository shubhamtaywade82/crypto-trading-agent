import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BinanceMarketBriefDataProvider,
  TIMEFRAME_MS,
  type SdkFuturesClient,
} from '../src/marketBrief/MarketBriefDataProvider.js';

describe('MarketBriefDataProvider', () => {
  it('correctly maps timeframe intervals to exact millisecond durations', () => {
    assert.equal(TIMEFRAME_MS['5m'], 300_000);
    assert.equal(TIMEFRAME_MS['15m'], 900_000);
    assert.equal(TIMEFRAME_MS['1h'], 3_600_000);
    assert.equal(TIMEFRAME_MS['4h'], 14_400_000);
  });

  it('separates confirmed closed candles from forming live bar using mock client', async () => {
    const baseTime = 1_700_000_000_000;
    const now = baseTime + 900_000 + 300_000; // 5 min into the 2nd 15m bar

    const mockKlines = [
      // 1st bar: fully closed
      { openTime: baseTime, open: 100, high: 105, low: 99, close: 104, volume: 1000 },
      // 2nd bar: currently forming (ends at baseTime + 1_800_000)
      { openTime: baseTime + 900_000, open: 104, high: 106, low: 103, close: 105, volume: 400 },
    ];

    const mockClient: SdkFuturesClient = {
      market: {
        klines: async (_s, tf) => (tf === '15m' ? mockKlines : []),
        ticker24hr: async () => ({ lastPrice: '105', priceChangePercent: '2.5', highPrice: '108', lowPrice: '98', closeTime: now }),
        depth: async () => ({ bids: [['104.9', '10']], asks: [['105.1', '10']] }),
      },
      data: {
        premiumIndex: async () => ({ markPrice: '105.0', indexPrice: '104.95', lastFundingRate: '0.0001', nextFundingTime: now + 3600000, time: now }),
        openInterest: async () => ({ openInterest: '50000' }),
        openInterestHist: async () => [{ sumOpenInterest: '48000', timestamp: now - 900000 }, { sumOpenInterest: '50000', timestamp: now }],
        globalLongShortAccountRatio: async () => [{ longShortRatio: '1.25', timestamp: now }],
        topLongShortAccountRatio: async () => [{ longShortRatio: '1.40', timestamp: now }],
        topLongShortPositionRatio: async () => [{ longShortRatio: '1.30', timestamp: now }],
        takerLongShortRatio: async (_s, period) => [{ period, buyVol: '600', sellVol: '400', buySellRatio: '1.5', timestamp: now }],
      },
    };

    const provider = new BinanceMarketBriefDataProvider(mockClient);
    const snapshot = await provider.getSnapshot('SOLUSDT', now);

    assert.equal(snapshot.symbol, 'SOLUSDT');
    assert.equal(snapshot.overview.lastPrice, 105);
    assert.equal(snapshot.overview.markPrice, 105);
    assert.equal(snapshot.derivatives.openInterestChangePct, 4.17); // (50000 - 48000)/48000 * 100

    const tf15 = snapshot.candleViews['15m'];
    assert.ok(tf15.confirmed, 'must have confirmed closed bar');
    assert.equal(tf15.confirmed?.openTime, baseTime);
    assert.equal(tf15.confirmed?.closeTime, baseTime + 900_000);
    assert.equal(tf15.confirmed?.close, 104);

    assert.ok(tf15.forming, 'must have active forming bar');
    assert.equal(tf15.forming?.openTime, baseTime + 900_000);
    assert.equal(tf15.forming?.latestPrice, 105);
    assert.equal(tf15.forming?.volume, 400);

    assert.equal(snapshot.derivatives.takerFlowByPeriod['15m'].buySellRatio, 1.5);
    assert.equal(snapshot.derivatives.spreadBps, 19.05); // ((105.1 - 104.9)/105) * 10000
  });
});
