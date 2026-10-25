import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OrderRejectedError,
  PaperExchangeClient,
  VenueUnavailableError,
} from '../src/binance/paperExchangeClient.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

type Reply = { status: number; json?: unknown; text?: string } | Error;

/** Replays `replies` in order (the last one repeats) and records every request. */
function scriptedFetch(replies: Reply[], calls: Call[]) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.json,
      text: async () => reply.text ?? JSON.stringify(reply.json ?? ''),
    } as Response;
  };
}

function clientFor(replies: Reply[], calls: Call[], opts: { retries?: number; timeoutMs?: number } = {}) {
  return new PaperExchangeClient('http://localhost:3000', 'ACC-1', { fetchImpl: scriptedFetch(replies, calls), backoffMs: 1, ...opts });
}

const ORDER = { symbol: 'BTCUSDT', side: 'buy', quantity: 0.01, leverage: 10, executionPrice: 65000, clientOrderId: 'abc-123' } as const;

test('getAccount maps the Rails snake_case payload to camelCase', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 200, json: {
    account_id: 'ACC-1', currency: 'USDT', margin: '100000.0', available_balance: '94000.0',
    locked_margin: '6000.0', equity: '100050.0', unrealized_pnl: '50.0', realized_pnl: '0.0', positions_count: 1,
  } }], calls);

  const account = await client.getAccount();

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'http://localhost:3000/api/account');
  assert.equal(calls[0].headers['X-Account-Id'], 'ACC-1');
  assert.deepEqual(account, {
    accountId: 'ACC-1', currency: 'USDT', margin: 100000, availableBalance: 94000,
    lockedMargin: 6000, equity: 100050, unrealizedPnl: 50, realizedPnl: 0, positionsCount: 1,
  });
});

test('sends X-API-Key header when apiKey option is provided', async () => {
  const calls: Call[] = [];
  const client = new PaperExchangeClient('http://localhost:3000', 'ACC-1', {
    fetchImpl: scriptedFetch([{ status: 200, json: {
      account_id: 'ACC-1', currency: 'USDT', margin: '1000', available_balance: '1000',
      locked_margin: '0', equity: '1000', unrealized_pnl: '0', realized_pnl: '0', positions_count: 0,
    } }], calls),
    apiKey: 'test-api-key',
  });

  await client.getAccount();

  assert.equal(calls[0].headers['X-API-Key'], 'test-api-key');
});

test('getAccount returns null on 404 without retrying', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 404, json: { error: 'Account not found' } }], calls);

  assert.equal(await client.getAccount(), null);
  assert.equal(calls.length, 1);
});

test('createAccount posts to /api/account/reset with the starting margin', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 200, json: {} }], calls);

  await client.createAccount(100000);

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://localhost:3000/api/account/reset?margin=100000');
});

test('getPositions maps each Rails position, treating a null liquidation_price as null', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 200, json: [
    {
      id: 7, symbol: 'BTCUSDT', side: 'long', net_quantity: '1.0', average_price: '60000.0',
      current_price: '61000.0', leverage: 10, margin_type: 'cross', liquidation_price: '54000.0', unrealized_pnl: '1000.0',
    },
    {
      id: 8, symbol: 'ETHUSDT', side: 'short', net_quantity: '2.0', average_price: '3000.0',
      current_price: '2950.0', leverage: 1, margin_type: 'cross', liquidation_price: null, unrealized_pnl: '100.0',
    },
  ] }], calls);

  const positions = await client.getPositions();

  assert.equal(positions.length, 2);
  assert.equal(positions[0].liquidationPrice, 54000);
  assert.equal(positions[1].liquidationPrice, null);
  assert.equal(positions[1].leverage, 1);
});

test('getPositions drops flat rows the broker keeps after a close', async () => {
  const calls: Call[] = [];
  const row = { average_price: '0.0', current_price: '0.0', leverage: 1, margin_type: 'isolated', liquidation_price: null, unrealized_pnl: '0.0' };
  const client = clientFor([{ status: 200, json: [
    { id: 1, symbol: 'BTCUSDT', side: 'long', net_quantity: '0.0', ...row },
    { id: 2, symbol: 'ETHUSDT', side: 'short', net_quantity: '2.0', ...row },
  ] }], calls);

  const positions = await client.getPositions();

  assert.deepEqual(positions.map((p) => p.symbol), ['ETHUSDT']);
});

test('submitOrder maps filled_quantity into filledQuantity when the broker reports it', async () => {
  const client = clientFor([{ status: 201, json: { id: 44, status: 'filled', filled_quantity: '0.0075' } }], []);

  assert.deepEqual(await client.submitOrder({ ...ORDER }), { orderId: 44, status: 'filled', filledQuantity: 0.0075 });
});

