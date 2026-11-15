import type { PositionView } from '../domain/portfolio.js';

/** Account state exactly as the venue reports it. Session figures (peak, day start, streak) are derived elsewhere. */
export interface AccountView {
  readonly asOf: number;
  readonly equity: number;
  readonly availableMargin: number;
  readonly realizedPnl: number;
  readonly positions: readonly PositionView[];
}

export interface PortfolioPort {
  getAccount(asOf: number): Promise<AccountView>;
}
