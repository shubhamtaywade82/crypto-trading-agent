import type { OptionContract, OptionRight } from './types.js';

const SYMBOL = /^([A-Z0-9]+)-(\d{2})(\d{2})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/;
/** Binance Options expiry time of day. */
export const EXPIRY_HOUR_UTC = 8;

export interface ParsedOptionSymbol {
  base: string;
  underlying: string;
  strike: number;
  right: OptionRight;
  /** UTC calendar date of expiry, YYYY-MM-DD. */
  expiryDate: string;
  expiryMs: number;
}

/** Null for anything that is not a well-formed option symbol, including an impossible calendar date. */
export function parseOptionSymbol(symbol: string): ParsedOptionSymbol | null {
  const match = SYMBOL.exec(symbol.trim().toUpperCase());
  if (!match) return null;
  const [, base, yy, mm, dd, strikeRaw, rightRaw] = match;
  const year = 2000 + Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  const expiryMs = Date.UTC(year, month - 1, day, EXPIRY_HOUR_UTC);
  const check = new Date(expiryMs);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const strike = Number(strikeRaw);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    base,
    underlying: `${base}USDT`,
    strike,
    right: rightRaw === 'C' ? 'CE' : 'PE',
    expiryDate: `${year}-${mm}-${dd}`,
    expiryMs,
  };
}

/** The raw exchangeInfo row this module reads. The SDK schema is loose, so `unit` and the filters arrive untyped. */
export interface RawOptionSymbol {
  symbol: string;
  underlying: string;
  strikePrice: number;
  expiryDate: number;
  unit?: unknown;
  contractSize?: unknown;
  status?: unknown;
  filters?: ReadonlyArray<{ filterType: string } & Record<string, unknown>>;
}

export type ContractParse = { ok: true; contract: OptionContract } | { ok: false; symbol: string; reason: string };

const positive = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Builds a contract from one exchangeInfo row, refusing anything it cannot fully verify: a symbol whose strike,
 * expiry date or underlying disagree with the row, a missing contract unit, or missing lot/tick filters. A refused
 * row is reported, never patched with a default, because sizing and fees are computed from these fields.
 */
export function contractFromExchangeInfo(raw: RawOptionSymbol): ContractParse {
  const fail = (reason: string): ContractParse => ({ ok: false, symbol: raw.symbol, reason });
  const parsed = parseOptionSymbol(raw.symbol);
  if (!parsed) return fail('malformed symbol');
  if (raw.underlying !== parsed.underlying) return fail(`underlying ${raw.underlying} does not match symbol (${parsed.underlying})`);
  if (Math.abs(raw.strikePrice - parsed.strike) > 1e-9 * parsed.strike) return fail(`strike ${raw.strikePrice} does not match symbol (${parsed.strike})`);
  const venueDate = new Date(raw.expiryDate).toISOString().slice(0, 10);
  if (venueDate !== parsed.expiryDate) return fail(`expiry ${venueDate} does not match symbol (${parsed.expiryDate})`);
  if (typeof raw.status === 'string' && raw.status !== 'TRADING') return fail(`status ${raw.status}`);

  const unit = positive(raw.unit) ?? positive(raw.contractSize);
  if (unit === null) return fail('no contract unit');
  const lot = raw.filters?.find((f) => f.filterType === 'LOT_SIZE');
  const price = raw.filters?.find((f) => f.filterType === 'PRICE_FILTER');
  const minQty = positive(lot?.minQty);
  const qtyStep = positive(lot?.stepSize);
  const tickSize = positive(price?.tickSize);
  if (minQty === null || qtyStep === null) return fail('no LOT_SIZE filter');
  if (tickSize === null) return fail('no PRICE_FILTER tick size');

  return {
    ok: true,
    contract: {
      symbol: raw.symbol,
      underlying: parsed.underlying,
      right: parsed.right,
      strike: parsed.strike,
      expiryMs: raw.expiryDate,
      unit,
      minQty,
      qtyStep,
      tickSize,
    },
  };
}

/** Floors `qty` to the lot step without binary-float drift (0.3 / 0.1 must give 3 steps, not 2). */
export function floorToStep(qty: number, step: number): number {
  if (!(qty > 0) || !(step > 0)) return 0;
  const steps = Math.floor(qty / step + 1e-9);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  return Number((steps * step).toFixed(Math.min(decimals, 12)));
}

export const hoursBetween = (fromMs: number, toMs: number): number => (toMs - fromMs) / 3_600_000;
