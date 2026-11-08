# Directional move capture

Research and decision layer for: **given a confirmed rejection, is there calibrated evidence and known room for a move of 1, 2, 3, 5 or 10% before the stop?** It returns NO_TRADE unless every gate passes.

Code: `src/market/directional/`. Builds on `src/market/rejection/` (see `docs/rejection-zones.md`). Tests: `tests/directional*.test.ts` (65 tests).

**Status: machinery built and tested; no probability is calibrated.** Repo data is too short, and Binance market data is unavailable from this environment (the API returns HTTP 451, a restricted-location notice). Every symbol returns NO_TRADE, which is the intended state until evidence exists. This module is not connected to order execution.

## Milestone changes (review of `0059dbe`)

| Review issue | Change | Where |
| --- | --- | --- |
| Hit probability published from training only; holdout checked only for net mean | Holdout hit rate reported with its own interval; calibration checked against the holdout under a versioned criterion (`HOLDOUT_V1`). A cell that fails is not published | `probability.ts` `evaluateHoldout`, `potential.ts` |
| Wilson intervals assume independent outcomes | Hit intervals are day-clustered bootstrap. Wilson is kept as a diagnostic | `probability.ts` `labelStats` |
| Unknown room treated as unlimited | Unknown room blocks every target (`ROOM_UNVERIFIED`). Capacity can only come from a validated model | `potential.ts`, `room.ts` |
| Constant hourly funding | Settlement-accurate funding from `perp_funding_history` rows, with a coverage check that fails closed. Constant rate remains as a labelled fallback | `barriers.ts` `fundingCostPct`, `assertFundingCoverage`, `fundingSettlementsFromRows` |
| Scale-out ladder is geometry only | Paired replay of single-target and ladder policies on identical entries and initial risk, in R multiples | `scaleout-replay.ts` |
| Moves, capacity and expectancy conflated | Three separate outputs: `moveProbability`, `capacity`, `tradeExpectancy` | `potential.ts` |
| No way to check history completeness | Per-day 1m coverage and gap count | `rejection/bars.ts` `minuteCoverageByDay` |

## Defects found while building the runner

| Defect | Effect | Fix |
| --- | --- | --- |
| The existing archive loader keeps six kline columns | Quote and taker-buy volume are missing, so the rejection and flow features cannot be computed from the archive | `archive-flow.ts`: a twelve-column loader that fails closed on bad timestamps, short rows and missing files |
| An experiment in which every symbol is excluded crashed in the table builder | The exclusions were lost | `runExperiment` reports an empty table with the exclusion reasons |
| A sweep bar that is large, high-volume and up-closing counted as directional expansion | A held rejection was overwritten by `VOLATILITY_EXPANSION` on the next sweep. 299 of 300 synthetic setups were tagged that way, so the tags would have selected the wrong population for EXP-001 | Expansion and exhaustion evidence exclude sweep bars. Regression test: `directionalContext.test.ts` (fails without the fix) |

No experiment result depends on the third defect, because none has been run.

## Reuse

| Need | Existing module | Used as |
| --- | --- | --- |
| Outcome conventions | `playbooks/outcome.ts` | Stop before target in a bar; stop gaps fill at open; missing bars are UNRESOLVED |
| Stops, ratchet, partial fills, execution | `trailing/` (spec `2026-11-03-crypto-futures-trailing-engine-design.md`) | Owns execution. The replay's trail is a research control |
| Settlement history | `scripts/pit-seed-funding.ts` → `perp_funding_history` | Input to `fundingSettlementsFromRows` |
| Cluster bootstrap, Holm | `research/Bootstrap.ts` | Intervals and family correction |
| Admission floors | `playbooks/calibration.ts` (200 setups, 20 decision days) | Same floors |
| Volatility phase | `market/VolatilityPhase.ts` | ATR percentile bands |
| Kline archive | `backtesting/archiveKlines.ts` | Designed for geo-blocked environments. Not run from here |

## Pipeline

```
RejectionEvent[] (CONFIRMED)  +  FlowBar[] (1m or higher)  +  FundingSettlement[] (from perp_funding_history)
   │
   ├─ classifyExpansionContext   per-bar state, one legal transition per bar, decays to NONE
   ├─ setupsFromRejections       entry = confirming close; stop = sweep extreme ± k·ATR; tag = context at entry
   ├─ labelBarriers              TARGET | STOP | TIMEOUT | UNRESOLVED; MFE, MAE; fee + slippage + settlement funding
   ├─ buildTargetTable           purged chronological split → train admission (Holm) → holdout calibration check
   ├─ availableRoom              distance to the nearest live opposing zone
   ├─ replayPolicy               paired exit-policy replay on the same setups (scale-out study)
   └─ assessDirectionalPotential gates → LONG | SHORT | NO_TRADE, with three separate outputs
```

