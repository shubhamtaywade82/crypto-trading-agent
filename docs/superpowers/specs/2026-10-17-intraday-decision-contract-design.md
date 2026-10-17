# Intraday Decision Contract, v1

**Status:** proposed, not implemented. **Date:** 2026-10-17. **Scope:** SOLUSDT on Binance USD-M perpetuals (see §11.1 before implementing).

This is the contract between the deterministic decision layer, the LLM, the risk gate and the order manager. §2 records what the code does today, checked against source on this branch. Anything marked **PROPOSED** is not in code and needs calibration before it is used.

---

## 1. Decision

1. **The LLM selects; it does not price.** In v1 it returns `PROPOSE` with a triggered `setupId` and a direction, or `WATCH` / `NO_TRADE`. Price, quantity, leverage, stop and target come only from deterministic code.
2. **Admission is expectancy, not confidence.** An entry needs the lower 95% bound of net expected R, estimated on *filled* trades in the setup's bucket, to exceed `EV_MIN_LOWER_BOUND_R`. A probability stated by the LLM is never a gate.
3. **Entries are limit orders with a TTL and no repricing in v1.** A position becomes `OPEN_PROTECTED` only after the venue has acknowledged protective legs for the executed quantity.
4. **Halts block entries, not management.** A halt is a flag orthogonal to position state. It never stops stop, target or time-stop handling on an open position.
5. **The 1–10% net ROI range is a report bucket, not an entry filter.** Entries are admitted by §5, not by the size of the expected move.

---

## 2. Current code against this contract

| # | Requirement | What the code does | Status |
| --- | --- | --- | --- |
| R1 | LLM cannot place or size orders | MiniCPM worker: the LLM returns `ENTER_LONG` / `ENTER_SHORT` with stop and target. `SymbolTraderWorker.executeEntry` calls `client.submitOrder` directly (`src/minicpm/SymbolTraderWorker.ts:176`). Nothing under `src/minicpm` references `RiskEngine`, `RiskAgent`, `MarketSafety`, the kill switch or `findUnprotected`. The client is typed as `PaperExchangeClient`, so the path is paper-only today, but it bypasses the gate for any venue. | **VIOLATED** |
| R2 | Trade gated by calibrated probability | `CouncilSignal.ts:40` compares the chair's raw `probability` (LLM-stated, clamped to 0.05–0.95 in `TradingCouncil.ts`) with `LLM_COUNCIL_MIN_PROBABILITY` (0.65). `LLM_COUNCIL_AUTOTRADE` defaults to `on` in `config.ts`, so the default configuration trades on this number. Brier scores are computed (`AgentLedger.ts:156`) and fed into prompts, not into the gate. | **VIOLATED** |
| R3 | Prices come from deterministic code | Council path: stop and target come from the SetupEngine scenario. MiniCPM path: the LLM's stop and target are used as returned. `MiniCpmService.ts:89-94` checks only that the stop is on the correct side of entry; the 0.5% minimum target and the swing-low rule exist only in the prompt (`MiniCpmPrompt.ts:38-42`). `SymbolTraderWorker.ensureRecoveryLevels` invents a 1.5% stop and a 1% target when levels are missing. | **VIOLATED** (MiniCPM) |
| R4 | Expectancy gate | `riskEngine.ts` checks sizing, risk per trade, leverage, position count, daily loss, loss streak, portfolio limits, portfolio risk and circuit state. The geometric `min_rr` check runs only when `MIN_RR > 0`, and its default is 0. No expectancy check exists. | **MISSING** |
| R5 | Limit entries with TTL and optional post-only | Live entries are `type: 'MARKET'` (`client.ts:214`). No TTL, no post-only. Repricing exists only for exit stop orders (`remoteOrders.ts:247`). | **MISSING** |
| R6 | Protection confirmed before OPEN | Live: protection is placed immediately after the entry call returns (`client.ts:218`). The entry call uses the default ACK response, which the code's own comment (`client.ts:261`) says is not enough to know the executed quantity. There is no fill or protection-ack state. | **PARTIAL** |
| R7 | Partial entry fills | `submitLiveOrder` returns `{orderId, status}` only; executed quantity is not read. Protection uses `closePosition`, so it covers whatever fills, but no state records a partial entry. | **MISSING** |
| R8 | Exchange-side stops | Live: `STOP_MARKET` / `TAKE_PROFIT_MARKET` with `closePosition` (`placeServerProtectionOrders`). paper_exchange: exits are agent-side, and the README states that if the agent is offline nothing exits. | **PARTIAL** (paper path violates) |
| R9 | Stale data blocks entries | `MarketSafety` returns NO_ENTRY or HALT on stale ticks or marks (`SAFETY_TICK_STALE_MS` 15 s, `SAFETY_MARK_STALE_MS` 30 s). | **EXISTS** |
| R10 | Kill switch and drawdown circuit | `src/ops/killSwitch.ts`; `riskConfig.ts` circuit states NORMAL → CAUTION → REDUCED → HALTED → EMERGENCY. | **EXISTS** |
| R11 | Time stop | `maxHoldMs` appears only in the learning module (`HypotheticalOutcome.ts:22`) and in backtest metrics (`BacktestMetrics.ts:46`). No live exit uses it. | **MISSING** |
| R12 | Order-level state machine | `PositionManager` phases `INITIAL → PROTECTED → TRAILING → CLOSED` (`PmPhase`) cover the position only. No entry-order states exist. | **PARTIAL** |
| R13 | Replay models limit fills and partials | The README states replay fills at the next bar's open with half-spread, slippage and taker fee. Only market fills are modelled. | **MISSING** |
| R14 | Acceptance gate | `PromotionGate` `DEFAULT_PROMOTION_POLICY`: `minTrades` 30, `minOosExpectancyR` 0.05, `minProfitFactor` 1.10, `maxDrawdownR` 15, `minOosConfidence` 0.85, walk-forward summary positive. The 30-trade floor is too small for this use (§9.1). | **PARTIAL** |
| R15 | Cost-aware reward floor | `CANDIDATE_MIN_RR` 0.25 is a geometry floor and says so ("not an edge claim"). `SETUP_MIN_REWARD_RISK` 1.5 is gross reward:risk, applied before costs. | **PARTIAL** |
| R16 | Reconciliation before new orders | `liveBook` reconciles every cycle and re-places missing stops. `remoteReconcile` does the same for paper_exchange. Nothing blocks new entries while reconciliation is pending. | **PARTIAL** |
| R17 | Idempotency | `clientOrderId` is used on MiniCPM entries and on reduce-only partials. Live entries do not use it. | **PARTIAL** |

