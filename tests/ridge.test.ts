import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitRidge, predictRidge } from '../src/research/Ridge.js';
import { mulberry32 } from '../src/research/Bootstrap.js';

test('should recover a linear signal and ignore a noise feature', () => {
  const rand = mulberry32(3);
  const x = Array.from({ length: 4000 }, () => [rand() - 0.5, rand() - 0.5, rand() - 0.5]);
  const y = x.map((r) => 0.02 * r[0]! - 0.01 * r[1]! + 0.0005 * (rand() - 0.5));
  const model = fitRidge(x, y, 1);
  assert.ok(model.coefficients[0]! > 0 && model.coefficients[1]! < 0);
  assert.ok(Math.abs(model.coefficients[2]!) < Math.abs(model.coefficients[1]!) / 5);
  assert.ok(Math.abs(predictRidge(model, [0.3, 0, 0]) - 0.006) < 0.0015);
});

test('should clip extreme feature values so one outlier cannot dominate a prediction', () => {
  const x = Array.from({ length: 200 }, (_, i) => [i / 200]);
  const model = fitRidge(x, x.map((r) => r[0]!), 0.1);
  assert.equal(predictRidge(model, [1e9]), predictRidge(model, [1e12]));
});
