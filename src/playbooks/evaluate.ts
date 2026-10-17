import type { SetupVerdict } from '../decision/SetupTypes.js';
import { deriveFacts } from './derive.js';
import { listPlaybooks } from './registry.js';
import { RULES } from './rules.js';
import type { PlaybookContext, PlaybookDefinition, PlaybookVerdict, RuleEvaluation, RuleId, SetupFacts, TradeDirection } from './types.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function runRule(ruleId: RuleId, facts: SetupFacts, ctx: PlaybookContext, pb: PlaybookDefinition): RuleEvaluation {
  const { stage, evaluate } = RULES[ruleId];
  try {
    return { ruleId, stage, ...evaluate(facts, ctx, pb) };
  } catch (err) {
    // A rule that cannot be evaluated fails closed: the verdict can only get stricter, never looser
    return { ruleId, stage, passed: false, reason: `rule error: ${errorText(err)}` };
  }
}

/**
 * Evaluates one playbook in one direction. Never throws.
 *
 * - Any CONTEXT or SETUP failure: NO_TRADE (the hypothesis does not hold, or has expired).
 * - Otherwise any TRIGGER failure: WATCH (the hypothesis holds and waits for confirmation). EXECUTION rules need the
 *   confirmed entry, so they are not run and are listed as pending.
 * - Otherwise any EXECUTION failure: NO_TRADE.
 * - Otherwise ENTRY_ELIGIBLE. Risk budget and sizing stay with RiskEngine downstream.
 */
export function evaluatePlaybook(pb: PlaybookDefinition, ctx: PlaybookContext, direction: TradeDirection): PlaybookVerdict {
  let facts: SetupFacts;
  try {
    facts = deriveFacts(ctx, pb, direction);
  } catch (err) {
    const failure: RuleEvaluation = { ruleId: 'frames_present', stage: 'CONTEXT', passed: false, reason: `setup derivation failed: ${errorText(err)}` };
    return {
      playbookId: pb.id, version: pb.version, symbol: ctx.symbol, direction, evaluatedAt: ctx.now,
      verdict: 'NO_TRADE', armedAt: null, triggeredAt: null, plan: null,
      evaluations: [failure], failed: [failure], pending: pb.rules.filter((r) => RULES[r].stage === 'EXECUTION'),
    };
  }

  const before = pb.rules.filter((r) => RULES[r].stage !== 'EXECUTION').map((r) => runRule(r, facts, ctx, pb));
  const triggerPassed = before.filter((e) => e.stage === 'TRIGGER').every((e) => e.passed);
  const executionRules = pb.rules.filter((r) => RULES[r].stage === 'EXECUTION');
  const execution = triggerPassed ? executionRules.map((r) => runRule(r, facts, ctx, pb)) : [];
  const evaluations = [...before, ...execution];
  const failed = evaluations.filter((e) => !e.passed);

  const failedIn = (stage: RuleEvaluation['stage']) => failed.some((e) => e.stage === stage);
  const verdict: SetupVerdict = failedIn('CONTEXT') || failedIn('SETUP') ? 'NO_TRADE'
    : failedIn('TRIGGER') ? 'WATCH'
      : failedIn('EXECUTION') ? 'NO_TRADE'
        : 'ENTRY_ELIGIBLE';

  return {
    playbookId: pb.id,
    version: pb.version,
    symbol: ctx.symbol,
    direction,
    evaluatedAt: ctx.now,
    verdict,
    armedAt: facts.armedAt,
    triggeredAt: facts.triggerClosedAt,
    plan: verdict === 'ENTRY_ELIGIBLE' ? facts.plan : null,
    evaluations,
    failed,
    pending: triggerPassed ? [] : executionRules,
  };
}

/** Every registered playbook in both directions. */
export function evaluateAllPlaybooks(ctx: PlaybookContext, playbooks: readonly PlaybookDefinition[] = listPlaybooks()): PlaybookVerdict[] {
  return playbooks.flatMap((pb) => (['LONG', 'SHORT'] as const).map((direction) => evaluatePlaybook(pb, ctx, direction)));
}
