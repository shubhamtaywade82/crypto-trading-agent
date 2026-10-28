/**
 * Declarative hypothesis contract and lifecycle state machine for trading research.
 * Prevents prompt leakage, lookahead contamination, and unauthorized rule alterations.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MarketRegime } from '../market/types.js';

export const WHITELISTED_FEATURES = [
  'sweep_depth_atr',
  'sweep_displacement_atr',
  'absorption_score',
  'order_flow_imbalance',
  'spread_bps',
  'break_distance_atr',
  'reward_risk_ratio',
  'atr_volatility_pct',
  'funding_rate_apr',
] as const;

export type WhitelistedFeature = (typeof WHITELISTED_FEATURES)[number];
export type ConditionOperator = 'gte' | 'lte' | 'gt' | 'lt' | 'eq';

export interface FeatureCondition {
  feature: WhitelistedFeature;
  operator: ConditionOperator;
  value: number;
}

export type HypothesisStatus =
  | 'PROPOSED'
  | 'REGISTERED'
  | 'TESTING'
  | 'REJECTED'
  | 'VALIDATED'
  | 'PAPER_CHALLENGER'
  | 'PROMOTED';

export interface HypothesisPopulation {
  instrumentGroup: 'perpetual_futures' | 'spot' | 'options';
  direction: 'long' | 'short' | 'both';
  regime: MarketRegime | 'all';
}

export interface DeclarativeHypothesis {
  id: string;
  title: string;
  rationale: string;
  dataCutoff: string;
  createdAt: number;
  population: HypothesisPopulation;
  conditions: FeatureCondition[];
  baseline: string;
  primaryMetric: string;
  requiredEvaluation: 'forward_only' | 'purged_walk_forward';
  status: HypothesisStatus;
  rejectionReason?: string;
  history: Array<{ at: number; from: HypothesisStatus; to: HypothesisStatus; reason?: string }>;
}

const ALLOWED_TRANSITIONS: Record<HypothesisStatus, HypothesisStatus[]> = {
  PROPOSED: ['REGISTERED', 'REJECTED'],
  REGISTERED: ['TESTING', 'REJECTED'],
  TESTING: ['VALIDATED', 'REJECTED'],
  VALIDATED: ['PAPER_CHALLENGER', 'REJECTED'],
  PAPER_CHALLENGER: ['PROMOTED', 'REJECTED'],
  PROMOTED: [],
  REJECTED: [],
};

/** Validates that all conditions in a hypothesis strictly reference whitelisted features. */
export function validateConditions(conditions: readonly FeatureCondition[]): boolean {
  if (conditions.length === 0) return false;
  const set = new Set<string>(WHITELISTED_FEATURES);
  return conditions.every((c) => set.has(c.feature) && Number.isFinite(c.value));
}

/**
 * Anonymizes diagnostic metadata before feeding it to an LLM researcher.
 * Strips asset identifiers, exchange names, and historical calendar dates to prevent lookahead memory leaks.
 */
export function anonymizeForResearch(input: {
  symbols: readonly string[];
  diagnostics: string;
}): { anonymizedText: string; symbolMap: Map<string, string> } {
  const symbolMap = new Map<string, string>();
  input.symbols.forEach((sym, idx) => {
    symbolMap.set(sym, `ASSET_${String.fromCharCode(65 + idx)}`);
  });

  let text = input.diagnostics;
  for (const [realSym, anonSym] of symbolMap) {
    text = text.replaceAll(realSym, anonSym);
  }

  // Anonymize calendar dates YYYY-MM-DD to relative period tokens
  text = text.replace(/\b20\d{2}-\d{2}-\d{2}\b/g, 'PERIOD_T');

  return { anonymizedText: text, symbolMap };
}

/** Append-only registry managing the lifecycle of research hypotheses. */
export class HypothesisRegistry {
  private readonly hypotheses = new Map<string, DeclarativeHypothesis>();

  constructor(private readonly filePath: string | null = null) {
    if (this.filePath && existsSync(this.filePath)) {
      this.load();
    }
  }

  register(input: Omit<DeclarativeHypothesis, 'status' | 'history'>): DeclarativeHypothesis {
    if (this.hypotheses.has(input.id)) {
      throw new Error(`Hypothesis with id ${input.id} already exists`);
    }
    if (!validateConditions(input.conditions)) {
      throw new Error('Hypothesis contains non-whitelisted features or invalid numeric thresholds');
    }

    const hypothesis: DeclarativeHypothesis = {
      ...input,
      status: 'REGISTERED',
      history: [{ at: Date.now(), from: 'PROPOSED', to: 'REGISTERED', reason: 'Initial registration' }],
    };

    this.hypotheses.set(hypothesis.id, hypothesis);
    this.persist(hypothesis);
    return hypothesis;
  }

  transition(id: string, to: HypothesisStatus, reason?: string): DeclarativeHypothesis {
    const hyp = this.hypotheses.get(id);
    if (!hyp) throw new Error(`Hypothesis ${id} not found in registry`);

    const allowed = ALLOWED_TRANSITIONS[hyp.status];
    if (!allowed.includes(to)) {
      throw new Error(`Illegal hypothesis transition from ${hyp.status} to ${to}`);
    }

    const from = hyp.status;
    hyp.status = to;
    if (to === 'REJECTED' && reason) hyp.rejectionReason = reason;
    hyp.history.push({ at: Date.now(), from, to, reason });

    this.persist(hyp);
    return hyp;
  }

  get(id: string): DeclarativeHypothesis | undefined {
    return this.hypotheses.get(id);
  }

  all(): readonly DeclarativeHypothesis[] {
    return [...this.hypotheses.values()];
  }

  private persist(hyp: DeclarativeHypothesis): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(hyp) + '\n', 'utf8');
  }

  private load(): void {
    if (!this.filePath) return;
    const lines = readFileSync(this.filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as DeclarativeHypothesis;
        this.hypotheses.set(parsed.id, parsed);
      } catch {
        // Skips corrupted lines from crash mid-write
      }
    }
  }
}
