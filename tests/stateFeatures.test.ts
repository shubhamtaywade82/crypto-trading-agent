import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/research/Bootstrap.js';
import { buildFrame, type MinuteInputs } from '../src/research/MtfFrame.js';
import { buildStateData, featureRow, PRICE_FEATURES, TICK_FEATURES, type TickMinutes } from '../src/research/StateFeatures.js';

const START = Date.UTC(2025, 0, 1);
const MINUTES = 12 * 1440;

function walk(seed: number): MinuteInputs {
  const rand = mulberry32(seed);
  const open = new Float64Array(MINUTES); const high = new Float64Array(MINUTES); const low = new Float64Array(MINUTES); const close = new Float64Array(MINUTES);
  const volume = new Float64Array(MINUTES); const takerBuy = new Float64Array(MINUTES);
  let price = 100;
  for (let i = 0; i < MINUTES; i += 1) {
    open[i] = price; price *= 1 + (rand() - 0.5) * 0.003; close[i] = price;
    high[i] = Math.max(open[i]!, price) * 1.0005; low[i] = Math.min(open[i]!, price) * 0.9995;
    volume[i] = 50 + 100 * rand(); takerBuy[i] = volume[i]! * (0.3 + 0.4 * rand());
  }
  return { start: START, open, high, low, close, volume, takerBuy };
}

function ticks(seed: number): TickMinutes {
  const rand = mulberry32(seed);
  return {
    start: START,
    trades: Array.from({ length: MINUTES }, () => [1000 * rand(), 1000 * rand(), 5 + 20 * rand(), 200 * rand(), 200 * rand()]),
    depth: Array.from({ length: MINUTES }, () => [1e6 * (1 + rand()), 1e6 * (1 + rand()), 5e6 * (1 + rand()), 5e6 * (1 + rand())]),
  };
}

const cut = (m: MinuteInputs, to: number): MinuteInputs => ({ start: m.start, open: m.open.slice(0, to), high: m.high.slice(0, to), low: m.low.slice(0, to), close: m.close.slice(0, to), volume: m.volume.slice(0, to), takerBuy: m.takerBuy.slice(0, to) });

test('should give each decision minute the same features whether or not later minutes exist', () => {
  const full = walk(5); const tk = ticks(6);
  const funding = new Float64Array(MINUTES).fill(0.0001);
  const limit = 9 * 1440;
  const sliceTicks: TickMinutes = { start: tk.start, trades: tk.trades.slice(0, limit), depth: tk.depth.slice(0, limit) };
  const withFuture = buildStateData(buildFrame(full), funding, tk);
  const truncated = buildStateData(buildFrame(cut(full, limit)), funding.slice(0, limit), sliceTicks);
  let compared = 0;
  for (let k = 5 * 1440; k < limit - 1; k += 97) {
    const a = featureRow(withFuture, k); const b = featureRow(truncated, k);
    assert.deepEqual(a, b, `features differ at minute ${k}`);
    if (a) compared += 1;
  }
  assert.ok(compared > 50, 'the test would be vacuous');
  assert.equal(featureRow(withFuture, 5 * 1440)!.length, PRICE_FEATURES.length + TICK_FEATURES.length);
});

test('should refuse a row while history is too short', () => {
  const data = buildStateData(buildFrame(walk(5)), new Float64Array(MINUTES).fill(0), undefined);
  assert.equal(featureRow(data, 1000), null);
  assert.equal(featureRow(data, 5 * 1440)!.length, PRICE_FEATURES.length);
});
