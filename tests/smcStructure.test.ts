import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import { analyzeStructure, findSwingPoints, calculateRangePricing, evaluateStructureState } from '../src/market/StructureEngine.js';
import { detectSessionPools, detectLiquidity } from '../src/market/LiquidityEngine.js';

const BAR_MS = 15 * 60_000;

function makeCandle(index: number, open: number, high: number, low: number, close: number): Candle {
  return {
    openTime: index * BAR_MS,
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

test('TASK-001: Mathematical BOS requires ATR buffer confirmation', () => {
  // Build a sequence with swing high at 100
  // strength = 2, so swing high at index 2
  const candles: Candle[] = [
    makeCandle(0, 90, 92, 89, 91),
    makeCandle(1, 91, 95, 90, 94),
    makeCandle(2, 94, 100, 93, 99), // Swing High at 100
    makeCandle(3, 98, 97, 95, 96),
    makeCandle(4, 96, 95, 92, 93),
    makeCandle(5, 93, 94, 91, 92),
  ];

  const atr = 10;
  const bufferPct = 0.2; // Requires break beyond 100 + (10 * 0.2) = 102

  // Candle 6 closes at 100.5 (above 100, but below 102 buffer threshold)
  const candleNear = makeCandle(6, 92, 101, 92, 100.5);
  const stateNear = analyzeStructure('15m', [...candles, candleNear], atr, { strength: 2, bufferPct });

  // Acceptance Criteria: BOS must NOT confirm if close does not exceed swing + ATR * bufferPct
  assert.equal(
    stateNear.lastBreak,
    null,
    'BOS should NOT trigger when close is above swing high but below the ATR buffer threshold',
  );

  // Candle 7 closes at 102.5 (above 102 buffer threshold)
  const candleBreak = makeCandle(6, 92, 103, 92, 102.5);
  const stateBreak = analyzeStructure('15m', [...candles, candleBreak], atr, { strength: 2, bufferPct });

  assert.ok(stateBreak.lastBreak, 'BOS should trigger when close exceeds swing high + ATR buffer');
  assert.equal(stateBreak.lastBreak?.type, 'BOS');
  assert.equal(stateBreak.lastBreak?.direction, 'BULLISH');
});

test('TASK-001: Protected swing CHOCH structural reversal validation', () => {
  // Bearish trend: High 1 (120) -> Low 1 (95) -> Lower High 2 (110, protected) -> Lower Low 2 (85)
  // With strength = 1, pivot needs 1 bar before and 1 bar after.
  const candles: Candle[] = [
    makeCandle(0, 100, 105, 99, 104),
    makeCandle(1, 104, 115, 103, 114),
    makeCandle(2, 114, 120, 113, 119), // Swing High 1 (120)
    makeCandle(3, 119, 116, 105, 106),
    makeCandle(4, 106, 108, 95, 96),   // Swing Low 1 (95)
    makeCandle(5, 96, 105, 96, 104),
    makeCandle(6, 104, 110, 103, 109), // Swing High 2 (110, Lower High)
    makeCandle(7, 109, 107, 90, 91),
    makeCandle(8, 91, 93, 85, 86),     // Swing Low 2 (85, Lower Low)
    makeCandle(9, 86, 92, 88, 90),
  ];

  const atr = 5;
  const bufferPct = 0.1; // buffer = 0.5; requires close > 110.5

  // Candle breaking above protected high at 110 with ATR buffer
  const breakCandle = makeCandle(10, 90, 115, 90, 112);
  const state = analyzeStructure('15m', [...candles, breakCandle], atr, { strength: 1, bufferPct });

  assert.ok(state.lastBreak, 'CHOCH should trigger when protected swing high is broken');
  assert.equal(state.lastBreak?.type, 'CHOCH');
  assert.equal(state.lastBreak?.direction, 'BULLISH');
});

test('TASK-002: Range Pricing calculates 0.5 equilibrium and premium/discount classification', () => {
  // Range between low 100 and high 200 -> Equilibrium is 150
  const candles: Candle[] = [
    makeCandle(0, 100, 150, 100, 140),
    makeCandle(1, 140, 200, 130, 180), // High 200
    makeCandle(2, 180, 185, 100, 120), // Low 100
  ];

  // Case 1: Price at 175 (Premium: 75% of range)
  const candlePremium = makeCandle(3, 120, 175, 120, 175);
  const pricingPremium = calculateRangePricing([...candles, candlePremium]);
  assert.equal(pricingPremium.high, 200);
  assert.equal(pricingPremium.low, 100);
  assert.equal(pricingPremium.equilibrium, 150);
  assert.equal(pricingPremium.positionPct, 75);
  assert.equal(pricingPremium.premium, true);
  assert.equal(pricingPremium.discount, false);

  // Case 2: Price at 125 (Discount: 25% of range)
  const candleDiscount = makeCandle(3, 120, 130, 110, 125);
  const pricingDiscount = calculateRangePricing([...candles, candleDiscount]);
  assert.equal(pricingDiscount.positionPct, 25);
  assert.equal(pricingDiscount.premium, false);
  assert.equal(pricingDiscount.discount, true);

  // Case 3: Price at exactly 150 (Equilibrium: 50%)
  const candleEq = makeCandle(3, 120, 160, 120, 150);
  const pricingEq = calculateRangePricing([...candles, candleEq]);
  assert.equal(pricingEq.positionPct, 50);
  assert.equal(pricingEq.premium, false);
  assert.equal(pricingEq.discount, false);
});

test('TASK-003: Session liquidity pools and confirmed close-back-inside sweep', () => {
  // Asia session candles: 00:00 to 08:00 UTC (8 hours, 32 15m candles)
  // Let start be 00:00 UTC on 2026-01-01 (epoch 1767225600000)
  const sessionStart = 1767225600000;
  const candles: Candle[] = [];
  for (let i = 0; i < 32; i++) {
    candles.push({
      openTime: sessionStart + i * 15 * 60_000,
      open: 100,
      high: i === 10 ? 120 : 105, // Session High at 120
      low: i === 20 ? 80 : 95,    // Session Low at 80
      close: 100,
      volume: 100,
    });
  }

  const atr = 10;
  const sessionPools = detectSessionPools(candles, '15m', atr);
  assert.ok(sessionPools.length >= 2, 'Should detect at least session high and low pools');
  assert.ok(sessionPools.some((p) => p.type === 'SESSION_HIGH' && p.price === 120));
  assert.ok(sessionPools.some((p) => p.type === 'SESSION_LOW' && p.price === 80));

  // Candle sweeps Asia High at 120:
  // Tolerance = atr * 0.15 = 1.5. Wick reaches 123 (> 121.5), close is 118 (< 120: confirmed close-back-inside)
  const sweepCandle: Candle = {
    openTime: sessionStart + 32 * 15 * 60_000,
    open: 115,
    high: 123,
    low: 114,
    close: 118,
    volume: 500,
  };

  const structure = analyzeStructure('15m', [...candles, sweepCandle], atr);
  const stateSwept = detectLiquidity('15m', [...candles, sweepCandle], structure, atr);
  const sweep = stateSwept.latestSweeps.find((s) => s.level === 120 && s.poolType === 'SESSION_HIGH');
  assert.ok(sweep, 'Should confirm sweep of session high when price wicks through and closes inside');
  assert.equal(sweep?.direction, 'BUY_SIDE');
  assert.equal(sweep?.confirmed, true);
});

test('TASK-004: evaluateStructureState unifies structure, liquidity, pricing, and zones', () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) {
    candles.push(makeCandle(i, 100 + i, 105 + i, 95 + i, 102 + i));
  }
  const result = evaluateStructureState('15m', candles, 5);
  assert.ok(result, 'evaluateStructureState should return a valid context');
  assert.equal(result.timeframe, '15m');
  assert.ok(result.structure, 'Should include structure state');
  assert.ok(result.liquidity, 'Should include liquidity state');
  assert.ok(result.pricing, 'Should include range pricing');
  assert.ok(Array.isArray(result.zones), 'Should include zones array');
  assert.ok(Array.isArray(result.zoneLedger), 'Should include zoneLedger array');
});
