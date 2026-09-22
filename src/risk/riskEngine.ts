import type { PerformanceSnapshot } from './performanceEngine.js';
import type { SizingResult } from './positionSizer.js';
import { circuitRiskMultiplier, clusterOf, deriveCircuitState, type CircuitState, type RiskLimits } from './riskConfig.js';

export interface PortfolioView {
  equity: number;
  openPositions: number;
  grossExposure: number;
  symbolExposure: (symbol: string) => number;
  clusterExposure: (cluster: string) => number;
  performance: PerformanceSnapshot;
}

export interface RiskInput {
  symbol: string;
  sizing: SizingResult;
  portfolio: PortfolioView;
  limits: RiskLimits;
  rr?: number;
}

export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RiskDecision {
  approved: boolean;
  circuit: CircuitState;
  checks: RiskCheck[];
  reasons: string[];
}

// Same slack the sizer allows: lot flooring and fee rounding can leave the risk a sliver above the budget
const RISK_BUDGET_TOLERANCE = 1.02;
const EXPOSURE_PERCENT_DECIMALS = 3;

const check = (name: string, passed: boolean, detail: string): RiskCheck => ({ name, passed, detail });

function sizingChecks(input: RiskInput, circuit: CircuitState): RiskCheck[] {
  const { sizing, portfolio, limits } = input;
  const riskBudget = (portfolio.equity * limits.maxRiskPerTradePercent) / 100 * circuitRiskMultiplier(circuit);
  return [
    check('sizing', sizing.ok, sizing.ok
      ? `qty ${sizing.quantity} risk ${sizing.riskAmount.toFixed(2)}`
      : (sizing.rejection ?? 'sizing failed')),
    check('risk_per_trade', sizing.ok && sizing.riskAmount <= riskBudget * RISK_BUDGET_TOLERANCE,
      `risk ${sizing.ok ? sizing.riskAmount.toFixed(2) : 'n/a'} vs budget ${riskBudget.toFixed(2)}`),
    check('leverage', sizing.ok && sizing.leverage <= limits.maxLeverage,
      `leverage ${sizing.leverage} (max ${limits.maxLeverage})`),
  ];
}

function portfolioChecks(input: RiskInput): RiskCheck[] {
  const { portfolio, limits } = input;
  const { dailyLossPercent, lossStreak } = portfolio.performance;
  return [
    check('position_count', portfolio.openPositions + 1 <= limits.maxConcurrentPositions,
      `${portfolio.openPositions + 1} of max ${limits.maxConcurrentPositions}`),
    check('daily_loss', dailyLossPercent < limits.maxDailyLossPercent,
      `daily loss ${dailyLossPercent.toFixed(2)}% of ${limits.maxDailyLossPercent}%`),
    check('loss_streak', lossStreak < limits.maxLossStreak,
      `streak ${lossStreak} of max ${limits.maxLossStreak}`),
  ];
}

function exposureBreaches(input: RiskInput): string[] {
  const { symbol, sizing, portfolio, limits } = input;
  const equity = Math.max(1, portfolio.equity);
  const percentOf = (value: number): number => Number(((value / equity) * 100).toFixed(EXPOSURE_PERCENT_DECIMALS));
  const cluster = clusterOf(symbol);
  const symbolPercent = percentOf(portfolio.symbolExposure(symbol) + sizing.notional);
  const grossPercent = percentOf(portfolio.grossExposure + sizing.notional);
  const clusterPercent = percentOf(portfolio.clusterExposure(cluster) + sizing.notional);
  const breaches: string[] = [];
  if (symbolPercent > limits.maxSymbolExposurePercent) {
    breaches.push(`symbol ${symbolPercent}% (max ${limits.maxSymbolExposurePercent}%)`);
  }
  if (grossPercent > limits.maxPortfolioGrossExposurePercent) {
    breaches.push(`gross ${grossPercent}% (max ${limits.maxPortfolioGrossExposurePercent}%)`);
  }
  if (clusterPercent > limits.maxCorrelatedExposurePercent) {
    breaches.push(`cluster ${cluster} ${clusterPercent}% (max ${limits.maxCorrelatedExposurePercent}%)`);
  }
  if (sizing.notional > limits.maxNotionalPerTrade) {
    breaches.push(`notional ${sizing.notional.toFixed(2)} (max ${limits.maxNotionalPerTrade})`);
  }
  return breaches;
}

function portfolioLimitsCheck(input: RiskInput): RiskCheck {
  const breaches = exposureBreaches(input);
  return check('portfolio_limits', breaches.length === 0,
    breaches.length === 0 ? 'symbol, gross, cluster and notional caps respected' : breaches.join('; '));
}

function minRewardRiskCheck(input: RiskInput): RiskCheck {
  const { rr, limits } = input;
  const min = limits.minRiskRewardRatio;
  if (rr === undefined) return check('min_rr', false, `rr unavailable (min ${min})`);
  return check('min_rr', rr >= min, `rr ${rr.toFixed(2)} (min ${min})`);
}

function runChecks(input: RiskInput, circuit: CircuitState): RiskCheck[] {
  const checks = [...sizingChecks(input, circuit), ...portfolioChecks(input), portfolioLimitsCheck(input)];
  if (input.limits.minRiskRewardRatio > 0) checks.push(minRewardRiskCheck(input));
  return checks;
}

function haltedDecision(circuit: CircuitState): RiskDecision {
  const halted = check('circuit_breaker', false, `circuit state ${circuit}`);
  return { approved: false, circuit, checks: [halted], reasons: [`${halted.name}: ${halted.detail}`] };
}

/** The final authority: a trade is approved only when the circuit allows entries and every check passes. */
export function evaluateRisk(input: RiskInput): RiskDecision {
  const { dailyLossPercent, drawdownPercent, lossStreak } = input.portfolio.performance;
  const circuit = deriveCircuitState(dailyLossPercent, drawdownPercent, lossStreak, input.limits);
  if (circuit === 'HALTED' || circuit === 'EMERGENCY') return haltedDecision(circuit);

  const checks = runChecks(input, circuit);
  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    return { approved: false, circuit, checks, reasons: failed.map((c) => `${c.name}: ${c.detail}`) };
  }
  return { approved: true, circuit, checks, reasons: [`all ${checks.length} checks passed`, `circuit ${circuit}`] };
}
