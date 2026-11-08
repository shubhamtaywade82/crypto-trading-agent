import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  quantile,
  computeIndicators,
  classifyBar,
  type Candle4h,
  type ContextThresholds
} from '../scripts/context-strategy-harness.js';

describe('context-strategy-harness', () => {
  it('quantile computes linear interpolation correctly', () => {
    const arr = [10, 20, 30, 40, 50];
    assert.equal(quantile(arr, 0), 10);
    assert.equal(quantile(arr, 1), 50);
    assert.equal(quantile(arr, 0.5), 30);
    assert.equal(quantile(arr, 0.25), 20);
  });

  it('computeIndicators produces recursive EMAs and Wilder ATR', () => {
    const candles: Candle4h[] = [];
    for (let i = 0; i < 210; i++) {
      candles.push({
        openTime: i * 14400000,
        open: 100 + i,
        high: 102 + i,
        low: 99 + i,
        close: 101 + i
      });
    }
    const ind = computeIndicators(candles);
    assert.equal(ind.ema20.length, 210);
    assert.equal(ind.ema50.length, 210);
    assert.equal(ind.ema200.length, 210);
    assert.equal(ind.atr14.length, 210);
    assert.ok(ind.ema20[209] > 0);
    assert.ok(ind.atr14[209] > 0);
  });

  it('classifyBar identifies SHOCK and directional trend states', () => {
    const th: ContextThresholds = {
      flatSpread: 0.02,
      atrQ33: 0.015,
      atrQ67: 0.03,
      shockQ99: 0.05
    };
    const cNormal: Candle4h = { openTime: 0, open: 100, high: 102, low: 99, close: 101 };
    const regimeNormal = classifyBar(cNormal, 100, 105, 100, 1.2, th);
    assert.equal(regimeNormal, 'UP_LOW');

    const cShock: Candle4h = { openTime: 0, open: 100, high: 110, low: 99, close: 108 };
    const regimeShock = classifyBar(cShock, 100, 105, 100, 1.2, th);
    assert.equal(regimeShock, 'SHOCK');
  });
});
