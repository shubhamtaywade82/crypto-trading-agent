import type { PlaybookDefinition, PlaybookVerdict, RuleId } from './types.js';

/**
 * Setup grade: a deterministic RANKING of an ENTRY_ELIGIBLE setup's evidence, 0 to 100. It is not a probability and is
 * never used as one. Whether a higher grade earns more is an empirical question, answered by calibrating outcomes with
 * the grade band as a bucket dimension (calibration.ts).
 *
 * The break's displacement, the sweep before it and the FVG it left are one event, so they form one component (break
 * quality) instead of three independent votes.
 */
/** v2: with the entry at the zone edge (registry v3) proximity is 1 by construction; location then rests on the leg position. */
export const GRADE_VERSION = 2;

export interface GradeComponent {
  name: 'context' | 'break' | 'location' | 'reward' | 'execution';
  weight: number;
  /** 0 to 1. */
  score: number;
  basis: string;
}

export type GradeBand = 'A' | 'B' | 'C';

export interface SetupGrade {
  version: number;
  score: number;
  band: GradeBand;
  components: GradeComponent[];
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const WEIGHTS = { context: 0.25, break: 0.3, location: 0.2, reward: 0.15, execution: 0.1 } as const;

export const bandOf = (score: number): GradeBand => (score >= 70 ? 'A' : score >= 50 ? 'B' : 'C');

/** Grades an ENTRY_ELIGIBLE verdict from the evidence its rules recorded; null for any other verdict. */
export function gradeVerdict(v: PlaybookVerdict, pb: PlaybookDefinition): SetupGrade | null {
  if (v.verdict !== 'ENTRY_ELIGIBLE') return null;
  const evaluation = (id: RuleId) => v.evaluations.find((e) => e.ruleId === id);
  const numeric = (id: RuleId): number | null => {
    const value = evaluation(id)?.observedValue;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  // Context: share of bias frames trending with the trade, read from the HTF rule's observed "4h=LONG 1h=NEUTRAL"
  const htf = evaluation('htf_aligned') ?? evaluation('htf_not_opposed');
  const trends = typeof htf?.observedValue === 'string' ? htf.observedValue.split(' ') : [];
  const withTrade = trends.filter((t) => t.endsWith(`=${v.direction}`)).length;
  const context = trends.length > 0 ? withTrade / trends.length : 0;

  // Break quality: displacement relative to twice the playbook minimum, discounted when no liquidity was swept first
  const displacement = numeric('displacement_confirmed');
  const swept = evaluation('liquidity_swept_before_break');
  const sweepFactor = swept === undefined ? 0.85 : swept.passed ? 1 : 0.7;
  const breakScore = displacement === null ? 0 : clamp01(displacement / (2 * pb.params.minDisplacementAtr)) * sweepFactor;

  // Location: how close the entry is to the zone, averaged with the leg position when the playbook measures it
  const chase = numeric('entry_not_chased');
  const legPosition = numeric('entry_in_discount');
  const proximity = chase === null ? 1 : clamp01(1 - Math.max(0, chase) / pb.params.maxChaseAtr);
  const location = legPosition === null ? proximity : (proximity + clamp01(1 - legPosition)) / 2;

  const rr = numeric('net_reward_risk_above_minimum');
  const reward = rr === null ? 0 : clamp01(rr / (2 * pb.params.minNetRewardRisk));
  const spread = numeric('spread_within_limit');
  const execution = spread === null ? 0 : clamp01(1 - spread / pb.params.maxSpreadBps);

  const components: GradeComponent[] = [
    { name: 'context', weight: WEIGHTS.context, score: context, basis: `${withTrade}/${trends.length} bias frames with the trade` },
    { name: 'break', weight: WEIGHTS.break, score: breakScore, basis: `displacement ${displacement ?? 'n/a'} ATR, sweep factor ${sweepFactor}` },
    { name: 'location', weight: WEIGHTS.location, score: location, basis: `chase ${chase ?? 'n/a'} ATR${legPosition === null ? '' : `, leg position ${legPosition}`}` },
    { name: 'reward', weight: WEIGHTS.reward, score: reward, basis: `net reward:risk ${rr ?? 'n/a'}` },
    { name: 'execution', weight: WEIGHTS.execution, score: execution, basis: `spread ${spread ?? 'n/a'} bps` },
  ];
  const score = Math.round(100 * components.reduce((sum, c) => sum + c.weight * c.score, 0));
  return { version: GRADE_VERSION, score, band: bandOf(score), components };
}
