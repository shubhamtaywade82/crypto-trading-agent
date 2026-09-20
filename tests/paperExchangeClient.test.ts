import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaperExchangeClient } from '../src/binance/paperExchangeClient.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(status: number, json: unknown, calls: Call[]) {
  return async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as Response;
  };
}

test('getAccount maps the Rails snake_case payload to camelCase', async () => {
  const calls: Call[] = [];
  const client = new PaperExchangeClient(
    'http://localhost:3000',
    'ACC-1',
    fakeFetch(200, {
      account_id: 'ACC-1', currency: 'USDT', margin: '100000.0', available_balance: '94000.0',
      locked_margin: '6000.0', equity: '100050.0', unrealized_pnl: '50.0', realized_pnl: '0.0', positions_count: 1,
    }, calls),
  );

  const account = await client.getAccount();

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'http://localhost:3000/api/account');
  assert.equal(calls[0].headers['X-Account-Id'], 'ACC-1');
  assert.deepEqual(account, {
    accountId: 'ACC-1', currency: 'USDT', margin: 100000, availableBalance: 94000,
    lockedMargin: 6000, equity: 100050, unrealizedPnl: 50, realizedPnl: 0, positionsCount: 1,
  });
});

test('getPositions maps each Rails position, treating a null liquidation_price as null', async () => {
  const calls: Call[] = [];
  const client = new PaperExchangeClient('http://localhost:3000', 'ACC-1', fakeFetch(200, [
    {
      id: 7, symbol: 'BTCUSDT', side: 'long', net_quantity: '1.0', average_price: '60000.0',
      current_price: '61000.0', leverage: 10, margin_type: 'cross', liquidation_price: '54000.0', unrealized_pnl: '1000.0',
    },
    {
      id: 8, symbol: 'ETHUSDT', side: 'short', net_quantity: '2.0', average_price: '3000.0',
      current_price: '2950.0', leverage: 1, margin_type: 'cross', liquidation_price: null, unrealized_pnl: '100.0',
    },
  ], calls));

  const positions = await client.getPositions();

  assert.equal(positions.length, 2);
  assert.equal(positions[0].liquidationPrice, 54000);
  assert.equal(positions[1].liquidationPrice, null);
  assert.equal(positions[1].leverage, 1);
});

test('submitOrder posts the order in the shape OrdersController expects', async () => {
  const calls: Call[] = [];
  const client = new PaperExchangeClient('http://localhost:3000', 'ACC-1', fakeFetch(201, { id: 42, status: 'filled' }, calls));

  const result = await client.submitOrder({
    symbol: 'BTCUSDT', side: 'buy', quantity: 0.01, leverage: 10, executionPrice: 65000, clientOrderId: 'abc-123',
  });

  assert.deepEqual(result, { orderId: 42, status: 'filled' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://localhost:3000/api/orders');
  assert.deepEqual(calls[0].body, {
    order: {
      symbol: 'BTCUSDT', side: 'buy', quantity: 0.01, order_type: 'market', instrument_type: 'CRYPTO_PERPETUAL',
      leverage: 10, margin_type: 'cross', execution_price: 65000, client_order_id: 'abc-123',
    },
  });
});

test('pushMarkPrices posts the raw prices map', async () => {
  const calls: Call[] = [];
  const client = new PaperExchangeClient('http://localhost:3000', 'ACC-1', fakeFetch(200, { updated: {} }, calls));

  await client.pushMarkPrices({ BTCUSDT: 65000, ETHUSDT: 3200 });

  assert.deepEqual(calls[0].body, { prices: { BTCUSDT: 65000, ETHUSDT: 3200 } });
});

test('pushFundingEvent posts symbol, rate, optional mark price, and funding_time (idempotency key — #10)', async () => {
  const calls: Call[] = [];
  const client = new PaperExchangeClient('http://localhost:3000', 'ACC-1', fakeFetch(202, { accepted: true }, calls));

  await client.pushFundingEvent('BTCUSDT', 0.0003, 65000, '2026-09-20T08:00:00.000Z');

  assert.deepEqual(calls[0].body, {
    symbol: 'BTCUSDT',
    funding_rate: 0.0003,
    mark_price: 65000,
    funding_time: '2026-09-20T08:00:00.000Z',
  });
});

test('pushFundingEvent omits funding_time when not supplied (backwards-compatible)', async () => {
  const calls: Call[] = [];
  const client = new PaperExchangeClient('http://localhost:3000', 'ACC-1', fakeFetch(202, { accepted: true }, calls));

  await client.pushFundingEvent('BTCUSDT', 0.0003);

  assert.deepEqual(calls[0].body, { symbol: 'BTCUSDT', funding_rate: 0.0003, mark_price: undefined, funding_time: undefined });
});

test('retries 5xx errors up to 3 times with exponential backoff (#7)', async () => {
  let calls = 0;
  const client = new PaperExchangeClient('http://localhost:3000', 'ACC-1', async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 502, json: async () => ({}), text: async () => 'Bad gateway' } as Response;
    return { ok: true, status: 200, json: async () => ({ id: 1, status: 'filled' }), text: async () => '' } as Response;
  });

  const result = await client.submitOrder({ symbol: 'BTCUSDT', side: 'buy', quantity: 1, leverage: 1, executionPrice: 100, clientOrderId: 'x' });

  assert.equal(calls, 3);
  assert.deepEqual(result, { orderId: 1, status: 'filled' });
});

test('does NOT retry 4xx errors — surfaces immediately as PaperExchangeHttpError (#7)', async () => {
  let calls = 0;
  const client = new PaperExchangeClient('http://localhost:3000', 'ACC-1', async () => {
    calls += 1;
    return { ok: false, status: 422, json: async () => ({}), text: async () => 'Insufficient margin' } as Response;
  });

  await assert.rejects(
    client.submitOrder({ symbol: 'BTCUSDT', side: 'buy', quantity: 1, leverage: 1, executionPrice: 100, clientOrderId: 'x' }),
    /422.*Insufficient margin/s,
  );
  assert.equal(calls, 1);
});

test('submitProtectionOrder posts stop_loss with trigger_price (#1)', async () => {
  const calls: Call[] = [];
  const client = new PaperExchangeClient('http://localhost:3000', 'ACC-1', fakeFetch(201, { id: 43, status: 'open' }, calls));

  await client.submitProtectionOrder({
    symbol: 'BTCUSDT', side: 'sell', quantity: 0.1, triggerPrice: 59000, executionPrice: 60000, clientOrderId: 'entry-1-SL',
  });

  assert.equal(calls[0].body.order.order_type, 'stop_loss');
  assert.equal(calls[0].body.order.trigger_price, 59000);
  assert.equal(calls[0].body.order.client_order_id, 'entry-1-SL');
});

test('submitProtectionOrder posts bounded with price (#1)', async () => {
  const calls: Call[] = [];
  const client = new PaperExchangeClient('http://localhost:3000', 'ACC-1', fakeFetch(201, { id: 44, status: 'open' }, calls));

  await client.submitProtectionOrder({
    symbol: 'BTCUSDT', side: 'sell', quantity: 0.1, price: 65000, executionPrice: 60000, clientOrderId: 'entry-1-TP',
  });

  assert.equal(calls[0].body.order.order_type, 'bounded');
  assert.equal(calls[0].body.order.price, 65000);
});
