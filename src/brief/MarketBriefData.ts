import type { USDMClient } from 'binance';
import type {
  BriefFormingCandle,
  BriefKlines,
  BriefMarketData,
  BriefTakerBucket,
  BriefTimeframe,
  BriefBook,
  TakerPeriod,
} from './types.js';
import { BRIEF_TIMEFRAMES, TIMEFRAME_MS } from './types.js';
import type { Candle } from '../types.js';

/**
 * Read-only market-data endpoints the brief needs. Injectable so tests run without a network,
 * mirroring MarketDataService's FuturesMarketClient contract. Everything here is public data:
 * no API keys, no orders, no writes.
 */
export type BriefMarketClient = Pick<
  USDMClient,
  | 'getKlines'
  | 'get24hrChangeStatistics'
  | 'getMarkPrice'
  | 'getOpenInterest'
  | 'getOpenInterestStatistics'
  | 'getGlobalLongShortAccountRatio'
  | 'getTopTradersLongShortPositionRatio'
  | 'getTakerBuySellVolume'
  | 'getOrderBook'
>;

export interface BriefCollectionOptions {
  /** Klines fetched per timeframe (closed + forming). */
  klineLimit: number;
  /** Hourly open-interest statistics snapshots used for the OI trend. */
  oiHistoryLimit: number;
  /** Order-book depth scanned for best prices and the largest displayed levels. */
  orderBookDepth: number;
}

export const DEFAULT_BRIEF_COLLECTION_OPTIONS: BriefCollectionOptions = {
  klineLimit: 200,
  oiHistoryLimit: 5,
  orderBookDepth: 20,
};

/** Funding settles every 8h by default; the APR figure assumes that interval. */
const FUNDINGS_PER_YEAR = 3 * 365;

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Runs one endpoint, converting failure into { ok: false } plus an error entry. A single public
 * endpoint failing must never lose the rest of the brief — the same safety rule MarketDataService
 * applies to its derivative snapshot.
 */
async function attempt<T>(name: string, run: () => Promise<T>, errors: string[]): Promise<{ ok: boolean; value: T | null }> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, value: null };
  }
}

/**
 * Splits raw klines into closed candles and the single forming candle. A candle is confirmed only
 * when its whole interval lies in the past (openTime + intervalMs <= now); the still-open candle
 * is reported separately so no consumer can mistake it for a confirmed close.
 */
export function splitKlines(raw: any[], timeframe: BriefTimeframe, now: number): BriefKlines {
  const intervalMs = TIMEFRAME_MS[timeframe];
  const candles: Candle[] = (raw as any[])
    .map((k: any[]) => {
      const [openTime, open, high, low, close, volume] = k.map(Number);
      return { openTime, open, high, low, close, volume };
    })
    .filter((c) => Number.isFinite(c.openTime) && Number.isFinite(c.close));

  const confirmed = candles.filter((c) => c.openTime + intervalMs <= now);
  const formingRaw = candles.find((c) => c.openTime + intervalMs > now) ?? null;
  const forming: BriefFormingCandle | null = formingRaw
    ? { openTime: formingRaw.openTime, open: formingRaw.open, high: formingRaw.high, low: formingRaw.low, last: formingRaw.close }
    : null;

  return { confirmed, forming };
}

/** The exchange reports account ratios as decimals (0.7488 = 74.88%); absent fields are derived from the ratio. */
function parseGlobalRatio(raw: any): BriefMarketData['globalRatio'] {
  const row = (raw as any[])?.at(-1);
  if (!row) return null;

  const ratio = asNumber(row.longShortRatio);
  const derivedLong = ratio !== null ? (ratio / (1 + ratio)) * 100 : null;
  const longPct = asNumber(row.longAccount) !== null ? asNumber(row.longAccount)! * 100 : derivedLong;
  const shortPct = asNumber(row.shortAccount) !== null ? asNumber(row.shortAccount)! * 100
    : ratio !== null ? (1 / (1 + ratio)) * 100 : null;
  if (ratio === null && longPct === null) return null;

  return { ratio, longPct, shortPct, timestamp: asNumber(row.timestamp) };
}