test('submitOrder posts a market order, isolated by default, without reduce_only', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 201, json: { id: 42, status: 'filled' } }], calls);

  const result = await client.submitOrder({ ...ORDER });

  assert.deepEqual(result, { orderId: 42, status: 'filled' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://localhost:3000/api/orders');
  assert.deepEqual(calls[0].body, {
    order: {
      symbol: 'BTCUSDT', side: 'buy', quantity: 0.01, order_type: 'market', instrument_type: 'CRYPTO_PERPETUAL',
      leverage: 10, margin_type: 'isolated', execution_price: 65000, client_order_id: 'abc-123',
    },
  });
});

test('submitOrder sends reduce_only: true only when reduceOnly is set', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 201, json: { id: 43, status: 'filled' } }], calls);

  await client.submitOrder({ ...ORDER, side: 'sell', reduceOnly: true });

  assert.equal(calls[0].body.order.reduce_only, true);
  assert.equal(calls[0].body.order.order_type, 'market');
});

test('the client no longer exposes server-side protection orders', () => {
  const client = clientFor([], []);

  assert.equal('submitProtectionOrder' in client, false);
});

test('findOrder reads the broker\'s { data, next_cursor } envelope', async () => {
  const calls: Call[] = [];
  const page = { data: [
    { id: 3, client_order_id: 'other', status: 'filled' },
    { id: 4, client_order_id: 'abc-123', status: 'filled', filled_quantity: '0.5' },
  ], next_cursor: null };
  const client = clientFor([{ status: 200, json: page }], calls);

  assert.deepEqual(await client.findOrder('abc-123'), { orderId: 4, status: 'filled', filledQuantity: 0.5 });
  assert.equal(await client.findOrder('missing'), null);
  assert.equal(calls[0].url, 'http://localhost:3000/api/orders?limit=500');
  assert.equal(calls.length, 2, 'a null next_cursor ends the walk after one page');
});

test('findOrder follows next_cursor (URL-encoded) to an order beyond the first page', async () => {
  const calls: Call[] = [];
  const client = clientFor([
    { status: 200, json: { data: [{ id: 1, client_order_id: 'newer', status: 'filled' }], next_cursor: 'MjAyNi0xMC0yNVQw+/=' } },
    { status: 200, json: { data: [{ id: 2, client_order_id: 'lost-reply', status: 'filled' }], next_cursor: 'c2' } },
  ], calls);

  assert.deepEqual(await client.findOrder('lost-reply'), { orderId: 2, status: 'filled' });
  assert.deepEqual(calls.map((c) => c.url), [
    'http://localhost:3000/api/orders?limit=500',
    'http://localhost:3000/api/orders?limit=500&cursor=MjAyNi0xMC0yNVQw%2B%2F%3D',
  ]);
});

test('findOrder gives up as not found after 5 pages instead of walking the whole history', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 200, json: { data: [{ id: 1, client_order_id: 'x', status: 'filled' }], next_cursor: 'more' } }], calls);

  assert.equal(await client.findOrder('ancient'), null);
  assert.equal(calls.length, 5);
});

test('findOrder still reads a bare array from a pre-pagination broker', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 200, json: [{ id: 7, client_order_id: 'abc', status: 'filled' }] }], calls);

  assert.deepEqual(await client.findOrder('abc'), { orderId: 7, status: 'filled' });
  assert.equal(calls.length, 1);
});

test('an unreadable list body is VenueUnavailableError, never "not found"', async () => {
  for (const json of [{ error: 'maintenance' }, { data: 'nope', next_cursor: null }, null]) {
    const client = clientFor([{ status: 200, json, text: json === null ? '' : undefined }], []);
    await assert.rejects(client.findOrder('abc'), VenueUnavailableError);
    await assert.rejects(client.getRiskEvents(), VenueUnavailableError);
  }
});

test('getRiskEvents maps id, event_type, details and created_at from the envelope', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 200, json: { data: [
    { id: 9, event_type: 'liquidation', details: { symbol: 'BTCUSDT' }, created_at: '2026-09-21T10:00:00Z' },
  ], next_cursor: null } }], calls);

  assert.deepEqual(await client.getRiskEvents(), [
    { id: 9, eventType: 'liquidation', details: { symbol: 'BTCUSDT' }, createdAt: '2026-09-21T10:00:00Z' },
  ]);
  assert.equal(calls[0].url, 'http://localhost:3000/api/risk_events?limit=500');
});

test('getRiskEvents pages back until it has read past sinceMs, and no further', async () => {
  const calls: Call[] = [];
  const ev = (id: number, at: string) => ({ id, event_type: 'MARGIN_CALL', details: {}, created_at: at });
  const client = clientFor([
    { status: 200, json: { data: [ev(5, '2026-10-25T09:00:00Z'), ev(4, '2026-10-25T08:00:00Z')], next_cursor: 'p2' } },
    { status: 200, json: { data: [ev(3, '2026-10-25T07:00:00Z'), ev(2, '2026-10-25T05:00:00Z')], next_cursor: 'p3' } },
    { status: 200, json: { data: [ev(1, '2026-10-25T04:00:00Z')], next_cursor: null } },
  ], calls);

  const events = await client.getRiskEvents(Date.parse('2026-10-25T06:00:00Z'));

  assert.deepEqual(events.map((e) => e.id), [5, 4, 3, 2]);
  assert.equal(calls.length, 2);
});

