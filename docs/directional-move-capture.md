# Directional move capture

Research and decision layer for the question: **given a rejection, is there enough evidence and room for a move of 1, 2, 3, 5 or 10% before the stop?** It produces target-specific probabilities from labelled history and returns NO_TRADE unless every gate passes.

Code: `src/market/directional/`. Builds on `src/market/rejection/` (see `docs/rejection-zones.md`). Tests: `tests/directional*.test.ts`.

**Status: the machinery is built and tested. No probability has been calibrated.** The repo's recorded data is too short and Binance market data is unavailable from this environment (HTTP 451), so every symbol currently returns NO_TRADE. That is the intended state until a calibrated, holdout-confirmed table exists.

## What already existed, and what this reuses

| Need | Existing module | Used as |
| --- | --- | --- |
| Outcome labelling with conservative intrabar rules | `playbooks/outcome.ts` | Convention: stop before target within a bar; stop gaps fill at the open; missing bars are UNRESOLVED |
| Trailing stops, ratchet, partial-fill lifecycle | `trailing/` (spec `2026-11-03-crypto-futures-trailing-engine-design.md`) | Owns execution. The ladder here is geometry only |
| Cluster bootstrap for expectancy | `research/Bootstrap.ts` `bootstrapMean` | EV interval, clustered by UTC day |
| Family-wise correction | `research/Bootstrap.ts` `holm` | Admission across every testable cell |
| Admission thresholds | `playbooks/calibration.ts` (200 setups, 20 decision days) | Same floors, applied to target probabilities |
| Volatility phase | `market/VolatilityPhase.ts` | ATR percentile to COMPRESSED / EXPANDING / EXTREME |
| Rejection events, zones, features | `market/rejection/` | Sweep, reclaim, wick, relative volume, ATR, zones for room |

New here: the percent-target barrier ladder with MFE, MAE and time-to-target; per-target probability tables with Wilson intervals and a purged holdout; the expansion-context state machine; available room; the NO_TRADE assembler.

## Pipeline

```
RejectionEvent[] (CONFIRMED)  +  FlowBar[] (1m or higher timeframe)
   │
   ├─ classifyExpansionContext   per-bar state, one legal transition per bar, decays to NONE
   │
   ├─ setupsFromRejections       entry = confirming close; stop = sweep extreme ± k·ATR; tag = context at entry
   │
   ├─ labelBarriers              for each target × horizon: TARGET | STOP | TIMEOUT | UNRESOLVED, MFE, MAE, net return
   │
   ├─ buildTargetTable           purged chronological split → Holm-corrected admission on training → holdout report
   │
   ├─ availableRoom              distance to the nearest live opposing zone (SUPPLY for LONG, DEMAND for SHORT)
   │
   └─ assessDirectionalPotential gates → LONG | SHORT | NO_TRADE, with probabilities only from admitted cells
```

## Expansion context

One state machine per side, in directional coordinates (LONG: price; SHORT: −price).

| State | Entered by | Meaning |
| --- | --- | --- |
| RANGE_COMPRESSION | ATR percentile in the COMPRESSED band | Watch |
| LIQUIDITY_SWEEP | A sweep bar without absorbed sell flow | Watch for reclaim |
| ABSORPTION_CANDIDATE | A sweep bar whose sell-led flow the price reclaimed | Watch for confirmation |
| REJECTION_CONFIRMED | Rejection confirmed (follow-through reached) | **Entry context** |
| STRUCTURE_SHIFT | Close through the most recent lower swing high, for the first time | **Entry context** |
| VOLATILITY_EXPANSION | Bar range ≥ `expansionAtr` × ATR with relative volume ≥ threshold, in the side's direction | **Entry context** |
| TREND_CONTINUATION | After a break, a higher low forms and the close holds above the break | **Entry context** |
| EXPANSION_EXHAUSTION | Opposing displacement of the same size, or a close back through the broken level | Avoid / reduce |

- Transitions are limited to `ALLOWED_TRANSITIONS`. A bar makes at most one transition, so the sequence has to unfold in order.
- Each state decays to NONE after `maxStateBars` (default 96) with no transition.
- Swing pivots need `swingK` bars on each side, so they are known only at `index + k`.
- Incomplete or non-contiguous bars reset the machine to NONE.

## Barrier labels

