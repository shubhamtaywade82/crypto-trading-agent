import type { Direction } from '../domain/strategy.js';

/** The deterministic numbers an advisor may look at. It receives no handle to orders, sizing or limits. */
export interface AdvisorBrief {
  readonly decisionId: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly strategyId: string;
  readonly reason: string;
  readonly entry: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly rewardRisk: number;
  readonly fundingRate: number | null;
}

export interface AdvisorOpinion {
  /** UNAVAILABLE: no usable answer (offline, timeout). The deterministic pipeline then decides alone. */
  readonly verdict: 'PROCEED' | 'VETO' | 'UNAVAILABLE';
  readonly reason: string;
  readonly model: string | null;
}

/**
 * Optional analysis with one power: it can refuse an entry the deterministic code proposed. It cannot originate an
 * order, change a size, move a stop or override a risk rejection, because nothing it returns carries those fields.
 */
export interface DecisionAdvisorPort {
  review(brief: AdvisorBrief): Promise<AdvisorOpinion>;
}
