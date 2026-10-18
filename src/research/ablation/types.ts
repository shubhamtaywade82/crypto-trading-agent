import type { OutcomePolicy } from '../../playbooks/outcome.js';
import type { PlaybookDefinition, PlaybookId, PlaybookParams, RuleId, SessionWindow } from '../../playbooks/types.js';
import type { BootstrapSummary } from '../Bootstrap.js';

/**
 * Component-ablation experiment framework (spec: docs/superpowers/specs/2026-10-19-smc-component-ablation-framework.md).
 *
 * A study replays, in ONE causal pass, many versions of the registry playbooks that differ by exactly which SMC/ICT
 * components their rule lists contain (a liquidity sweep, an FVG zone, a killzone filter, ...). It then answers, with
 * out-of-sample evidence, whether each component helps: expectancy in R after costs, day-clustered bootstrap bounds,
 * Holm-corrected holdout p-values across the whole variant family, and negative controls.
 */

export const ABLATION_FRAMEWORK_VERSION = 1;

export type SegmentName = 'train' | 'validation' | 'holdout';

/** A toggleable state of one component group. A group's off state is "no option of the group is on". */
export interface ComponentOption {
  /** Option key within the group, e.g. 'aligned' for the htf group. */
  key: string;
  description: string;
  /** Rules added when this option is on. */
  rules?: readonly RuleId[];
  /** Params merged when this option is on. */
  params?: Partial<PlaybookParams>;
}

/** A component group before the per-playbook registry default is attached. */
export type GroupSpec = Omit<ComponentGroup, 'registryDefault'>;

export interface ComponentGroup {
  /** Dimension key, e.g. 'htf', 'sweep', 'session'. Variant component strings are `group:option` or just `group`. */
  key: string;
  description: string;
  /** Every non-off option. */
  options: readonly ComponentOption[];
  /** Option key the registry's published definition has on; null when the registry runs the group off (or it is param-only). */
  registryDefault: string | null;
}

/**
 * One replayed variant of one playbook. `definition` is what the causal engine evaluates; its playbook id and version
 * stay the base registry's, so every decision record still names the exact rule engine that produced it. The variant's
 * identity lives in `label`, and the full definition hash is stored with the results.
 */
export interface VariantSpec {
  /** `<playbookId>::<name>` — unique within a study, filesystem-safe. */
  label: string;
  playbookId: PlaybookId;
  /** Human variant name, e.g. 'core', 'full', 'iso:sweep', 'abl:htf', 'pair:sweep+displacement'. */
  name: string;
  /** Components on, as `group` (single-option groups) or `group:option` strings, in catalog order. */
  components: readonly string[];
  /** Research-only param overrides applied on top of the components' params. */
  paramOverrides: Partial<PlaybookParams>;
  /** The concrete definition the replay evaluates. */
  definition: PlaybookDefinition;
}

/** Fractions of the decision timeline; boundaries are floored to UTC day starts. Must sum to 1. */
export interface SplitFractions {
  train: number;
  validation: number;
  holdout: number;
}

export interface ExperimentConfig {
  version: 1;
  symbol: string;
  /** Replay window [from, to] in epoch ms. The CLI fills these from --days/--end-days-ago when absent. */
  from: number;
  to: number;
  splits: SplitFractions;
  source: 'archive' | 'sdk';
  execution: { spreadBps: number; takerFeeRate: number; slippageRate: number };
  outcomePolicy: OutcomePolicy;
  /** Research-only param overrides applied to EVERY variant (e.g. a wider trigger window). Recorded in the manifest. */
  paramOverrides: Partial<PlaybookParams>;
  playbooks: readonly PlaybookId[];
  /** Core-plus-one-component variants for every group option. */
  isolation: boolean;
  /** Full-minus-one-component variants for every component the registry default has on. */
  ablation: boolean;
  /** Core-plus-two-components variants over these group keys; 'none' disables. Pairs use each group's default option. */
  pairs: readonly string[] | 'none';
  /** Session preset used by the session component: 'ict' killzones, or 'none' to drop the session group. */
  sessionPreset: 'ict' | 'none';
  bootstrap: { confidence: number; iterations: number; seed: number };
  selection: {
    minTrainFilled: number;
    minValidationFilled: number;
    minHoldoutFilled: number;
    /** Distinct UTC decision days required on the holdout. */
    minDays: number;
    /** Family-wise alpha for the Holm correction across the whole variant family. */
    alpha: number;
    /** How many variants ranked by train evidence continue to validation and holdout. */
    topK: number;
  };
  costMultipliers: readonly number[];
  /** Delayed-entry controls, in trigger-frame bars. */
  delayBars: readonly number[];
  permutations: number;
  windowBars: number;
}

