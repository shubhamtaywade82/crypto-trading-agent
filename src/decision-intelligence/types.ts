/**
 * Type model for the Tev1 decision-intelligence layer.
 *
 * Tev1 (Ollama `/v1/systemone`, Jev-style decision models) is a *classifier*, not
 * a predictor: it receives an already-computed candidate snapshot and answers
 * versioned questions about it. It never fetches market data, never computes an
 * indicator, never sizes a position and never executes an order — those stay in
 * the deterministic engine. Its output probabilities are probabilities of its
 * classification choices, NOT probabilities that a trade will be profitable.
 *
 * This file is types and constants only: no I/O, no parsing, no policy.
 */

// ─── Wire protocol (Ollama /v1/systemone) ────────────────────────────────────

/** Question kinds the decision endpoint understands. `score` is unused by this layer (kept for completeness). */
export type SystemoneQuestionType = 'choice' | 'noul' | 'score';

/** A multiple-choice question: every option is described in `criteria`. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Option name -> what selecting it means. `null` lets the option name describe itself. */
  criteria: Record<string, string | null>;
}

/** A true/false question; the answer is the probability that the statement is true. */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export type SystemoneQuestion = ChoiceQuestion | NoulQuestion;

/**
 * One request to the decision endpoint. `state` is the evidence to judge — a
 * structured snapshot of computed facts, never raw candle history. The model
 * builds its own prompt from it.
 */
export interface SystemoneRequest {
  model: string;
  state: unknown;
  questions: Record<string, SystemoneQuestion>;
  /** Ollama keep-alive for the loaded model; omitted uses the server default. */
  keep_alive?: string;
}

/** Answer to a `choice` question: the selected option, per-option probabilities and how concentrated the choice is. */
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/** Answer to a `noul` question: the probability that the answer is true. */
export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export type SystemoneAnswer = ChoiceAnswer | NoulAnswer;

