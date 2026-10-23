import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isolatedLiquidationPrice, safestLeverage, stopClearsLiquidation, tierForNotional, type MaintenanceTier,
} from '../src/risk/liquidation.js';

const flat: MaintenanceTier[] = [{ notionalFloor: 0, notionalCap: Infinity, maintMarginRatio: 0.004, cumMaintenance: 0, maxLeverage: 125 }];
const tiered: MaintenanceTier[] = [
  { notionalFloor: 0, notionalCap: 1000, maintMarginRatio: 0.004, cumMaintenance: 0, maxLeverage: 125 },
  { notionalFloor: 1000, notionalCap: Infinity, maintMarginRatio: 0.05, cumMaintenance: 25, maxLeverage: 20 },
];

test('an isolated long at 10x with no cumulative maintenance is liquidated about 9.6% adverse', () => {
  const price = isolatedLiquidationPrice({ side: 'LONG', entry: 100, qty: 1, leverage: 10, tiers: flat });
  assert.ok(price !== null);
  assert.ok(Math.abs(price - (100 * 0.9) / 0.996) < 1e-9, `got ${price}`);
});

test('an isolated short at 10x is liquidated above entry by the mirror formula', () => {
  const price = isolatedLiquidationPrice({ side: 'SHORT', entry: 100, qty: 1, leverage: 10, tiers: flat });
  assert.ok(price !== null);
  assert.ok(Math.abs(price - (100 * 1.1) / 1.004) < 1e-9, `got ${price}`);
});

test('cumulative maintenance moves the liquidation price by cum / quantity', () => {
  const tier: MaintenanceTier[] = [{ notionalFloor: 0, notionalCap: Infinity, maintMarginRatio: 0.01, cumMaintenance: 50, maxLeverage: 50 }];
  const price = isolatedLiquidationPrice({ side: 'LONG', entry: 100, qty: 10, leverage: 10, tiers: tier });
  assert.ok(price !== null);
  assert.ok(Math.abs(price - (100 * 0.9 - 5) / 0.99) < 1e-9, `got ${price}`);
});

test('the tier is re-picked at the liquidation notional, so a short never assumes the cheaper bracket', () => {
  // Entry notional 950 sits in tier 1; at the 10x liquidation price (~109.56) the notional reaches 1040, tier 2
  const price = isolatedLiquidationPrice({ side: 'SHORT', entry: 100, qty: 9.5, leverage: 10, tiers: tiered });
  assert.ok(price !== null);
  assert.ok(Math.abs(price - (110 + 25 / 9.5) / 1.05) < 1e-9, `got ${price}`);
  assert.ok(price < (100 * 1.1) / 1.004, 'the costlier bracket liquidates sooner');
});

test('tierForNotional picks the last bracket whose floor is reached, and null without tiers', () => {
  assert.equal(tierForNotional(tiered, 500)?.maintMarginRatio, 0.004);
  assert.equal(tierForNotional(tiered, 1500)?.maintMarginRatio, 0.05);
  assert.equal(tierForNotional([], 500), null);
});

test('bad inputs produce no liquidation price rather than a number', () => {
  assert.equal(isolatedLiquidationPrice({ side: 'LONG', entry: 100, qty: 1, leverage: 10, tiers: [] }), null);
  assert.equal(isolatedLiquidationPrice({ side: 'LONG', entry: 0, qty: 1, leverage: 10, tiers: flat }), null);
  assert.equal(isolatedLiquidationPrice({ side: 'LONG', entry: 100, qty: 1, leverage: 0.5, tiers: flat }), null);
});

test('the stop must clear liquidation on the correct side for each direction', () => {
  assert.equal(stopClearsLiquidation('LONG', 96, 93, 2), true);
  assert.equal(stopClearsLiquidation('LONG', 94, 93, 2), false);
  assert.equal(stopClearsLiquidation('SHORT', 104, 107, 2), true);
  assert.equal(stopClearsLiquidation('SHORT', 104, 107, 4), false);
  assert.equal(stopClearsLiquidation('SHORT', 108, 107, 0), false, 'a short stop above liquidation never executes first');
});

test('safestLeverage returns the highest leverage whose liquidation clears the stop by the ATR buffer', () => {
  const input = { side: 'LONG' as const, entry: 100, stop: 96, qty: 1, atr: 2, clearanceAtr: 1, requestedLeverage: 25, minLeverage: 5, maxLeverage: 25, tiers: flat };
  const safe = safestLeverage(input);
  assert.ok(safe !== null);
  assert.equal(safe.leverage, 15);
  assert.ok(stopClearsLiquidation('LONG', 96, safe.liquidationPrice, 2));
  const one = isolatedLiquidationPrice({ side: 'LONG', entry: 100, qty: 1, leverage: 16, tiers: flat });
  assert.ok(one !== null && !stopClearsLiquidation('LONG', 96, one, 2), 'one step higher must fail the buffer');
});

test('safestLeverage gives up when even the minimum leverage leaves liquidation inside the stop', () => {
  const tooTight = { side: 'LONG' as const, entry: 100, stop: 81, qty: 1, atr: 1, clearanceAtr: 1, requestedLeverage: 10, minLeverage: 5, maxLeverage: 25, tiers: flat };
  assert.equal(safestLeverage(tooTight), null);
});

test('safestLeverage respects the bracket maximum leverage for the position notional', () => {
  const capped = { side: 'LONG' as const, entry: 100, stop: 90, qty: 15, atr: 1, clearanceAtr: 0.5, requestedLeverage: 50, minLeverage: 5, maxLeverage: 50, tiers: tiered };
  const safe = safestLeverage(capped);
  assert.ok(safe === null || safe.leverage <= 20, `tier 2 allows at most 20x, got ${safe?.leverage}`);
});
