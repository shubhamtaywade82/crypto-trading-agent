import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SdkFuturesMarketClient } from '../src/market/SdkFuturesMarketClient.js';

const kline = { openTime: 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100, closeTime: 2 };
const book = { lastUpdateId: 1, bids: [{ price: 100, qty: 2 }], asks: [{ price: 101, qty: 3 }] };

function fakeFutures() {
  return {
    market: {
      klines: async () => [kline],
      depth: async () => book,
    },
    data: {
      openInterest: async () => ({ openInterest: 42 }),
      openInterestHist: async () => [{ sumOpenInterest: 1 }],
      globalLongShortAccountRatio: async () => [{ longShortRatio: 1.2 }],
      topLongShortAccountRatio: async () => [{ longShortRatio: 1.1 }],
      topLongShortPositionRatio: async () => [{ longShortRatio: 1.3 }],
      takerLongShortRatio: async () => [{ buySellRatio: 1.4, buyVol: 7, sellVol: 5 }],
    },
  } as never;
}

test('SDK klines are normalised to the legacy six-column rows', async () => {
  const client = new SdkFuturesMarketClient(fakeFutures());
  assert.deepEqual(await client.getKlines({ symbol: 'BTCUSDT', interval: '1m', limit: 1 }), [
    [1, 10, 11, 9, 10.5, 100],
  ]);
});

test('SDK depth levels are normalised to [price, qty] pairs', async () => {
  const client = new SdkFuturesMarketClient(fakeFutures());
  assert.deepEqual(await client.getOrderBook({ symbol: 'BTCUSDT', limit: 1 }), {
    bids: [[100, 2]],
    asks: [[101, 3]],
  });
});

test('basis uses the documented pair and contractType parameters', async () => {
  const original = globalThis.fetch;
  let requested: URL | null = null;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested = new URL(String(input));
    return new Response(JSON.stringify([{ basisRate: '0.001' }]), { status: 200 });
  }) as typeof fetch;
  try {
    const client = new SdkFuturesMarketClient(fakeFutures());
    const rows = await client.getBasis({ pair: 'BTC', contractType: 'PERPETUAL', period: '5m', limit: 2 });
    assert.deepEqual(rows, [{ basisRate: '0.001' }]);
    assert.equal(requested!.pathname, '/futures/data/basis');
    assert.equal(requested!.searchParams.get('pair'), 'BTCUSDT');
    assert.equal(requested!.searchParams.get('contractType'), 'PERPETUAL');
    assert.equal(requested!.searchParams.get('period'), '5m');
    assert.equal(requested!.searchParams.get('limit'), '2');
  } finally {
    globalThis.fetch = original;
  }
});

test('a rejected basis response is reported, never parsed', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 451 })) as typeof fetch;
  try {
    const client = new SdkFuturesMarketClient(fakeFutures());
    await assert.rejects(
      client.getBasis({ pair: 'BTC', contractType: 'PERPETUAL', period: '5m', limit: 2 }),
      /basis 451/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