/** Response envelope. Answers come back keyed by the question names, in order. */
export interface SystemoneResponse {
  model?: string;
  answers: Record<string, SystemoneAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

// ─── Gate configuration ──────────────────────────────────────────────────────

/**
 * off:    the layer is not constructed; candidates never reach it.
 * shadow: every evaluation runs and is audited, but nothing is refused.
 * on:     a BLOCK verdict refuses the candidate (fail-closed on transport errors
 *         and malformed responses).
 */
export type Tev1GateMode = 'off' | 'shadow' | 'on';

// ─── Classification vocabularies ─────────────────────────────────────────────

/** What the trade-decision question can conclude about a candidate. */
export const TRADE_DECISION_CHOICES = ['APPROVE', 'WAIT', 'NO_TRADE', 'INSUFFICIENT_DATA'] as const;
export type TradeDecisionChoice = (typeof TRADE_DECISION_CHOICES)[number];

/**
 * The most important weakness of a candidate, as classifiable from the supplied
 * facts. Reason codes (not prose) so refusals can be counted per weakness.
 */
export const SETUP_WEAKNESS_CHOICES = [
  'NONE',
  'TREND_CONFLICT',
  'LIQUIDITY_FAILURE',
  'NO_DISPLACEMENT',
  'ORDER_FLOW_CONFLICT',
  'POOR_RISK_REWARD',
  'INSUFFICIENT_DATA',
] as const;
export type SetupWeakness = (typeof SETUP_WEAKNESS_CHOICES)[number];

// ─── Decision snapshot (the `state` payload) ─────────────────────────────────

/** Higher-timeframe facts, already computed by the deterministic engine. */
export interface TimeframeFacts {
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** Latest structural event, e.g. 'BOS_BULLISH@101.2' or 'NO_BREAK'. */
  structure: string;
  adx14: number | null;
  rsi14: number | null;
  /** ATR14 as a percentage of last close, comparable across symbols and price levels. */
  atrPct: number | null;
}

/** Order-flow and derivatives facts; every field may be missing on the venue feed. */
export interface OrderFlowFacts {
  takerBuySellRatio: number | null;
  openInterestChangePct: number | null;
  globalLongShortRatio: number | null;
  orderBookImbalance: number | null;
  spreadBps: number | null;
}

/** What the snapshot can honestly say about its own completeness. */
export interface SnapshotDataQuality {
  /** False when the MarketState was missing entirely — the candidate cannot be judged. */
  marketStatePresent: boolean;
  /** Age of the MarketState the facts were computed from, at evaluation time. */
  marketStateAgeMs: number | null;
  /** True when the MarketState is older than the staleness budget. */
  stale: boolean;
  /** MarketState facts are computed on confirmed candles only (no forming-bar evidence). */
  closedCandlesOnly: boolean;
  /** Optional venue features that were unavailable; each is declared, never guessed. */
  missingFeatures: string[];
}

/**
 * The complete, compact evidence package for one candidate. Computed facts
 * only — the model is never asked to discover structure, and raw candles are
 * never sent. Kept small enough to stay inside the ~2,000-token budget the
 * model's README recommends (see SNAPSHOT_JSON_BUDGET).
 */
export interface DecisionSnapshot {
  symbol: string;
  venue: 'BINANCE_USDM';
  decisionTimeframe: '15m';
  asOf: number;
  market: {
    regime: string;
    trendDirection: string;
    trendStrength: number;
    volatility: string;
    mark: number;
    fundingRatePct: number | null;
    rangePositionPct: number | null;
  };
  higherTimeframes: Partial<Record<'4h' | '1h' | '15m', TimeframeFacts>>;
  setup: {
    type: string;
    side: 'LONG' | 'SHORT';
    strategy: string;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    riskReward: number;
    evidenceScore: number;
    evidenceReasons: string[];
  };
  orderFlow: OrderFlowFacts;
  positioning: {
    positioningExtreme: string | null;
    fundingPercentile: number | null;
    topTraderVsGlobalBias: number | null;
  };
  dataQuality: SnapshotDataQuality;
}

/**
 * Soft budget on the serialized snapshot (characters, ~4 chars/token for JSON).
 * Enforced by tests, not at runtime: the builder is designed to fit, and a
 * breach is a design bug to fix, not a payload to silently truncate.
 */
export const SNAPSHOT_JSON_BUDGET = 6_000;

// ─── Evaluation and policy output ────────────────────────────────────────────

/** The interpreted answer set for the trade-decision question set. */
export interface DecisionEvaluation {
  /** False when the response was missing, malformed or semantically invalid — always treated as INSUFFICIENT_DATA. */
  ok: boolean;
  tradeDecision: {
    choice: TradeDecisionChoice;
    probabilities: Partial<Record<TradeDecisionChoice, number>>;
    confidence: number;
  } | null;
  primaryWeakness: {
    choice: SetupWeakness;
    probabilities: Partial<Record<SetupWeakness, number>>;
    confidence: number;
  } | null;
  mtfAlignment: { probabilityTrue: number } | null;
  /** Human-readable record of everything that failed validation, for the audit trail. */
  invalidReasons: string[];
}

/** Deterministic verdict of the policy engine over an evaluation. */
export interface TradeGateVerdict {
  /** PASS = the candidate may proceed. BLOCK = do not execute this candidate. */
  gate: 'PASS' | 'BLOCK';
  /** PROCEED | HOLD (needs confirmation) | REFUSE (hard block) | NOT_EVALUATED (gate off). */
  action: 'PROCEED' | 'HOLD' | 'REFUSE' | 'NOT_EVALUATED';
  /** True only when mode is 'on' and the verdict is actually enforced. Shadow verdicts report what would happen. */
  enforced: boolean;
  mode: Tev1GateMode;
  choice: TradeDecisionChoice | null;
  confidence: number | null;
  reason: string;
}

/** One replayable audit row: everything needed to re-run and score the decision later. */
export interface DecisionAuditRecord {
  auditId: string;
  timestamp: number;
  decisionId: string;
  symbol: string;
  model: string;
  questionSetVersion: string;
  policyVersion: string;
  mode: Tev1GateMode;
  latencyMs: number | null;
  snapshot: DecisionSnapshot;
  request: SystemoneRequest;
  response: SystemoneResponse | null;
  error: string | null;
  evaluation: DecisionEvaluation;
  verdict: TradeGateVerdict;
}
