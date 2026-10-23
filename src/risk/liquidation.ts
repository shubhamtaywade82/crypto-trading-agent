import type { Side } from '../types.js';

/**
 * One row of the venue's leverage brackets (GET /fapi/v1/leverageBracket). Maintenance margin on a position is
 * `notional × maintMarginRatio − cumMaintenance`, and the tier is chosen by notional.
 */
export interface MaintenanceTier {
  readonly notionalFloor: number;
  readonly notionalCap: number;
  readonly maintMarginRatio: number;
  readonly cumMaintenance: number;
  readonly maxLeverage: number;
}

/**
 * Stand-in brackets for replay, where the venue's tiers are not captured: one flat 1% maintenance tier. That is above
 * the venue's entry tiers, so replayed liquidation prices sit closer to entry than live ones and replay errs toward
 * refusing. Live never uses this; it reads the venue's brackets.
 */
export const REPLAY_MAINTENANCE_TIERS: readonly MaintenanceTier[] = [
  { notionalFloor: 0, notionalCap: Infinity, maintMarginRatio: 0.01, cumMaintenance: 0, maxLeverage: 125 },
];

/** The bracket a notional falls into: the last tier whose floor it reaches, or null when there are no tiers. */
export function tierForNotional(tiers: readonly MaintenanceTier[], notional: number): MaintenanceTier | null {
  let chosen: MaintenanceTier | null = null;
  for (const tier of tiers) if (notional >= tier.notionalFloor) chosen = tier;
  return chosen;
}

export interface LiquidationInput {
  readonly side: Side;
  readonly entry: number;
  readonly qty: number;
  readonly leverage: number;
  readonly tiers: readonly MaintenanceTier[];
}

// Solves the isolated-margin equity condition for the price: equity = maintenance margin at that price.
// Long:  M + q(P − E) = q·P·mmr − cum  with M = q·E/L  ⇒  P = (E(1 − 1/L) − cum/q) / (1 − mmr)
// Short: M + q(E − P) = q·P·mmr − cum                  ⇒  P = (E(1 + 1/L) + cum/q) / (1 + mmr)
function solve(side: Side, entry: number, qty: number, leverage: number, tier: MaintenanceTier): number {
  const mmr = tier.maintMarginRatio;
  return side === 'LONG'
    ? (entry * (1 - 1 / leverage) - tier.cumMaintenance / qty) / (1 - mmr)
    : (entry * (1 + 1 / leverage) + tier.cumMaintenance / qty) / (1 + mmr);
}

/**
 * Liquidation price of an isolated position. The tier is re-picked at the liquidation notional and the higher
 * maintenance rate wins, so the price never assumes a cheaper tier than the position would reach. Returns 0 for a
 * long whose equity cannot be exhausted above zero (liquidation then sits below any price), and null when the inputs
 * cannot produce a price (no tiers, bad numbers).
 */
export function isolatedLiquidationPrice(input: LiquidationInput): number | null {
  const { side, entry, qty, leverage, tiers } = input;
  if (!(entry > 0 && qty > 0 && leverage >= 1) || tiers.length === 0) return null;
  let tier = tierForNotional(tiers, entry * qty);
  if (!tier) return null;
  let price = solve(side, entry, qty, leverage, tier);
  for (let step = 0; step < 5; step++) {
    const atLiquidation = tierForNotional(tiers, Math.max(0, price) * qty);
    if (!atLiquidation || atLiquidation.maintMarginRatio <= tier.maintMarginRatio) break;
    tier = atLiquidation;
    price = solve(side, entry, qty, leverage, tier);
  }
  if (!Number.isFinite(price)) return null;
  return Math.max(0, price);
}

/** True when the stop sits beyond the liquidation price by at least `clearance` price units, so the stop executes first. */
export function stopClearsLiquidation(side: Side, stop: number, liquidation: number, clearance: number): boolean {
  return side === 'LONG' ? stop - liquidation >= clearance : liquidation - stop >= clearance;
}

export interface SafeLeverageInput {
  readonly side: Side;
  readonly entry: number;
  readonly stop: number;
  readonly qty: number;
  /** ATR in price units; the stop must clear liquidation by `clearanceAtr` of it. */
  readonly atr: number;
  readonly clearanceAtr: number;
  readonly requestedLeverage: number;
  readonly minLeverage: number;
  readonly maxLeverage: number;
  readonly tiers: readonly MaintenanceTier[];
}

export interface SafeLeverage {
  readonly leverage: number;
  readonly liquidationPrice: number;
}

/**
 * The highest whole leverage, no greater than the request, at which the stop clears liquidation by the ATR buffer.
 * Leverage is the only lever that moves the liquidation price (quantity is set by the risk budget), so this searches
 * downward from the request. Null when even the minimum leverage leaves liquidation inside the stop.
 */
export function safestLeverage(input: SafeLeverageInput): SafeLeverage | null {
  const { side, entry, stop, qty, atr, clearanceAtr, tiers } = input;
  if (!(atr > 0) || !(qty > 0)) return null;
  const tier = tierForNotional(tiers, entry * qty);
  if (!tier) return null;
  const clearance = clearanceAtr * atr;
  const top = Math.floor(Math.min(input.requestedLeverage, input.maxLeverage, tier.maxLeverage));
  for (let leverage = top; leverage >= Math.max(1, input.minLeverage); leverage--) {
    const liquidationPrice = isolatedLiquidationPrice({ side, entry, qty, leverage, tiers });
    if (liquidationPrice !== null && stopClearsLiquidation(side, stop, liquidationPrice, clearance)) {
      return { leverage, liquidationPrice };
    }
  }
  return null;
}
