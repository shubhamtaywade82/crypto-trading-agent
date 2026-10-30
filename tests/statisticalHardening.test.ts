import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shrinkMean, estimateK, applyShrinkage } from '../src/research/Shrinkage.js';
import { calculateRequiredSampleSize, normalQuantile } from '../src/research/SampleSize.js';
import {
  normalCdf,
  expectedMaxSharpe,
  sharpeStandardError,
  computeDeflatedSharpe,
  computeDeflatedSharpeFromReturns,
} from '../src/research/DeflatedSharpe.js';
import { walkForward, type Observation } from '../src/research/ConditionalEdge.js';

test('Shrinkage: regularizes small-sample cells heavily toward baseline mean', () => {
  const baselineMean = 0.05; // 0.05R baseline across whole dataset
  const luckySmallCellMean = 0.80; // Lucky +0.80R with only 5 trades

  const shrunkSmall = shrinkMean(luckySmallCellMean, 5, baselineMean, 25);
  // (5 / 30) * 0.80 + (25 / 30) * 0.05 = 0.1333 + 0.0416 = ~0.175R
  assert.ok(shrunkSmall < 0.20, 'lucky small cell should be shrunk strongly toward baseline');

  // Large-sample cell with 250 trades retains its evidence
  const shrunkLarge = shrinkMean(0.40, 250, baselineMean, 25);
  // (250 / 275) * 0.40 + (25 / 275) * 0.05 = ~0.368R
  assert.ok(shrunkLarge > 0.35, 'large-N cell should preserve its evidence');
});

test('Shrinkage: applyShrinkage sorts cells by shrunken expectancy', () => {
  const cells = [
    { key: 'A', mean: 0.90, n: 2 },   // Outlier on tiny sample
    { key: 'B', mean: 0.30, n: 100 }, // Robust moderate edge
    { key: 'C', mean: -0.20, n: 50 }, // Consistent loser
  ];

  const results = applyShrinkage(cells, 0.0, { k: 20 });
  // Cell B should rank higher than Cell A after shrinkage
  assert.equal(results[0].cell.key, 'B');
  assert.equal(results[1].cell.key, 'A');
  assert.equal(results[2].cell.key, 'C');
});

test('SampleSize: derives trade counts from stated effect size and power', () => {
  // Delta = 0.1R, sigma = 1.0R, alpha = 0.05, power = 0.80 => ~784 trades
  const res1 = calculateRequiredSampleSize({ effectSizeR: 0.10, sigmaR: 1.0, alpha: 0.05, power: 0.80 });
  assert.ok(res1.requiredSampleSize >= 780 && res1.requiredSampleSize <= 790);

  // Delta = 0.25R => ~126 trades
  const res2 = calculateRequiredSampleSize({ effectSizeR: 0.25, sigmaR: 1.0, alpha: 0.05, power: 0.80 });
  assert.ok(res2.requiredSampleSize >= 120 && res2.requiredSampleSize <= 130);

  // Delta = 0.50R => ~32 trades (matches 30-trade floor for large swings)
  const res3 = calculateRequiredSampleSize({ effectSizeR: 0.50, sigmaR: 1.0, alpha: 0.05, power: 0.80 });
  assert.ok(res3.requiredSampleSize >= 30 && res3.requiredSampleSize <= 35);
});

test('DeflatedSharpe: deflates Sharpe ratio under multiple testing and fat tails', () => {
  // A modest Sharpe of 1.2 across 100 trades with only 1 trial has high PSR
  const single = computeDeflatedSharpe({
    sharpeRatio: 1.2,
    sampleLength: 100,
    trialCount: 1,
    trialSharpeVariance: 0.5,
  });
  assert.equal(single.expectedMaxSharpe, 0);
  assert.ok(single.psr > 0.95);
  assert.ok(single.isSignificant);

  // The SAME Sharpe of 1.2 found after trying 500 candidate variations is NOT significant!
  const searched = computeDeflatedSharpe({
    sharpeRatio: 1.2,
    sampleLength: 100,
    trialCount: 500,
    trialSharpeVariance: 0.5,
  });
  assert.ok(searched.expectedMaxSharpe > 1.5, 'expected max Sharpe under 500 trials exceeds 1.5');
  assert.ok(searched.dsr < 0.50, 'deflated Sharpe must collapse under multiple testing');
  assert.equal(searched.isSignificant, false);
});

test('DeflatedSharpe derives Sharpe, skewness and kurtosis from fixed-frequency equity returns', () => {
  const returns = Array.from({ length: 600 }, (_, i) => {
    const centered = ((i * 37) % 101 - 50) / 10_000;
    return 0.0002 + centered;
  });
  const dsr = computeDeflatedSharpeFromReturns({
    returns,
    samplingFrequencyMs: 15 * 60_000,
    trialCount: 25,
    trialSharpeVariance: 0.2,
  });
  assert.equal(dsr.samplingFrequencyMs, 15 * 60_000);
  assert.equal(dsr.sampleLength, undefined);
  assert.equal(dsr.psr > 0, true);
  assert.ok(Number.isFinite(dsr.sharpeRatio));
  assert.ok(Number.isFinite(dsr.skewness));
  assert.ok(Number.isFinite(dsr.kurtosis));
  assert.ok(dsr.kurtosis >= 1);
  assert.throws(() => computeDeflatedSharpeFromReturns({
    returns,
    samplingFrequencyMs: 0,
    trialCount: 25,
    trialSharpeVariance: 0.2,
  }), /samplingFrequencyMs/);
  assert.throws(() => computeDeflatedSharpeFromReturns({
    returns,
    samplingFrequencyMs: 60_000,
    trialCount: 25,
    trialSharpeVariance: 0,
  }), /trialSharpeVariance/);
});

test('SampleSize rejects invalid power-analysis assumptions', () => {
  assert.throws(() => calculateRequiredSampleSize({ effectSizeR: 0, sigmaR: 1 }), /effectSizeR/);
  assert.throws(() => calculateRequiredSampleSize({ effectSizeR: 0.1, sigmaR: 0 }), /sigmaR/);
  assert.throws(() => calculateRequiredSampleSize({ effectSizeR: 0.1, sigmaR: 1, alpha: 0 }), /alpha/);
  assert.throws(() => calculateRequiredSampleSize({ effectSizeR: 0.1, sigmaR: 1, power: 1 }), /power/);
});

test('ConditionalEdge: walkForward respects embargoDays buffer between train and test', () => {
  const DAY = 86_400_000;
  const obs: Observation[] = [];
  const baseTime = 1_000_000;

  // Generate 60 days of observations
  for (let d = 0; d < 60; d += 1) {
    obs.push({
      t: baseTime + d * DAY + 1_000,
      closedAt: baseTime + d * DAY + 10_000,
      key: 'TEST_STRATEGY',
      netR: 0.2,
    });
  }

  const report = walkForward(obs, {
    trainDays: 20,
    testDays: 10,
    stepDays: 15,
    embargoDays: 3, // 3 days embargo buffer
    minN: 5,
  });

  assert.ok(report.folds.length > 0);
  for (const fold of report.folds) {
    // Assert that test starts strictly after trainTo + embargoDays
    assert.equal(fold.testFrom, fold.trainTo + 3 * DAY);
  }
});
