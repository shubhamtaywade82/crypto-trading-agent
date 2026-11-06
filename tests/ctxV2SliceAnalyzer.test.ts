import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeQuantile,
  computeEma,
  computeIndicators,
  classifyBar,
  calcMetrics,
  type Candle,
  type ContextThresholds,
  type TradeRecord
} from '../scripts/ctx-v2-slice-analyzer.js';

describe('ctx-v2-slice-analyzer', () => {
  it('computes linear interpolation quantiles correctly', () => {
    const vals = [10, 20, 30, 40, 50];
    assert.equal(computeQuantile(vals, 0), 10);
    assert.equal(computeQuantile(vals, 0.5), 30);
    assert.equal(computeQuantile(vals, 1), 50);
  });

  it('computes recursive EMA series with SMA seed', () => {
    const series = [10, 10, 10, 10, 10, 20, 20];
    const ema = computeEma(series, 5);
    assert.equal(ema.length, 7);
    assert.equal(ema[4], 10);
    assert.ok(ema[5]! > 10 && ema[5]! < 20);
  });

  it('classifies bar into 10 mutually exclusive CTX-v2 states', () => {
    const th: ContextThresholds = {
      flatSpread: 0.02,
      atrQ33: 0.015,
      atrQ67: 0.030,
      shockQ99: 0.060
    };
    const cLow: Candle = { openTime: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 100 };
    assert.equal(classifyBar(cLow, 100, 105, 100, 1.0, th), 'UP_LOW');

    const cHigh: Candle = { openTime: 0, open: 100, high: 105, low: 95, close: 101, volume: 100 };
    assert.equal(classifyBar(cHigh, 100, 105, 100, 3.5, th), 'UP_HIGH');

    const cSideways: Candle = { openTime: 0, open: 100, high: 101, low: 99, close: 100.1, volume: 100 };
    assert.equal(classifyBar(cSideways, 100, 100.5, 100, 2.0, th), 'SIDEWAYS_NORMAL');

    const cShock: Candle = { openTime: 0, open: 100, high: 110, low: 99, close: 108, volume: 100 };
    assert.equal(classifyBar(cShock, 100, 105, 100, 1.0, th), 'SHOCK');
  });

  it('aggregates trade metrics without division by zero on zero loss', () => {
    const trades: TradeRecord[] = [
      { entryIdx: 1, openTime: 0, regime: 'UP_LOW', isTrain: true, netR: 1.5, isWin: true },
      { entryIdx: 2, openTime: 0, regime: 'UP_LOW', isTrain: true, netR: 1.0, isWin: true }
    ];
    const m = calcMetrics(trades);
    assert.equal(m.n, 2);
    assert.equal(m.winRate, 100);
    assert.equal(m.profitFactor, 99);
    assert.equal(m.meanR, 1.25);
  });
});
