import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalOrderBook } from '../src/microstructure/LocalOrderBook.js';
import { OrderBookDepthSource, computeDepthMetrics } from '../src/market/OrderBookDepthSource.js';
import { MarketDataService, type FuturesMarketClient } from '../src/market/MarketDataService.js';

const T0 = 1700000000000;

test('OrderBookDepthSource calculates spread and imbalance from live book', () => {
  const book = new LocalOrderBook();
  book.loadSnapshot({
    lastUpdateId: 100,
    bids: [{ price: 100, qty: 3 }, { price: 99, qty: 1 }],
    asks: [{ price: 102, qty: 1 }, { price: 103, qty: 3 }],
  });
  book.onDiff({ U: 99, u: 101, pu: 98, E: T0, b: [], a: [] });

  const metrics = computeDepthMetrics(book, 2);
  assert.equal(book.status, 'LIVE');
  assert.equal(book.bestBid(), 100);
  assert.equal(book.bestAsk(), 102);
  // mid = 101, spreadBps = ((102 - 100) / 101) * 10000 ~= 198.0198
  assert.ok(metrics.spreadBps !== null && metrics.spreadBps > 190 && metrics.spreadBps < 200);

  const source = new OrderBookDepthSource(15_000);
  source.register('BTCUSDT', book);
  assert.notEqual(source.depth('BTCUSDT', 2, T0 + 1000), null);
  // Stale book after maxAgeMs returns null
  assert.equal(source.depth('BTCUSDT', 2, T0 + 20_000), null);
});

test('MarketDataService skips getOrderBook REST call when DepthSource has fresh book', async () => {
  let orderBookCalls = 0;
  const mockClient: FuturesMarketClient = {
    getKlines: async () => [],
    getOpenInterest: async () => ({ openInterest: '100' }),
    getOpenInterestStatistics: async () => [],
    getGlobalLongShortAccountRatio: async () => [],
    getTopTradersLongShortAccountRatio: async () => [],
    getTopTradersLongShortPositionRatio: async () => [],
    getTakerBuySellVolume: async () => [],
    getOrderBook: async () => { orderBookCalls++; return { bids: [], asks: [] }; },
    getBasis: async () => [],
  };

  const fakeDepthSource = {
    depth: () => ({ imbalance: 0.25, spreadBps: 2.5 }),
  };

  const service = new MarketDataService(mockClient, undefined, undefined, fakeDepthSource);
  const snapshots = await service.snapshot(['BTCUSDT'], T0);

  assert.equal(orderBookCalls, 0, 'REST getOrderBook was not called');
  assert.equal(snapshots['BTCUSDT']?.derivatives?.orderBookImbalance, 0.25);
  assert.equal(snapshots['BTCUSDT']?.derivatives?.spreadBps, 2.5);
});
