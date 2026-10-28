import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessBriefSafety, type SafetyThresholds } from '../src/marketBrief/MarketBriefSafety.js';
import type { MarketBriefRawData } from '../src/marketBrief/MarketBriefDataProvider.js';

function createMockRawData(now: number): MarketBriefRawData {
  return {
    symbol: 'SOLUSDT',
    asOf: now,
    overview: {
      lastPrice: 100,
      markPrice: 100,
      indexPrice: 100,
      change24hPct: 2.5,
      high24h: 105,
      low24h: 95,
    },
    candleViews: {
      '5m': { timeframe: '5m', confirmed: { openTime: now - 300_000, closeTime: now, open: 99, high: 101, low: 98, close: 100, volume: 100 }, forming: null, bias: 'UNKNOWN' },
      '15m': { timeframe: '15m', confirmed: { openTime: now - 900_000, closeTime: now, open: 98, high: 101, low: 97, close: 100, volume: 500 }, forming: null, bias: 'UNKNOWN' },
      '1h': { timeframe: '1h', confirmed: { openTime: now - 3_600_000, closeTime: now, open: 95, high: 102, low: 94, close: 100, volume: 2000 }, forming: null, bias: 'UNKNOWN' },
      '4h': { timeframe: '4h', confirmed: { openTime: now - 14_400_000, closeTime: now, open: 90, high: 103, low: 89, close: 100, volume: 8000 }, forming: null, bias: 'UNKNOWN' },
    },
    confirmedSeries: { '5m': [], '15m': [], '1h': [], '4h': [] },
    derivatives: {
      fundingRate: 0.0001,
      nextFundingAt: now + 3600_000,
      openInterest: 1000,
      openInterestChangePct: 1.0,
      globalLongShortRatio: 1.2,
      topTraderAccountLongShortRatio: 1.3,
      topTraderPositionLongShortRatio: 1.3,
      spreadBps: 5.0,
      takerFlowByPeriod: {},
    },
    sourceTimestamps: {
      lastTradeAt: now - 2000,
      markPriceAt: now - 2000,
      derivativesAt: now - 5000,
    },
  };
}

describe('MarketBriefSafety', () => {
  it('returns VALID when all feeds are fresh, consistent, and geometrically valid', () => {
    const now = 1_700_000_000_000;
    const raw = createMockRawData(now);
    const report = assessBriefSafety(raw, now);

    assert.equal(report.status, 'VALID');
    assert.equal(report.reasons.length, 0);
  });

  it('fails closed with INVALID when mark price is missing or non-positive', () => {
    const now = 1_700_000_000_000;
    const raw = createMockRawData(now);
    const badRaw = {
      ...raw,
      overview: { ...raw.overview, markPrice: null },
    };

    const report = assessBriefSafety(badRaw, now);
    assert.equal(report.status, 'INVALID');
    assert.ok(report.reasons.some((r) => r.includes('mark price missing')));
  });

  it('fails closed with INVALID on impossible OHLC relationships', () => {
    const now = 1_700_000_000_000;
    const raw = createMockRawData(now);
    const badCandles = {
      ...raw.candleViews,
      '15m': {
        ...raw.candleViews['15m'],
        confirmed: { openTime: now - 900_000, closeTime: now, open: 100, high: 90, low: 95, close: 92, volume: 100 }, // high < low
      },
    };

    const report = assessBriefSafety({ ...raw, candleViews: badCandles }, now);
    assert.equal(report.status, 'INVALID');
    assert.ok(report.reasons.some((r) => r.includes('impossible high < low')));
  });

  it('returns DEGRADED when mark and last ticker price diverge significantly', () => {
    const now = 1_700_000_000_000;
    const raw = createMockRawData(now);
    const diverged = {
      ...raw,
      overview: { ...raw.overview, lastPrice: 102.5, markPrice: 100.0 }, // 2.5% divergence
    };

    const report = assessBriefSafety(diverged, now);
    assert.equal(report.status, 'DEGRADED');
    assert.ok(report.reasons.some((r) => r.includes('divergence')));
  });

  it('returns DEGRADED when mark price timestamp is older than threshold', () => {
    const now = 1_700_000_000_000;
    const raw = createMockRawData(now);
    const staleMark = {
      ...raw,
      sourceTimestamps: { ...raw.sourceTimestamps, markPriceAt: now - 45_000 }, // 45s > 30s threshold
    };

    const report = assessBriefSafety(staleMark, now);
    assert.equal(report.status, 'DEGRADED');
    assert.ok(report.reasons.some((r) => r.includes('mark price stale')));
  });
});
