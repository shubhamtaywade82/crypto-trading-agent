export type DrawdownAction = 'block' | 'flatten';

export interface DrawdownResponse {
  readonly breached: boolean;
  readonly drawdownPct: number;
  /** Engage the kill-switch: no new entries until an operator resumes. */
  readonly halt: boolean;
  /** Close every open position with reduce-only orders, and cancel resting entries. */
  readonly closeAll: boolean;
  readonly reason: string;
}

/**
 * What an account drawdown past the limit does. `block` only refuses new entries (the risk gate already does that);
 * `flatten` also halts and closes the book, because a drawdown spread across several positions trips no per-position stop.
 */
export function drawdownResponse(input: { equity: number; peak: number; maxPct: number; action: DrawdownAction }): DrawdownResponse {
  const drawdownPct = input.peak > 0 ? Math.max(0, ((input.peak - input.equity) / input.peak) * 100) : 0;
  const breached = input.equity <= 0 || drawdownPct > input.maxPct;
  const reason = `drawdown ${drawdownPct.toFixed(2)}% exceeds ${input.maxPct}% from peak`;
  if (!breached) return { breached, drawdownPct, halt: false, closeAll: false, reason: '' };
  return { breached, drawdownPct, halt: input.action === 'flatten', closeAll: input.action === 'flatten', reason };
}
