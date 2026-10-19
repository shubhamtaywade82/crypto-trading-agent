import type { Candle } from '../types.js';
import type { SetupVerdict } from '../decision/SetupTypes.js';
import type { SMCConfig, SMCFrame, SMCFrameAnalysis, StructureBreak } from '../strategies/smc-ml/types.js';

/**
 * Playbook engine types (spec: docs/superpowers/specs/2026-10-18-smc-playbook-phase1-audit.md, Phase 2).
 *
 * A playbook is a versioned, named trading hypothesis. Evaluating it produces one RuleEvaluation per rule, so every
 * verdict says exactly which predicate passed or failed, on what observed value, against what threshold.
 */

export type TradeDirection = 'LONG' | 'SHORT';

/**
 * CONTEXT and SETUP failures mean the hypothesis does not hold: NO_TRADE. TRIGGER failures mean it holds but has not
 * confirmed yet: WATCH. EXECUTION rules need a confirmed entry, so they run only once every TRIGGER rule passed.
 */
export type RuleStage = 'CONTEXT' | 'SETUP' | 'TRIGGER' | 'EXECUTION';

export interface RuleEvaluation {
  ruleId: RuleId;
  stage: RuleStage;
  passed: boolean;
  reason: string;
  observedValue?: number | string | boolean | null;
  threshold?: number | string | null;
  /** Time of the market event the rule judged (a candle close), when there is one. */
  evidenceTime?: number;
}

export type RuleId =
  | 'frames_present'
  | 'data_fresh'
  | 'htf_not_opposed'
  | 'htf_aligned'
  | 'structure_break_in_direction'
  | 'liquidity_swept_before_break'
  | 'displacement_confirmed'
  | 'breakout_volume'
  | 'entry_zone_present'
  | 'zone_unmitigated'
  | 'structural_stop_defined'
  | 'setup_not_invalidated'
  | 'setup_fresh'
  | 'target_liquidity_available'
  | 'trigger_window_open'
  | 'armed'
  | 'trigger_confirmed'
  | 'spread_within_limit'
  | 'stop_geometry_valid'
  | 'entry_not_chased'
  | 'entry_in_discount'
  | 'net_reward_risk_above_minimum'
  /** Session filter (experiment rule): the trigger close must fall inside `params.sessionWindows` (UTC). */
  | 'session_in_window';

export type PlaybookId = 'sweep_mss_fvg_reversal' | 'bos_fvg_ob_continuation' | 'breakout_retest';

/** A named UTC intraday window, used by the session_in_window experiment rule. ICT killzones are a research preset (src/research/ablation/variants.ts). */
export interface SessionWindow {
  name: string;
  startHourUtc: number;
  startMinuteUtc?: number;
  endHourUtc: number;
  endMinuteUtc?: number;
}

/** The zone kinds the arming rule may use. Defaults to FVG, then ORDER_BLOCK (registry v3 behaviour). */
export type ZoneKind = 'FVG' | 'ORDER_BLOCK';

/** Every threshold a rule reads. Values in the registry are proposals until calibrated; they are versioned with the playbook. */
export interface PlaybookParams {
  /** Required type of the zone-frame break: CHOCH for a reversal, BOS for a continuation, ANY for a breakout. */
  requiredBreakType: 'CHOCH' | 'BOS' | 'ANY';
  /** Break candle body divided by ATR14 of the zone frame at that candle. */
  minDisplacementAtr: number;
  stopBufferAtr: number;
  minStopAtr: number;
  maxStopAtr: number;
  /** How far the entry may sit beyond the zone's near edge, in zone-frame ATR. */
  maxChaseAtr: number;
  /** Age of the zone-frame break, in zone-frame bars, after which the setup is stale. */
  maxSetupAgeBars: number;
  /** The trigger must close within this many trigger-frame bars of arming (approved Phase 1, §5). */
  maxTriggerBars: number;
  minNetRewardRisk: number;
  maxSpreadBps: number;
  /** A frame whose last closed bar is this many bars behind the clock is stale. */
  maxStaleBars: number;
  /** Continuation only: highest allowed entry position in the displacement leg (0 = leg origin, 1 = leg extreme). */
  maxLegPosition?: number;
  /** Breakout only: retest band half-width around the broken level, in zone-frame ATR. */
  levelToleranceAtr?: number;
  /** Breakout only: break candle volume over the mean of the previous `volumeLookback` bars. */
  minBreakoutVolumeMultiple?: number;
  volumeLookback?: number;
  /** session_in_window only: the trigger close must fall inside one of these UTC windows. */
  sessionWindows?: readonly SessionWindow[];
  /** Arming only: which zone kinds are eligible, in preference order. Default: FVG first, then ORDER_BLOCK. */
  zoneKinds?: readonly ZoneKind[];
}

export interface PlaybookFrames {
  bias: readonly SMCFrame[];
  zone: SMCFrame;
  trigger: SMCFrame;
}

export interface PlaybookDefinition {
  id: PlaybookId;
  version: number;
  kind: 'REVERSAL' | 'CONTINUATION';
  thesis: string;
  frames: PlaybookFrames;
  rules: readonly RuleId[];
  params: PlaybookParams;
}

export interface ExecutionSnapshot {
  /** Bid/ask spread in basis points; null when unknown, which fails the spread gate. */
  spreadBps: number | null;
  takerFeeRate: number;
  slippageRate: number;
}

/** Closed, sorted, de-duplicated candles and the SMC analysis built from exactly those candles. */
export interface PlaybookContext {
  symbol: string;
  now: number;
  candles: Partial<Record<SMCFrame, Candle[]>>;
  frames: Partial<Record<SMCFrame, SMCFrameAnalysis>>;
  /** Integrity problems found while building the context, per frame (such a frame is left out of `frames`). */
  dataIssues: Partial<Record<SMCFrame, string>>;
  execution: ExecutionSnapshot;
  smcConfig: SMCConfig;
}

export interface EntryZone {
  kind: 'FVG' | 'ORDER_BLOCK' | 'LEVEL';
  top: number;
  bottom: number;
}

export interface TradePlan {
  entry: number;
  stop: number;
  target: number;
}

/** What a playbook derived from the context for one direction. Every field is null when it could not be established. */
export interface SetupFacts {
  direction: TradeDirection;
  dir: 1 | -1;
  zoneAtr: number | null;
  zoneBreak: StructureBreak | null;
  /** Close time of the zone-frame break candle. */
  breakClosedAt: number | null;
  breakCandle: Candle | null;
  /** ATR14 of the zone frame at the break candle. */
  breakAtr: number | null;
  zone: EntryZone | null;
  stop: number | null;
  /** Close time of the event that armed the setup (break close, zone touch or retest, by playbook). */
  armedAt: number | null;
  trigger: StructureBreak | null;
  triggerClosedAt: number | null;
  target: number | null;
  plan: TradePlan | null;
}

export interface PlaybookVerdict {
  playbookId: PlaybookId;
  version: number;
  symbol: string;
  direction: TradeDirection;
  evaluatedAt: number;
  verdict: SetupVerdict;
  armedAt: number | null;
  triggeredAt: number | null;
  plan: TradePlan | null;
  evaluations: RuleEvaluation[];
  failed: RuleEvaluation[];
  /** EXECUTION rules not evaluated because the trigger has not confirmed. */
  pending: RuleId[];
}
