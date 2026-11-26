import { z } from 'zod';

/** A decimal string from Binance as a finite, strictly positive number; anything else is null. */
export function parsePositive(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// REST: GET /api/v3/exchangeInfo (Spot, data-api.binance.vision)
export const SpotExchangeInfoRest = z.object({
  symbols: z.array(z.object({ symbol: z.string(), status: z.string() })),
});

// REST: GET /api/v3/ticker/bookTicker?symbol= (Spot)
export const BookTickerRest = z.object({
  symbol: z.string(),
  bidPrice: z.string(),
  askPrice: z.string(),
});

// REST: GET /fapi/v1/fundingRate?symbol=&limit= (USDⓈ-M)
export const FundingRateRest = z.array(z.object({
  symbol: z.string(),
  fundingRate: z.string(),
  fundingTime: z.number(),
}));

// WebSocket combined-stream envelope: { stream: "btcusdt@bookTicker", data: {...} }
export const CombinedFrame = z.object({ stream: z.string(), data: z.unknown() });

// Book ticker payloads, Spot and USDⓈ-M both: { s, b, a } (USDⓈ-M adds e/T/E, which are not needed)
export const BookTickerFrame = z.object({ s: z.string(), b: z.string(), a: z.string() });

// Trade payload: { e: "trade", s, p, T }
export const TradeFrame = z.object({ s: z.string(), p: z.string(), T: z.number() });

/** A decimal string as a finite number, negative values included (funding rates go negative). Anything else is null. */
export function parseFinite(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
