import type { PortfolioSnapshot } from '../../domain/portfolio.js';
import type { RiskLimits, TradeProposal } from '../../domain/risk.js';
import type { DecisionDraft } from '../decisions/DecisionBuilder.js';

export type SizingOutcome =
  | { readonly ok: true; readonly proposal: TradeProposal }
  | { readonly ok: false; readonly reason: string };

/** Floors to the step without the float drift of a plain division (0.3 / 0.1 = 2.999…). */
export function floorToStep(value: number, step: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number((Math.floor(value / step + 1e-9) * step).toFixed(decimals));
}

/**
 * Risk-based sizing: the quantity whose loss at the stop, round-trip costs included, equals the per-trade budget.
 * It then shrinks to what the available margin supports at the leverage cap. It can only size down, never up.
 */
export function sizeProposal(draft: DecisionDraft, portfolio: PortfolioSnapshot, limits: RiskLimits): SizingOutcome {
  const { signal } = draft;
  const stopDistance = Math.abs(signal.entry - signal.stopLoss);
  if (!(stopDistance > 0)) return { ok: false, reason: 'stop distance is zero' };
  if (!(portfolio.equity > 0) || !(portfolio.availableMargin > 0)) return { ok: false, reason: 'no equity or available margin' };

  const riskPerUnit = stopDistance + signal.entry * limits.costRatePerLeg * 2;
  const budget = portfolio.equity * (limits.riskPerTradePct / 100);
  const byRisk = budget / riskPerUnit;
  const byMargin = (portfolio.availableMargin * limits.maxLeverage) / signal.entry;
  const quantity = floorToStep(Math.min(byRisk, byMargin), limits.quantityStep);
  const notional = quantity * signal.entry;
  if (!(quantity > 0) || notional < limits.minNotional) {
    return { ok: false, reason: `sized quantity ${quantity} (notional ${notional.toFixed(2)}) is below the minimum notional ${limits.minNotional}` };
  }
  // The lowest whole leverage whose margin fits, so the liquidation price stays as far away as the account allows
  const leverage = Math.min(limits.maxLeverage, Math.max(1, Math.ceil(notional / portfolio.availableMargin)));
  return {
    ok: true,
    proposal: {
      decisionId: draft.decisionId,
      signal,
      supportingStrategies: draft.supportingStrategies,
      symbol: signal.symbol,
      direction: signal.direction,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      quantity,
      leverage,
      notional,
      riskAmount: quantity * riskPerUnit,
    },
  };
}
