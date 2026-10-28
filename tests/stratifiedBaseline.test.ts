import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import type { MarketRegime } from '../src/market/types.js';
import {
  sampleStratifiedEntries,
  evaluateBaselineEntries,
  summarizeByStrata,
  type StratifiedBar,
  type BaselineConfig,
} from '../src/research/StratifiedBaseline.js';

function createMockBars(count: number, regime: MarketRegime, startPrice = 100): StratifiedBar[] {
  const bars: StratifiedBar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    const openTime = i * 60_000;
    const open = price;
    const close = price + (regime === 'TREND_UP' ? 0.5 : regime === 'TREND_DOWN' ? -0.5 : 0.05);
    bars.push({
      candle: {
        openTime,
        open,
        high: Math.max(open, close) + 0.5,
        low: Math.min(open, close) - 0.5,
        close,
        volume: 50,
      },
      regime,
      atr: 1.0,
    });
    price = close;
  }
  return bars;
}

test('StratifiedBaseline: samples evenly across regimes with seed determinism', () => {
  const trendBars = createMockBars(50, 'TREND_UP', 100);
  const rangeBars = createMockBars(50, 'RANGE', 200);
  const highVolBars = createMockBars(50, 'HIGH_VOL', 300);

  const allBars = [...trendBars, ...rangeBars, ...highVolBars];
  const config: BaselineConfig = {
    seed: 1234,
    samplesPerStrata: 10,
    stopAtrMultiple: 1.5,
    targetRewardRisk: 1.5,
    maxHoldBars: 20,
    costs: { feeRate: 0.0004, slippageRate: 0.0002 },
  };

  const sample1 = sampleStratifiedEntries(allBars, 'BTCUSDT', config);
  const sample2 = sampleStratifiedEntries(allBars, 'BTCUSDT', config);

  // Assert seed determinism
  assert.deepEqual(sample1, sample2);

  // Assert representation across all 3 strata
  const trendCount = sample1.filter((e) => e.regime === 'TREND_UP').length;
  const rangeCount = sample1.filter((e) => e.regime === 'RANGE').length;
  const highVolCount = sample1.filter((e) => e.regime === 'HIGH_VOL').length;

  assert.equal(trendCount, 10);
  assert.equal(rangeCount, 10);
  assert.equal(highVolCount, 10);
  assert.equal(sample1.length, 30);
});

test('StratifiedBaseline: evaluates bracket outcomes with cost deductions', () => {
  const bars = createMockBars(60, 'RANGE', 100);
  const candles: Candle[] = bars.map((b) => b.candle);

  const entries = sampleStratifiedEntries(bars, 'BTCUSDT', {
    seed: 42,
    samplesPerStrata: 5,
    stopAtrMultiple: 1.0,
    targetRewardRisk: 2.0,
    maxHoldBars: 10,
    costs: { feeRate: 0.0005, slippageRate: 0.0005 }, // 0.1% round-trip cost
  });

  const results = evaluateBaselineEntries(entries, candles, { feeRate: 0.0005, slippageRate: 0.0005 }, 60_000, 10);

  assert.ok(results.length > 0);
  for (const r of results) {
    assert.ok(r.outcome === 'TP' || r.outcome === 'SL' || r.outcome === 'TIMEOUT');
    assert.ok(Number.isFinite(r.grossR));
    assert.ok(Number.isFinite(r.netR));
    // Round-trip cost must strictly decrease net R below gross R
    assert.ok(r.netR < r.grossR, 'net R must be lower than gross R due to execution friction');
  }

  const summaries = summarizeByStrata(results);
  const rangeSummary = summaries.get('RANGE');
  assert.ok(rangeSummary);
  assert.equal(rangeSummary?.n, results.length);
  assert.ok(rangeSummary?.winRate >= 0 && rangeSummary?.winRate <= 1);
});
