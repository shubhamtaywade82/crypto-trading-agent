import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle, Position } from '../src/types.js';
import { buildPolicy } from '../src/trailing/registry.js';
import { atrOf } from '../src/trailing/price.js';
import { bosChoch, confirmedPivots, deriveStructure, swingTrail } from '../src/trailing/structure.js';
import type { PolicyContext, TrailingState } from '../src/trailing/types.js';

let seq = 0;
const candle = (o: number, h: number, l: number, c: number): Candle => (
  { openTime: 1_700_000_000_000 + seq++ * 300_000, open: o, high: h, low: l, close: c, volume: 1 });

/** 19 bars: flat prefix (ties can never be pivots) then a low/rally/break structure.
 *  closes: 100×7, 101, 102, 98, 97, 99, 103, 106, 104, 105, 108, 107, 95.
 *  Closing-basis pivots (3L/2R): low@10=97 (conf@12); highs@8=102 (conf@10), @13=106 (conf@15), @16=108 (conf@18).
 *  BOS-up@12 (103>102, no protected low yet), BOS-up@16 (108>106 → protected 97), CHoCH@18 (95<97). */
function structureCandles(): Candle[] {
  const closes = [100, 100, 100, 100, 100, 100, 100, 101, 102, 98, 97, 99, 103, 106, 104, 105, 108, 107, 95];
  // first candle has no previous close — anchor its whole body on its own close (else NaN inputs)
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1];
    return candle(prev, Math.max(c, prev), Math.min(c, prev), c);
  });
}

/** 7 bars of TR=2 then 8 bars of TR=3 falling toward a swing-low then low fade (short series). */
const fallingCloses = [110, 109, 108, 109.5, 109, 110.5, 111.5, 112, 108, 107, 105, 104, 103, 102, 101];

function candlesFromCloses(closes: number[]): Candle[] {
  // same first-bar guard as structureCandles: prev must exist or high/low turn into NaN
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1];
    return candle(prev, Math.max(c, prev), Math.min(c, prev), c);
  });
}

const longCtx = (candles: Candle[], price: number, overrides: Partial<PolicyContext> = {}): PolicyContext => {
  const position: Position = {
    id: 't1', symbol: 'SOLUSDT', side: 'LONG', strategy: 'ADAPTIVE-ST-ζ', entry: 100, qty: 1,
    mark: price, upnl: 0, upnlPct: 0, leverage: 3, marginType: 'ISOLATED', liqDistancePct: null,
    serverSl: '94', serverTp: '112', initialRisk: 6,
  };
  return {
    position, s: 1, tf: '15m', price, mark: { price, fundingRate: 0.0001, nextFundingAt: 0 },
    index: null, book: null, flow: null, atr: { contract: null, mark: null }, candles,
    tickSize: null, account: { fundingAccrued: 0, feesAccrued: 0, fundingSettledAt: [] }, ...overrides,
  };
};

const stateOf = (overrides: Partial<TrailingState> = {}): TrailingState => ({
  key: 'SOLUSDT:ADAPTIVE-ST-ζ', symbol: 'SOLUSDT', strategy: 'ADAPTIVE-ST-ζ', side: 'LONG',
  entry: 100, initialQty: 1, reducedQty: 0, phase: 'TRAILING_ACTIVE', policyId: 't-swing',
  stopZ: 12, confirmedStop: 12, favorableExtremeX: 110, peakNetPnl: null, mfeX: 10, maeX: 0,
  fundingAccrued: 0, feesAccrued: 0, liquidationPrice: null, openedAt: 0, updatedAt: 0,
  lastBookSeq: null, lastAcceptedDecision: null, ...overrides,
});

test('pivots: golden highs/lows on the closing-basis window (3L/2R)', () => {
  const pivots = confirmedPivots(structureCandles(), 3, 2);
  assert.deepEqual(pivots.lows, [{ index: 10, price: 97 }]);
  assert.deepEqual(pivots.highs, [{ index: 8, price: 102 }, { index: 13, price: 106 }, { index: 16, price: 108 }]);
});

test('pivots: confirmation delay and no repainting on growing prefixes', () => {
  const candles = structureCandles();
  // pivot low @10 confirms when bar 12 closes — absent before, present after, never removed again
  assert.equal(confirmedPivots(candles.slice(0, 12), 3, 2).lows.length, 0);
  assert.deepEqual(confirmedPivots(candles.slice(0, 13), 3, 2).lows, [{ index: 10, price: 97 }]);
  // the last potential high (@16) is unconfirmed until bar 18 closes
  assert.deepEqual(confirmedPivots(candles.slice(0, 18), 3, 2).highs.at(-1), { index: 13, price: 106 });
});

