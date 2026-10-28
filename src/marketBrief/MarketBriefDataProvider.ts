import { createUSDMClient, type BinanceClient } from '@nemesis-oss/binance-sdk';
import type {
  BriefTimeframe,
  CandleView,
  ConfirmedBar,
  FormingBar,
  MarketOverview,
  MultiPeriodDerivatives,
  TakerFlowBucket,
} from './types.js';
import type { Candle } from '../types.js';

export interface MarketBriefRawData {
  readonly symbol: string;
  readonly asOf: number;
  readonly overview: MarketOverview;
  readonly candleViews: Readonly<Record<BriefTimeframe, CandleView>>;
  readonly confirmedSeries: Readonly<Record<BriefTimeframe, Candle[]>>;
  readonly derivatives: MultiPeriodDerivatives;
  readonly sourceTimestamps: {
    readonly lastTradeAt: number | null;
    readonly markPriceAt: number | null;
    readonly derivativesAt: number | null;
  };
}

export interface SdkFuturesClient {
  market: {
    klines(symbol: string, interval: string, options?: { limit?: number }): Promise<ReadonlyArray<any>>;
    ticker24hr(symbol: string): Promise<any>;
    depth(symbol: string, limit?: number): Promise<any>;
  };
  data: {
    premiumIndex(symbol: string): Promise<any>;
    openInterest(symbol: string): Promise<any>;
    openInterestHist(symbol: string, period: string, limit?: number): Promise<ReadonlyArray<any>>;
    globalLongShortAccountRatio(symbol: string, period: string, limit?: number): Promise<ReadonlyArray<any>>;
    topLongShortAccountRatio(symbol: string, period: string, limit?: number): Promise<ReadonlyArray<any>>;
    topLongShortPositionRatio(symbol: string, period: string, limit?: number): Promise<ReadonlyArray<any>>;
    takerLongShortRatio(symbol: string, period: string, limit?: number): Promise<ReadonlyArray<any>>;
  };
}

export const TIMEFRAME_MS: Readonly<Record<BriefTimeframe, number>> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

const BRIEF_TIMEFRAMES: readonly BriefTimeframe[] = ['5m', '15m', '1h', '4h'];

// Derives directional bias strictly from completed candle moving averages
function deriveTimeframeBias(confirmed: readonly Candle[]): 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNKNOWN' {
  if (confirmed.length < 20) return 'UNKNOWN';
  const closes = confirmed.map((c) => c.close);
  const sma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const last = closes.at(-1)!;
  const prev = closes.at(-2)!;

  if (last > sma20 && prev > sma20) return 'BULLISH';
  if (last < sma20 && prev < sma20) return 'BEARISH';
  return 'MIXED';
}

// Separates confirmed closed candles from forming live bars to prevent lookahead
function parseTimeframeCandles(
  rawList: readonly any[],
  tf: BriefTimeframe,
  now: number
): { confirmed: Candle[]; view: CandleView } {
  const span = TIMEFRAME_MS[tf];
  const allBars = rawList.map((k) => ({
    openTime: Number(k.openTime ?? k[0]),
    open: Number(k.open ?? k[1]),
    high: Number(k.high ?? k[2]),
    low: Number(k.low ?? k[3]),
    close: Number(k.close ?? k[4]),
    volume: Number(k.volume ?? k[5]),
  })).filter((c) => Number.isFinite(c.openTime) && c.openTime > 0);

  const confirmed = allBars.filter((c) => c.openTime + span <= now);
  const formingBar = allBars.find((c) => c.openTime <= now && c.openTime + span > now);

  const lastClosed = confirmed.at(-1);
  const confirmedBar: ConfirmedBar | null = lastClosed ? {
    ...lastClosed,
    closeTime: lastClosed.openTime + span,
  } : null;

  const forming: FormingBar | null = formingBar ? {
    openTime: formingBar.openTime,
    open: formingBar.open,
    high: formingBar.high,
    low: formingBar.low,
    latestPrice: formingBar.close,
    volume: formingBar.volume,
    updatedAt: now,
  } : null;

  const view: CandleView = {
    timeframe: tf,
    confirmed: confirmedBar,
    forming,
    bias: deriveTimeframeBias(confirmed),
  };

  return { confirmed, view };
}

// Extracts latest taker flow bucket for a single period
function parseTakerBucket(raw: readonly any[] | undefined, period: string): TakerFlowBucket {
  const entry = raw?.at(-1);
  if (!entry) return { period, buyVolume: null, sellVolume: null, buySellRatio: null, timestamp: 0 };
  return {
    period,
    buyVolume: Number.isFinite(Number(entry.buyVol)) ? Number(entry.buyVol) : null,
    sellVolume: Number.isFinite(Number(entry.sellVol)) ? Number(entry.sellVol) : null,
    buySellRatio: Number.isFinite(Number(entry.buySellRatio)) ? Number(entry.buySellRatio) : null,
    timestamp: Number(entry.timestamp ?? 0),
  };
}

// Computes spread in basis points from top order book bids and asks
function calculateSpreadBps(depth: any): number | null {
  const bestBid = Number(depth?.bids?.[0]?.[0] ?? depth?.bids?.[0]?.price);
  const bestAsk = Number(depth?.asks?.[0]?.[0] ?? depth?.asks?.[0]?.price);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return null;
  const mid = (bestBid + bestAsk) / 2;
  return Number((((bestAsk - bestBid) / mid) * 10_000).toFixed(2));
}

