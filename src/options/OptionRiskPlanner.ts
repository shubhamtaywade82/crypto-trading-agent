import { floorToStep } from './contract.js';
import { optionFee, walkBook, type FeeModel } from './execution.js';
import type { OptionContract, OptionQuote } from './types.js';

export interface RiskLimits {
  riskPerTradePct: number;
  maxPremiumPct: number;
  maxTotalPremiumPct: number;
  maxOpenPositions: number;
  maxDailyLossPct: number;
  maxLossStreak: number;
  maxSlippagePct: number;
}

export interface OpenExposure {
  /** Premium paid on every open option position, at entry. */
  premiumAtRisk: number;
  openPositions: number;
}

export interface EntryPlan {
  qty: number;
  /** Book VWAP for `qty` within the slippage limit. */
  expectedFill: number;
  limitPrice: number;
  stopPremium: number;
  targetPremium: number;
  /** Loss if the stop fills at its price: qty x (fill - stop) + round-trip fees. */
  plannedLoss: number;
  /** Loss if the option goes to zero (a gap through the stop): the whole premium plus the entry fee. */
  worstCaseLoss: number;
  binding: 'risk' | 'premium' | 'portfolio' | 'book';
}

export type PlanResult = { ok: true; plan: EntryPlan } | { ok: false; reason: string };

/**
 * Sizes a long option. Three ceilings, smallest wins:
 *  - risk:      equity x riskPerTradePct / (fill - stop + fees per contract)
 *  - premium:   equity x maxPremiumPct / (fill + fee)  -- the most a long option can lose is its premium
 *  - portfolio: (equity x maxTotalPremiumPct - premium already at risk) / (fill + fee)
 * then whatever the book can fill inside the slippage limit, floored to the lot step.
 */
export function planEntry(params: {
  equity: number;
  exposure: OpenExposure;
  contract: OptionContract;
  quote: OptionQuote;
  indexPrice: number;
  stopPct: number;
  targetPct: number;
  limits: RiskLimits;
  fees: FeeModel;
}): PlanResult {
  const { equity, exposure, contract, quote, indexPrice, stopPct, targetPct, limits, fees } = params;
  if (!(equity > 0)) return { ok: false, reason: 'no equity' };
  if (exposure.openPositions >= limits.maxOpenPositions) return { ok: false, reason: `${exposure.openPositions} open positions (max ${limits.maxOpenPositions})` };
  const ask = quote.asks[0]?.[0];
  if (!(ask! > 0)) return { ok: false, reason: 'no ask' };

  const limitPrice = ask! * (1 + limits.maxSlippagePct / 100);
  // Price the sizing at the slippage limit: a fill can be no worse than that.
  const unitFee = optionFee(fees, limitPrice, 1, indexPrice, contract.unit);
  const stopPremium = limitPrice * (1 - stopPct / 100);
  const stopFee = optionFee(fees, stopPremium, 1, indexPrice, contract.unit);
  const riskPerContract = (limitPrice - stopPremium) + unitFee + stopFee;
  const costPerContract = limitPrice + unitFee;

  const byRisk = (equity * limits.riskPerTradePct / 100) / riskPerContract;
  const byPremium = (equity * limits.maxPremiumPct / 100) / costPerContract;
  const portfolioRoom = equity * limits.maxTotalPremiumPct / 100 - exposure.premiumAtRisk;
  if (portfolioRoom <= 0) return { ok: false, reason: `portfolio premium cap reached (${exposure.premiumAtRisk.toFixed(2)} at risk)` };
  const byPortfolio = portfolioRoom / costPerContract;

  const ceilings = [['risk', byRisk], ['premium', byPremium], ['portfolio', byPortfolio]] as const;
  let [binding, wanted] = ceilings.reduce((min, cur) => (cur[1] < min[1] ? cur : min));
  wanted = floorToStep(wanted, contract.qtyStep);
  if (wanted < contract.minQty) {
    return { ok: false, reason: `size ${wanted} below min qty ${contract.minQty} (bound by ${binding}; 1 lot risks ${(riskPerContract * contract.minQty).toFixed(2)} USDT)` };
  }

  const fill = walkBook(quote.asks, 'buy', wanted, limitPrice, contract);
  if (fill.qty <= 0) return { ok: false, reason: `book cannot fill ${contract.minQty} within ${limits.maxSlippagePct}% of the ask` };
  const qty = fill.qty;
  const resultBinding = fill.partial ? 'book' : binding;

  const entryFee = optionFee(fees, fill.avgPrice, qty, indexPrice, contract.unit);
  const stopAtFill = fill.avgPrice * (1 - stopPct / 100);
  const exitFee = optionFee(fees, stopAtFill, qty, indexPrice, contract.unit);
  return {
    ok: true,
    plan: {
      qty,
      expectedFill: fill.avgPrice,
      limitPrice,
      stopPremium: stopAtFill,
      targetPremium: fill.avgPrice * (1 + targetPct / 100),
      plannedLoss: qty * (fill.avgPrice - stopAtFill) + entryFee + exitFee,
      worstCaseLoss: qty * fill.avgPrice + entryFee,
      binding: resultBinding,
    },
  };
}

export interface ClosedTradeResult {
  pnl: number;
  closedAt: number;
}

export interface RiskBookState {
  day: string;
  dayStartEquity: number;
  realizedToday: number;
  lossStreak: number;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Daily-loss and loss-streak governor for option entries. Days roll on UTC midnight; the streak resets on a winner. */
export class OptionRiskBook {
  private state: RiskBookState;

  constructor(private readonly limits: Pick<RiskLimits, 'maxDailyLossPct' | 'maxLossStreak'>, initial: RiskBookState | null, equity: number, now: number) {
    this.state = initial && initial.day === utcDay(now)
      ? { ...initial }
      : { day: utcDay(now), dayStartEquity: equity, realizedToday: 0, lossStreak: initial?.lossStreak ?? 0 };
  }

  rollIfNewDay(equity: number, now: number): void {
    const day = utcDay(now);
    if (day !== this.state.day) this.state = { day, dayStartEquity: equity, realizedToday: 0, lossStreak: this.state.lossStreak };
  }

  record(trade: ClosedTradeResult): void {
    this.rollIfNewDay(this.state.dayStartEquity + this.state.realizedToday, trade.closedAt);
    this.state.realizedToday += trade.pnl;
    this.state.lossStreak = trade.pnl < 0 ? this.state.lossStreak + 1 : 0;
  }

  /** Why new entries are blocked, or null. */
  haltReason(): string | null {
    const lossLimit = this.state.dayStartEquity * this.limits.maxDailyLossPct / 100;
    if (-this.state.realizedToday >= lossLimit) return `daily loss ${(-this.state.realizedToday).toFixed(2)} >= ${lossLimit.toFixed(2)} USDT`;
    if (this.state.lossStreak >= this.limits.maxLossStreak) return `${this.state.lossStreak} losses in a row`;
    return null;
  }

  snapshot(): RiskBookState {
    return { ...this.state };
  }
}
