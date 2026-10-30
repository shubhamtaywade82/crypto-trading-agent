/**
 * Versioned question set for candidate evaluation.
 *
 * Questions — their wording, options and criteria — are part of the decision
 * policy: changing what a question asks changes what the audit trail means.
 * Every question therefore carries a version, and the set as a whole carries
 * QUESTION_SET_VERSION; both are stamped into every audit record so a decision
 * made in March can be replayed and scored against the exact questions that
 * produced it.
 *
 * Rules encoded here (the honesty contract, from the Tev1 integration design):
 *  - the model may only use the supplied evidence, never invent missing facts;
 *  - it classifies, it does not forecast prices or trade outcomes;
 *  - missing/stale/contradictory evidence is INSUFFICIENT_DATA, not a guess.
 */

import type { ChoiceQuestion, NoulQuestion, SetupWeakness, SystemoneQuestion, TradeDecisionChoice } from '../types.js';
import { SETUP_WEAKNESS_CHOICES, TRADE_DECISION_CHOICES } from '../types.js';

/** Bump on any change to a question's instructions, options or criteria. */
export const QUESTION_SET_VERSION = '1.0.0';

export interface VersionedQuestion<Q extends SystemoneQuestion = SystemoneQuestion> {
  /** Key in the request's `questions` map; the response answers are keyed by it. */
  name: string;
  version: string;
  question: Q;
}

const EVIDENCE_RULES =
  'Use only the evidence supplied in the state. Do not invent missing information, do not estimate prices, and do not forecast whether the trade will be profitable. If the evidence needed to answer is missing, stale or contradictory, answer INSUFFICIENT_DATA.';

export const TRADE_DECISION_QUESTION: VersionedQuestion<ChoiceQuestion> = {
  name: 'trade_decision',
  version: '1.0.0',
  question: {
    type: 'choice',
    instructions: `Evaluate the supplied ${'{side}'} candidate strictly against the strategy criteria. ${EVIDENCE_RULES}`,
    criteria: {
      APPROVE:
        'The supplied evidence satisfies the strategy: higher-timeframe trend and structure agree with the candidate side, the entry location and liquidity facts support it, the supplied risk/reward meets the strategy floor, the evidence score supports participation, and no required fact is missing.',
      WAIT: 'The setup is developing but at least one important confirmation is still missing, or the evidence is mixed rather than contradictory.',
      NO_TRADE: 'The supplied evidence conflicts with the candidate, or a mandatory setup condition fails.',
      INSUFFICIENT_DATA: 'The information required to evaluate the candidate is unavailable, stale or contradictory.',
    },
  },
};

export const PRIMARY_WEAKNESS_QUESTION: VersionedQuestion<ChoiceQuestion> = {
  name: 'primary_weakness',
  version: '1.0.0',
  question: {
    type: 'choice',
    instructions: `Identify the most important weakness in the supplied candidate using only the supplied facts. ${EVIDENCE_RULES}`,
    criteria: {
      NONE: 'No material setup weakness is evident from the supplied facts.',
      TREND_CONFLICT: 'The higher-timeframe direction conflicts with the candidate.',
      LIQUIDITY_FAILURE: 'The liquidity facts around the entry are not sufficiently established.',
      NO_DISPLACEMENT: 'Directional displacement or momentum behind the setup is missing.',
      ORDER_FLOW_CONFLICT: 'The supplied order-flow facts contradict the candidate direction.',
      POOR_RISK_REWARD: 'The supplied risk/reward does not meet the strategy requirement.',
      INSUFFICIENT_DATA: 'There is not enough evidence to identify the weakness.',
    },
  },
};

export const MTF_ALIGNMENT_QUESTION: VersionedQuestion<NoulQuestion> = {
  name: 'mtf_alignment',
  version: '1.0.0',
  question: {
    type: 'noul',
    instructions:
      'Do the supplied higher-timeframe facts support the candidate direction? Answer true only if the supplied facts support it; missing higher-timeframe evidence is not support.',
  },
};

/** The v1 set: 3 questions — deliberately far below the 64-question maximum, per the integration design. */
export const DECISION_QUESTIONS = [TRADE_DECISION_QUESTION, PRIMARY_WEAKNESS_QUESTION, MTF_ALIGNMENT_QUESTION] as const;

/**
 * Assembles the wire `questions` map. `side` is substituted into the
 * trade-decision instructions so the question names the direction it is judging.
 */
export function buildQuestionSet(side: 'LONG' | 'SHORT'): {
  questions: Record<string, SystemoneQuestion>;
  versions: Record<string, string>;
} {
  const questions: Record<string, SystemoneQuestion> = {};
  const versions: Record<string, string> = {};
  for (const vq of DECISION_QUESTIONS) {
    questions[vq.name] =
      vq === TRADE_DECISION_QUESTION
        ? { ...vq.question, instructions: vq.question.instructions.replaceAll('{side}', side) }
        : vq.question;
    versions[vq.name] = vq.version;
  }
  return { questions, versions };
}

/** Options the trade-decision answer may legitimately contain (used by the evaluator's schema check). */
export const tradeDecisionOptions = (): readonly TradeDecisionChoice[] => TRADE_DECISION_CHOICES;
export const setupWeaknessOptions = (): readonly SetupWeakness[] => SETUP_WEAKNESS_CHOICES;
