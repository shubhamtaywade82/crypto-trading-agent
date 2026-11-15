import { TIMEFRAME_MS, type Timeframe } from '../domain/market.js';
import type { ReplayTrade } from '../ports/ReplaySessionPort.js';

export interface PerformanceReport {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  /** Null when there are no trades: a rate over nothing is not zero. */
  readonly winRate: number | null;
  readonly netPnl: number;
  readonly returnPct: number;
  /** Mean net PnL per trade, in quote currency. */
  readonly expectancy: number | null;
  readonly averageWin: number | null;
  readonly averageLoss: number | null;
  /** Gross profit / gross loss. Null without a losing trade. */
  readonly profitFactor: number | null;
  readonly maxDrawdownPct: number;
  /** Annualised from per-bar equity returns. Null with fewer than two bars or no variance. */
  readonly sharpe: number | null;
  readonly commission: number;
  readonly averageBarsHeld: number | null;
}

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length);

export function maxDrawdownPct(equity: readonly number[]): number {
  let peak = -Infinity, worst = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.max(worst, ((peak - value) / peak) * 100);
  }
  return worst;
}

export function sharpeRatio(equity: readonly number[], timeframe: Timeframe): number | null {
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i += 1) if (equity[i - 1] > 0) returns.push(equity[i] / equity[i - 1] - 1);
  const average = mean(returns);
  if (average === null || returns.length < 2) return null;
  const deviation = Math.sqrt(returns.reduce((sum, r) => sum + (r - average) ** 2, 0) / (returns.length - 1));
  if (deviation === 0) return null;
  const barsPerYear = (365 * 86_400_000) / TIMEFRAME_MS[timeframe];
  return (average / deviation) * Math.sqrt(barsPerYear);
}

/** Summary statistics of one run, computed only from what the venue reported: its closed trades and its equity curve. */
export function analyzePerformance(trades: readonly ReplayTrade[], equity: ReadonlyArray<{ equity: number }>, initialCapital: number, timeframe: Timeframe): PerformanceReport {
  const wins = trades.filter((t) => t.netPnl > 0), losses = trades.filter((t) => t.netPnl < 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.netPnl, 0);
  const grossLoss = -losses.reduce((sum, t) => sum + t.netPnl, 0);
  const curve = [initialCapital, ...equity.map((point) => point.equity)];
  const finalEquity = curve[curve.length - 1];
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length === 0 ? null : wins.length / trades.length,
    netPnl: trades.reduce((sum, t) => sum + t.netPnl, 0),
    returnPct: initialCapital > 0 ? (finalEquity / initialCapital - 1) * 100 : 0,
    expectancy: mean(trades.map((t) => t.netPnl)),
    averageWin: mean(wins.map((t) => t.netPnl)),
    averageLoss: mean(losses.map((t) => t.netPnl)),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdownPct: maxDrawdownPct(curve),
    sharpe: sharpeRatio(curve, timeframe),
    commission: trades.reduce((sum, t) => sum + t.commission, 0),
    averageBarsHeld: mean(trades.map((t) => t.barsHeld)),
  };
}
