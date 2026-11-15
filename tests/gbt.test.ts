import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/research/Bootstrap.js';
import { fitGbt, predictGbt } from '../src/research/Gbt.js';

test('should learn an interaction a linear model cannot see', () => {
  const rand = mulberry32(9);
  const x = Array.from({ length: 6000 }, () => [rand() - 0.5, rand() - 0.5, rand() - 0.5]);
  const y = x.map((r) => (r[0]! > 0 && r[1]! > 0 ? 0.01 : 0) + 0.001 * (rand() - 0.5));
  const model = fitGbt(x, y, { rounds: 60, depth: 2, learningRate: 0.1, subsample: 0.7, bins: 16, minLeaf: 50, seed: 1 });
  assert.ok(predictGbt(model, [0.3, 0.3, 0]) > 0.007);
  assert.ok(predictGbt(model, [0.3, -0.3, 0]) < 0.003);
  assert.ok(predictGbt(model, [-0.3, 0.3, 0]) < 0.003);
});

test('should predict the training mean when the features carry no information', () => {
  const rand = mulberry32(2);
  const x = Array.from({ length: 3000 }, () => [rand(), rand()]);
  const y = x.map(() => 0.001 * (rand() - 0.5));
  const model = fitGbt(x, y, { rounds: 20, depth: 2, learningRate: 0.05, subsample: 0.5, bins: 16, minLeaf: 200, seed: 1 });
  assert.ok(Math.abs(predictGbt(model, [0.5, 0.5])) < 0.0003);
});
