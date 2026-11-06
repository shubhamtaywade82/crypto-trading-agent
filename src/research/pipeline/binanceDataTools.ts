/**
 * Public Binance USD-M market metrics provider for autonomous research.
 * Queries live funding rates, open interest, and long/short positioning ratios without API keys.
 */
const BASE_URL = 'https://fapi.binance.com';
const TIMEOUT_MS = 10_000;

export interface BinanceMetrics {
  symbol: string;
  markPrice: number;
  lastFundingRate: number;
  annualizedFundingPct: number;
  openInterest: number;
  takerBuySellRatio: number;
  longShortAccountRatio: number;
  fetchedAtIso: string;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchBinanceMetrics(symbol: string): Promise<BinanceMetrics> {
  const [prem, oi, taker, ls] = await Promise.all([
    fetchJson<{ markPrice: string; lastFundingRate: string }>(`${BASE_URL}/fapi/v1/premiumIndex?symbol=${symbol}`),
    fetchJson<{ openInterest: string }>(`${BASE_URL}/fapi/v1/openInterest?symbol=${symbol}`),
    fetchJson<Array<{ buySellRatio: string }>>(`${BASE_URL}/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=1`),
    fetchJson<Array<{ longShortRatio: string }>>(`${BASE_URL}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`),
  ]);

  const markPrice = Number(prem?.markPrice ?? 0);
  const lastFundingRate = Number(prem?.lastFundingRate ?? 0);
  const annualizedFundingPct = Math.round(lastFundingRate * 3 * 365 * 10_000) / 100;
  const openInterest = Number(oi?.openInterest ?? 0);
  const takerBuySellRatio = Number(taker?.[0]?.buySellRatio ?? 1);
  const longShortAccountRatio = Number(ls?.[0]?.longShortRatio ?? 1);

  return {
    symbol,
    markPrice,
    lastFundingRate,
    annualizedFundingPct,
    openInterest,
    takerBuySellRatio,
    longShortAccountRatio,
    fetchedAtIso: new Date().toISOString(),
  };
}