**Measured baseline (README, 90-day real-kline replay, BTC/ETH/SOL, net of fees and slippage):** 227 trades, E[R] = −0.248 with exit management off. The entries lose money before any exit logic runs. A promoted setup has to beat this, not just be positive in a window.

---

## 3. Risks and invariants

| ID | Invariant |
| --- | --- |
| I1 | Single authority. Every order goes through `evaluateEntry()` and then `evaluateRisk()`. No code path calls `submitOrder` without an approved `EntryIntent`. |
| I2 | LLM output is a selection, not a price. The parser rejects any key outside `{action, setupId, direction, rationale}`. |
| I3 | Expectancy is measured on filled trades only. A resting limit fills more often when price moves through it, so the unconditional hit rate overstates the edge. |
| I4 | The payoff has three outcomes: TARGET, STOP, TIMEOUT. Time exits are common, so a binary win/loss EV is biased. |
| I5 | No `OPEN_PROTECTED` state without venue-confirmed protective legs covering the executed quantity. |
| I6 | `OPEN_UNPROTECTED` lasts at most `UNPROTECTED_MAX_MS`, then the position is flattened with a reduce-only market order. |
| I7 | A halt blocks entries. It never blocks management of an open position. |
| I8 | `intentId` is the `newClientOrderId`. Replaying the same intent cannot open a second position. |
| I9 | Stale market data or unreconciled state blocks entries. |
| I10 | Quantity comes from the risk budget. Leverage is an output (notional ÷ allocated margin), never an input. |

**Worked example of I10 failing today.** In the MiniCPM fleet, notional = `marginPerPosition × 0.98 × leverage` = 980 × 0.98 × 10 = 9,604.4 USDT. Loss at stop (before fees and gap risk) = notional × stop distance. A 1% stop loses 96 USDT, which is 9.6% of the $1,000 account. The core `RISK_PER_TRADE_PCT` default allows 10 USDT, so this path risks about 9.6 times the core budget. Nothing in code caps the LLM's stop distance. The 1.5% recovery stop costs about 144 USDT (14.4%).

