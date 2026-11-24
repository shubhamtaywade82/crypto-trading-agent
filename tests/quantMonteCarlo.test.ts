import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateGeometricBrownianMotion,
  type MonteCarloGbmConfig,
} from '../src/quant/monteCarlo.js';

describe('Quant Monte Carlo GBM Simulator', () => {
  it('generates reproducible paths given the same seed', () => {
    const config: MonteCarloGbmConfig = {
      initialPrice: 100,
      driftAnnual: 0.05,
      volatilityAnnual: 0.20,
      timeHorizonYears: 1.0,
      steps: 20,
      simulations: 100,
      seed: 42,
    };

    const res1 = simulateGeometricBrownianMotion(config);
    const res2 = simulateGeometricBrownianMotion(config);

    assert.equal(res1.paths.length, 100);
    assert.equal(res1.paths[0].length, 21); // initial step 0 + 20 steps
    assert.deepEqual(res1.paths, res2.paths);
    assert.deepEqual(res1.quantiles, res2.quantiles);
  });

  it('converges to theoretical log-normal expectation', () => {
    // E[S_T] = S_0 * exp(mu * T)
    const s0 = 100;
    const mu = 0.08;
    const vol = 0.15;
    const t = 1.0;

    const res = simulateGeometricBrownianMotion({
      initialPrice: s0,
      driftAnnual: mu,
      volatilityAnnual: vol,
      timeHorizonYears: t,
      steps: 50,
      simulations: 2000,
      useAntithetic: true,
      seed: 12345,
    });

    const theoreticalMean = s0 * Math.exp(mu * t);
    const relativeError = Math.abs(res.terminalStats.mean - theoreticalMean) / theoreticalMean;
    // With 2000 antithetic paths, error should be under 2%
    assert.ok(relativeError < 0.02, `Relative error ${relativeError} exceeds 2%`);
  });

  it('calculates proper quantile confidence bands at every time step', () => {
    const res = simulateGeometricBrownianMotion({
      initialPrice: 100,
      driftAnnual: 0.0,
      volatilityAnnual: 0.20,
      timeHorizonYears: 0.5,
      steps: 10,
      simulations: 200,
      seed: 99,
    });

    assert.equal(res.quantiles.p05.length, 11);
    assert.equal(res.quantiles.p50.length, 11);
    assert.equal(res.quantiles.p95.length, 11);

    for (let step = 0; step <= 10; step++) {
      assert.ok(res.quantiles.p05[step] <= res.quantiles.p50[step]);
      assert.ok(res.quantiles.p50[step] <= res.quantiles.p95[step]);
    }
  });
});
