import type { SMCConfig, SMCFrame } from '../strategies/smc-ml/types.js';

/**
 * Per-frame overrides of the SMC analysis the playbooks read. Kept in its own module so the context builder, the replay
 * and the registry share one definition without importing each other.
 *
 * The 5m trigger is a break of a 5m swing (approved definition, spec 2026-10-18 §5), and its swing length N is its own
 * parameter there. A swing of length N is confirmed only N bars after it forms, so N must be below the trigger window
 * (maxTriggerBars) or a trigger can almost never print in time. Registry v1 used the engine default (10) on 5m: on 30 days
 * of SOLUSDT not one of 19 valid setups got a trigger inside its 6-bar window. 3 is a starting value, not calibrated.
 */
export const TRIGGER_SWING_LENGTH = 3;

export const PLAYBOOK_FRAME_OVERRIDES: Readonly<Partial<Record<SMCFrame, Partial<SMCConfig>>>> = {
  '5m': { swingLength: TRIGGER_SWING_LENGTH },
};

export const frameConfig = (base: SMCConfig, frame: SMCFrame, overrides: Partial<Record<SMCFrame, Partial<SMCConfig>>> = PLAYBOOK_FRAME_OVERRIDES): SMCConfig =>
  ({ ...base, ...(overrides[frame] ?? {}) });
