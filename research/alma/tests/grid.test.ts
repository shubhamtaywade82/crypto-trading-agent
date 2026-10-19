import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  candidateId,
  enumerateStage1,
  parseSearchSpace,
  validPairs,
} from '../src/grid.js';
import type { AlmaSource } from '../src/types.js';

const configPath = new URL('../config/search-space.v1.json', import.meta.url);
const config = parseSearchSpace(JSON.parse(readFileSync(configPath, 'utf8')));

test('predeclared stage-1 grid yields 112 valid fast<slow pairs and 141,120 total candidates', () => {
  const grid = enumerateStage1(config);
  assert.equal(grid.counts.pairs, 112);
  assert.equal(grid.counts.offsets, config.offsetCoarseShared.length);
  assert.equal(grid.counts.sigmas, config.sigmaCoarseShared.length);
  assert.equal(grid.counts.sources, 2); // search-space stage 1 pins close + hlc3
  assert.equal(grid.counts.timeframes, 15);
  assert.equal(grid.counts.total, 141_120);
  assert.equal(grid.candidates.length, grid.counts.total);
});

test('enumeration is deterministic and ids encode every axis value', () => {
  const a = enumerateStage1(config);
  const b = enumerateStage1(config);
  assert.deepEqual(a.candidates, b.candidates);
  assert.equal(a.candidates[0].id, 's1|1m|f3-s9|o0.5|g2|close');
  const last = a.candidates[a.candidates.length - 1];
  assert.equal(last.timeframe, '1M');
  assert.equal(last.source, 'hlc3');
  assert.equal(candidateId('15m', 9, 21, 0.85, 6, 'close'), 's1|15m|f9-s21|o0.85|g6|close');
});

test('every candidate satisfies fast < slow and stays inside the declared axes', () => {
  const grid = enumerateStage1(config);
  const offsets = new Set(config.offsetCoarseShared);
  const sigmas = new Set(config.sigmaCoarseShared);
  for (const candidate of grid.candidates) {
    assert.ok(candidate.fastLength < candidate.slowLength);
    assert.ok(offsets.has(candidate.offset));
    assert.ok(sigmas.has(candidate.sigma));
  }
});

test('validPairs keeps only strictly ascending pairs', () => {
  const pairs = validPairs([9, 21], [9, 21, 50]);
  assert.deepEqual(pairs, [
    { fast: 9, slow: 21 },
    { fast: 9, slow: 50 },
    { fast: 21, slow: 50 },
  ]);
});

test('parseSearchSpace rejects malformed configs deterministically', () => {
  assert.throws(() => parseSearchSpace({}), /missing "alma"/);
  assert.throws(() => parseSearchSpace({ alma: { ...config, fastLength: [0] } }), /positive integers/);
  assert.throws(() => parseSearchSpace({ alma: { ...config, offsetCoarseShared: [1.5] } }), /\[0, 1\]/);
  assert.throws(() => parseSearchSpace({ alma: { ...config, sigmaCoarseShared: [0] } }), /must be > 0/);
  assert.throws(() => parseSearchSpace({ alma: { ...config, source: ['not-a-source'] } }), /unsupported source/);
  assert.throws(
    () => parseSearchSpace({ alma: { ...config, offsetCoarseShared: [0.85, 0.85] } }),
    /duplicate/,
  );
});

test('source subset must be part of the declared source axis', () => {
  // 'low' is a valid ALMA source generally, but it is not declared in this config's axis.
  assert.throws(
    () => enumerateStage1(config, undefined, ['low'] as AlmaSource[]),
    /not part of the declared source axis/,
  );
});
