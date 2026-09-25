import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BinanceSmcLifecycleExchange,
  SmcTradeLifecycleCoordinator,
  type SmcLifecycleExchange,
  type SmcLifecycleExchangeState,
} from '../src/strategies/smc-ml/SmcTradeLifecycleCoordinator.js';

function exchangeFor(initialQty = 1): {
  exchange: SmcLifecycleExchange;
  state: SmcLifecycleExchangeState;
  calls: string[];
} {
  const state: SmcLifecycleExchangeState = {
    position: { symbol: 'BTCUSDT', direction: 'LONG', quantity: initialQty, entryPrice: 100 },
    openOrders: [
      { orderId: 101, type: 'STOP_MARKET', side: 'SELL', quantity: initialQty, stopPrice: 90, status: 'NEW' },
      { orderId: 102, type: 'TAKE_PROFIT_MARKET', side: 'SELL', quantity: initialQty, stopPrice: 120, status: 'NEW' },
    ],
  };
  const calls: string[] = [];

  const exchange: SmcLifecycleExchange = {
    async reconcile(symbol) {
      calls.push('reconcile:' + symbol);
      return state;
    },
    async partialClose(symbol, portion) {
      calls.push(`partial:${symbol}:${portion}`);
      state.position = state.position
        ? { ...state.position, quantity: state.position.quantity * (1 - portion) }
        : null;
      return { ok: true, orderId: 201 };
    },
    async modifyOrder(symbol, orderId, input) {
      calls.push(`modify:${symbol}:${orderId}`);
      const order = state.openOrders.find((item) => item.orderId === orderId);
      if (!order) throw new Error('missing order');
      Object.assign(order, input);
      return order;
    },
    async closeRemaining(symbol) {
      calls.push('close:' + symbol);
      state.position = null;
      return { ok: true, orderId: 202 };
    },
    async cancelOrder(symbol, orderId) {
      calls.push(`cancel:${symbol}:${orderId}`);
      const order = state.openOrders.find((item) => item.orderId === orderId);
      if (order) order.status = 'CANCELED';
    },
  };

  return { exchange, state, calls };
}

test('coordinator executes TP1, then synchronizes protective order quantities', async () => {
  const { exchange, state, calls } = exchangeFor();
  const coordinator = new SmcTradeLifecycleCoordinator(exchange);

  coordinator.register({
    setupId: 'BTCUSDT:LONG:BOS:1000',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    initialQty: 1,
    entryPrice: 100,
    initialRisk: 10,
    tp1: 110,
    tp2: 120,
    stopPrice: 90,
    stopOrderId: 101,
    tp2OrderId: 102,
  });

  const result = await coordinator.onMarkPrice('BTCUSDT', 110);
  assert.equal(result.actions[0]?.type, 'PARTIAL_CLOSE');
  assert.equal(state.position?.quantity, 0.5);
  assert.equal(state.openOrders.find((o) => o.orderId === 101)?.quantity, 0.5);
  assert.equal(state.openOrders.find((o) => o.orderId === 102)?.quantity, 0.5);
  assert.deepEqual(calls.slice(0, 4), [
    'reconcile:BTCUSDT',
    'partial:BTCUSDT:0.5',
    'reconcile:BTCUSDT',
    'modify:BTCUSDT:101',
  ]);
});

test('coordinator does not commit lifecycle state when an exchange mutation fails', async () => {
  const { exchange } = exchangeFor();
  exchange.partialClose = async () => {
    throw new Error('transport');
  };

  const coordinator = new SmcTradeLifecycleCoordinator(exchange);
  coordinator.register({
    setupId: 'BTCUSDT:LONG:BOS:1000',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    initialQty: 1,
    entryPrice: 100,
    initialRisk: 10,
    tp1: 110,
    tp2: 120,
    stopPrice: 90,
    stopOrderId: 101,
    tp2OrderId: 102,
  });

  await assert.rejects(
    () => coordinator.onMarkPrice('BTCUSDT', 110),
    /transport/,
  );

  assert.equal(coordinator.get('BTCUSDT')?.tp1Executed, false);
});

test('coordinator closes and cancels both protective orders at TP2', async () => {
  const { exchange, calls } = exchangeFor(0.5);
  const coordinator = new SmcTradeLifecycleCoordinator(exchange);

  coordinator.register({
    setupId: 'BTCUSDT:LONG:BOS:1000',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    initialQty: 1,
    entryPrice: 100,
    initialRisk: 10,
    tp1: 110,
    tp2: 120,
    stopPrice: 90,
    stopOrderId: 101,
    tp2OrderId: 102,
  });

  let lifecycle = coordinator.get('BTCUSDT')!;
  lifecycle = { ...lifecycle, tp1Executed: true, phase: 'BREAKEVEN', breakevenActivated: true };
  coordinator.replace('BTCUSDT', lifecycle);

  const result = await coordinator.onMarkPrice('BTCUSDT', 120);
  assert.equal(result.state.phase, 'CLOSED');
  assert.deepEqual(calls.slice(-3), ['close:BTCUSDT', 'cancel:BTCUSDT:101', 'cancel:BTCUSDT:102']);
});

test('order-trade update for the bound stop marks the lifecycle terminal', () => {
  const { exchange } = exchangeFor();
  const coordinator = new SmcTradeLifecycleCoordinator(exchange);
  coordinator.register({
    setupId: 'BTCUSDT:LONG:BOS:1000',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    initialQty: 1,
    entryPrice: 100,
    initialRisk: 10,
    tp1: 110,
    tp2: 120,
    stopPrice: 90,
    stopOrderId: 101,
    tp2OrderId: 102,
  });

  coordinator.handleOrderTradeUpdate({
    e: 'ORDER_TRADE_UPDATE',
    o: { s: 'BTCUSDT', i: 101, X: 'FILLED', x: 'TRADE', o: 'STOP_MARKET' },
  });

  assert.equal(coordinator.get('BTCUSDT')?.phase, 'CLOSED');
  assert.equal(coordinator.get('BTCUSDT')?.closedReason, 'STOP');
});

test('Binance adapter exposes the lifecycle exchange boundary without inventing strategy values', () => {
  assert.equal(typeof BinanceSmcLifecycleExchange, 'function');
});
