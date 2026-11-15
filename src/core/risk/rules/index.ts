import { dailyLossPct, drawdownPct, grossNotional } from '../../domain/portfolio.js';
import type { RiskContext, RiskFinding, RiskRule, TradeProposal } from '../../domain/risk.js';

const block = (ruleId: string, code: string, message: string): RiskFinding => ({ ruleId, severity: 'block', code, message });
const warn = (ruleId: string, code: string, message: string): RiskFinding => ({ ruleId, severity: 'warning', code, message });

const rule = (id: string, evaluate: (proposal: TradeProposal, context: RiskContext) => RiskFinding | null): RiskRule => Object.freeze({ id, evaluate });

// Lot flooring leaves a sliver of slack; beyond it a trade is genuinely over budget
const BUDGET_TOLERANCE = 1.02;

export const TradingHaltRule = rule('trading-halt', (_p, ctx) =>
  ctx.haltReason ? block('trading-halt', 'TRADING_HALTED', ctx.haltReason) : null);

export const MarketDataFreshnessRule = rule('market-data-freshness', (_p, { market, limits }) => {
  if (!Number.isFinite(market.markPrice) || market.markPrice <= 0) return block('market-data-freshness', 'MARK_INVALID', `mark price ${market.markPrice} is not usable`);
  // Positive: the mark predates the bar close. Negative: it was read after it, which is normal in real time (the bar
  // is read a moment after it closes) but not when an old bar is being decided against a current mark.
  const age = market.asOf - market.markAt;
  if (!Number.isFinite(age)) return block('market-data-freshness', 'MARK_UNDATED', 'the mark carries no usable timestamp');
  if (age > limits.maxMarkAgeMs) return block('market-data-freshness', 'MARK_STALE', `mark is ${age} ms older than the bar close; the limit is ${limits.maxMarkAgeMs} ms`);
  if (-age > limits.maxMarkAgeMs) return block('market-data-freshness', 'BAR_STALE', `the bar closed ${-age} ms before the mark was read; the limit is ${limits.maxMarkAgeMs} ms`);
  return null;
});

export const SymbolAllowlistRule = rule('symbol-allowlist', (p, { limits }) =>
  limits.allowedSymbols.includes(p.symbol) ? null : block('symbol-allowlist', 'SYMBOL_NOT_ALLOWED', `${p.symbol} is not in the allowlist`));

export const DuplicateDecisionRule = rule('duplicate-decision', (p, ctx) =>
  ctx.executedDecisionIds.has(p.decisionId) ? block('duplicate-decision', 'DUPLICATE_DECISION', `decision ${p.decisionId} already produced an order`) : null);

export const ExistingPositionRule = rule('existing-position', (p, { portfolio }) =>
  portfolio.positions.some((position) => position.symbol === p.symbol) ? block('existing-position', 'POSITION_OPEN', `a ${p.symbol} position is already open`) : null);

export const MaxPositionCountRule = rule('max-position-count', (_p, { portfolio, limits }) =>
  portfolio.positions.length >= limits.maxConcurrentPositions
    ? block('max-position-count', 'TOO_MANY_POSITIONS', `${portfolio.positions.length} positions open; the limit is ${limits.maxConcurrentPositions}`)
    : null);

export const StopLossValidityRule = rule('stop-loss-validity', (p, { market }) => {
  const id = 'stop-loss-validity';
  if (![p.entry, p.stopLoss, p.takeProfit, p.quantity].every((v) => Number.isFinite(v) && v > 0)) return block(id, 'NON_FINITE', 'entry, stop, target and quantity must be positive finite numbers');
  const long = p.direction === 'LONG';
  if (long ? p.stopLoss >= p.entry : p.stopLoss <= p.entry) return block(id, 'STOP_WRONG_SIDE', `${p.direction} stop ${p.stopLoss} is not beyond entry ${p.entry}`);
  if (long ? p.takeProfit <= p.entry : p.takeProfit >= p.entry) return block(id, 'TARGET_WRONG_SIDE', `${p.direction} target ${p.takeProfit} is not beyond entry ${p.entry}`);
  // A stop the mark has already crossed would trigger the moment it is attached
  if (long ? market.markPrice <= p.stopLoss : market.markPrice >= p.stopLoss) return block(id, 'STOP_ALREADY_BREACHED', `mark ${market.markPrice} is already through the stop ${p.stopLoss}`);
  return null;
});