---

## 4. Return model

**Net R.** `R_unit = |entry − stop| × Q` in quote currency. An outcome's R is `NetPnL / R_unit`, where NetPnL uses actual fills, fees, slippage, and funding if a settlement was crossed.

**Price move required for a target ROI.** Let `x` be the favourable price move as a fraction of entry, `L` leverage, `f` taker fee, `s` slippage buffer. To first order:

```
ROI_net = L · (x − 2(f + s))        ⇒        x_required = ROI_net / L + 2(f + s)
```

With the repo defaults (`TAKER_FEE_RATE` 0.0004, `SLIPPAGE_BUFFER_RATE` 0.0002), `2(f+s)` = 0.12%:

| Leverage | Net ROI | x_required (repo costs) | x_required (fee 0.05%, no slippage) |
| --- | --- | --- | --- |
| 5× | 1% | 0.32% | 0.30% |
| 10× | 1% | 0.22% | 0.20% |

A maker fee is not in config. Post-only entries need `MAKER_FEE_RATE` before EV can be computed for them.

---

## 5. Entry contract

Proposed location: `src/decision/EntryContract.ts`.

```ts
export type NoTradeReason =
  | 'STALE_DATA' | 'SAFETY_NOT_NORMAL' | 'ENTRIES_BLOCKED' | 'RECONCILE_PENDING'
  | 'NO_TRIGGERED_SETUP' | 'LLM_NOT_SELECTED' | 'LLM_OUTPUT_INVALID'
  | 'SAMPLE_BELOW_MIN' | 'EV_LOWER_BOUND_BELOW_MIN' | 'STOP_DISTANCE_OUT_OF_BOUNDS'
  | 'SPREAD_TOO_WIDE' | 'RISK_REJECTED' | 'INTENT_ALREADY_SUBMITTED';

/** The only fields the LLM may return. Confidence is not a field: it may be logged for calibration, never gated on. */
export interface LlmSelection {
  action: 'PROPOSE' | 'WATCH' | 'NO_TRADE';
  setupId: string | null;
  direction: 'LONG' | 'SHORT' | null;
  rationale: string;
}

export interface OutcomeEstimate {
  bucket: string;                    // setupKind | regime | volClass
  basis: 'FILLED_TRADES';
  n: number;
  pTarget: number;
  pStop: number;
  pTimeout: number;                  // pTarget + pStop + pTimeout = 1
  rTarget: number;                   // net R per outcome, from actual fills
  rStop: number;
  rTimeout: number;
  evR: number;                       // pTarget·rTarget + pStop·rStop + pTimeout·rTimeout
  evLowerBoundR: number;             // day-blocked bootstrap, one-sided at EV_CONFIDENCE
}

export interface EntryIntent {
  intentId: string;                  // used as newClientOrderId
  symbol: string;
  side: 'LONG' | 'SHORT';
  setupId: string;
  limitPrice: number;                // tick-rounded
  quantity: number;                  // step-rounded, from positionSizer
  stopPrice: number;                 // from the setup definition
  targetPrice: number;
  leverage: number;                  // derived, clamped to [MIN_LEVERAGE, MAX_LEVERAGE]
  ttlMs: number;
  maxHoldMs: number;                 // ≤ MAX_HOLD_MINUTES
  estimate: OutcomeEstimate;
}

export type EntryDecision =
  | { kind: 'NO_TRADE'; reason: NoTradeReason; detail: string }
  | { kind: 'ENTER'; intent: EntryIntent };
```

**Evaluation order.** Each step either passes or returns `NO_TRADE` with its reason. Nothing reorders the list.

1. Freshness and safety: `MarketSafety` is NORMAL, market data is fresh, `entriesBlocked` is false, reconciliation is not pending.
2. Setup: the SetupEngine scenario is `TRIGGERED` and its quality verdict is `ENTRY_ELIGIBLE` (the same check `CouncilSignal.ts` already applies).
3. LLM selection: `PROPOSE` must name a triggered `setupId` with a matching direction. The LLM cannot create a setup.
4. Expectancy: the bucket's `OutcomeEstimate` has `n ≥ EV_MIN_BUCKET_SAMPLE` and `evLowerBoundR > EV_MIN_LOWER_BOUND_R`.
5. Geometry: stop distance lies within `[MIN_STOP_ATR_MULT, MAX_STOP_ATR_MULT] × ATR`. Spread is within `MAX_SPREAD_BPS`.
6. Sizing: `positionSizer` returns Q from `RISK_PER_TRADE_PCT`. Leverage is derived from notional and allocated margin.
7. Portfolio: `evaluateRisk()` returns approved.
8. Emit `ENTER` with an `EntryIntent`. Duplicate `intentId` values are refused.

