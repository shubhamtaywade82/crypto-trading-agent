import { floorToStep } from './contract.js';
import type { BookLevel, OptionContract } from './types.js';

export interface FeeModel {
  /** Rate on the underlying's notional (index x qty x unit). */
  rate: number;
  /** Cap as a fraction of the premium paid or received. */
  cap: number;
}

/** min(rate x index x qty x unit, cap x premium x qty): the Binance Options fee shape, and the one paper_exchange charges. */
export function optionFee(model: FeeModel, premium: number, qty: number, indexPrice: number, unit: number): number {
  if (!(qty > 0) || !(premium >= 0)) return 0;
  const cap = model.cap * premium * qty;
  if (!(indexPrice > 0)) return cap;
  return Math.min(model.rate * indexPrice * qty * unit, cap);
}

export interface BookFill {
  /** Lot-floored quantity the book can absorb within the price limit. */
  qty: number;
  /** Volume-weighted price of that quantity; 0 when nothing fills. */
  avgPrice: number;
  /** True when the book ran out (or hit the limit) before the requested quantity. */
  partial: boolean;
}

/**
 * Walks the opposite side of the book for `qty`, never past `limitPrice` (a buy takes asks up to it, a sell takes
 * bids down to it), and floors the result to the contract's lot step. This is the fill model of the in-process venue
 * and the execution price/size sent to paper_exchange, so both venues fill the same way.
 */
export function walkBook(levels: ReadonlyArray<BookLevel>, side: 'buy' | 'sell', qty: number, limitPrice: number, contract: Pick<OptionContract, 'qtyStep' | 'minQty'>): BookFill {
  let remaining = qty;
  let filled = 0;
  let cost = 0;
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    if (side === 'buy' ? price > limitPrice : price < limitPrice) break;
    const take = Math.min(size, remaining);
    filled += take;
    cost += take * price;
    remaining -= take;
  }
  const lots = floorToStep(filled, contract.qtyStep);
  if (lots < contract.minQty || lots <= 0) return { qty: 0, avgPrice: 0, partial: qty > 0 };
  // Re-price the floored quantity from the top so the average matches what was actually taken.
  let left = lots;
  let lotCost = 0;
  for (const [price, size] of levels) {
    if (left <= 0) break;
    const take = Math.min(size, left);
    lotCost += take * price;
    left -= take;
  }
  return { qty: lots, avgPrice: lotCost / lots, partial: lots + 1e-12 < qty };
}

export const bestBid = (levels: ReadonlyArray<BookLevel>): number | null => levels[0]?.[0] ?? null;
export const bestAsk = (levels: ReadonlyArray<BookLevel>): number | null => levels[0]?.[0] ?? null;
