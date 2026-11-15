import type { MarketSnapshot } from './market.js';
import type { PortfolioSnapshot } from './portfolio.js';
import type { Direction, StrategySignal } from './strategy.js';

/** A sized trade waiting for the risk verdict. Built by the decision builder and the sizer, never by a strategy. */
export interface TradeProposal {
  /** Deterministic over (symbol, bar, strategy, direction): the same bar can never yield two different decisions. */
  readonly decisionId: string;
  readonly signal: StrategySignal;
  /** Other strategies that agreed on the direction. */
  readonly supportingStrategies: readonly string[];
  readonly symbol: string;
  readonly direction: Direction;
  readonly entry: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly quantity: number;
  readonly leverage: number;
  readonly notional: number;
  /** Loss at the stop including round-trip costs, in quote currency. */
  readonly riskAmount: number;
}

export interface RiskLimits {
  readonly allowedSymbols: readonly string[];
  readonly riskPerTradePct: number;
  readonly maxLeverage: number;
  readonly maxConcurrentPositions: number;
  /** Gross notional of all positions plus the proposal, as a % of equity. */
  readonly maxGrossExposurePct: number;
  readonly maxDailyLossPct: number;
  readonly maxDrawdownPct: number;
  readonly maxLossStreak: number;
  readonly minRewardRisk: number;
  /** A mark older than this relative to the event is stale. */
  readonly maxMarkAgeMs: number;
  /** Taker fee plus slippage allowance per leg, as a fraction of notional. */
  readonly costRatePerLeg: number;
  readonly minNotional: number;
  readonly quantityStep: number;
}

export interface RiskContext {
  readonly market: MarketSnapshot;
  readonly portfolio: PortfolioSnapshot;
  readonly limits: RiskLimits;
  /** decisionIds that already produced an order command. */
  readonly executedDecisionIds: ReadonlySet<string>;
  /** Null while trading is allowed; otherwise why the kill switch or circuit breaker refuses entries. */
  readonly haltReason: string | null;
  /** Open venue positions this process does not own. Any entry is refused while this is non-empty. */
  readonly foreignPositionSymbols: readonly string[];
}

export interface RiskFinding {
  readonly ruleId: string;
  readonly severity: 'block' | 'warning';
  readonly code: string;
  readonly message: string;
}

export interface RiskRule {
  readonly id: string;
  /** Pure and synchronous: every input a rule may use is in the proposal and the context. */
  evaluate(proposal: TradeProposal, context: RiskContext): RiskFinding | null;
}

export interface RiskDecision {
  readonly decisionId: string;
  readonly approved: boolean;
  readonly findings: readonly RiskFinding[];
  readonly evaluatedRules: readonly string[];
  readonly decidedAt: number;
}

const approvals = new WeakSet<object>();

/**
 * Proof that the risk pipeline approved exactly this proposal. Only `approve` creates one, and only the pipeline calls
 * it, so an order command cannot be built from a proposal the pipeline did not pass.
 */
export interface ApprovedTrade {
  readonly proposal: TradeProposal;
  readonly decision: RiskDecision;
}

/** @internal Called by RiskPipeline only. */
export function approve(proposal: TradeProposal, decision: RiskDecision): ApprovedTrade {
  if (!decision.approved || decision.decisionId !== proposal.decisionId) throw new Error('approve() needs an approving decision for the same proposal');
  const token = Object.freeze({ proposal: Object.freeze({ ...proposal }), decision });
  approvals.add(token);
  return token;
}

export const isApprovedTrade = (value: unknown): value is ApprovedTrade =>
  typeof value === 'object' && value !== null && approvals.has(value);
