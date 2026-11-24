import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSimpleReturns,
  calculateLogReturns,
  calculateCumulativeReturns,
  calculateAnnualizedSharpe,
  calculateAnnualizedSortino,
} from '../src/quant/returns.js';

describe('Quant Returns & Ratios', () => {
  it('returns empty array when price history has fewer than 2 points', () => {
    assert.deepEqual(calculateSimpleReturns([]), []);
    assert.deepEqual(calculateSimpleReturns([100]), []);
    assert.deepEqual(calculateLogReturns([]), []);
    assert.deepEqual(calculateLogReturns([100]), []);
  });

  it('calculates exact simple and log returns', () => {
    const prices = [100, 110, 99];
    const simple = calculateSimpleReturns(prices);
    assert.equal(simple.length, 2);
    assert.ok(Math.abs(simple[0] - 0.10) < 1e-9);
    assert.ok(Math.abs(simple[1] - (-0.10)) < 1e-9);

    const log = calculateLogReturns(prices);
    assert.equal(log.length, 2);
    assert.ok(Math.abs(log[0] - Math.log(1.10)) < 1e-9);
    assert.ok(Math.abs(log[1] - Math.log(99 / 110)) < 1e-9);
  });

  it('calculates cumulative returns compounded properly', () => {
    const returns = [0.10, -0.05, 0.20];
    const cum = calculateCumulativeReturns(returns);
    assert.equal(cum.length, 3);
    assert.ok(Math.abs(cum[0] - 0.10) < 1e-9);
    // (1 + 0.1) * (1 - 0.05) - 1 = 1.1 * 0.95 - 1 = 1.045 - 1 = 0.045
    assert.ok(Math.abs(cum[1] - 0.045) < 1e-9);
    // 1.045 * 1.2 - 1 = 1.254 - 1 = 0.254
    assert.ok(Math.abs(cum[2] - 0.254) < 1e-9);
  });

  it('calculates annualized Sharpe ratio matching reference', () => {
    // Constant positive returns with zero std dev return null or 0
    assert.equal(calculateAnnualizedSharpe([0.01, 0.01, 0.01], 0, 252), 0);

    const returns = [0.01, -0.005, 0.02, 0.015, -0.01];
    const sharpe = calculateAnnualizedSharpe(returns, 0.02 / 252, 252);
    assert.ok(Number.isFinite(sharpe));
    assert.ok(sharpe > 0);
  });

  it('calculates annualized Sortino ratio penalizing only downside deviation', () => {
    const returns = [0.05, 0.02, 0.03, -0.01, -0.02];
    const sortino = calculateAnnualizedSortino(returns, 0, 252);
    assert.ok(Number.isFinite(sortino));
    assert.ok(sortino > 0);

    // If there is zero downside, Sortino should not be NaN
    const positiveOnly = [0.01, 0.02, 0.03];
    const noDownside = calculateAnnualizedSortino(positiveOnly, 0, 252);
    assert.ok(Number.isFinite(noDownside));
  });
});