test('structure: protected low after the BOS-up, stop trails under 97 correct', () => {
  const candles = structureCandles();
  const st = deriveStructure(candles, 3, 2);
  assert.equal(st.breached, true);
  assert.equal(st.breachedLevel, 97);
  assert.equal(st.trend, -1);       // the final close also broke the confirmed low: structure flipped
  assert.equal(st.protected, 102);  // shorts inherit the protected lower high from the same event
  // mid-trend slice (before the break): trend bullish, protected low = 97
  const mid = deriveStructure(candles.slice(0, 18), 3, 2);
  assert.equal(mid.trend, 1);
  assert.equal(mid.protected, 97);
  assert.equal(mid.breached, false);
});

test('bos/choch: exit candidate on the confirming close through the protected low', () => {
  const policy = buildPolicy('t-bos', 'BOS_CHOCH', { bufferAtr: 0.2, tf: '15m' });
  const candles = structureCandles();
  const candidate = bosChoch(policy, longCtx(candles, 95), stateOf());
  assert.ok(candidate);
  assert.equal(candidate.exit, true);
  assert.equal(candidate.reason, 'choch-break@97');
});

test('bos/choch: move-stop candidate under the protected low while structure holds', () => {
  const policy = buildPolicy('t-bos', 'BOS_CHOCH', { bufferAtr: 0.2, tf: '15m' });
  const candles = structureCandles().slice(0, 18); // close 108, structure bullish, protected 97
  const candidate = bosChoch(policy, longCtx(candles, 108), stateOf());
  const atr = atrOf(candles, 14);
  assert.ok(candidate && atr);
  assert.equal(candidate.exit, undefined);
  assert.equal(candidate.levelZ, 97 - 0.2 * atr); // stop price = 97 − 0.2·ATR(14)
});

test('bos/choch: no candidate until a protected level exists (BOS with no confirmed low)', () => {
  const policy = buildPolicy('t-bos', 'BOS_CHOCH', { bufferAtr: 0.2, tf: '15m' });
  const candles = structureCandles().slice(0, 13); // BOS@12 fired, no confirmed low yet
  const st = deriveStructure(candles, 3, 2);
  assert.equal(st.trend, 1);
  assert.equal(st.protected, null);
  assert.equal(bosChoch(policy, longCtx(candles, 103), stateOf()), null);
});

test('bos/choch: short candidate mirrors via price negation (stop above the protected high)', () => {
  const policy = buildPolicy('t-bos', 'BOS_CHOCH', { bufferAtr: 0.2, tf: '15m' });
  const candles = structureCandles();
  const ctx = longCtx(candles, 95, { s: -1, position: { ...longCtx(candles, 95).position, side: 'SHORT' } });
  const candidate = bosChoch(policy, ctx, stateOf({ side: 'SHORT' }));
  const atr = atrOf(candles, 14);
  assert.ok(candidate && atr);
  assert.equal(candidate.levelZ, -102 - 0.2 * atr); // real stop = 102 + 0.2·ATR above price 95
});

test('structure: derivation is deterministic (same input, same output)', () => {
  const candles = structureCandles();
  assert.deepEqual(deriveStructure(candles, 3, 2), deriveStructure(candles, 3, 2));
});

test('swing: long stop from the latest confirmed swing low with the max atr/tick buffer', () => {
  const policy = buildPolicy('t-swing', 'SWING', { bufferAtr: 0.2, tf: '15m' });
  const candles = structureCandles().slice(0, 18);
  const atr = atrOf(candles, 14);
  const candidate = swingTrail(policy, longCtx(candles, 108), stateOf());
  assert.ok(candidate && atr);
  assert.equal(candidate.levelZ, 97 - 0.2 * atr);
});

test('swing: tick buffer takes over when larger than the ATR buffer', () => {
  const policy = buildPolicy('t-swing', 'SWING', { bufferAtr: 0.1, bufferTicks: 2, tf: '15m' });
  const candles = fallingCandles();
  const atr = atrOf(candles, 14)!;
  const ctx = longCtx(candles, 101, { tickSize: 0.5, s: -1 });
  const candidate = swingTrail({ ...policy, id: 't-swing-s' }, ctx, stateOf({ side: 'SHORT' }));
  assert.ok(candidate);
  assert.equal(candidate.levelZ, -(112 + Math.max(0.1 * atr, 2 * 0.5)));
});

function fallingCandles(): Candle[] {
  return candlesFromCloses(fallingCloses);
}

test('swing: refuses a stop the price has already crossed (rally past a short stop)', () => {
  const policy = buildPolicy('t-swing', 'SWING', { bufferAtr: 0.1, tf: '15m' });
  // at price 101 the stop 112+buffer still sits above price — protective for a short
  const ctx = longCtx(fallingCandles(), 101, { s: -1 });
  const candidate = swingTrail(policy, ctx, stateOf({ side: 'SHORT', favorableExtremeX: -101 }));
  assert.ok(candidate);
  // price 120 puts the stop below price — from the stop's own side it would instantly breach
  const rallied = longCtx(fallingCandles(), 120, { s: -1 });
  assert.equal(swingTrail(policy, rallied, stateOf({ side: 'SHORT', favorableExtremeX: -120 })), null);
});
