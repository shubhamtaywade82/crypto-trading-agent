import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import { MarketDataService, type KlineSource, type MarketDataServiceOptions } from '../src/market/MarketDataService.js';
import type { NativeTimeframe } from '../src/market/MarketDataTypes.js';

const NOW = 1_800_000_000_000;

const options: MarketDataServiceOptions = {
  candleTtlMs: { '1m': 10_000, '5m': 10_000, '15m': 10_000, '1h': 10_000, '4h': 10_000 },
  derivativesTtlMs: 10_000,
  klineLimit: 50,
  historyLimit: 3,
  orderBookDepth: 2,
  maxConcurrency: 2,
  derivativesPeriod: '1h',
  basisEnabled: false,
};

/** A REST client that counts kline requests per interval and answers every derivatives call with nothing. */
function fakeClient() {
  const klineCalls: string[] = [];
  const empty = async () => [];
  return {
    klineCalls,
    client: {
      async getKlines({ interval }: { interval: string }) {
        klineCalls.push(interval);
        return [[NOW - 900_000, 100, 101, 99, 100, 10, NOW - 1]];
      },
      getOpenInterest: async () => ({ openInterest: '1' }),
      getOpenInterestStatistics: empty,
      getGlobalLongShortAccountRatio: empty,
      getTopTradersLongShortAccountRatio: empty,
      getTopTradersLongShortPositionRatio: empty,
      getTakerBuySellVolume: empty,
      getOrderBook: async () => ({ bids: [], asks: [] }),
      getBasis: empty,
    },
  };
}

test('a timeframe the stream serves costs no REST kline call; the others still read REST', async () => {
  const { client, klineCalls } = fakeClient();
  const streamed: Candle[] = [{ openTime: NOW - 900_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 }];
  const klines: KlineSource = {
    candles: (_symbol, timeframe: NativeTimeframe) => (timeframe === '15m' ? streamed : null),
  };
  const service = new MarketDataService(client as never, options, klines);

  const snapshot = await service.snapshot(['BTCUSDT'], NOW);

  assert.deepEqual(klineCalls.sort(), ['1h', '1m', '4h', '5m'].sort(), '15m came from the stream');
  assert.deepEqual(snapshot.BTCUSDT!.candles['15m'], streamed);
});

test('with no stream, every timeframe is read from REST as before', async () => {
  const { client, klineCalls } = fakeClient();
  const service = new MarketDataService(client as never, options, { candles: () => null });

  await service.snapshot(['BTCUSDT'], NOW);

  assert.deepEqual(klineCalls.sort(), ['15m', '1h', '1m', '4h', '5m'].sort());
});

test('the service is unchanged when no kline source is passed', async () => {
  const { client, klineCalls } = fakeClient();
  const service = new MarketDataService(client as never, options);

  await service.snapshot(['BTCUSDT'], NOW);

  assert.equal(klineCalls.length, 5);
});