For each setup, target `T` (percent of entry) and horizon `H` (hours):

- The first bar that touches the stop gives STOP. If the same bar also touches the target, the result is still STOP.
- A stop gap that opens beyond the stop fills at the open.
- The first bar that touches the target gives TARGET, filled at the target price.
- If neither happens within `H`, the result is TIMEOUT, exited at the horizon close.
- A missing or incomplete bar before resolution gives UNRESOLVED, which is excluded from every statistic.
- `netReturnPct` = gross return − round-trip cost. Round trip = 2 × (fee + slippage) plus signed funding over the time held. **Costs are required input.** There is no default venue fee.

## Probability tables

- `hitBeforeStop` = TARGET ÷ (TARGET + STOP + TIMEOUT). A timeout is a miss.
- Wilson score interval for the proportion, at the table's confidence level.
- Expectancy: cluster bootstrap on net return, clustered by UTC day. Admission needs its lower bound above 0.
- **Purged chronological split.** The last `holdoutFraction` of entry times is the holdout. Training labels whose horizon ends at or after the cut-off are dropped, so no outcome that resolves inside the holdout informs training.
- Admission (training only): ≥ 200 resolved setups, ≥ 20 distinct days, bootstrap lower bound > 0, and Holm-rejected across all testable cells at α = 0.05.
- Holdout: reported for each admitted cell. The potential requires holdout net mean > 0 with at least `minHoldoutSample` outcomes.
- Cells are per (symbol, side, target, horizon, context tag). The untagged baseline takes every setup, so each context can be compared with it.

**Confidence level.** The bootstrap interval is two-sided 90%, whose lower end is a one-sided 95% bound. The calibration module uses 0.95 for its own estimate. The two conventions are not interchangeable.

## Gates in `assessDirectionalPotential`

Evaluated in this order. The first failure returns NO_TRADE with the reason.

1. The stop is beyond entry and no wider than `maxStopPct` (required input, a risk parameter).
2. The context is an entry context. Sweeps, compression, exhaustion and NONE are not.
3. An admitted cell exists for this symbol, side and context.
4. The holdout confirms it.
5. Known room covers the target. With no opposing zone known, the target is allowed and a warning is recorded.

A probability is reported only when all five pass. Zone scores never become probabilities.

## Scale-out

`planScaleOut` returns rung prices, the fraction at each rung, the runner fraction, and a stop after the first rung at entry plus round-trip cost. It places nothing. Execution and any stop ratchet belong to the trailing engine.

## Invariants

- **No lookahead in features and context.** Evidence at bar `t` uses bars ≤ `t` and events known by `t`. Tests check that a truncated run reproduces every state and transition it had already produced.
- **No lookahead in labels.** A label reads only the entry bar's close and the bars after it. Changing any earlier bar leaves it unchanged. Tests check this, and that a truncated series reproduces every resolved label.
- **Holdout independence.** Admission never sees holdout labels, and training labels that run into the holdout are purged.
- **Fail closed.** Invalid configs, stops on the wrong side, and horizons that are not whole bars all throw. Missing data gives UNRESOLVED, never a loss or a win.
- **Probabilities come from outcomes.** The only source is labelled history, and every probability carries its sample, days and interval.

## Not built, and why

- **BTC and derivatives context (note §2F).** BTC relative strength, open interest change, funding, long/short ratio, and taker imbalance are not inputs here. They need a data path that is not in this module.
- **Effort-versus-result (note §2B).** ER = |price change| ÷ aggressive volume is not computed. Absorption currently comes from the rejection detector's sell-led flag on the sweep bar.
- **Experiments EXP-001 to EXP-003.** Not run. They need long contiguous 1m history for SOL, ETH, XRP and BTC. The recorded data holds at most 16 bars per 5m series.
- **Scale-out simulation.** The ladder's expectancy against a single target belongs in the trailing engine's paired replay (spec §13), using identical entries and risk.
- **Multiple testing across experiments.** Holm applies within one table. Comparing EXP-001 to EXP-003 needs a correction across all of them, which has not been set up.
- **Live use.** Nothing here sends orders, changes a strategy, or reads a live feed.

## Running

```bash
npx tsx --test tests/directional*.test.ts    # 43 tests
```

The labeler, table builder and assessor take bars, labels and costs as explicit inputs, so a research script can drive them once data exists.