## Expansion context

One state machine per side, in directional coordinates (LONG: price; SHORT: −price).

| State | Entered by | Meaning |
| --- | --- | --- |
| RANGE_COMPRESSION | ATR percentile in the COMPRESSED band | Watch |
| LIQUIDITY_SWEEP | A sweep bar without absorbed sell flow | Watch for reclaim |
| ABSORPTION_CANDIDATE | A sweep bar whose sell-led flow the price reclaimed | Watch for confirmation |
| REJECTION_CONFIRMED | Rejection confirmed | **Entry context** |
| STRUCTURE_SHIFT | Close through the most recent lower swing high, first time | **Entry context** |
| VOLATILITY_EXPANSION | Bar range ≥ `expansionAtr` × ATR with relative volume ≥ threshold, in the side's direction | **Entry context** |
| TREND_CONTINUATION | After a break, a higher low forms and the close holds above the break | **Entry context** |
| EXPANSION_EXHAUSTION | Opposing displacement of the same size, or a close back through the broken level | Avoid / reduce |

- Transitions are limited to `ALLOWED_TRANSITIONS`. A bar makes at most one transition.
- Each state decays to NONE after `maxStateBars` (default 96) with no transition.
- Swing pivots need `swingK` bars on each side and are known only at `index + k`.
- Incomplete or non-contiguous bars reset the machine to NONE.

## Barrier labels and costs

For each setup, target `T` (percent of entry) and horizon `H`:

- The first bar touching the stop gives STOP. If the same bar touches the target, the result is still STOP.
- A stop gap that opens beyond the stop fills at the open.
- The first bar touching the target gives TARGET, filled at the target price.
- Neither within `H` gives TIMEOUT, exited at the horizon close.
- A missing or incomplete bar before resolution gives UNRESOLVED, which is excluded from all statistics.

**Costs** are required input and have no default.

- **Fee and slippage:** 2 × (fee + slippage) per round trip.
- **Funding, settlement model (`SETTLEMENTS`):** each settlement with `entryTime < time ≤ exitTime` is charged `side × rate × mark / entry`. A LONG pays a positive rate and a SHORT receives it. Coverage is checked before labelling. A gap longer than 8 h, or a missing edge, throws `FUNDING_COVERAGE`.
- **Funding, fallback (`CONSTANT_FALLBACK`):** a constant hourly rate. Every label records `fundingModel`, and `fundingModels` appears on every cell and candidate, so a mixed or fallback basis cannot pass unnoticed.

`netReturnPct` = gross − fee/slippage − funding.

## Probability tables

- `hitBeforeStop` = TARGET ÷ (TARGET + STOP + TIMEOUT). A timeout is a miss.
- **Hit interval:** day-clustered bootstrap, two-sided at the policy confidence (0.9). Wilson is reported as a diagnostic.
- **Expectancy:** cluster bootstrap of net return by UTC day.
- **Purged split:** the last `holdoutFraction` of entry times is the holdout. Training labels whose horizon runs into the holdout are dropped.
- **Train admission:** ≥ 200 resolved setups, ≥ 20 days, expectancy lower bound > 0, Holm-rejected across testable cells at α = 0.05.
- **Holdout criterion (`HOLDOUT_V1`):** holdout ≥ 100 resolved setups and ≥ 10 days; |holdout hit − train hit| ≤ 0.05; the train estimate lies inside the holdout's clustered interval; holdout mean net return > 0. Each table stamps its criterion `id`.

**Provisional criterion values.** The `HOLDOUT_V1` numbers were chosen as starting points before any historical run. They are not pre-registered in a timestamped record yet. Before the first experiment, the values should be committed as a dated record, and any change should create a new id.

## Gates in `assessDirectionalPotential`

The first failure returns NO_TRADE with its reason.

