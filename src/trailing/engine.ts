import type { PolicyContext, StopCandidate, TrailingDecision, TrailingPolicy, TrailingState } from './types.js';
import { atrTrail, chandelier } from './price.js';
import { bosChoch, swingTrail } from './structure.js';

/**
 * Decision aggregator (spec §3, §5). Every candidate and stop lives in directional coordinates
 * X = s·price, so the whole engine is one ratchet: exit when X ≤ stopZ, otherwise accept only the
 * tightest candidate above the current stop. The engine is pure — it never ACKs stops (confirmStop
 * in stateMachine.ts owns that) and never touches the orchestrator or order path (phase 4).
 */

type Evaluator = (policy: TrailingPolicy, ctx: PolicyContext, state: TrailingState) => StopCandidate | null;

function evaluatorFor(method: TrailingPolicy['method']): Evaluator {
  switch (method) {
    case 'ATR_TRAIL': return atrTrail;
    case 'CHANDELIER': return chandelier;
    case 'SWING': return swingTrail;
    case 'BOS_CHOCH': return bosChoch;
    default: throw new Error(`trailing method ${method} is not implemented in this phase`);
  }
}

export interface TrailingEvaluation {
  state: TrailingState;
  decision: TrailingDecision;
}

interface RunResult {
  x: number;
  ran: string[];
  policyById: Map<string, TrailingPolicy>;
  cands: StopCandidate[];
  loosening: number;
  invalid: number;
}

// Favorable excursion in R: (F − entry)/D0, D0 = initial risk — thresholds comparable across
// symbols and sizes without carrying units into the policy grid.
function favorableExcursionR(state: TrailingState, ctx: PolicyContext): number {
  const x0 = ctx.s * ctx.position.entry;
  const d0 = ctx.position.initialRisk ?? Math.abs(ctx.position.entry - ctx.s * state.confirmedStop);
  return d0 > 0 ? (state.favorableExtremeX - x0) / d0 : 0;
}

function activated(policy: TrailingPolicy, ctx: PolicyContext, state: TrailingState): boolean {
  switch (policy.activation.type) {
    case 'IMMEDIATE': return true;
    case 'NEVER': return false;
    case 'TP1_FILLED': return false; // wired with the position manager in phase 4
    case 'PEAK_PNL': return (state.peakNetPnl ?? 0) >= policy.activation.threshold;
    case 'MFE_R': return favorableExcursionR(state, ctx) >= policy.activation.threshold;
  }
}

function advanceState(prev: TrailingState, ctx: PolicyContext, x: number, now: number): TrailingState {
  const excursion = x - ctx.s * ctx.position.entry;
  return {
    ...prev,
    favorableExtremeX: Math.max(prev.favorableExtremeX, x),
    mfeX: Math.max(prev.mfeX, excursion),
    maeX: Math.min(prev.maeX, excursion),
    updatedAt: now,
  };
}

function collectRun(state: TrailingState, ctx: PolicyContext, policies: readonly TrailingPolicy[], x: number): RunResult {
  const active = policies.filter((p) => p.enabled && activated(p, ctx, state));
  const cands: StopCandidate[] = [];
  for (const policy of active) {
    const candidate = evaluatorFor(policy.method)(policy, ctx, state);
    if (candidate) cands.push(candidate);
  }
  return {
    x,
    ran: active.map((p) => p.id),
    policyById: new Map(active.map((p) => [p.id, p])),
    cands,
    loosening: cands.filter((c) => c.levelZ <= state.stopZ).length,
    invalid: cands.filter((c) => c.levelZ >= x).length,
  };
}

function evidenceOf(state: TrailingState, run: RunResult | null): TrailingDecision['evidence'] {
  if (!run) return { stopZ: state.stopZ, candidates: 0 };
  return {
    x: run.x,
    extreme: state.favorableExtremeX,
    stopZ: state.stopZ,
    candidates: run.cands.length,
    rejectedLoosening: run.loosening,
    rejectedInvalid: run.invalid,
  };
}

function holdDecision(state: TrailingState, reasonCode: string, now: number, run: RunResult | null): TrailingDecision {
  return {
    positionId: state.key,
    policyIds: run ? run.ran : [],
    action: 'HOLD',
    reasonCode,
    evidence: evidenceOf(state, run),
    ts: now,
  };
}

function breachExit(state: TrailingState, policies: readonly TrailingPolicy[], x: number, now: number): TrailingDecision {
  const acked = state.lastAcceptedDecision;
  const source = acked ? policies.find((p) => p.id === acked.policyId) : undefined;
  return {
    positionId: state.key,
    policyIds: [],
    action: 'EXIT',
    triggerReference: source?.priceReference ?? 'CONTRACT_PRICE',
    triggerDomain: source?.domain ?? 'CONTRACT',
    reasonCode: acked ? `STOP_BREACH:${acked.policyId}` : 'INITIAL_STOP_BREACH',
    evidence: { x, extreme: state.favorableExtremeX, stopZ: state.stopZ, breachZ: state.stopZ },
    ts: now,
  };
}

function structureExit(state: TrailingState, run: RunResult, exit: StopCandidate, now: number): TrailingDecision {
  const source = run.policyById.get(exit.policyId);
  return {
    positionId: state.key,
    policyIds: run.ran,
    action: 'EXIT',
    triggerReference: exit.priceReference,
    triggerDomain: source?.domain ?? 'CONTRACT',
    reasonCode: exit.reason,
    evidence: { ...evidenceOf(state, run), breachZ: exit.levelZ },
    ts: now,
  };
}

export function evaluate(prev: TrailingState, ctx: PolicyContext, policies: readonly TrailingPolicy[], now: number): TrailingEvaluation {
  const x = ctx.s * ctx.price;
  if (!Number.isFinite(x) || !(ctx.price > 0)) {
    return { state: prev, decision: holdDecision(prev, 'INVALID_CONTEXT', now, null) };
  }
  const state = advanceState(prev, ctx, x, now);
  if (x <= prev.stopZ) {
    return { state, decision: breachExit(state, policies, x, now) };
  }
  const run = collectRun(state, ctx, policies, x);
  const exit = run.cands.find((c) => c.exit === true);
  if (exit) {
    return { state, decision: structureExit(state, run, exit, now) };
  }
  const tighter = run.cands.filter((c) => c.levelZ > state.stopZ && c.levelZ < x);
  const winner = tighter.length > 0 ? tighter.reduce((a, b) => (b.levelZ > a.levelZ ? b : a)) : null;
  if (!winner) {
    return { state, decision: holdDecision(state, 'NO_CHANGE', now, run) };
  }
  const next: TrailingState = { ...state, stopZ: winner.levelZ };
  const decision: TrailingDecision = {
    positionId: state.key,
    policyIds: run.ran,
    action: 'MOVE_STOP',
    stopPrice: ctx.s * winner.levelZ,
    stopZ: winner.levelZ,
    reasonCode: winner.reason,
    evidence: { ...evidenceOf(state, run), acceptingPolicyId: winner.policyId },
    ts: now,
  };
  return { state: next, decision };
}