/**
 * Latest published taker bucket for one period. Binance keeps rewriting the current bucket, so
 * its timestamp is carried along: buckets for different periods do not end at the same time, and
 * the brief must not pretend they do.
 */
function parseTakerBucket(period: TakerPeriod, raw: any): BriefTakerBucket {
  const row = (raw as any[])?.at(-1);
  const ratio = row ? asNumber(row.buySellRatio) : null;
  const buyVol = row ? asNumber(row.buyVol) : null;
  const sellVol = row ? asNumber(row.sellVol) : null;
  const dominance = ratio === null ? 'UNKNOWN' : ratio > 1 ? 'BUY' : ratio < 1 ? 'SELL' : 'BALANCED';

  return { period, ratio, buyVol, sellVol, bucketTime: row ? asNumber(row.timestamp) : null, dominance };
}

/** Best prices plus the largest displayed level on each side. Book concentrations are transient. */
export function parseBriefBook(raw: any, depth: number): BriefBook {
  const bids = Array.isArray(raw?.bids) ? raw.bids : [];
  const asks = Array.isArray(raw?.asks) ? raw.asks : [];
  if (!bids.length || !asks.length) {
    return { bestBid: null, bestAsk: null, spreadBps: null, largestBidLevel: null, largestAskLevel: null };
  }

  const bestBid = asNumber(bids[0]?.[0]);
  const bestAsk = asNumber(asks[0]?.[0]);
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spreadBps = mid !== null && mid > 0 && bestBid !== null && bestAsk !== null
    ? ((bestAsk - bestBid) / mid) * 10_000
    : null;

  const largest = (rows: any[]) => {
    let best: { price: number; qty: number; notional: number } | null = null;
    for (const row of rows.slice(0, depth)) {
      const price = asNumber(row?.[0]);
      const qty = asNumber(row?.[1]);
      if (price === null || qty === null) continue;
      const notional = price * qty;
      if (!best || notional > best.notional) best = { price, qty, notional };
    }
    return best;
  };

  return { bestBid, bestAsk, spreadBps, largestBidLevel: largest(bids), largestAskLevel: largest(asks) };
}

/**
 * Collects every raw input the brief needs for one symbol. Endpoints run concurrently; each
 * failure is recorded in `errors` and its fields become null. The returned object is a faithful
 * record of what the exchange served at `now` — no interpretation happens here.
 */
