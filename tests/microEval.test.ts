import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bootstrapMeanCI,
  costAdjustedReturnBps,
  parseJsonlContent,
  pathIsValid,
  realizedVolatilityBps,
} from '../scripts/micro-eval.js';

const reading = (t: number, mid: number, overrides: Record<string, unknown> = {}) => ({
  symbol: 'SOLUSDT',
  t,
  book: { status: 'LIVE', reason: '', ageMs: 10 },
  mid,
  spreadBps: 1,
  friction: { status: 'OK', spreadBps: 1, buySlipBps: 2, sellSlipBps: 2, orderNotional: 5000, reasons: [] },
  phase: 'INITIATIVE_BUYING',
  windows: [{ ms: 30_000, complete: true, trades: 20, delta: 0.3, ofi: 0.2, priceBps: 3, phase: 'INITIATIVE_BUYING' }],
  bias: { bias: 'LONG' },
  ...overrides,
});

test('parses JSONL, rejects malformed JSON and ignores invalid reading shapes', () => {
  const result = parseJsonlContent([
    JSON.stringify(reading(1000, 100)),
    '{not-json',
    JSON.stringify({ symbol: 'SOLUSDT', t: 'bad', mid: 100 }),
    JSON.stringify(reading(2000, 101)),
  ].join('\n'));
  assert.equal(result.records.length, 2);
  assert.equal(result.malformedJson, 1);
  assert.equal(result.invalidRecords, 1);
  assert.deepEqual(result.records.map((r) => r.t), [1000, 2000]);
});

test('cost-adjusted long and short outcomes use entry and exit side slippage plus two fees', () => {
  const a = reading(1000, 100);
  const b = reading(6000, 101);
  const long = costAdjustedReturnBps(a, b, 'LONG', 4);
  const short = costAdjustedReturnBps(a, b, 'SHORT', 4);
  assert.ok(long !== null && Math.abs(long - (100 - 2 - 2 - 8)) < 1e-6);
  assert.ok(short !== null && Math.abs(short - (-100 - 2 - 2 - 8)) < 1e-6);
});

test('cost-adjusted outcome is unavailable when either side cannot be priced', () => {
  const a = reading(1000, 100);
  const b = reading(6000, 101, { friction: { status: 'BLOCK', spreadBps: 1, buySlipBps: null, sellSlipBps: null, orderNotional: 5000, reasons: ['thin'] } });
  assert.equal(costAdjustedReturnBps(a, b, 'LONG', 4), null);
});

test('path validation rejects non-live readings and timestamp gaps', () => {
  const live = [reading(1000, 100), reading(2000, 100.1), reading(3000, 100.2)];
  assert.equal(pathIsValid(live, 0, 2, 1000), true);
  assert.equal(pathIsValid([live[0], reading(2000, 100.1, { book: { status: 'STALE', reason: 'stale', ageMs: 6000 } }), live[2]], 0, 2, 1000), false);
  assert.equal(pathIsValid([live[0], live[2]], 0, 1, 1000), false);
});

test('realized volatility uses only the trailing live path and rejects insufficient history', () => {
  const rows = Array.from({ length: 301 }, (_, i) => reading(i * 1000, 100 + Math.sin(i / 4) * 0.1));
  assert.equal(realizedVolatilityBps(rows.slice(0, 100), 300_000, 1000), null);
  const value = realizedVolatilityBps(rows, 300_000, 1000, 0.8);
  assert.ok(value !== null && value > 0);
  rows[150] = reading(150_000, 100, { book: { status: 'RESYNC', reason: 'gap', ageMs: null } });
  assert.equal(realizedVolatilityBps(rows, 300_000, 1000, 0.8), null);
});

test('bootstrap confidence intervals are deterministic for a fixed seed', () => {
  const points = Array.from({ length: 120 }, (_, i) => ({ t: i * 1000, value: i % 2 ? 2 : -1 }));
  const a = bootstrapMeanCI(points, { iterations: 300, blockMs: 10_000, seed: 42, confidence: 0.95 });
  const b = bootstrapMeanCI(points, { iterations: 300, blockMs: 10_000, seed: 42, confidence: 0.95 });
  assert.deepEqual(a, b);
  assert.equal(a.n, 120);
  assert.ok(a.low !== null && a.high !== null && a.low <= a.mean && a.mean <= a.high);
});
