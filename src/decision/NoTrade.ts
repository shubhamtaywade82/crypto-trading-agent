/** Machine-readable reasons a candidate ends in NO_TRADE; the audit trail keys on these, not on prose. */
export const NO_TRADE_REASONS = [
  'RR_TOO_LOW',
  'PORTFOLIO_CAPACITY',
  'CIRCUIT_BREAKER',
  'RISK_PER_TRADE',
  'LEVERAGE',
  'SIZING_FAILED',
  'OTHER_RISK',
] as const;
export type NoTradeReason = (typeof NO_TRADE_REASONS)[number];

/** Blocks that are standing states: they cannot clear until the portfolio or circuit changes. */
const STANDING: ReadonlySet<NoTradeReason> = new Set(['PORTFOLIO_CAPACITY', 'CIRCUIT_BREAKER']);

/** Maps a risk-engine refusal ("risk-engine: name: detail; name: detail") to a code; the first failing check wins. */
export function classifyRiskRefusal(reason: string): NoTradeReason {
  const text = reason.replace(/^risk-engine:\s*/, '');
  const name = /^([a-z_]+):/.exec(text)?.[1];
  switch (name) {
    case 'min_rr': return 'RR_TOO_LOW';
    case 'portfolio_limits':
    case 'position_count': return 'PORTFOLIO_CAPACITY';
    case 'circuit_breaker':
    case 'daily_loss':
    case 'loss_streak': return 'CIRCUIT_BREAKER';
    case 'risk_per_trade': return 'RISK_PER_TRADE';
    case 'leverage': return 'LEVERAGE';
    case 'sizing': return 'SIZING_FAILED';
    default: return 'OTHER_RISK';
  }
}

export const isStandingBlock = (reason: NoTradeReason): boolean => STANDING.has(reason);