---

## 6. Exit contract

```ts
export type ExitReason = 'TARGET' | 'STOP' | 'TIME_STOP' | 'INVALIDATION' | 'EV_DETERIORATION' | 'EMERGENCY_FLATTEN';
```

| Reason | Trigger | Execution | v1 status |
| --- | --- | --- | --- |
| TARGET, STOP | Exchange-side leg fills | Position goes flat; `EXIT_PENDING` → `CLOSED` | Live: EXISTS. paper_exchange: agent-side, violates I5 |
| TIME_STOP | `now − openedAt ≥ maxHoldMs` | Cancel non-required legs, reduce-only market close | **MISSING** |
| INVALIDATION | A predicate defined on the setup, such as a close beyond its structural level | Reduce-only market close | **PROPOSED**. The predicate is part of the setup definition. The LLM cannot define it. |
| EV_DETERIORATION | Conditional remaining E[R] ≤ 0 at the lower bound | Reduce-only market close | **Disabled** until a conditional table keyed by (bucket, elapsed-time bin, MFE/MAE bin) exists |
| EMERGENCY_FLATTEN | Circuit HALTED or EMERGENCY, `OPEN_UNPROTECTED` deadline, protection failure, exit retries exhausted | Reduce-only market close | **MISSING** as a unified path |

PositionManager ratchets (`REDUCE`, `MOVE_STOP`) stay as they are and run inside `OPEN_PROTECTED`. The LLM may log an exit request in v1, but exits are triggered only by deterministic reasons.

---

## 7. Order state machine (v1)

Evaluation (§5) is a pure function called from `FLAT`. It has no persisted state, so the input document's `EVALUATING` and `SIGNAL_DETECTED` states are dropped.

**Persisted states:** `FLAT`, `ENTRY_SUBMITTED`, `ENTRY_PARTIAL`, `ENTRY_CANCELLING`, `OPEN_UNPROTECTED`, `OPEN_PROTECTED`, `EXIT_PENDING`, `CLOSED`, `COOLDOWN`.

**Orthogonal flags:** `entriesBlocked` (set by the kill switch, circuit HALTED or EMERGENCY, stale data, reconciliation mismatch, or exit retries exhausted) and the PositionManager phase, which is a sub-state of `OPEN_PROTECTED`.