export const MinRewardRiskRule = rule('min-reward-risk', (p, { limits }) => {
  const costs = p.entry * limits.costRatePerLeg * 2;
  const reward = Math.abs(p.takeProfit - p.entry) - costs;
  const risk = Math.abs(p.entry - p.stopLoss) + costs;
  const ratio = reward / risk;
  return ratio >= limits.minRewardRisk ? null : block('min-reward-risk', 'REWARD_RISK_TOO_LOW', `net reward:risk ${ratio.toFixed(2)} is below ${limits.minRewardRisk}`);
});

export const MaxLeverageRule = rule('max-leverage', (p, { limits }) =>
  Number.isInteger(p.leverage) && p.leverage >= 1 && p.leverage <= limits.maxLeverage
    ? null
    : block('max-leverage', 'LEVERAGE_OUT_OF_RANGE', `leverage ${p.leverage} is outside 1..${limits.maxLeverage}`));

export const MinNotionalRule = rule('min-notional', (p, { limits }) =>
  p.notional >= limits.minNotional ? null : block('min-notional', 'BELOW_MIN_NOTIONAL', `notional ${p.notional.toFixed(2)} is below ${limits.minNotional}`));

export const RiskBudgetRule = rule('risk-budget', (p, { portfolio, limits }) => {
  const budget = portfolio.equity * (limits.riskPerTradePct / 100);
  return p.riskAmount <= budget * BUDGET_TOLERANCE
    ? null
    : block('risk-budget', 'OVER_RISK_BUDGET', `loss at stop ${p.riskAmount.toFixed(2)} exceeds the ${limits.riskPerTradePct}% budget ${budget.toFixed(2)}`);
});

export const MarginRule = rule('margin', (p, { portfolio }) => {
  const required = p.notional / p.leverage;
  return required <= portfolio.availableMargin
    ? null
    : block('margin', 'INSUFFICIENT_MARGIN', `margin ${required.toFixed(2)} exceeds the available ${portfolio.availableMargin.toFixed(2)}`);
});

export const MaxGrossExposureRule = rule('max-gross-exposure', (p, { portfolio, limits }) => {
  const exposure = portfolio.equity > 0 ? ((grossNotional(portfolio) + p.notional) / portfolio.equity) * 100 : Infinity;
  return exposure <= limits.maxGrossExposurePct
    ? null
    : block('max-gross-exposure', 'OVER_GROSS_EXPOSURE', `gross exposure would be ${exposure.toFixed(1)}% of equity; the limit is ${limits.maxGrossExposurePct}%`);
});

export const DailyLossLimitRule = rule('daily-loss-limit', (_p, { portfolio, limits }) => {
  const loss = dailyLossPct(portfolio);
  return loss >= limits.maxDailyLossPct ? block('daily-loss-limit', 'DAILY_LOSS_LIMIT', `today's loss ${loss.toFixed(2)}% reached the ${limits.maxDailyLossPct}% limit`) : null;
});

export const PortfolioDrawdownRule = rule('portfolio-drawdown', (_p, { portfolio, limits }) => {
  const drawdown = drawdownPct(portfolio);
  return drawdown >= limits.maxDrawdownPct ? block('portfolio-drawdown', 'DRAWDOWN_LIMIT', `drawdown ${drawdown.toFixed(2)}% reached the ${limits.maxDrawdownPct}% limit`) : null;
});

export const LossStreakRule = rule('loss-streak', (_p, { portfolio, limits }) =>
  portfolio.lossStreak >= limits.maxLossStreak ? block('loss-streak', 'LOSS_STREAK_LIMIT', `${portfolio.lossStreak} consecutive losses; the limit is ${limits.maxLossStreak}`) : null);

export const UnprotectedPositionRule = rule('unprotected-position', (_p, { portfolio }) => {
  const bare = portfolio.positions.filter((position) => position.stopLoss === null).map((position) => position.symbol);
  return bare.length > 0 ? warn('unprotected-position', 'POSITION_WITHOUT_STOP', `the venue reports no stop for: ${bare.join(', ')}`) : null;
});

/** The standing order. Halt and data checks first so their findings lead the report; the order does not change the verdict. */
export function defaultRiskRules(): RiskRule[] {
  return [
    TradingHaltRule, MarketDataFreshnessRule, SymbolAllowlistRule, DuplicateDecisionRule, ExistingPositionRule,
    MaxPositionCountRule, StopLossValidityRule, MinRewardRiskRule, MaxLeverageRule, MinNotionalRule, RiskBudgetRule,
    MarginRule, MaxGrossExposureRule, DailyLossLimitRule, PortfolioDrawdownRule, LossStreakRule, UnprotectedPositionRule,
  ];
}
