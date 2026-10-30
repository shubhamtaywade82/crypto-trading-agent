/**
 * DecisionIntelligenceService: coordinates one candidate evaluation.
 *
 * Workflow per candidate:
 *   signal + MarketState + evidence  ->  DecisionSnapshotBuilder  ->  snapshot
 *   snapshot                         ->  snapshotPrecheck         ->  (fail-closed verdict, no model call)
 *   snapshot + question registry     ->  Tev1Client (/v1/systemone)
 *   raw response                     ->  TradeDecisionEvaluator   ->  evaluation
 *   evaluation                       ->  TradeDecisionPolicy      ->  deterministic verdict
 *   everything above                 ->  DecisionAuditRepository  ->  replayable audit row
 *
 * The service NEVER throws into the trading loop: a transport timeout, a
 * malformed response or a broken audit write all degrade to a verdict — in
 * enforced mode a non-approval, in shadow mode a log line. Hard risk checks
 * (sizing, leverage, drawdown, stops) are entirely outside this layer and
 * remain unconditionally binding.
 */

import type { Tev1Client } from '../clients/tev1Client.js';
import { evaluateTradeDecisionResponse, summarizeEvaluation } from '../evaluators/tradeDecisionEvaluator.js';
import { applyTradeDecisionPolicy, POLICY_VERSION, snapshotPrecheck, type TradePolicyOptions } from '../policies/tradeDecisionPolicy.js';
import { buildQuestionSet, QUESTION_SET_VERSION } from '../questions/questionRegistry.js';
import { DecisionAuditRepository } from '../repositories/decisionAuditRepository.js';
import { buildDecisionSnapshot, type DecisionSnapshotInput } from '../snapshots/decisionSnapshotBuilder.js';
import type { DecisionAuditRecord, SystemoneRequest, SystemoneResponse, Tev1GateMode, TradeGateVerdict } from '../types.js';

export type DecisionLog = (message: string, level: 'info' | 'warn') => void;

export interface DecisionIntelligenceOptions extends TradePolicyOptions {
  client: Tev1Client;
  audit: DecisionAuditRepository;
  /** Model tag, e.g. 'tev1:4b'; stamped into requests and audit rows. */
  model: string;
  log?: DecisionLog;
}

/** One candidate to evaluate: what the live loop already holds when it reaches the gate chain. */
export type CandidateEvaluationInput = DecisionSnapshotInput & { decisionId: string };

export class DecisionIntelligenceService {
  private readonly options: DecisionIntelligenceOptions;

  constructor(options: DecisionIntelligenceOptions) {
    this.options = options;
  }

  /** Evaluates one candidate. Never throws. */
  async evaluateCandidate(input: CandidateEvaluationInput): Promise<TradeGateVerdict> {
    const startedAt = Date.now();
    const snapshot = buildDecisionSnapshot(input);

    // Pre-model precheck: incomplete geometry or an unusable MarketState is refused deterministically.
    const precheck = snapshotPrecheck(snapshot, this.options);
    if (precheck !== null) {
      const record = this.auditRow(input.decisionId, snapshot, null, null, { ok: false, tradeDecision: null, primaryWeakness: null, mtfAlignment: null, invalidReasons: [precheck.reason] }, precheck, null, startedAt);
      this.options.audit.append(record);
      this.report(precheck);
      return precheck;
    }

    const { questions, versions } = buildQuestionSet(snapshot!.setup.side);
    const request: SystemoneRequest = { model: this.options.model, state: snapshot, questions };

    let response: SystemoneResponse | null = null;
    let error: string | null = null;
    try {
      response = await this.options.client.systemone(request);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const evaluation = evaluateTradeDecisionResponse(response);
    const verdict = applyTradeDecisionPolicy(evaluation, this.options);
    const latencyMs = Date.now() - startedAt;
    this.options.audit.append(this.auditRow(input.decisionId, snapshot, request, response, evaluation, verdict, error, startedAt));
    this.report(verdict, error, latencyMs);
    return verdict;
  }

  private report(verdict: TradeGateVerdict, error: string | null = null, latencyMs: number | null = null): void {
    const log = this.options.log;
    if (!log) return;
    const suffix = [error ? `error: ${error}` : null, latencyMs !== null ? `${latencyMs}ms` : null].filter(Boolean).join(' ');
    const line = `${verdict.mode === 'shadow' ? '(shadow) would ' : ''}${verdict.gate === 'PASS' ? 'pass' : 'block'} ${verdict.reason.replace(/^tev1: /, '')}${suffix ? ` [${suffix}]` : ''}`;
    log(`TEV1 ${line}`, verdict.gate === 'PASS' ? 'info' : 'warn');
  }

  private auditRow(
    decisionId: string,
    snapshot: DecisionAuditRecord['snapshot'] | null,
    request: SystemoneRequest | null,
    response: SystemoneResponse | null,
    evaluation: DecisionAuditRecord['evaluation'],
    verdict: TradeGateVerdict,
    error: string | null,
    startedAt: number,
  ): DecisionAuditRecord {
    return {
      auditId: `tev1-${decisionId}-${startedAt}`,
      timestamp: startedAt,
      decisionId,
      symbol: snapshot?.symbol ?? '',
      model: this.options.model,
      questionSetVersion: QUESTION_SET_VERSION,
      policyVersion: POLICY_VERSION,
      mode: this.options.mode,
      latencyMs: Date.now() - startedAt,
      snapshot: snapshot ?? ({} as DecisionAuditRecord['snapshot']),
      request: request ?? { model: this.options.model, state: snapshot ?? {}, questions: {} },
      response,
      error,
      evaluation,
      verdict,
    };
  }
}

/** Builds the production service from config when the gate is enabled; null when TEV1_GATE=off. */
export function buildDecisionIntelligence(options: {
  mode: Tev1GateMode;
  model: string;
  minConfidence: number;
  client: Tev1Client;
  auditPath: string | null;
  log?: DecisionLog;
}): DecisionIntelligenceService | null {
  if (options.mode === 'off') return null;
  return new DecisionIntelligenceService({
    mode: options.mode,
    model: options.model,
    minConfidence: options.minConfidence,
    client: options.client,
    audit: new DecisionAuditRepository(options.auditPath),
    log: options.log,
  });
}
