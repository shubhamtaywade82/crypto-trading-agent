# Tev1 decision intelligence

A decision layer between the strategy engine and execution: a small classification model
([Tev1](https://ollama.com/library/tev1), served by Ollama's `/v1/systemone` Jev-style decision
endpoint) that evaluates each risk-approved entry candidate against the strategy criteria and
classifies it. It is a **filter, not a predictor** — it can only refuse or pass candidates the
deterministic engine already produced; it never originates an entry, prices a level, sizes a
position or executes an order.

## The honesty contract

| Tev1's output is | Tev1's output is NOT |
| --- | --- |
| A classification of the supplied evidence (`APPROVE` / `WAIT` / `NO_TRADE` / `INSUFFICIENT_DATA`) | A prediction that price will move up or down |
| `probabilities` = how it distributes its classification among the offered options | The probability that the trade hits TP, or is profitable |
| `confidence` = how concentrated its classification choice is | The probability that it is correct |
| A judgment over **computed facts supplied by this repo** | An independent market analysis (it never sees raw candles) |

Tev1 was trained on general decision-classification datasets (37,840 examples; 73.3% benchmark
accuracy for the 4B, 63.5% for 0.8B), not on trading data. Whether its classifications improve
net trading performance is an empirical question this repo answers with the benchmark plan below
— never by assuming the model's stated confidence translates to edge.

## Where it sits

```
Binance market data → Market Intelligence (indicators, MTF, SMC/ICT, order flow)
                        → Strategy Engine (signals + setups)
                          → Risk gate (deterministic: sizing, leverage, drawdown, stops)
                            → LLM veto (advisor)
                              → ★ Tev1 decision gate (this layer)   ← only OPEN_* signals, only after risk approval
                                → Execution-quality gate → Friction gate → Order manager
```

Placement decisions and why:

- **After the risk gate, not before** — a deterministic refusal never spends a model call; the
  candidates that reach Tev1 are exactly those the deterministic engine would trade.
- **Only `OPEN_*` signals** — exits, monitors and alerts are never gated (same contract as the
  friction gate).
- **Hard risk checks stay outside** — the risk engine, kill-switch and protective stops are
  unconditionally binding regardless of what Tev1 says. An `APPROVE` never lowers a stop or
  raises leverage.

## The three questions (v1, deliberately few)

Each evaluation asks exactly three questions in one `/v1/systemone` request — far below the
endpoint's 64-question maximum, per the integration design:

1. **`trade_decision`** (choice) — does the candidate satisfy the strategy criteria?
   `APPROVE` / `WAIT` / `NO_TRADE` / `INSUFFICIENT_DATA`.
2. **`primary_weakness`** (choice) — the most important weakness as a reason code:
   `NONE` / `TREND_CONFLICT` / `LIQUIDITY_FAILURE` / `NO_DISPLACEMENT` / `ORDER_FLOW_CONFLICT` /
   `POOR_RISK_REWARD` / `INSUFFICIENT_DATA`. Reason codes, not prose: the model does not produce
   a natural-language rationale, and codes can be counted.
3. **`mtf_alignment`** (noul) — do the supplied higher-timeframe facts support the candidate
   direction? Returns the probability that the answer is true.

Questions and criteria are versioned (`QUESTION_SET_VERSION`, per-question versions, stamped
into every audit row) so any historical decision can be replayed against the exact wording that
produced it.

The `state` payload is a compact **snapshot of computed facts** (`DecisionSnapshotBuilder`):
regime, per-timeframe trend/structure/ADX/RSI/ATR%, the candidate geometry with its computed
risk/reward, the deterministic evidence score and top reasons, order-flow and positioning facts,
and an explicit data-quality block. Unavailable venue features are listed in
`dataQuality.missingFeatures` — declared, never guessed or substituted. Snapshots serialize well
under the ~2,000-token input budget the model's README recommends. MarketState facts are computed
on **confirmed candles only**, so forming-bar evidence never reaches this layer.

## Gate modes and the rollout policy

`TEV1_GATE` follows the repo's tri-state gate pattern (`MICRO_ENTRY_GATE`, `LIVE_POSITION_MANAGER`):

| Mode | Behavior |
| --- | --- |
| `off` (default) | The service is not constructed; zero cost, zero calls. |
| `shadow` | Every risk-approved entry is evaluated and audited; **nothing is refused**. The recommended mode for collecting benchmark data. |
| `on` | A BLOCK verdict refuses the candidate — journaled as `TEV1_REJECTED` with the policy reason. Fails closed. |

`TEV1_GATE=on` is **refused at startup in `MODE=live`** until out-of-sample evidence exists that
the filter improves net expectancy without unacceptable missed opportunities — the same bar the
LLM council autotrade is held to. Shadow remains available in every mode.

## Policy rules (v1, deterministic and versioned)

The model classifies; the **policy engine decides**. Every rule is fixed code (`POLICY_VERSION`
stamped into audit rows):

| Evaluation | Verdict | Action |
| --- | --- | --- |
| Unusable response (timeout, malformed, choice not offered) | BLOCK | REFUSE (fail closed) |
| `INSUFFICIENT_DATA` | BLOCK | REFUSE |
| `NO_TRADE` | BLOCK | REFUSE |
| `WAIT` | BLOCK | HOLD (re-confirmation) |
| `APPROVE` below `TEV1_MIN_CONFIDENCE` (default 0.6) | BLOCK | HOLD |
| `APPROVE` at/above floor but `mtf_alignment` < 0.5 | BLOCK | HOLD |
| `APPROVE` at/above floor with aligned timeframes | PASS | PROCEED |

Before any model call, a **snapshot precheck** refuses candidates with incomplete
entry/stop/target geometry, a missing MarketState, or a MarketState older than the 45-minute
staleness budget (a state stamped on closed 15m candles is 15–30 minutes old by construction;
older means the feed stalled).

In shadow mode the identical verdicts are computed, logged (`TEV1 (shadow) would block …`) and
audited, but nothing is refused.

## Fail-closed semantics

In enforced mode, every failure is a **non-approval**:

- transport timeout (default 8 s — the decision must fail fast, not stall the 8 s loop);
- HTTP error, non-JSON body, missing `answers` envelope;
- an answer whose choice was not among the offered options;
- missing features or stale market state.

The service never throws into the trading loop; every path degrades to a verdict.

## Audit trail and replayability

Every evaluation appends one row to `TEV1_AUDIT_PATH` (default `data/tev1-decisions.jsonl`):

```jsonc
{
  "auditId": "tev1-<decisionId>-<ts>", "timestamp": 0, "decisionId": "...", "symbol": "SOLUSDT",
  "model": "tev1:4b",                    // model tag actually used
  "questionSetVersion": "1.0.0", "policyVersion": "1.0.0",
  "mode": "shadow", "latencyMs": 640,
  "snapshot": { /* the exact state payload */ },
  "request": { /* the exact wire request */ },
  "response": { /* the raw model response, or null with error set */ },
  "error": null,
  "evaluation": { /* interpreted answers: choice, probabilities, confidence, weakness, mtf */ },
  "verdict": { "gate": "PASS|BLOCK", "action": "PROCEED|HOLD|REFUSE", "enforced": false, "reason": "tev1: ..." }
}
```

With the row's `decisionId`, the decision journal's realized outcomes and the audit trail, every
decision is replayable and scoreable.

## One-shot evaluation

```
npm run tev1:eval --                              # synthetic demo candidate (no Binance, no Ollama needed)
npm run tev1:eval -- --live --symbol SOLUSDT      # real MarketState, demonstration candidate from mark + 15m ATR
npm run tev1:eval -- --side SHORT --mode shadow   # shadow verdict, nothing enforced
npm run tev1:eval -- --model tev1:0.8b            # compare the small model
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEV1_GATE` | `off` | `off` / `shadow` / `on` (see above; `on` refused in live mode) |
| `TEV1_MODEL` | `tev1:4b` | Model tag sent to `/v1/systemone` (4B is the accurate baseline; `tev1:0.8b` for tight memory) |
| `TEV1_TIMEOUT_MS` | `8000` | Per-request budget; timeouts fail closed |
| `TEV1_MIN_CONFIDENCE` | `0.6` | Classification-confidence floor for an APPROVE to pass |
| `TEV1_AUDIT_PATH` | `data/tev1-decisions.jsonl` | Replayable audit trail |

The client uses `OLLAMA_HOST` and the first `OLLAMA_API_KEY_*` (cloud hosts; a local daemon needs
no key). Tev1 requires Ollama 0.35+.

## Relationship to the LLM council

Two LLM layers, different jobs, both advisory-first:

| | LLM council (`AI-COUNCIL-κ`) | Tev1 decision gate |
| --- | --- | --- |
| Job | Five personas debate a *setup* and propose a candidate | Classify an *existing candidate* against the criteria |
| Output | TRADE/WATCH/NO_TRADE + scenario pick | APPROVE/WAIT/NO_TRADE/INSUFFICIENT_DATA + weakness code |
| Model | General chat model via `/api/generate` | Purpose-trained decision model via `/v1/systemone` |
| Enforcement | Advisory only (autotrade refused at startup) | Shadow now; `on` in paper, refused in live until benchmarked |

## The benchmark plan (next milestone)

The key question is not whether Tev1 classifies accurately — it is whether adding it improves
**net out-of-sample trading performance** without unacceptable missed opportunities or execution
delay. The audit trail above is built to answer it:

1. **Collect** — run `TEV1_GATE=shadow` over the normal paper/replay workload; every candidate
   gets an evaluation row without changing behavior.
2. **Label** — join audit rows to realized outcomes via `decisionId` (the decision journal already
   records TP/SL sequences, net PnL after fees and funding).
3. **Compare** — three arms over the same candidates: (A) baseline strategy, (B) strategy +
   Tev1 filter, (C) hybrid with a calibrated quantitative probability model. Metrics: net
   expectancy per trade, profit factor, max drawdown, win rate, trade count, **false approvals**,
   **missed profitable opportunities**, fees/funding share. Chronological walk-forward, not
   shuffled splits.
4. **Promote** — only out-of-sample evidence lifts the `MODE=live` refusal of `TEV1_GATE=on`.

The relationship between classification confidence and trading outcomes must be established by
these experiments — a 0.82 `APPROVE` confidence is not an 82% win probability.

## Layout

```
src/decision-intelligence/
  types.ts                              wire protocol + decision-layer type model
  clients/tev1Client.ts                 raw-fetch /v1/systemone client (timeout, auth, typed errors)
  snapshots/decisionSnapshotBuilder.ts  candidate + MarketState -> compact facts payload
  questions/questionRegistry.ts         versioned question set (3 questions)
  evaluators/tradeDecisionEvaluator.ts  response interpretation + option-set validation
  policies/tradeDecisionPolicy.ts       deterministic acceptance rules (POLICY_VERSION)
  repositories/decisionAuditRepository.ts  append-only replayable audit trail
  services/decisionOrchestrator.ts      DecisionIntelligenceService (never throws)
  demo/demoState.ts                     synthetic state for the CLI demo (never used in trading)
```
