import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Position } from '../src/types.js';
import { nextStops, type TrailState } from '../src/agents/TrailingStopManager.js';

function longPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'BTCUSDT_ADAPTIVE-ST-ζ', symbol: 'BTCUSDT', side: 'LONG', strategy: 'ADAPTIVE-ST-ζ',
    entry: 100, qty: 1, mark: 105, upnl: 5, upnlPct: 5, leverage: 5, marginType: 'ISOLATED',
    liqDistancePct: null, serverSl: '94', serverTp: '112', initialRisk: 6, ...overrides,
  };
}

const medium = (superTrend: number): TrailState => ({ superTrend, regime: 'MEDIUM', assignedAtr: 2 });

test('should ratchet the stop up to the SuperTrend line', () => {
  assert.deepEqual(nextStops(longPosition(), medium(97)), { stopLoss: 97, takeProfit: 112 });
});

test('should never loosen the stop', () => {
  assert.equal(nextStops(longPosition(), medium(90)), null);
});

test('should lock breakeven once price has moved 1R', () => {
  assert.deepEqual(nextStops(longPosition({ mark: 106 }), medium(95)), { stopLoss: 100, takeProfit: 112 });
});

test('should extend the target and lock gains when price nears it', () => {
  // mark 111.5 is 0.5 from TP (<= 0.5 ATR = 1): TP +1 ATR, SL floors at oldTP - 1 ATR
  assert.deepEqual(nextStops(longPosition({ mark: 111.5 }), medium(95)), { stopLoss: 110, takeProfit: 114 });
});

test('should cap the target near price in LOW regime while in profit', () => {
  const state: TrailState = { superTrend: 97, regime: 'LOW', assignedAtr: 2 };
  assert.deepEqual(nextStops(longPosition(), state), { stopLoss: 97, takeProfit: 109 });
});

test('should leave the target alone in LOW regime while losing', () => {
  const state: TrailState = { superTrend: 90, regime: 'LOW', assignedAtr: 2 };
  assert.equal(nextStops(longPosition({ mark: 98 }), state), null);
});

test('should mirror every rule for shorts', () => {
  const short = longPosition({ side: 'SHORT', mark: 95, serverSl: '106', serverTp: '88' });
  assert.deepEqual(nextStops(short, medium(103)), { stopLoss: 103, takeProfit: 88 });
  const nearTarget = { ...short, mark: 88.5 };
  assert.deepEqual(nextStops(nearTarget, medium(105)), { stopLoss: 90, takeProfit: 86 });
});

test('should be idempotent: applying the result and calling again changes nothing', () => {
  const position = longPosition({ mark: 111.5 });
  const first = nextStops(position, medium(95))!;
  const applied = { ...position, serverSl: String(first.stopLoss), serverTp: String(first.takeProfit) };
  assert.equal(nextStops(applied, medium(95)), null);
});

test('should skip positions whose stops are not numeric', () => {
  assert.equal(nextStops(longPosition({ serverSl: '—' }), medium(97)), null);
});

test('should not re-tighten the LOW cap for a change smaller than half an ATR', () => {
  const state: TrailState = { superTrend: 90, regime: 'LOW', assignedAtr: 2 };
  // cap = 105 + 2*2 = 109; TP 109.5 is only 0.5 above it (<= 0.5 ATR = 1)
  assert.equal(nextStops(longPosition({ serverTp: '109.5' }), state), null);
});