1. The stop is beyond entry and no wider than `maxStopPct` (required input).
2. The context is an entry context.
3. An admitted cell exists for this symbol, side and context.
4. The cell passes `HOLDOUT_V1`. Otherwise `HOLDOUT_CALIBRATION_FAILED`.
5. Capacity is known: a validated capacity model, or a known opposing zone. Otherwise `ROOM_UNVERIFIED`.
6. Capacity covers at least one calibrated target.

## Three outputs

| Output | Answers | Fields |
| --- | --- | --- |
| `moveProbability` | Chance of reaching the target before the stop | Training estimate (published only when calibrated), day-clustered training interval, holdout rate and interval, calibration gap, criterion id |
| `capacity` | How far price can travel | Available room, capacity used, its source (`OPPOSING_ZONE`, `VALIDATED_MODEL`, `UNVERIFIED`) |
| `tradeExpectancy` | Expected net PnL after costs and funding | Mean net return with its lower bound, holdout mean, funding models |

They are kept separate because a setup can have a high chance of 1% and no room for 5%, or a high hit rate and negative expectancy because the stop is wide.

## Scale-out replay

`replayPolicy` replays exit policies over identical setups. Every policy gets the same entry, the same initial stop and therefore the same R.

- **Policies:** `SINGLE_TARGET` (one target); `LADDER_RUNNER` (rungs as fractions, and a runner with a trail). The trail is `CHANDELIER` (ATR multiple) or `FIXED_PCT`, and the trail only ratchets after the first rung. The stop after the first rung can move to breakeven plus round-trip fee and slippage.
- **Bar order:** the stop is tested first, then targets or rungs. A bar touching both does not book the rung. Funding is charged on the fraction still open at the start of the bar in which the settlement falls, an approximation within the settlement bar.
- **Outputs per trade:** exits with reasons, gross, fee, funding, net, R multiple, bars held. Unresolved trades are excluded.
- **Summary:** mean and median R, win rate, profit factor (null without losses), maximum drawdown of cumulative R, 5th percentile and worst R, exposure, funding models.
- **Paired difference:** B − A on setups both resolve, with a day-clustered bootstrap.

The trailing rule is a simple research control. It is not the trailing engine's policy, and the result of this study is not a claim about the engine. Hand-traced tests show the expected trade-off: on a continuation path the ladder beats the single target, and on a reversal after the first rung the breakeven stop costs it the edge.

## Invariants

- **No lookahead in features, context or labels.** Tests check that a truncated run reproduces every state, transition and resolved label it had already produced, and that changing bars before an entry leaves its labels unchanged.
- **Holdout independence.** Admission never sees holdout labels. Training labels that run into the holdout are purged.
- **Probabilities come only from calibrated cells.** A training estimate is published only when the holdout confirms it.
- **Unknown room blocks.** No opposing zone and no validated model means NO_TRADE.
- **Costs and funding are explicit.** Costs have no default. Funding is either settlement-based with coverage checked, or a labelled fallback.
- **Fail closed.** Invalid configs, wrong-side stops, invalid horizons, settlement gaps, and conflicting funding rows all throw.

## Not built, and why

- **Historical 1m history.** Not in the repo. Coverage can be measured with `minuteCoverageByDay`. Acquisition needs data access from your environment: `fetchArchiveKlines` (public archive) or the REST client. This environment is restricted from the Binance API (HTTP 451), and I did not route around that.
- **Funding history.** `scripts/pit-seed-funding.ts` needs the same API access, and a Postgres instance. The adapter reads rows once they exist.
- **Experiments EXP-001 to EXP-003.** Not run. They need the history above, and the criterion values should be frozen first.
- **BTC and derivatives context (note §2F).** Not built. Needs open interest, funding, and BTC series from the same data path.
- **Effort-versus-result (note §2B).** Not computed. Absorption comes from the detector's sell-flow flag.
- **Trailing-engine policy comparison.** The replay compares exit geometry under a simple trail. Comparing against the trailing engine's policies needs its own paired study (spec §13).
- **Correction across experiments.** Holm applies within one table. Correcting across EXP-001 to EXP-003 is not set up.
- **Validated capacity model.** `validatedCapacityPct` is an input hook. This module does not produce one.

## Running

- Experiments, step by step: `docs/directional-runbook.md`. Command: `npx tsx scripts/directional-experiment.ts --config research/directional/exp-001.json [--fetch]`.
- Tests: `npx tsx --test tests/directional*.test.ts` (76 tests).

Bars, labels, settlements and costs are explicit inputs to every function, so the runner is a thin layer over them.
