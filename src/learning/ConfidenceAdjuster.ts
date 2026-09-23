import type { AgentId } from '../types.js';
import type { AgentLedger } from './AgentLedger.js';

// Multiplier bounds: never suppress below 60% or amplify above 120%
const MIN_MULTIPLIER = 0.6;
const MAX_MULTIPLIER = 1.2;
const COLD_START = 1.0; // neutral until 3+ trades recorded

/**
 * Returns a confidence multiplier for a given agent based on its historical edge.
 * Cold start (< 3 trades): 1.0 — no adjustment.
 * Proven edge (high win-rate + positive R): up to 1.2×.
 * Underperforming (low win-rate + negative R): as low as 0.6×.
 *
 * Uses Kelly-inspired blending: winRate * (1 + avgR) - (1 - winRate)
 * capped to [MIN_MULTIPLIER, MAX_MULTIPLIER] around 1.0.
 */
export function confidenceMultiplier(agentId: AgentId, ledger: AgentLedger): number {
  const wr = ledger.winRate(agentId);
  const avgR = ledger.avgR(agentId);
  if (wr === null || avgR === null) return COLD_START;

  // Expectancy edge: positive means the strategy has proven edge
  const edge = wr * (1 + Math.max(avgR, -1)) - (1 - wr);
  // Map edge from [-1, +1] to [MIN_MULTIPLIER, MAX_MULTIPLIER] around 1.0
  const multiplier = 1.0 + edge * (edge > 0 ? MAX_MULTIPLIER - 1.0 : 1.0 - MIN_MULTIPLIER);
  return Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, multiplier));
}