| From | Event | Guard | To | Side effects |
| --- | --- | --- | --- | --- |
| FLAT | ENTRY_APPROVED | `!entriesBlocked`, `intentId` unseen | ENTRY_SUBMITTED | LIMIT order with `newClientOrderId = intentId`; start TTL timer |
| FLAT | ENTRY_APPROVED | `intentId` already seen | FLAT | Refuse; journal `INTENT_ALREADY_SUBMITTED` |
| ENTRY_SUBMITTED | ORDER_FILLED | executed = Q | OPEN_UNPROTECTED | Place STOP_MARKET and TAKE_PROFIT_MARKET with `closePosition`; start `UNPROTECTED_MAX_MS` timer |
| ENTRY_SUBMITTED | ORDER_PARTIAL | 0 < executed < Q | ENTRY_PARTIAL | Record executed quantity; keep TTL |
| ENTRY_PARTIAL | ORDER_FILLED | executed = Q | OPEN_UNPROTECTED | As above |
| ENTRY_SUBMITTED, ENTRY_PARTIAL | TTL_EXPIRED | none | ENTRY_CANCELLING | Cancel by `intentId` |
| ENTRY_CANCELLING | FILL_UPDATE | none | ENTRY_CANCELLING | Update executed quantity; no transition |
| ENTRY_CANCELLING | FINAL_STATUS | executed = 0 | FLAT | Journal `NOT_FILLED` |
| ENTRY_CANCELLING | FINAL_STATUS | executed > 0 | OPEN_UNPROTECTED | Executed quantity is the position; place protection |
| ENTRY_SUBMITTED | ORDER_REJECTED | executed = 0 | FLAT | Journal `REJECTED` |
| OPEN_UNPROTECTED | PROTECTION_ACKED | both legs acked for the position quantity | OPEN_PROTECTED | Journal `ENTRY_CONFIRMED` |
| OPEN_UNPROTECTED | PROTECTION_FAILED, or `UNPROTECTED_MAX_MS` elapsed | none | EXIT_PENDING | EMERGENCY_FLATTEN: reduce-only market close |
| OPEN_PROTECTED | EXIT_TRIGGERED | reason ∈ {TIME_STOP, EMERGENCY_FLATTEN, INVALIDATION} | EXIT_PENDING | Cancel legs not needed; reduce-only market close |
| OPEN_PROTECTED | STOP_OR_TARGET_FILLED | none | EXIT_PENDING | Position goes flat on the venue |
| OPEN_PROTECTED | PARTIAL_EXIT_FILLED | 0 < remaining | OPEN_PROTECTED | Update PositionManager sub-state |
| EXIT_PENDING | POSITION_FLAT_CONFIRMED | venue position = 0 | CLOSED | Cancel remaining legs; journal realized R |
| EXIT_PENDING | EXIT_REJECTED | retries < `EXIT_MAX_RETRIES` | EXIT_PENDING | Retry with the same exit intent id |
| EXIT_PENDING | EXIT_REJECTED | retries exhausted | EXIT_PENDING | Set `entriesBlocked`; CRITICAL alert; keep retrying with backoff. Protective legs stay in place. |
| CLOSED | (automatic) | none | COOLDOWN | Start cooldown |
| COOLDOWN | COOLDOWN_ELAPSED | `!entriesBlocked` | FLAT | None |
| any | RECONCILE_MISMATCH | none | same state | Set `entriesBlocked`; re-place missing protective legs if the position is open |
| any | RECONCILED | none | same state | Clear reconciliation block when no other block applies |

Any (state, event) pair not listed is rejected and journaled as `INVALID_TRANSITION`. Nothing changes silently.

**Why halt is a flag and not a state.** The input document's `OPEN --> HALTED` transition would stop management of an open position when a halt fires. That is the wrong direction: a halt should stop new risk, and the protective legs and exit logic should keep running.

---

## 8. Risk configuration

**EXISTS** (current values from `src/config.ts`):

| Variable | Default | Role in this contract |
| --- | --- | --- |
| `RISK_PER_TRADE_PCT` | 1 | Risk budget per trade, % of equity (`positionSizer`) |
| `MIN_LEVERAGE` / `MAX_LEVERAGE` | 5 / 10 | Clamp on derived leverage |
| `MAX_EXPOSURE_PCT` | 80 | Gross notional cap |
| `MAX_DRAWDOWN_PCT` | 5 | Drawdown kill switch and circuit |
| `MAX_DAILY_LOSS_PCT` | 3 | `daily_loss` check |
| `MAX_LOSS_STREAK` | 4 | `loss_streak` check |
| `MAX_CONCURRENT_POSITIONS` | number of symbols | `position_count` check |
| `MAX_PORTFOLIO_RISK_PCT` | 3 | Summed loss-at-stop cap |
| `MIN_RR` | 0 | Geometric reward:risk floor. **0 disables the check.** |
| `TAKER_FEE_RATE` | 0.0004 | Fee in the cost model |
| `SLIPPAGE_BUFFER_RATE` | 0.0002 | Slippage in the cost model |
| `SAFETY_TICK_STALE_MS` / `SAFETY_MARK_STALE_MS` | 15000 / 30000 | Stale-data gate |
| `MIN_LIQ_BUFFER_ATR` | 1.2 | **README says 2; the schema default is 1.2. Resolve before implementing.** |
| `LLM_COUNCIL_MIN_PROBABILITY` | 0.65 | **Remove from the gate (R2).** |
| `LLM_COUNCIL_AUTOTRADE` | on | **Default on, so the LLM probability gate is live by default.** |

**PROPOSED** (not in config; values need calibration unless stated):

