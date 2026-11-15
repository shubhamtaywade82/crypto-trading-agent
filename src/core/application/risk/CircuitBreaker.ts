import { drawdownPct, type PortfolioSnapshot } from '../../domain/portfolio.js';

export type BreakerState = 'ARMED' | 'TRIPPED';

export interface BreakerSnapshot {
  readonly state: BreakerState;
  readonly reason: string | null;
  readonly trippedAt: number | null;
}

/**
 * Latching kill switch. ARMED -> TRIPPED on a drawdown breach or an explicit trip (an order whose outcome is unknown,
 * a position left without a stop). TRIPPED -> ARMED only through `reset`, which an operator calls; nothing in the
 * engine resets it. While tripped, every entry is refused.
 */
export class CircuitBreaker {
  private current: BreakerSnapshot;

  constructor(private readonly maxDrawdownPct: number, restored?: BreakerSnapshot) {
    this.current = restored ?? { state: 'ARMED', reason: null, trippedAt: null };
  }

  get snapshot(): BreakerSnapshot {
    return this.current;
  }

  haltReason(): string | null {
    return this.current.state === 'TRIPPED' ? `circuit breaker tripped: ${this.current.reason}` : null;
  }

  /** Returns true when this call tripped the breaker. The first reason is kept. */
  trip(reason: string, at: number): boolean {
    if (this.current.state === 'TRIPPED') return false;
    this.current = { state: 'TRIPPED', reason, trippedAt: at };
    return true;
  }

  observe(portfolio: PortfolioSnapshot): boolean {
    const drawdown = drawdownPct(portfolio);
    if (this.maxDrawdownPct > 0 && drawdown >= this.maxDrawdownPct) {
      return this.trip(`drawdown ${drawdown.toFixed(2)}% reached the ${this.maxDrawdownPct}% limit`, portfolio.asOf);
    }
    return false;
  }

  reset(operator: string): void {
    if (!operator.trim()) throw new Error('a breaker reset needs the operator who authorised it');
    this.current = { state: 'ARMED', reason: null, trippedAt: null };
  }
}
