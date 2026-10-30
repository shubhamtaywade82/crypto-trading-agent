/**
 * TradeDecisionPolicy: the deterministic acceptance rules applied to a Tev1
 * evaluation. The model classifies; THIS code decides — and every rule here is
 * fixed, versioned and auditable, so the gate's behavior can be replayed and
 * benchmarked without the model.
 *
 * v1 rules (fail-closed in enforced mode):
 *  - unusable evaluation (missing/malformed/invalidated answers)  -> REFUSE
 *  - INSUFFICIENT_DATA                                            -> REFUSE
 *  - NO_TRADE                                                     -> REFUSE
 *  - WAIT                                                         -> HOLD (re-confirmation)
 *  - APPROVE below the confidence floor                           -> HOLD
 *  - APPROVE at/above the floor but higher timeframes do not
 *    support the direction (mtf_alignment < 0.5)                  -> HOLD
 *  - otherwise                                                    -> PROCEED
 *
 * 'enforced' is true only when mode is 'on'; shadow verdicts report exactly
 * what would happen without refusing anything.
 */

import type { DecisionEvaluation, DecisionSnapshot, Tev1GateMode, TradeDecisionChoice, TradeGateVerdict } from '../types.js';
import { STALE_MARKET_STATE_MS } from '../snapshots/decisionSnapshotBuilder.js';

/** Bump on any change to the rules above; stamped into every audit record. */
export const POLICY_VERSION = '1.0.0';

/** An APPROVE the higher timeframes do not support is a WAIT, not a trade. */
export const MTF_ALIGNMENT_FLOOR = 0.5;

export interface TradePolicyOptions {
  mode: Tev1GateMode;
  /** Minimum classification confidence for an APPROVE to pass. */
  minConfidence: number;
}

/**
 * Deterministic pre-check on the snapshot itself, before any model call: a
 * candidate on a missing or stale MarketState cannot be judged, so the verdict
 * is a fail-closed refusal (or, in shadow, the same verdict logged) without
 * spending a request. Returns null when the snapshot is fit to be judged.
 */
export function snapshotPrecheck(snapshot: DecisionSnapshot | null, options: TradePolicyOptions): TradeGateVerdict | null {
  if (snapshot === null) {
    return refuse(options, 'tev1: candidate geometry incomplete — no risk/reward to validate (INSUFFICIENT_DATA)');
  }
  if (!snapshot.dataQuality.marketStatePresent) {
    return refuse(options, 'tev1: no MarketState for the candidate (INSUFFICIENT_DATA)');
  }
  if (snapshot.dataQuality.marketStateAgeMs !== null && snapshot.dataQuality.marketStateAgeMs > STALE_MARKET_STATE_MS) {
    return refuse(options, `tev1: MarketState ${Math.round(snapshot.dataQuality.marketStateAgeMs / 60_000)}m old is stale (INSUFFICIENT_DATA)`);
  }
  return null;
}

/** Applies the v1 rules to an evaluation. Never throws. */
export function applyTradeDecisionPolicy(evaluation: DecisionEvaluation, options: TradePolicyOptions): TradeGateVerdict {
  if (options.mode === 'off') {
    return { gate: 'PASS', action: 'NOT_EVALUATED', enforced: false, mode: options.mode, choice: null, confidence: null, reason: 'tev1 gate off' };
  }
  const enforced = options.mode === 'on';

  if (!evaluation.ok || evaluation.tradeDecision === null) {
    return {
      gate: 'BLOCK', action: 'REFUSE', enforced, mode: options.mode, choice: 'INSUFFICIENT_DATA', confidence: null,
      reason: `tev1: unusable response — ${evaluation.invalidReasons.join('; ') || 'no reasons recorded'}`,
    };
  }

  const { choice, confidence } = evaluation.tradeDecision;
  switch (choice) {
    case 'APPROVE': {
      if (confidence < options.minConfidence) {
        return hold(options, choice, confidence, `tev1: APPROVE confidence ${confidence.toFixed(2)} below floor ${options.minConfidence.toFixed(2)}`);
      }
      const mtf = evaluation.mtfAlignment?.probabilityTrue ?? null;
      if (mtf !== null && mtf < MTF_ALIGNMENT_FLOOR) {
        return hold(options, choice, confidence, `tev1: APPROVE but higher timeframes do not support the direction (mtf_alignment ${mtf.toFixed(2)} < ${MTF_ALIGNMENT_FLOOR})`);
      }
      return {
        gate: 'PASS', action: 'PROCEED', enforced, mode: options.mode, choice, confidence,
        reason: `tev1: APPROVE${mtf !== null ? ` mtf_alignment ${mtf.toFixed(2)}` : ''}`,
      };
    }
    case 'WAIT':
      return hold(options, choice, confidence, `tev1: WAIT — confirmation still missing${evaluation.primaryWeakness && evaluation.primaryWeakness.choice !== 'NONE' ? ` (primary weakness: ${evaluation.primaryWeakness.choice})` : ''}`);
    case 'NO_TRADE':
      return refuse(options, `tev1: NO_TRADE${evaluation.primaryWeakness && evaluation.primaryWeakness.choice !== 'NONE' ? ` (primary weakness: ${evaluation.primaryWeakness.choice})` : ''}`, choice, confidence);
    case 'INSUFFICIENT_DATA':
      return refuse(options, `tev1: INSUFFICIENT_DATA${evaluation.invalidReasons.length ? ` — ${evaluation.invalidReasons.join('; ')}` : ''}`, choice, confidence);
  }
}

function hold(options: TradePolicyOptions, choice: TradeDecisionChoice, confidence: number, reason: string): TradeGateVerdict {
  return { gate: 'BLOCK', action: 'HOLD', enforced: options.mode === 'on', mode: options.mode, choice, confidence, reason };
}

function refuse(options: TradePolicyOptions, reason: string, choice: 'NO_TRADE' | 'INSUFFICIENT_DATA' = 'INSUFFICIENT_DATA', confidence: number | null = null): TradeGateVerdict {
  return { gate: 'BLOCK', action: 'REFUSE', enforced: options.mode === 'on', mode: options.mode, choice, confidence, reason };
}
