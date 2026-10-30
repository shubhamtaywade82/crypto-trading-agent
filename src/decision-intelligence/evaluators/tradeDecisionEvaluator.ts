/**
 * TradeDecisionEvaluator: interprets a raw /v1/systemone response against the
 * question registry.
 *
 * Every answer is validated against the exact option set the question offered —
 * a choice the model was not offered is a malfunction, not a verdict. Any
 * missing or malformed answer marks the whole evaluation unusable (ok=false),
 * which the policy maps to a non-approval: in enforced mode the gate fails
 * closed on unusable responses rather than guessing.
 */

import type {
  DecisionEvaluation,
  SetupWeakness,
  SystemoneResponse,
  TradeDecisionChoice,
} from '../types.js';
import { SETUP_WEAKNESS_CHOICES, TRADE_DECISION_CHOICES } from '../types.js';
import { setupWeaknessOptions, tradeDecisionOptions } from '../questions/questionRegistry.js';

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Evaluates a response; null (transport failure) yields an unusable evaluation. */
export function evaluateTradeDecisionResponse(response: SystemoneResponse | null): DecisionEvaluation {
  const invalidReasons: string[] = [];
  if (!response) {
    return { ok: false, tradeDecision: null, primaryWeakness: null, mtfAlignment: null, invalidReasons: ['no response'] };
  }

  const tradeDecision = readChoice(response, 'trade_decision', tradeDecisionOptions(), invalidReasons);
  const primaryWeakness = readChoice(response, 'primary_weakness', setupWeaknessOptions(), invalidReasons);
  const mtfAlignment = readNoul(response, 'mtf_alignment', invalidReasons);

  return {
    ok: invalidReasons.length === 0 && tradeDecision !== null,
    tradeDecision: tradeDecision as DecisionEvaluation['tradeDecision'],
    primaryWeakness: primaryWeakness as DecisionEvaluation['primaryWeakness'],
    mtfAlignment,
    invalidReasons,
  };
}

function readChoice<T extends string>(
  response: SystemoneResponse,
  name: string,
  allowed: readonly T[],
  invalidReasons: string[],
): { choice: T; probabilities: Partial<Record<T, number>>; confidence: number } | null {
  const answer = response.answers[name];
  if (!answer) {
    invalidReasons.push(`${name}: answer missing`);
    return null;
  }
  if (answer.type !== 'choice') {
    invalidReasons.push(`${name}: expected a choice answer, got ${answer.type}`);
    return null;
  }
  const choice = answer.choice;
  if (!allowed.includes(choice as T)) {
    invalidReasons.push(`${name}: choice '${choice}' was not offered`);
    return null;
  }
  const probabilities: Partial<Record<T, number>> = {};
  for (const [option, probability] of Object.entries(answer.probabilities ?? {})) {
    if (typeof probability === 'number' && Number.isFinite(probability)) {
      probabilities[option as T] = clamp01(probability);
    }
  }
  const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? clamp01(answer.confidence) : null;
  if (confidence === null) {
    invalidReasons.push(`${name}: confidence missing or not a number`);
    return null;
  }
  return { choice: choice as T, probabilities, confidence };
}

function readNoul(response: SystemoneResponse, name: string, invalidReasons: string[]): { probabilityTrue: number } | null {
  const answer = response.answers[name];
  if (!answer) {
    invalidReasons.push(`${name}: answer missing`);
    return null;
  }
  if (answer.type !== 'noul') {
    invalidReasons.push(`${name}: expected a noul answer, got ${answer.type}`);
    return null;
  }
  if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
    invalidReasons.push(`${name}: noul probability missing or not a number`);
    return null;
  }
  return { probabilityTrue: clamp01(answer.noul) };
}

/** Convenience for logs and audit summaries: the classification in one short line. */
export function summarizeEvaluation(evaluation: DecisionEvaluation): string {
  if (!evaluation.ok) return `unusable (${evaluation.invalidReasons.join('; ') || 'no reasons recorded'})`;
  const parts = [`${evaluation.tradeDecision!.choice}@${evaluation.tradeDecision!.confidence.toFixed(2)}`];
  if (evaluation.primaryWeakness) parts.push(`weakness=${evaluation.primaryWeakness.choice}`);
  if (evaluation.mtfAlignment) parts.push(`mtf=${evaluation.mtfAlignment.probabilityTrue.toFixed(2)}`);
  return parts.join(' ');
}

export type { TradeDecisionChoice, SetupWeakness };