| Variable | Proposed value | Purpose |
| --- | --- | --- |
| `ENTRY_ORDER_TYPE` | `LIMIT` | `LIMIT` or `MARKET`. `MARKET` is used only for EMERGENCY_FLATTEN. |
| `ENTRY_ORDER_TTL_MS` | 120000 | About two one-minute bars |
| `ENTRY_MAX_REPRICES` | 0 | No chasing in v1 |
| `MAKER_FEE_RATE` | none; set from the account tier | Required before post-only EV |
| `EV_CONFIDENCE` | 0.95 | One-sided confidence for the EV lower bound |
| `EV_MIN_LOWER_BOUND_R` | 0.05 | Matches `PromotionGate.minOosExpectancyR` |
| `EV_MIN_BUCKET_SAMPLE` | 200 | Matches gate G1 in §9 |
| `MAX_HOLD_MINUTES` | 240 | Cap on per-setup `maxHoldMs` |
| `UNPROTECTED_MAX_MS` | 5000 | Invariant I6 |
| `EXIT_MAX_RETRIES` | 3 | Retries before `entriesBlocked` |
| `MIN_STOP_ATR_MULT` / `MAX_STOP_ATR_MULT` | none; calibrate from replay | Stop-distance bounds |
| `MAX_SPREAD_BPS` | none; calibrate from recorded book data | Spread gate |
| `LLM_GATES_TRADES` | `off` | v1: the LLM selects setups and never gates by its own number |

---

## 9. Backtest and forward acceptance

### 9.1 Why 30 trades is not enough

Let the break-even hit rate be p₀ = 2/3, from the input document's example (target +1%, stop −2%). Use a one-sided 95% test (z = 1.645), 80% power (z = 0.84), and a binomial approximation:

```
n = [ (1.645·√(p₀q₀) + 0.84·√(p₁q₁)) / (p₁ − p₀) ]²
```

| True hit rate p₁ | Trades needed |
| --- | --- |
| 0.70 | ≈ 1,210 |
| 0.75 | ≈ 187 |
| 0.80 | ≈ 70 |

With 30 trades, the smallest hit rate detected reliably is ≈ 0.86. Variable payoffs, timeouts and fill conditioning all change the variance, so treat these figures as lower bounds. `PromotionGate.minTrades = 30` is too low for any setup whose edge is a hit rate.

### 9.2 Gates

| Gate | Criterion | Source |
| --- | --- | --- |
| G1 Sample | ≥ 200 filled OOS trades per bucket used for entry; ≥ 500 in total | PROPOSED |
| G2 Expectancy | Day-blocked bootstrap, one-sided 95% lower bound of net E[R] on filled trades > 0.05 R | Value EXISTS (`PromotionGate`); confidence level PROPOSED (the gate uses 0.85) |
| G3 Profit factor | Net PF ≥ 1.10 | EXISTS (`PromotionGate`) |
| G4 Drawdown | Max drawdown ≤ 15 R | EXISTS (`PromotionGate`) |
| G5 Walk-forward | ≥ 4 consecutive OOS folds, each with n ≥ 30 and E[R] > 0 | PROPOSED. `PromotionGate` checks only that the summary is positive. |
| G6 Cost stress | E[R] > 0 with fees × 1.5 and slippage × 2 | PROPOSED |
| G7 Selection deflation | Lower bound at confidence 1 − 0.05/K, where K = configurations tried, taken from `ExperimentStore` or sweep logs | PROPOSED |
| G8 Fill realism | Replay uses limit fills (trade-through rule), TTL and partials. E[R] is reported separately for filled and unfilled orders. | PROPOSED. **Currently MISSING (R13).** |
| G9 Failure injection | Every test in §12 passes | PROPOSED |
| G10 Shadow | ≥ 4 weeks on the live feed with no orders. Realized fill rate is within a stated band of predicted, and realized E[R] lower bound is > 0. | PROPOSED |

**Trade-through fill rule for G8.** A resting buy fills only if the bar's low is strictly below the limit price. A touch (low equal to the limit) does not fill. This is conservative by design.

---

## 10. Challenges to the input document