// Canonical SDK-backed provider querying USDⓈ-M futures market and analytics
export class BinanceMarketBriefDataProvider {
  private readonly client: SdkFuturesClient;

  constructor(client?: SdkFuturesClient) {
    this.client = client ?? (createUSDMClient() as unknown as SdkFuturesClient);
  }

  async getSnapshot(symbol: string, now: number = Date.now()): Promise<MarketBriefRawData> {
    const [
      ticker,
      prem,
      depth,
      oiCurrent,
      oiHist,
      glsRatio,
      topAccRatio,
      topPosRatio,
      raw5m,
      raw15m,
      raw1h,
      raw4h,
      taker5m,
      taker15m,
      taker1h,
    ] = await Promise.all([
      this.client.market.ticker24hr(symbol).catch(() => null),
      this.client.data.premiumIndex(symbol).catch(() => null),
      this.client.market.depth(symbol, 5).catch(() => null),
      this.client.data.openInterest(symbol).catch(() => null),
      this.client.data.openInterestHist(symbol, '15m', 5).catch(() => []),
      this.client.data.globalLongShortAccountRatio(symbol, '15m', 5).catch(() => []),
      this.client.data.topLongShortAccountRatio(symbol, '15m', 5).catch(() => []),
      this.client.data.topLongShortPositionRatio(symbol, '15m', 5).catch(() => []),
      this.client.market.klines(symbol, '5m', { limit: 100 }).catch(() => []),
      this.client.market.klines(symbol, '15m', { limit: 100 }).catch(() => []),
      this.client.market.klines(symbol, '1h', { limit: 100 }).catch(() => []),
      this.client.market.klines(symbol, '4h', { limit: 100 }).catch(() => []),
      this.client.data.takerLongShortRatio(symbol, '5m', 5).catch(() => []),
      this.client.data.takerLongShortRatio(symbol, '15m', 5).catch(() => []),
      this.client.data.takerLongShortRatio(symbol, '1h', 5).catch(() => []),
    ]);

    const parsed5m = parseTimeframeCandles(raw5m, '5m', now);
    const parsed15m = parseTimeframeCandles(raw15m, '15m', now);
    const parsed1h = parseTimeframeCandles(raw1h, '1h', now);
    const parsed4h = parseTimeframeCandles(raw4h, '4h', now);

    const candleViews = { '5m': parsed5m.view, '15m': parsed15m.view, '1h': parsed1h.view, '4h': parsed4h.view };
    const confirmedSeries = { '5m': parsed5m.confirmed, '15m': parsed15m.confirmed, '1h': parsed1h.confirmed, '4h': parsed4h.confirmed };

    const oiLatest = Number(oiCurrent?.openInterest);
    const oiPrev = Number(oiHist?.at(-2)?.sumOpenInterest);
    const oiChangePct = Number.isFinite(oiLatest) && Number.isFinite(oiPrev) && oiPrev > 0
      ? Number((((oiLatest - oiPrev) / oiPrev) * 100).toFixed(2))
      : null;

    const takerFlowByPeriod: Record<string, TakerFlowBucket> = {
      '5m': parseTakerBucket(taker5m, '5m'),
      '15m': parseTakerBucket(taker15m, '15m'),
      '1h': parseTakerBucket(taker1h, '1h'),
    };

    const overview: MarketOverview = {
      lastPrice: Number.isFinite(Number(ticker?.lastPrice)) ? Number(ticker.lastPrice) : null,
      markPrice: Number.isFinite(Number(prem?.markPrice)) ? Number(prem.markPrice) : null,
      indexPrice: Number.isFinite(Number(prem?.indexPrice)) ? Number(prem.indexPrice) : null,
      change24hPct: Number.isFinite(Number(ticker?.priceChangePercent)) ? Number(ticker.priceChangePercent) : null,
      high24h: Number.isFinite(Number(ticker?.highPrice)) ? Number(ticker.highPrice) : null,
      low24h: Number.isFinite(Number(ticker?.lowPrice)) ? Number(ticker.lowPrice) : null,
    };

    const derivatives: MultiPeriodDerivatives = {
      fundingRate: Number.isFinite(Number(prem?.lastFundingRate)) ? Number(prem.lastFundingRate) : null,
      nextFundingAt: Number.isFinite(Number(prem?.nextFundingTime)) ? Number(prem.nextFundingTime) : null,
      openInterest: Number.isFinite(oiLatest) ? oiLatest : null,
      openInterestChangePct: oiChangePct,
      globalLongShortRatio: Number.isFinite(Number(glsRatio?.at(-1)?.longShortRatio)) ? Number(glsRatio.at(-1).longShortRatio) : null,
      topTraderAccountLongShortRatio: Number.isFinite(Number(topAccRatio?.at(-1)?.longShortRatio)) ? Number(topAccRatio.at(-1).longShortRatio) : null,
      topTraderPositionLongShortRatio: Number.isFinite(Number(topPosRatio?.at(-1)?.longShortRatio)) ? Number(topPosRatio.at(-1).longShortRatio) : null,
      spreadBps: calculateSpreadBps(depth),
      takerFlowByPeriod,
    };

    return {
      symbol,
      asOf: now,
      overview,
      candleViews,
      confirmedSeries,
      derivatives,
      sourceTimestamps: {
        lastTradeAt: Number(ticker?.closeTime ?? now),
        markPriceAt: Number(prem?.time ?? now),
        derivativesAt: Number(oiHist?.at(-1)?.timestamp ?? now),
      },
    };
  }
}
