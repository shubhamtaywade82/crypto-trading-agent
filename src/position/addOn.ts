import type { RiskDecision } from '../types.js';
import { dec } from '../risk/primitives.js';
import type { PmState } from './PositionManager.js';

/**
 * Add-on rules for a managed position. An add is a same-strategy, same-side entry into an open position. It is allowed
 * only after TP1 has been taken, and the position held may grow to at most ADD_CAP_MULTIPLE times the entry size. The add
 * is sized by the risk gate against the stop that protects the position (see the Orchestrator), so each add risks the
 * same budget as the entry does.
 */
export const ADD_CAP_MULTIPLE = 2;

export type AddRoom = { readonly ok: true; readonly maxQty: number } | { readonly ok: false; readonly reason: string };

/** How much may be added to a managed position right now. Pure. */
export function addRoomOf(state: PmState | undefined, heldQty: number, multiple = ADD_CAP_MULTIPLE): AddRoom {
  if (!state) return { ok: false, reason: 'position is not managed (no manager state)' };
  if (!state.tp1Done) return { ok: false, reason: 'TP1 not yet taken' };
  const entryQty = state.entryQty ?? state.initialQty;
  const maxQty = dec(entryQty).times(multiple).minus(heldQty).toNumber();
  if (!(maxQty > 0)) return { ok: false, reason: `held ${heldQty} is at the ${multiple}x entry cap` };
  return { ok: true, maxQty };
}

/** The stop that will protect the position must sit on the protective side of the price the add fills at. Pure. */
export function addLevelsOk(side: 'LONG' | 'SHORT', stop: number, price: number): boolean {
  if (!Number.isFinite(stop) || !Number.isFinite(price) || price <= 0) return false;
  return side === 'LONG' ? stop > 0 && stop < price : stop > price;
}

/** Caps an approved add's notional so the position never exceeds the room. A zero room refuses the add. Pure. */
export function capAddSize(decision: RiskDecision, maxQty: number, price: number): RiskDecision {
  if (!decision.approved) return decision;
  const cap = maxQty * price;
  if (!(cap > 0)) return { ...decision, approved: false, reason: 'add-on cap reached' };
  return decision.positionSizeUsdt <= cap ? decision : { ...decision, positionSizeUsdt: cap };
}