export interface TradeRecord {
  setupId: string;
  direction: 'LONG' | 'SHORT';
  decidedAt: number;
  filledAt: number | null;
  resolvedAt: number | null;
  label: 'TARGET' | 'STOP' | 'TIMEOUT' | 'NOT_FILLED';
  /** Null for NOT_FILLED. */
  netR: number | null;
  barsHeld: number | null;
  /** Adverse/favourable excursion from the fill, in R units; null when not filled or no candles. */
  maeR: number | null;
  mfeR: number | null;
  /** Round-trip fee+slippage cost in R units; null when not filled. */
  costR: number | null;
  hourUtc: number;
}

export interface SplitStats {
  n: number;
  filled: number;
  evR: number | null;
  winRate: number | null;
}

export interface VariantMetrics {
  decisions: number;
  filled: number;
  notFilled: number;
  pending: number;
  fillRate: number | null;
  evR: number | null;
  medianR: number | null;
  stdevR: number | null;
  /** Share of filled trades with netR > 0. */
  winRate: number | null;
  targetRate: number | null;
  stopRate: number | null;
  timeoutRate: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  avgBarsHeld: number | null;
  avgHoldMinutes: number | null;
  avgMaeR: number | null;
  avgMfeR: number | null;
  avgCostR: number | null;
  /** Day-clustered bootstrap of the mean net R; two-sided interval, `ciLow` at the one-sided confidence. */
  bootstrap: BootstrapSummary | null;
  splits: {
    direction: Record<string, SplitStats>;
    session: Record<string, SplitStats>;
    regime: Record<string, SplitStats>;
  };
}

export interface MetricsBundle {
  full: VariantMetrics;
  train: VariantMetrics;
  validation: VariantMetrics;
  holdout: VariantMetrics;
}

/** Negative controls for one variant: answers "is the edge in the signal, or in the exit policy / luck?" */
export interface ControlsResult {
  /** Which decisions the controls read: the holdout's when it has evidence, else the full window. */
  basis: SegmentName | 'full';
  /** Mirror null: mean R of every filled trade flipped. A timing edge should invert. */
  flipMeanR: number | null;
  /** Sign-flip permutation test of the mean against a no-directional-information null. */
  permutation: { iterations: number; seed: number; observedMeanR: number | null; pValue: number | null; nullP95R: number | null };
  /** Delayed entries: the same plan resolved k trigger bars later. A real timing edge decays. */
  delay: { bars: number; n: number; evR: number | null; deltaR: number | null }[];
  /** Outcome re-pricing at multiplied fee+slippage. The decision gates are not re-run. */
  costs: { multiplier: number; n: number; evR: number | null }[];
}

export interface SelectionCheck {
  considered: boolean;
  reasons: string[];
  holmRejected: boolean | null;
  promoted: boolean;
}

export interface VariantResult {
  spec: VariantSpec;
  /** sha256 of the canonical JSON of the variant definition. */
  definitionHash: string;
  metrics: MetricsBundle;
  /** Controls run on the full window for the selected variants only; null otherwise. */
  controls: ControlsResult | null;
  selection: SelectionCheck;
}

export interface SelectionReport {
  /** Variants in ranked order with their selection evidence, selected ones first. */
  ranking: { label: string; trainFilled: number; trainEvR: number | null; trainLowerBoundR: number | null; selected: boolean }[];
  /** One-sided bootstrap p-values on the holdout, Holm-corrected across every variant tested. */
  holm: { alpha: number; familySize: number; rejections: number };
  summary: string;
}

export interface DatasetFrameFingerprint {
  frame: string;
  bars: number;
  firstOpenTime: number;
  lastOpenTime: number;
  /** sha256 over every bar's `openTime|open|high|low|close|volume` line. */
  sha256: string;
}

export interface StudyManifest {
  frameworkVersion: number;
  studyId: string;
  configHash: string;
  config: ExperimentConfig;
  dataset: DatasetFrameFingerprint[];
  code: { gitSha: string | null; playbookRegistryVersion: number; nodeVersion: string };
  seeds: { bootstrap: number; permutation: number };
  startedAt: number;
  finishedAt: number;
  variantCount: number;
  replay: { steps: number; warmupSteps: number; decisionsRecorded: number; outcomesWritten: number; durationMs: number };
}

export interface StudyResult {
  manifest: StudyManifest;
  variants: VariantResult[];
  selection: SelectionReport;
}

/** Session presets for the session component. ICT killzones, UTC (EST = UTC-5). */
export const SESSION_PRESETS: Readonly<Record<Exclude<ExperimentConfig['sessionPreset'], 'none'>, readonly SessionWindow[]>> = {
  ict: [
    { name: 'london_open', startHourUtc: 7, endHourUtc: 10 },
    { name: 'new_york_open', startHourUtc: 12, endHourUtc: 15 },
    { name: 'london_close', startHourUtc: 15, endHourUtc: 17 },
    { name: 'new_york_pm', startHourUtc: 18, startMinuteUtc: 30, endHourUtc: 21 },
  ],
};
