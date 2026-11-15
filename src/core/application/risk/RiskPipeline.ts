import { approve, type ApprovedTrade, type RiskContext, type RiskDecision, type RiskFinding, type RiskRule, type TradeProposal } from '../../domain/risk.js';
import type { Clock } from '../../ports/Clock.js';

export interface RiskVerdict {
  readonly decision: RiskDecision;
  /** Present only when no rule blocked. The order command can be built from nothing else. */
  readonly approved: ApprovedTrade | null;
}

/**
 * An explicit, ordered list of independent rules. Every rule runs on every proposal, so a rejection reports all
 * violations rather than the first. A rule that throws blocks: an unevaluated safety check is a failed one.
 */
export class RiskPipeline {
  private readonly rules: readonly RiskRule[];

  constructor(rules: readonly RiskRule[], private readonly clock: Clock) {
    const ids = rules.map((rule) => rule.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) throw new Error(`risk rule "${duplicate}" is registered twice`);
    if (rules.length === 0) throw new Error('a risk pipeline needs at least one rule');
    this.rules = Object.freeze([...rules]);
  }

  evaluate(proposal: TradeProposal, context: RiskContext): RiskVerdict {
    const findings: RiskFinding[] = [];
    for (const rule of this.rules) {
      try {
        const finding = rule.evaluate(proposal, context);
        if (finding) findings.push(Object.freeze({ ...finding }));
      } catch (error) {
        findings.push({ ruleId: rule.id, severity: 'block', code: 'RULE_ERROR', message: `rule threw: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const decision: RiskDecision = Object.freeze({
      decisionId: proposal.decisionId,
      approved: !findings.some((finding) => finding.severity === 'block'),
      findings: Object.freeze(findings),
      evaluatedRules: this.rules.map((rule) => rule.id),
      decidedAt: this.clock.now(),
    });
    return { decision, approved: decision.approved ? approve(proposal, decision) : null };
  }

  ruleIds(): readonly string[] {
    return this.rules.map((rule) => rule.id);
  }
}
