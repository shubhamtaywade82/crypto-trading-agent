import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCloseVol,
  calculateParkinsonVol,
  calculateGarmanKlassVol,
  calculateYangZhangVol,
  calculateRollingVol,
  type OHLCBar,
} from '../src/quant/volatility.js';

describe('Quant Volatility Estimators', () => {
  const bars: OHLCBar[] = [
    { open: 100, high: 105, low: 98, close: 102 },
    { open: 102, high: 108, low: 101, close: 107 },
    { open: 106, high: 109, low: 103, close: 104 },
    { open: 104, high: 106, low: 99, close: 101 },
    { open: 101, high: 103, low: 97, close: 99 },
    { open: 100, high: 104, low: 99, close: 103 },
  ];

  it('handles empty and insufficient data gracefully', () => {
    assert.equal(calculateCloseVol([]), 0);
    assert.equal(calculateParkinsonVol([]), 0);
    assert.equal(calculateGarmanKlassVol([]), 0);
    assert.equal(calculateYangZhangVol([]), 0);
  });

  it('calculates positive Parkinson volatility from high/low spreads', () => {
    const vol = calculateParkinsonVol(bars, 365);
    assert.ok(Number.isFinite(vol));
    assert.ok(vol > 0);
  });

  it('calculates positive Garman-Klass volatility from OHLC', () => {
    const vol = calculateGarmanKlassVol(bars, 365);
    assert.ok(Number.isFinite(vol));
    assert.ok(vol > 0);
  });

  it('calculates positive Yang-Zhang volatility handling overnight jumps', () => {
    const vol = calculateYangZhangVol(bars, 365);
    assert.ok(Number.isFinite(vol));
    assert.ok(vol > 0);
  });

  it('computes rolling volatility series correctly', () => {
    const rolling = calculateRollingVol(bars, 3, 'parkinson', 365);
    assert.equal(rolling.length, bars.length);
    // First 2 elements should be 0 because window = 3
    assert.equal(rolling[0], 0);
    assert.equal(rolling[1], 0);
    assert.ok(rolling[2] > 0);
    assert.ok(rolling[5] > 0);
  });
});
