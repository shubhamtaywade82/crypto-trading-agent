import type { Direction } from './strategy.js';

export interface PositionView {
  readonly symbol: string;
  readonly direction: Direction;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly markPrice: number;
  readonly leverage: number;
  readonly unrealizedPnl: number;
  /** Null when the venue reports no protective stop for the position. */
  readonly stopLoss: number | null;
}

/** Account state as the venue reports it, plus the session figures the loss governors need. */
export interface PortfolioSnapshot {
  readonly asOf: number;
  readonly equity: number;
  readonly availableMargin: number;
  readonly positions: readonly PositionView[];
  /** Equity at the start of the current UTC day. */
  readonly dayStartEquity: number;
  /** Highest equity observed. */
  readonly peakEquity: number;
  /** Consecutive losing closed trades, most recent first. */
  readonly lossStreak: number;
}

export const dailyLossPct = (p: PortfolioSnapshot): number =>
  p.dayStartEquity > 0 ? Math.max(0, ((p.dayStartEquity - p.equity) / p.dayStartEquity) * 100) : 0;

export const drawdownPct = (p: PortfolioSnapshot): number =>
  p.peakEquity > 0 ? Math.max(0, ((p.peakEquity - p.equity) / p.peakEquity) * 100) : 0;

export const grossNotional = (p: PortfolioSnapshot): number =>
  p.positions.reduce((sum, position) => sum + position.quantity * position.markPrice, 0);
