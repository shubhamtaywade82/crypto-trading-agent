import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isAlreadyIsolated, isVenueRejection, parseOrderTradeUpdate, planStartupReconciliation, protectionClientOrderId,
  protectionOf, type OpenOrderView,
} from '../src/binance/liveProtection.js';

const order = (over: Partial<OpenOrderView>): OpenOrderView => ({
  symbol: 'ETHUSDT', orderId: 1, clientOrderId: 'x', type: 'LIMIT', side: 'BUY', reduceOnly: false, closePosition: false, stopPrice: 0, status: 'NEW', ...over,
});
const entry = (over: Partial<OpenOrderView> = {}): OpenOrderView => order({ clientOrderId: 'e1abc', orderId: 10, ...over });
const stop = (over: Partial<OpenOrderView> = {}): OpenOrderView =>
  order({ type: 'STOP_MARKET', side: 'SELL', closePosition: true, reduceOnly: false, stopPrice: 95, clientOrderId: 'p1', orderId: 20, ...over });
const target = (over: Partial<OpenOrderView> = {}): OpenOrderView =>
  order({ type: 'TAKE_PROFIT_MARKET', side: 'SELL', closePosition: true, stopPrice: 110, clientOrderId: 'p2', orderId: 21, ...over });

test('protection client ids are unique, prefixed and inside the 36-character venue limit', () => {
  const a = protectionClientOrderId(1_000);
  const b = protectionClientOrderId(1_000);
  assert.notEqual(a, b);
  assert.ok(a.startsWith('p'));
  assert.ok(a.length <= 36);
});

test('the tightest stop is the highest for a long and the lowest for a short', () => {
  const long = protectionOf([stop({ stopPrice: 95, orderId: 1 }), stop({ stopPrice: 96, orderId: 2 })], 'ETHUSDT', 2);
  assert.equal(long.stopPrice, 96);
  assert.deepEqual(long.stopOrderIds, [1, 2]);
  const short = protectionOf([stop({ side: 'BUY', stopPrice: 105, orderId: 3 }), stop({ side: 'BUY', stopPrice: 104, orderId: 4 })], 'ETHUSDT', -2);
  assert.equal(short.stopPrice, 104);
});

test('a position with no closePosition stop is reported unprotected, a protected one is not', () => {
  const plan = planStartupReconciliation([], [{ symbol: 'ETHUSDT', amount: 2 }]);
  assert.deepEqual(plan.unprotected, ['ETHUSDT']);
  const protectedPlan = planStartupReconciliation([stop(), target()], [{ symbol: 'ETHUSDT', amount: 2 }]);
  assert.deepEqual(protectedPlan.unprotected, []);
});

test('startup cancels the bot\'s own resting entries and orphaned protective orders, and keeps protection on held symbols', () => {
  const plan = planStartupReconciliation(
    [entry({ symbol: 'ETHUSDT' }), stop({ symbol: 'SOLUSDT', orderId: 30 }), stop({ symbol: 'ETHUSDT', orderId: 31 })],
    [{ symbol: 'ETHUSDT', amount: 2 }],
  );
  assert.deepEqual(plan.cancel.map((o) => o.orderId).sort(), [10, 30]);
  assert.deepEqual(plan.unrecognised, []);
});

test('operator orders the bot did not place are reported, never cancelled', () => {
  const manual = order({ clientOrderId: 'web_abc', orderId: 40, type: 'LIMIT' });
  const plan = planStartupReconciliation([manual], []);
  assert.deepEqual(plan.cancel, []);
  assert.deepEqual(plan.unrecognised.map((o) => o.orderId), [40]);
});

test('an already-isolated answer is ignored, every other margin failure is not', () => {
  assert.equal(isAlreadyIsolated({ code: -4046, message: 'No need to change margin type.' }), true);
  assert.equal(isAlreadyIsolated(new Error('No need to change margin type.')), true);
  assert.equal(isAlreadyIsolated({ code: -4067, message: 'Margin type cannot be changed if there exists open orders.' }), false);
  assert.equal(isAlreadyIsolated(new Error('socket hang up')), false);
});

test('only a numeric venue code proves a request was refused', () => {
  assert.equal(isVenueRejection({ code: -2021, message: 'Order would immediately trigger.' }), true);
  assert.equal(isVenueRejection(new Error('ETIMEDOUT')), false);
});

test('an ORDER_TRADE_UPDATE event is reduced to the fields the tracker and journal read', () => {
  const update = parseOrderTradeUpdate({
    e: 'ORDER_TRADE_UPDATE',
    o: { s: 'ETHUSDT', c: 'e1abc', S: 'BUY', o: 'LIMIT', x: 'TRADE', X: 'PARTIALLY_FILLED', R: false, l: '0.5', z: '0.5', ap: '2000.5', rp: '0' },
  });
  assert.deepEqual(update, {
    symbol: 'ETHUSDT', clientOrderId: 'e1abc', side: 'BUY', orderType: 'LIMIT', executionType: 'TRADE', status: 'PARTIALLY_FILLED',
    reduceOnly: false, lastFilledQty: 0.5, cumulativeFilledQty: 0.5, averagePrice: 2000.5, realizedPnl: 0,
  });
  assert.equal(parseOrderTradeUpdate({ e: 'ACCOUNT_UPDATE' }), null);
  assert.equal(parseOrderTradeUpdate(null), null);
});
