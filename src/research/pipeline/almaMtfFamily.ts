/**
 * ALMA MTF as a research-factory family: a typed parameter space whose candidates run through the canonical
 * full-system ReplayService (signal -> risk -> execution -> portfolio), with the same agent class the orchestrator runs.
 * No second PnL path: a candidate is only a different constructor argument.
 */
import { z } from 'zod';
import { AlmaMtfChampionAgent, type AlmaMtfParams } from '../../agents/AlmaMtfChampionAgent.js';
import type { BinanceService } from '../../binance/client.js';
import { config } from '../../config.js';
import { pmConfigFromEnv } from '../../position/pmConfig.js';
import { riskLimitsFromConfig } from '../../risk/riskConfig.js';
import { ReplayService, type ReplayResult } from '../../backtesting/ReplayService.js';
import { DEFAULT_REPLAY_CONFIG, type ReplayConfig, type ReplayData } from '../../backtesting/types.js';
import { experimentIdentity, type CandidateSpec, type ExperimentIdentity } from './experimentIdentity.js';

export const ALMA_MTF_FAMILY = { id: 'ALMA_MTF', version: 1 } as const;

const almaSchema = z.object({
  length: z.number().int().min(5).max(200),
  offset: z.number().min(0).max(1),
  sigma: z.number().gt(0).max(20),
}).strict();

export const almaMtfParamsSchema = z.object({
  fast: almaSchema,
  slow: almaSchema,
  htfFast: almaSchema,
  htfSlow: almaSchema,
  atrPeriod: z.number().int().min(5).max(50),
  atrStopMultiplier: z.number().min(0.5).max(6),
  riskRewardRatio: z.number().min(0.5).max(5),
}).strict()
  .refine((p) => p.fast.length < p.slow.length, { message: 'fast.length must be below slow.length' })
  .refine((p) => p.htfFast.length < p.htfSlow.length, { message: 'htfFast.length must be below htfSlow.length' });

export interface AlmaMtfExperiment {
  identity: ExperimentIdentity;
  spec: CandidateSpec<AlmaMtfParams>;
  replayConfig: ReplayConfig;
  result: ReplayResult;
}

/** Throws on params outside the family's schema: an invalid candidate is terminal, never silently clamped. */
export function almaMtfCandidate(params: unknown): CandidateSpec<AlmaMtfParams> {
  const parsed = almaMtfParamsSchema.safeParse(params);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid ${ALMA_MTF_FAMILY.id} params: ${issues}`);
  }
  return { family: ALMA_MTF_FAMILY.id, familyVersion: ALMA_MTF_FAMILY.version, params: parsed.data };
}

/**
 * Every field ReplayService would otherwise read from env/config at run time, resolved now so it is part of the
 * experiment hash. Overrides win; the decision journal stays in memory.
 */
export function resolvedReplayConfig(overrides: Partial<ReplayConfig> = {}): ReplayConfig {
  const positionManager = overrides.positionManager ?? config.positionManager.enabled;
  return {
    ...DEFAULT_REPLAY_CONFIG,
    riskLimits: riskLimitsFromConfig(),
    positionManager,
    regime: config.regime.scored ? config.regime.options : null,
    ...(positionManager ? { pm: pmConfigFromEnv() } : {}),
    ...overrides,
    costs: { ...DEFAULT_REPLAY_CONFIG.costs, ...overrides.costs },
    funding: { ...DEFAULT_REPLAY_CONFIG.funding, ...overrides.funding },
    decisionsPath: null,
  };
}

/** Full replay of one candidate with ALMA MTF as the only strategy in the fleet. */
export async function runAlmaMtfExperiment(params: unknown, data: ReplayData, replayConfig: ReplayConfig): Promise<AlmaMtfExperiment> {
  const spec = almaMtfCandidate(params);
  const agent = new AlmaMtfChampionAgent({} as BinanceService, spec.params);
  const result = await new ReplayService({ config: replayConfig, agents: [agent] }).run(data);
  return { identity: experimentIdentity(spec, data, replayConfig), spec, replayConfig, result };
}
