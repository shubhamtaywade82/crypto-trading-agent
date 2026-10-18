import { DEFAULT_OUTCOME_POLICY } from '../../playbooks/outcome.js';
import type { ExperimentConfig } from './types.js';

/**
 * The default study config: every registry playbook, every component group, isolation + ablation + a small pair family,
 * with the research param overrides the Phase 1 audit's sensitivity table motivates. The audit (2026-10-18 §9-§10)
 * found that the approved 6-bar trigger window produced zero decisions in 90 days: 12 bars gave 4 valid setups and
 * 24 bars gave 9. The overrides widen the trigger window and the entry TTL so the study can actually collect
 * outcomes; they are research overrides, recorded in the manifest — the registry stays at v3 and nothing here is
 * tuned on any outcome (the defaults were fixed before the first study ran).
 */
export const DEFAULT_ABLATION_CONFIG: ExperimentConfig = {
  version: 1,
  symbol: 'SOLUSDT',
  from: 0,
  to: 0,
  splits: { train: 0.5, validation: 0.25, holdout: 0.25 },
  source: 'archive',
  execution: { spreadBps: 1, takerFeeRate: 0.0004, slippageRate: 0.0002 },
  outcomePolicy: { ...DEFAULT_OUTCOME_POLICY, entryTtlBars: 24 },
  paramOverrides: { maxTriggerBars: 24 },
  playbooks: ['sweep_mss_fvg_reversal', 'bos_fvg_ob_continuation', 'breakout_retest'],
  isolation: true,
  ablation: true,
  pairs: ['sweep', 'displacement', 'htf', 'session'],
  sessionPreset: 'ict',
  bootstrap: { confidence: 0.95, iterations: 2000, seed: 20261019 },
  selection: { minTrainFilled: 30, minValidationFilled: 10, minHoldoutFilled: 10, minDays: 10, alpha: 0.05, topK: 3 },
  costMultipliers: [0.5, 1, 2, 3],
  delayBars: [1, 2, 4],
  permutations: 1000,
  windowBars: 300,
};
