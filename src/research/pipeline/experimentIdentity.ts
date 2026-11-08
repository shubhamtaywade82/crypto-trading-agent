/**
 * Content-addressed identity for research-factory candidates and experiments.
 *
 * candidateId pins WHAT is tested (family + family version + normalized params). experimentId pins the whole question:
 * candidate + exact candle content + fully resolved replay config + replay engine version. Same inputs, same ids, so a
 * re-run of an immutable experiment is recognisable as a replay instead of a new trial.
 */
import type { ReplayConfig, ReplayData } from '../../backtesting/types.js';
import { readCodeState } from '../../backtesting/researchRun.js';
import { fingerprintCandles, hashOfConfig } from '../ablation/fingerprint.js';

// Bump when ReplayService fill/exit/cost semantics change: old results then stop matching new experiment ids.
export const REPLAY_ENGINE_VERSION = 1;

export interface CandidateSpec<P> {
  family: string;
  familyVersion: number;
  params: P;
}

export interface ExperimentIdentity {
  experimentId: string;
  candidateId: string;
  datasetHash: string;
  replayConfigHash: string;
  replayEngineVersion: number;
}

/** Provenance recorded beside the identity; deliberately not hashed, so the same experiment at a new commit keeps its id. */
export interface ExperimentProvenance {
  codeCommit: string | null;
  codeDirty: boolean | null;
  ranAtIso: string;
}

export const candidateId = <P>(spec: CandidateSpec<P>): string => hashOfConfig(spec);

/** sha256 over every symbol x timeframe frame fingerprint, in sorted order. */
export function datasetHash(data: ReplayData): string {
  const frames = Object.keys(data).sort().flatMap((symbol) =>
    Object.keys(data[symbol]).sort().map((timeframe) =>
      fingerprintCandles(`${symbol}/${timeframe}`, data[symbol][timeframe as keyof ReplayData[string]] ?? []),
    ),
  );
  return hashOfConfig(frames);
}

/** Identity of one candidate on one dataset. `replayConfig` must be fully resolved: env-derived defaults break reproducibility. */
export function experimentIdentity<P>(spec: CandidateSpec<P>, data: ReplayData, replayConfig: ReplayConfig): ExperimentIdentity {
  const parts = {
    candidateId: candidateId(spec),
    datasetHash: datasetHash(data),
    replayConfigHash: hashOfConfig(replayConfig),
    replayEngineVersion: REPLAY_ENGINE_VERSION,
  };
  return { experimentId: hashOfConfig(parts), ...parts };
}

export function experimentProvenance(cwd: string, nowMs: number): ExperimentProvenance {
  const { commit, dirty } = readCodeState(cwd);
  return { codeCommit: commit, codeDirty: dirty, ranAtIso: new Date(nowMs).toISOString() };
}