1. **The EV formula is binary.** `EV = pW − (1−p)L` has no TIMEOUT or partial-exit term. Replace it with the three-outcome E[R] in §5.
2. **The LLM's probability contradicts the document's own rule.** The document says probability must not come from verbal confidence. The repo already gates on it (`CouncilSignal.ts:40`). Replace the gate with the empirical estimator.
3. **Adverse selection.** A resting limit fills more often when price moves through it. The hit rate conditional on a fill is lower than the unconditional one. Estimate on filled trades only (I3).
4. **The 1–10% band does two jobs.** The document says "not a fixed target" and also "target between 1% and 10%". As a filter, the band selects on the size of the move, not on expectancy. Keep it as a report bucket.
5. **HALTED as a state is unsafe from OPEN.** See §7. Halt must be a flag.
6. **The rehearsal path cannot test the main invariant.** The document requires exchange-side protection. paper_exchange exits are agent-side, so a paper run cannot show that the protective legs work.
7. **No time stop.** §4B says strategies need maximum holding-time rules, but the exit table has no TIME_STOP row. Add it (§6).
8. **"Bracket orders."** This codebase uses separate `closePosition` conditional legs. It has no bracket primitive. The spec requires both legs to be acknowledged before OPEN (I5).
9. **Venue and market.** The document describes Binance USD-M perpetuals. The user preference file describes NSE, DhanHQ and options buying only. These cannot both be the target. See §11.1.

---

## 11. Decisions needed from the owner

1. **Venue and market.** This spec follows the pasted document and the repo: Binance USD-M SOLUSDT, long and short. The user preference file says NSE / DhanHQ / options buying only. Options have premium decay and no funding, so the EV model would need to change. Confirm before implementation.
2. **Remove the LLM probability gate.** Recommended. It is on by default today (R2).
3. **Stop the MiniCPM order path until it goes through `RiskEngine`.** Recommended (R1, I1).
4. **Entry order type.** Recommended: LIMIT with TTL in v1. The alternative is keeping MARKET and adding TTL later, which leaves I3 and I5 unmet on the live path.

---

## 12. Verification

**Unit tests** (`node:test` under `tests/`, the repo's existing convention):

- Outcome estimator: a fixture of filled trades gives the expected pTarget, pStop, pTimeout, evR and lower bound. A fixed seed makes the bootstrap deterministic.
- A bucket with `n < EV_MIN_BUCKET_SAMPLE` returns `NO_TRADE` with `SAMPLE_BELOW_MIN`.
- LLM schema: an extra key (`price`, `quantity`, `leverage`, `stopLoss`, `probability`) returns `LLM_OUTPUT_INVALID`.
- Transition table: enumerate every state × event pair. Each pair is either in the table with exactly one target, or rejected as `INVALID_TRANSITION`.
- Halt flag: with `entriesBlocked = true`, an open `OPEN_PROTECTED` position still gets its stop re-placed, and its TIME_STOP still fires.

**Failure injection** (`tests/support/fakeExchange.ts`):

- Protection rejected → `EXIT_PENDING` within `UNPROTECTED_MAX_MS` and a reduce-only close is sent.
- TTL expires while a fill races the cancel → ends in `OPEN_UNPROTECTED`, never `FLAT`.
- WebSocket silent for longer than `SAFETY_TICK_STALE_MS` → `NO_TRADE: STALE_DATA`.
- Reconciliation mismatch → `entriesBlocked`, and the open position's protective legs are re-placed.
- Exit rejected `EXIT_MAX_RETRIES` times → `entriesBlocked`, and the protective legs stay in place.

**Replay:** a bar whose low is strictly below a buy limit fills at the limit. A bar whose low equals the limit does not fill.

**Expected log sequence for one trade** (format example; values illustrative, not output):

```
[decision] SOLUSDT ENTER setup=<id> bucket=<setupKind|regime|vol> n=<n> evLowerBound=<R>
[order]    SOLUSDT LIMIT BUY qty=<Q> price=<P> ttlMs=120000 clientOrderId=<intentId>
[order]    SOLUSDT FILLED qty=<Q> state ENTRY_SUBMITTED -> OPEN_UNPROTECTED
[protect]  SOLUSDT STOP_MARKET closePosition stop=<S> acked
[protect]  SOLUSDT TAKE_PROFIT_MARKET closePosition target=<T> acked
[state]    SOLUSDT OPEN_UNPROTECTED -> OPEN_PROTECTED
```

**Shadow (G10):** the same decisions run on the live feed for at least four weeks with no orders. The journal records predicted fill, realized fill, and the realized R of each simulated trade.
