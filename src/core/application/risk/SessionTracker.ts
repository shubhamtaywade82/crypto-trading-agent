import type { PortfolioSnapshot } from '../../domain/portfolio.js';
import type { AccountView } from '../../ports/PortfolioPort.js';

export interface SessionState {
  readonly utcDay: string;
  readonly dayStartEquity: number;
  readonly peakEquity: number;
  readonly lossStreak: number;
  readonly lastRealizedPnl: number;
  readonly openSymbols: readonly string[];
}

const utcDayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Derives the figures the loss governors need from successive account views: the day's opening equity, the equity
 * peak, and the losing streak. A trade counts as closed when its symbol leaves the position list; its result is the
 * change in the venue's realized PnL since the previous view.
 */
export class SessionTracker {
  private state: SessionState | null;

  constructor(restored: SessionState | null = null) {
    this.state = restored;
  }

  observe(account: AccountView): PortfolioSnapshot {
    const day = utcDayOf(account.asOf);
    const previous = this.state;
    const openSymbols = account.positions.map((p) => p.symbol).sort();
    let lossStreak = previous?.lossStreak ?? 0;
    if (previous) {
      const closed = previous.openSymbols.filter((symbol) => !openSymbols.includes(symbol));
      const realized = account.realizedPnl - previous.lastRealizedPnl;
      if (closed.length > 0 && realized < 0) lossStreak += closed.length;
      else if (closed.length > 0 && realized > 0) lossStreak = 0;
    }
    this.state = {
      utcDay: day,
      dayStartEquity: previous && previous.utcDay === day ? previous.dayStartEquity : account.equity,
      peakEquity: Math.max(previous?.peakEquity ?? 0, account.equity),
      lossStreak,
      lastRealizedPnl: account.realizedPnl,
      openSymbols,
    };
    return {
      asOf: account.asOf,
      equity: account.equity,
      availableMargin: account.availableMargin,
      positions: account.positions,
      dayStartEquity: this.state.dayStartEquity,
      peakEquity: this.state.peakEquity,
      lossStreak: this.state.lossStreak,
    };
  }

  serialize(): SessionState | null {
    return this.state;
  }
}