test('getRiskEvents without sinceMs reads every page up to the 20-page cap', async () => {
  const calls: Call[] = [];
  const client = clientFor([
    { status: 200, json: { data: [{ id: 2, event_type: 'A', details: {}, created_at: '2026-10-25T09:00:00Z' }], next_cursor: 'p2' } },
    { status: 200, json: { data: [{ id: 1, event_type: 'B', details: {}, created_at: '2026-10-25T08:00:00Z' }], next_cursor: null } },
  ], calls);
  assert.deepEqual((await client.getRiskEvents()).map((e) => e.id), [2, 1]);

  const endless: Call[] = [];
  const capped = clientFor([{ status: 200, json: { data: [{ id: 1, event_type: 'A', details: {}, created_at: '2026-10-25T08:00:00Z' }], next_cursor: 'again' } }], endless);
  assert.equal((await capped.getRiskEvents()).length, 20);
  assert.equal(endless.length, 20);
});

test('pushMarkPrices posts the raw prices map', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 200, json: { updated: {} } }], calls);

  await client.pushMarkPrices({ BTCUSDT: 65000, ETHUSDT: 3200 });

  assert.deepEqual(calls[0].body, { prices: { BTCUSDT: 65000, ETHUSDT: 3200 } });
});

test('pushFundingEvent sends funding_time as ISO-8601, the format the broker dedupes on', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 202, json: { accepted: true } }], calls);

  await client.pushFundingEvent('BTCUSDT', 0.0003, 65000, Date.parse('2026-09-20T08:00:00.000Z'));

  assert.deepEqual(calls[0].body, {
    symbol: 'BTCUSDT', funding_rate: 0.0003, mark_price: 65000, funding_time: '2026-09-20T08:00:00.000Z',
  });
});

test('retries 5xx twice then succeeds, resending the identical body and client_order_id', async () => {
  const calls: Call[] = [];
  const client = clientFor([
    { status: 502, text: 'Bad gateway' },
    { status: 503, text: 'Unavailable' },
    { status: 201, json: { id: 1, status: 'filled' } },
  ], calls);

  const result = await client.submitOrder({ ...ORDER });

  assert.equal(calls.length, 3);
  assert.deepEqual(result, { orderId: 1, status: 'filled' });
  assert.deepEqual(calls[1].body, calls[0].body);
  assert.deepEqual(calls[2].body, calls[0].body);
  assert.equal(calls[2].body.order.client_order_id, 'abc-123');
});

test('4xx is never retried and surfaces as OrderRejectedError carrying status and body', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 402, text: 'Insufficient margin' }], calls);

  await assert.rejects(client.submitOrder({ ...ORDER }), (err: unknown) => {
    assert.ok(err instanceof OrderRejectedError);
    assert.equal(err.status, 402);
    assert.equal(err.body, 'Insufficient margin');
    assert.match(err.message, /402.*Insufficient margin/s);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('5xx after the retry budget is VenueUnavailableError', async () => {
  const calls: Call[] = [];
  const client = clientFor([{ status: 500, text: 'boom' }], calls);

  await assert.rejects(client.getPositions(), VenueUnavailableError);
  assert.equal(calls.length, 3);
});

test('network errors are retried, then raise VenueUnavailableError', async () => {
  const calls: Call[] = [];
  const client = clientFor([new TypeError('fetch failed')], calls, { retries: 1 });

  await assert.rejects(client.getAccount(), VenueUnavailableError);
  assert.equal(calls.length, 2);
});

test('a hung request is aborted after timeoutMs and raises VenueUnavailableError', async () => {
  let attempts = 0;
  const hangUntilAborted = (_url: string | URL, init?: RequestInit) => {
    attempts += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  };
  const client = new PaperExchangeClient('http://localhost:3000', 'ACC-1', {
    fetchImpl: hangUntilAborted as typeof fetch, timeoutMs: 20, retries: 1, backoffMs: 1,
  });

  // AbortSignal.timeout() uses an unref'd timer, so the hanging fetch leaves nothing
  // keeping the event loop alive. A ref'd keepalive interval guarantees the abort
  // timers always fire before node:test's idle detection declares the loop drained
  // (observed as a flaky "Promise resolution is still pending" failure in CI).
  const keepAlive = setInterval(() => {}, 5);
  try {
    await assert.rejects(client.getAccount(), VenueUnavailableError);
    assert.equal(attempts, 2);
  } finally {
    clearInterval(keepAlive);
  }
});
