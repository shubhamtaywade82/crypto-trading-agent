import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePearsonCorrelation,
  calculateSpearmanCorrelation,
  calculateCovariance,
  calculateCorrelationMatrix,
} from '../src/quant/correlation.js';

describe('Quant Correlation & Covariance', () => {
  it('handles empty and mismatched arrays', () => {
    assert.equal(calculatePearsonCorrelation([], []), 0);
    assert.equal(calculatePearsonCorrelation([1, 2], [1]), 0);
    assert.equal(calculateSpearmanCorrelation([], []), 0);
    assert.equal(calculateCovariance([], []), 0);
  });

  it('calculates perfect positive and negative Pearson correlation', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    const negY = [-2, -4, -6, -8, -10];

    assert.ok(Math.abs(calculatePearsonCorrelation(x, y) - 1.0) < 1e-9);
    assert.ok(Math.abs(calculatePearsonCorrelation(x, negY) - (-1.0)) < 1e-9);
  });

  it('calculates Spearman rank correlation handling non-linear monotonicity and ties', () => {
    // Non-linear monotonic: Pearson < 1.0, but Spearman == 1.0
    const x = [1, 2, 3, 4, 5];
    const y = [1, 8, 27, 64, 125];

    const pearson = calculatePearsonCorrelation(x, y);
    const spearman = calculateSpearmanCorrelation(x, y);
    assert.ok(pearson < 0.99);
    assert.ok(Math.abs(spearman - 1.0) < 1e-9);
  });

  it('builds a valid, symmetric correlation matrix across multiple series', () => {
    const series = {
      BTC: [0.01, 0.02, -0.01, 0.03, -0.02],
      ETH: [0.012, 0.018, -0.008, 0.025, -0.015],
      SOL: [-0.02, 0.01, 0.03, -0.01, 0.04],
    };

    const matrix = calculateCorrelationMatrix(series, 'pearson');
    assert.deepEqual(matrix.symbols, ['BTC', 'ETH', 'SOL']);

    // Diagonal must be 1.0
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(matrix.matrix[i][i] - 1.0) < 1e-9);
    }

    // Symmetry: matrix[i][j] === matrix[j][i]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        assert.ok(Math.abs(matrix.matrix[i][j] - matrix.matrix[j][i]) < 1e-9);
        assert.ok(matrix.matrix[i][j] >= -1.0 && matrix.matrix[i][j] <= 1.0);
      }
    }

    // BTC and ETH should be strongly positively correlated
    assert.ok(matrix.matrix[0][1] > 0.85);
  });
});