export async function collectBriefMarketData(
  symbol: string,
  client: BriefMarketClient,
  options: BriefCollectionOptions = DEFAULT_BRIEF_COLLECTION_OPTIONS,
  now: number = Date.now(),
): Promise<BriefMarketData> {
  const errors: string[] = [];

  const [ticker, mark, klineResults, openInterest, oiHistory, globalRatio, topPositionRatio, taker5m, taker15m, taker1h, book] =
    await Promise.all([
      attempt('24h ticker', () => client.get24hrChangeStatistics({ symbol }), errors),
      attempt('mark price', () => client.getMarkPrice({ symbol }), errors),
      Promise.all(BRIEF_TIMEFRAMES.map((tf) =>
        attempt(`klines ${tf}`, () => client.getKlines({ symbol, interval: tf, limit: options.klineLimit }), errors),
      )),
      attempt('open interest', () => client.getOpenInterest({ symbol }), errors),
      attempt('open interest history', () => client.getOpenInterestStatistics({ symbol, period: '1h', limit: options.oiHistoryLimit }), errors),
      attempt('global long/short ratio', () => client.getGlobalLongShortAccountRatio({ symbol, period: '1h', limit: 1 }), errors),
      attempt('top trader position ratio', () => client.getTopTradersLongShortPositionRatio({ symbol, period: '1h', limit: 1 }), errors),
      attempt('taker flow 5m', () => client.getTakerBuySellVolume({ symbol, period: '5m', limit: 1 }), errors),
      attempt('taker flow 15m', () => client.getTakerBuySellVolume({ symbol, period: '15m', limit: 1 }), errors),
      attempt('taker flow 1h', () => client.getTakerBuySellVolume({ symbol, period: '1h', limit: 1 }), errors),
      attempt('order book', () => client.getOrderBook({ symbol, limit: options.orderBookDepth as 5 | 10 | 20 | 50 | 100 | 500 | 1000 | 5000 }), errors),
    ]);

  // get24hrChangeStatistics returns a single object with a symbol and an array without one.
  const tickerRaw: any = ticker.value;
  const tickerRow = Array.isArray(tickerRaw) ? tickerRaw.find((t) => t?.symbol === symbol) : tickerRaw;
  const parsedTicker = tickerRow
    ? {
        lastPrice: asNumber(tickerRow.lastPrice),
        changePct: asNumber(tickerRow.priceChangePercent),
        changeAbs: asNumber(tickerRow.priceChange),
        high24h: asNumber(tickerRow.highPrice),
        low24h: asNumber(tickerRow.lowPrice),
        volumeBase: asNumber(tickerRow.volume),
        volumeQuote: asNumber(tickerRow.quoteVolume),
      }
    : null;

  const markRaw: any = Array.isArray(mark.value) ? (mark.value as any[]).find((m) => m?.symbol === symbol) : mark.value;
  const parsedMark = markRaw
    ? {
        markPrice: asNumber(markRaw.markPrice),
        indexPrice: asNumber(markRaw.indexPrice),
        fundingRate: asNumber(markRaw.lastFundingRate),
        nextFundingTime: asNumber(markRaw.nextFundingTime),
      }
    : null;

  const candles: BriefMarketData['candles'] = {};
  BRIEF_TIMEFRAMES.forEach((tf, i) => {
    const result = klineResults[i];
    if (result?.ok && Array.isArray(result.value)) candles[tf] = splitKlines(result.value as any[], tf, now);
  });

  const oiRows = Array.isArray(oiHistory.value) ? (oiHistory.value as any[]) : [];
  const parsedOiHistory = oiRows
    .map((row) => ({ sumOpenInterest: asNumber(row?.sumOpenInterest), timestamp: asNumber(row?.timestamp) }))
    .filter((row): row is { sumOpenInterest: number; timestamp: number } => row.sumOpenInterest !== null);

  return {
    symbol,
    fetchedAt: now,
    ticker: parsedTicker,
    mark: parsedMark,
    candles,
    openInterest: openInterest.value ? asNumber((openInterest.value as any)?.openInterest) : null,
    oiHistory: parsedOiHistory,
    globalRatio: globalRatio.value ? parseGlobalRatio(globalRatio.value) : null,
    topTraderPositionRatio: topPositionRatio.value
      ? asNumber((topPositionRatio.value as any[])?.at(-1)?.longShortRatio)
      : null,
    taker: {
      '5m': taker5m.value ? parseTakerBucket('5m', taker5m.value) : { period: '5m', ratio: null, buyVol: null, sellVol: null, bucketTime: null, dominance: 'UNKNOWN' },
      '15m': taker15m.value ? parseTakerBucket('15m', taker15m.value) : { period: '15m', ratio: null, buyVol: null, sellVol: null, bucketTime: null, dominance: 'UNKNOWN' },
      '1h': taker1h.value ? parseTakerBucket('1h', taker1h.value) : { period: '1h', ratio: null, buyVol: null, sellVol: null, bucketTime: null, dominance: 'UNKNOWN' },
    },
    book: book.value ? parseBriefBook(book.value, options.orderBookDepth) : { bestBid: null, bestAsk: null, spreadBps: null, largestBidLevel: null, largestAskLevel: null },
    errors,
  };
}
