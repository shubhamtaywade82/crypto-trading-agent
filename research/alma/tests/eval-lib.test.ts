import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dayKeysNotInMonths,
  evalConfirmationGate,
  evalStageCGate,
  holmRejects,
  monthKeys,
  mulberry32,
  parseFundingCsv,
  permutationP,
  summarizeR,
} from '../src/eval-lib.js';

// ---------------------------------------------------------------------------
// holmRejects
// ---------------------------------------------------------------------------

test('holmRejects returns no rejections for empty or non-significant families', () => {
  assert.deepEqual(holmRejects([]), []);
  assert.deepEqual(holmRejects([1, 1, 1]), [false, false, false]);
});

test('holmRejects steps down and stops at the first failure', () => {
  // 0.001 <= 0.05/3 -> reject; active 2; 0.04 > 0.025 -> stop (third not tested).
  assert.deepEqual(holmRejects([0.001, 0.04, 0.04]), [true, false, false]);
  // 0.01 <= 0.05/3; 0.02 <= 0.05/2; 0.03 <= 0.05/1 -> all rejected.
  assert.deepEqual(holmRejects([0.01, 0.02, 0.03]), [true, true, true]);
});

test('holmRejects treats the boundary as significant and preserves input order', () => {
  // alpha/active = 0.05/2 = 0.025; p === boundary counts as rejected.
  assert.deepEqual(holmRejects([0.5, 0.025]), [false, true]);
});

// ---------------------------------------------------------------------------
// mulberry32 + permutationP
// ---------------------------------------------------------------------------

test('mulberry32 is deterministic and bounded in [0, 1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = Array.from({ length: 8 }, () => a());
  const seqB = Array.from({ length: 8 }, () => b());
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test('permutationP is deterministic for a fixed seed', () => {
  const trades = [0.5, -1, 1.7, -1, 0.3, 2.1, -1];
  const p1 = permutationP(trades, 20261021, 2000);
  const p2 = permutationP(trades, 20261021, 2000);
  assert.equal(p1, p2);
});

test('permutationP is 1 for an empty series or an all-losing series', () => {
  assert.equal(permutationP([], 7, 1000), 1);
  assert.equal(permutationP([-1, -1, -1, -1], 7, 1000), 1);
});

test('permutationP is small for a consistently positive series', () => {
  // mean 3; a sign flip reaches >= 3 only when every sign stays + (p ~ 1/32).
  const p = permutationP([3, 3, 3, 3, 3], 20261021, 10000);
  assert.ok(p < 0.05, 'expected p < 0.05, got ' + p);
});

// ---------------------------------------------------------------------------
// summarizeR
// ---------------------------------------------------------------------------

test('summarizeR computes exact mean/median/win/PF/maxDD', () => {
  const s = summarizeR([2, -1, 3, -1, -1]);
  assert.ok(Math.abs((s.mean as number) - 0.4) < 1e-12);
  assert.equal(s.median, -1);
  assert.ok(Math.abs((s.win as number) - 0.4) < 1e-12);
  assert.ok(Math.abs((s.pf as number) - 5 / 3) < 1e-12);
  assert.ok(Math.abs((s.maxDD as number) - 2) < 1e-12);
});

test('summarizeR handles empty series and loss-free series', () => {
  assert.deepEqual(summarizeR([]), { mean: null, median: null, win: null, pf: null, maxDD: null });
  const s = summarizeR([1, 2, 3]);
  assert.equal(s.pf, null);
  assert.equal(s.maxDD, 0);
  assert.equal(s.win, 1);
});

// ---------------------------------------------------------------------------
// funding csv / month keys
// ---------------------------------------------------------------------------

test('parseFundingCsv skips headers and normalizes seconds to milliseconds', () => {
  const csv = 'timestamp,rate\n1601424000000,0.0001\n1601436000,0.0002\nnot,numeric\n';
  const points = parseFundingCsv(csv);
  assert.equal(points.length, 2);
  assert.deepEqual(points[0], { time: 1601424000000, rate: 0.0001 });
  assert.equal(points[1].time, 1601436000000);
});

test('monthKeys enumerates intersecting months only', () => {
  const from = Date.UTC(2024, 9, 19); // 2024-10-19
  const to = Date.UTC(2024, 11, 1);   // 2024-12-01
  assert.deepEqual(monthKeys(from, to), ['2024-10', '2024-11']);
});

test('dayKeysNotInMonths returns only days outside the given months', () => {
  const from = Date.UTC(2024, 9, 30);
  const to = Date.UTC(2024, 10, 2);
  const keys = dayKeysNotInMonths(from, to, new Set(['2024-10']));
  assert.deepEqual(keys, ['2024-11-01']);
});

// ---------------------------------------------------------------------------
// Predeclared gates
// ---------------------------------------------------------------------------

test('evalStageCGate passes only when every predeclared leg holds', () => {
  const pass = evalStageCGate(
    { n: 40, holmSignificant: true, netMeanR: 0.1, foldMeanR: [0.1, 0.2, -0.05, 0.1] },
    { minFills: 30, minPositiveFolds: 3 },
  );
  assert.equal(pass.pass, true);
  assert.deepEqual(pass.failures, []);
});

test('evalStageCGate reports a failure for each violated leg', () => {
  const starved = evalStageCGate(
    { n: 29, holmSignificant: true, netMeanR: 0.1, foldMeanR: [0.1, 0.2, 0.1, 0.1] },
    { minFills: 30, minPositiveFolds: 3 },
  );
  assert.equal(starved.pass, false);
  assert.equal(starved.failures.length, 1);
  assert.match(starved.failures[0], /fills/);

  const notSig = evalStageCGate(
    { n: 40, holmSignificant: false, netMeanR: 0.1, foldMeanR: [0.1, 0.2, 0.1, 0.1] },
    { minFills: 30, minPositiveFolds: 3 },
  );
  assert.match(notSig.failures[0], /Holm/);

  const negative = evalStageCGate(
    { n: 40, holmSignificant: true, netMeanR: -0.1, foldMeanR: [0.1, 0.2, 0.1, 0.1] },
    { minFills: 30, minPositiveFolds: 3 },
  );
  assert.match(negative.failures[0], /E\[R\]/);

  const inconsistent = evalStageCGate(
    { n: 40, holmSignificant: true, netMeanR: 0.1, foldMeanR: [0.1, 0.2, -0.05, -0.1] },
    { minFills: 30, minPositiveFolds: 3 },
  );
  assert.match(inconsistent.failures[0], /folds/);
});

test('evalStageCGate requires strictly positive folds (zero does not count)', () => {
  const verdict = evalStageCGate(
    { n: 40, holmSignificant: true, netMeanR: 0.1, foldMeanR: [0, 0.2, 0.1, -0.1] },
    { minFills: 30, minPositiveFolds: 3 },
  );
  assert.equal(verdict.pass, false);
});

test('evalConfirmationGate passes on positive E[R] with significant p and enough fills', () => {
  assert.equal(evalConfirmationGate({ n: 30, netMeanR: 0.08, permutationP: 0.03 }, { minFills: 30, alpha: 0.05 }).pass, true);
  const fails = evalConfirmationGate({ n: 30, netMeanR: 0.08, permutationP: 0.06 }, { minFills: 30, alpha: 0.05 });
  assert.equal(fails.pass, false);
  assert.match(fails.failures[0], /permutation/);
  const starved = evalConfirmationGate({ n: 12, netMeanR: 0.5, permutationP: 0.01 }, { minFills: 30, alpha: 0.05 });
  assert.equal(starved.pass, false);
});
