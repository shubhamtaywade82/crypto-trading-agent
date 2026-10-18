import { DEFAULT_SMC_CONFIG } from '../strategies/smc-ml/types.js';
import { frameConfig, PLAYBOOK_FRAME_OVERRIDES } from './frameConfig.js';
import { RULES } from './rules.js';
import type { PlaybookDefinition, PlaybookId, PlaybookParams } from './types.js';

/**
 * Versioned playbook registry. Bump a playbook's `version` whenever its rules or params change, so a journaled verdict
 * always names the exact definition it was judged by. Every threshold here is a starting value, not a calibrated one
 * (spec 2026-10-18 §5 and §6): calibration is Phase 3.
 */
/**
 * v2 (2026-10-18): the 5m trigger swing length is 3, not the engine default 10 (frameConfig.ts).
 * v3 (2026-10-18): after the 5m trigger, entry is a limit at the zone's near edge (owner decision, option 2), and the chase
 * gate is dropped because the entry is the zone edge by construction. The limit's fill rule is in outcome.ts.
 */
export const PLAYBOOK_REGISTRY_VERSION = 3;

const FRAMES = { bias: ['4h', '1h'], zone: '15m', trigger: '5m' } as const;

const BASE_PARAMS: Omit<PlaybookParams, 'requiredBreakType'> = {
  minDisplacementAtr: 1.0,
  stopBufferAtr: 0.2, // same buffer as the SMC engine's stopBufferAtr
  minStopAtr: 0.25,
  maxStopAtr: 4,
  maxChaseAtr: 0.5,
  maxSetupAgeBars: 16,
  maxTriggerBars: 6, // approved 2026-10-18
  minNetRewardRisk: 1.5,
  maxSpreadBps: 5,
  maxStaleBars: 1,
};

const PLAYBOOKS: readonly PlaybookDefinition[] = [
  {
    id: 'sweep_mss_fvg_reversal',
    version: 3,
    kind: 'REVERSAL',
    thesis: 'Price takes opposing liquidity, then shifts structure (CHOCH) with displacement that leaves an FVG; enter on a 5m confirmation near the FVG.',
    frames: FRAMES,
    rules: [
      'frames_present', 'data_fresh', 'htf_not_opposed',
      'structure_break_in_direction', 'liquidity_swept_before_break', 'displacement_confirmed',
      'entry_zone_present', 'zone_unmitigated', 'structural_stop_defined', 'setup_not_invalidated', 'setup_fresh',
      'target_liquidity_available', 'trigger_window_open',
      'armed', 'trigger_confirmed',
      'spread_within_limit', 'stop_geometry_valid', 'net_reward_risk_above_minimum',
    ],
    params: { ...BASE_PARAMS, requiredBreakType: 'CHOCH' },
  },
  {
    id: 'bos_fvg_ob_continuation',
    version: 3,
    kind: 'CONTINUATION',
    thesis: 'With 4h and 1h aligned, a displacing BOS leaves an FVG or order block; enter when price pulls back into it and 5m confirms.',
    frames: FRAMES,
    rules: [
      'frames_present', 'data_fresh', 'htf_aligned',
      'structure_break_in_direction', 'displacement_confirmed',
      'entry_zone_present', 'zone_unmitigated', 'structural_stop_defined', 'setup_not_invalidated', 'setup_fresh',
      'target_liquidity_available', 'trigger_window_open',
      'armed', 'trigger_confirmed',
      'spread_within_limit', 'stop_geometry_valid', 'entry_in_discount', 'net_reward_risk_above_minimum',
    ],
    params: { ...BASE_PARAMS, requiredBreakType: 'BOS', maxLegPosition: 0.5 },
  },
  {
    id: 'breakout_retest',
    version: 3,
    kind: 'CONTINUATION',
    thesis: 'A displacing, high-volume close through a structure level is retested on 5m and holds; enter on the 5m confirmation.',
    frames: FRAMES,
    rules: [
      'frames_present', 'data_fresh', 'htf_not_opposed',
      'structure_break_in_direction', 'displacement_confirmed', 'breakout_volume',
      'entry_zone_present', 'structural_stop_defined', 'setup_not_invalidated', 'setup_fresh',
      'target_liquidity_available', 'trigger_window_open',
      'armed', 'trigger_confirmed',
      'spread_within_limit', 'stop_geometry_valid', 'net_reward_risk_above_minimum',
    ],
    params: { ...BASE_PARAMS, requiredBreakType: 'ANY', levelToleranceAtr: 0.15, minBreakoutVolumeMultiple: 1.5, volumeLookback: 20 },
  },
];

/** Rejects a registry that a typo or an edit could silently weaken. Runs at module load. */
export function validateRegistry(playbooks: readonly PlaybookDefinition[]): void {
  const ids = new Set<string>();
  for (const pb of playbooks) {
    if (ids.has(pb.id)) throw new Error(`duplicate playbook ${pb.id}`);
    ids.add(pb.id);
    if (!Number.isInteger(pb.version) || pb.version < 1) throw new Error(`${pb.id}: version must be a positive integer`);
    const unknown = pb.rules.filter((r) => !(r in RULES));
    if (unknown.length) throw new Error(`${pb.id}: unknown rules ${unknown.join(', ')}`);
    if (new Set(pb.rules).size !== pb.rules.length) throw new Error(`${pb.id}: a rule is listed twice`);
    for (const stage of ['CONTEXT', 'SETUP', 'TRIGGER', 'EXECUTION'] as const) {
      if (!pb.rules.some((r) => RULES[r].stage === stage)) throw new Error(`${pb.id}: no ${stage} rule`);
    }
    // A playbook may never reach ENTRY_ELIGIBLE without these
    for (const mandatory of ['frames_present', 'data_fresh', 'structural_stop_defined', 'setup_not_invalidated', 'trigger_confirmed', 'stop_geometry_valid', 'net_reward_risk_above_minimum'] as const) {
      if (!pb.rules.includes(mandatory)) throw new Error(`${pb.id}: mandatory rule ${mandatory} missing`);
    }
    if (pb.rules.includes('entry_in_discount') && pb.params.maxLegPosition === undefined) throw new Error(`${pb.id}: entry_in_discount needs maxLegPosition`);
    if (pb.rules.includes('breakout_volume') && (pb.params.minBreakoutVolumeMultiple === undefined || pb.params.volumeLookback === undefined)) {
      throw new Error(`${pb.id}: breakout_volume needs minBreakoutVolumeMultiple and volumeLookback`);
    }
    if (pb.params.minStopAtr >= pb.params.maxStopAtr) throw new Error(`${pb.id}: minStopAtr must be below maxStopAtr`);
    // A trigger swing is confirmed only swingLength bars after it forms: it must fit inside the trigger window
    const triggerSwing = frameConfig(DEFAULT_SMC_CONFIG, pb.frames.trigger, PLAYBOOK_FRAME_OVERRIDES).swingLength;
    if (triggerSwing >= pb.params.maxTriggerBars) {
      throw new Error(`${pb.id}: trigger swing length ${triggerSwing} must be below maxTriggerBars ${pb.params.maxTriggerBars}`);
    }
  }
}

validateRegistry(PLAYBOOKS);

export const listPlaybooks = (): readonly PlaybookDefinition[] => PLAYBOOKS;

export function getPlaybook(id: PlaybookId): PlaybookDefinition {
  const pb = PLAYBOOKS.find((p) => p.id === id);
  if (!pb) throw new Error(`unknown playbook ${id}`);
  return pb;
}
