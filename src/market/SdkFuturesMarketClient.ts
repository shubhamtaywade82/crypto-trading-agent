import type { BinanceClient, KlineInterval } from '@nemesis-oss/binance-sdk';
import type { FuturesMarketClient } from './MarketDataService.js';
import type { NativeTimeframe } from './MarketDataTypes.js';

const FAPI = 'https://fapi.binance.com';

type FuturesSurface = BinanceClient['futures'];

/**
 * Public USDⓈ-M REST reads over the SDK. The service's parsers expect the legacy six-column kline
 * rows and `[price, qty]` book levels, so this adapter normalises the SDK's typed objects back to
 * those shapes.
 *
 * `futures.data.basis` in SDK 3.6.0 sends `symbol`; the endpoint requires `pair` and
 * `contractType`, so that one call is made directly until the SDK fixes it.
 */
export class SdkFuturesMarketClient implements FuturesMarketClient {
  constructor(private readonly futures: FuturesSurface) {}

  async getKlines(params: { symbol: string; interval: NativeTimeframe; limit: number }): Promise<unknown[]> {
    const rows = await this.futures.market.klines(params.symbol, params.interval as KlineInterval, { limit: params.limit });
    return rows.map((k) => [k.openTime, k.open, k.high, k.low, k.close, k.volume]);
  }

  async getOpenInterest(params: { symbol: string }): Promise<unknown> {
    return this.futures.data.openInterest(params.symbol);
  }

  async getOpenInterestStatistics(params: { symbol: string; period: string; limit: number }): Promise<unknown[]> {
    return this.futures.data.openInterestHist(params.symbol, params.period, params.limit);
  }

  async getGlobalLongShortAccountRatio(params: { symbol: string; period: string; limit: number }): Promise<unknown[]> {
    return this.futures.data.globalLongShortAccountRatio(params.symbol, params.period, params.limit);
  }

  async getTopTradersLongShortAccountRatio(params: { symbol: string; period: string; limit: number }): Promise<unknown[]> {
    return this.futures.data.topLongShortAccountRatio(params.symbol, params.period, params.limit);
  }

  async getTopTradersLongShortPositionRatio(params: { symbol: string; period: string; limit: number }): Promise<unknown[]> {
    return this.futures.data.topLongShortPositionRatio(params.symbol, params.period, params.limit);
  }

  async getTakerBuySellVolume(params: { symbol: string; period: string; limit: number }): Promise<unknown[]> {
    return this.futures.data.takerLongShortRatio(params.symbol, params.period, params.limit);
  }

  async getOrderBook(params: { symbol: string; limit: number }): Promise<unknown> {
    const book = await this.futures.market.depth(params.symbol, params.limit);
    return {
      bids: book.bids.map(({ price, qty }) => [price, qty]),
      asks: book.asks.map(({ price, qty }) => [price, qty]),
    };
  }

  async getBasis(params: { pair: string; contractType: string; period: string; limit: number }): Promise<unknown[]> {
    const url = new URL('/futures/data/basis', FAPI);
    url.searchParams.set('pair', params.pair.endsWith('USDT') ? params.pair : `${params.pair}USDT`);
    url.searchParams.set('contractType', params.contractType);
    url.searchParams.set('period', params.period);
    url.searchParams.set('limit', String(params.limit));
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`basis ${response.status}`);
    return (await response.json()) as unknown[];
  }
}
