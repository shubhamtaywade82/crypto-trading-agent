# ALMA research protocol

## Research question

Do ALMA parameters and event definitions produce repeatable, cost-adjusted directional information on SOLUSDT USDⓈ-M perpetual futures, and does MTF alignment add value beyond the best single-timeframe rule?

The primary object is not a two-line crossover in isolation. It is an event sequence:

1. **State:** fast ALMA relative to slow ALMA, their slopes, separation normalized by ATR, and distance from price.
2. **Transition:** cross, cross-back, separation expansion, compression, or slope reversal.
3. **Price interaction:** extension away from the fast/slow line, touch, penetration, close-through, reclaim, rejection or structural failure.
4. **Context:** higher-timeframe state from fully closed bars only.
5. **Outcome:** forward directional return, maximum favorable/adverse excursion, and later—once implemented—net R under a trade/exit model.

## Phases

### Phase 0 — workspace and data contract

- Pin the Binance SDK version and method used for public Futures klines.
- Fetch a small sample for each chosen interval.
- Validate OHLCV envelope, timestamp uniqueness/order, close times, cadence/gaps and candle completeness.
- Save immutable raw data with retrieval metadata and SHA-256 checksums.
- Verify the ALMA implementation against deterministic unit tests before any search.

### Phase 1 — event-definition calibration, no performance tuning

Implement event labels with explicit, testable definitions: cross, cross with slope agreement, cross plus expansion, fast-line pullback/rejection, slow-line pullback/rejection, pullback reclaim, failed reclaim, compression breakout and post-cross recross. Fix these definitions before inspecting large result tables.

### Phase 2 — single-timeframe coarse grid

Enumerate valid fast/slow length pairs (fast < slow), shared offset/sigma first, and the configured OHLC source candidates. Run every supported native timeframe, but report each interval's sample span and bar count. Do not compare returns across different holding durations without normalization.

### Phase 3 — refinement

For parameter neighborhoods that survive a robustness screen, allow independent fast/slow offset and sigma. Add slope lookback, normalized separation/expansion, pullback extension, touch tolerance and close/reclaim requirements. Keep a record of all trials, including failed or abandoned trials.

### Phase 4 — MTF topologies

Evaluate only causally valid stacks: regime timeframe > setup timeframe > entry timeframe. First screen single timeframes, then combine a limited, predeclared set of strong and stable candidates. Do not search all role assignments as arbitrary permutations; equivalent stacks and invalid ordering must be eliminated deterministically. At each entry decision, use the last fully closed bar on every higher timeframe.

### Phase 5 — entry, stop and exit model

Only after event behavior is understood, test entry timing and risk/exit parameters. Include structure and ATR stops, target multiples, time stops, cross-back exits and trailing logic as separate hypotheses. Use the same execution model across candidates.

### Phase 6 — robustness and promotion gate

- Chronological training, validation and locked final test periods.
- Walk-forward folds with a purged gap at least as large as the maximum outcome horizon plus any lookback contamination required by the model.
- Block bootstrap clustered by UTC day to preserve within-day dependence.
- Multiple-testing correction across the tested family; report how many total candidates were tried.
- Parameter-neighborhood stability, not only the single best row.
- Separate trending, ranging, high-volatility and low-volatility regimes.
- No parameter is promoted on a single aggregate metric or one market regime.

## Metrics

### Event study (before a trade simulator)

- Event count; long/short counts; overlap and clustering.
- Forward directional return at fixed bar horizons.
- Median and distribution quantiles of forward return.
- MFE / MAE before the horizon.
- Follow-through rate, recross rate, and time to continuation/failure.
- Results split by timeframe, direction, volatility regime and trend state.

### Executable strategy (later phase)

- Net expectancy per trade and per unit initial risk (R).
- Profit factor, win rate, average win/loss, maximum drawdown and time under water.
- Fees, slippage and funding separately and jointly.
- Exposure, turnover, trades/day, concentration in a few dates, and tail loss/CVaR.
- OOS fold results and confidence intervals.

A positive event hit rate does not prove a profitable strategy. A trade can be directionally correct but still lose after entry timing, stop placement, adverse excursion and costs.

## Default assumptions

- Signals only on completed candles.
- Next-bar-open entry; no same-close fills.
- Conservative stop-before-target resolution if both are touched inside one bar.
- Gaps through a stop fill at the next available open, not at the ideal stop price.
- Historical funding must be charged/credited at actual settlement timestamps for any held futures position.
- Use taker-fee and slippage assumptions unless a realistic maker-fill model is implemented.
- Report raw price-event statistics separately from fee-adjusted trade results.

## Research artifacts required for each run

- Versioned experiment config and its SHA-256.
- Raw dataset manifest and checksums per symbol/timeframe.
- Code commit SHA, Node version and SDK version.
- Deterministic search-space definition and total candidate count.
- Per-candidate metrics (including failures and ineligible samples).
- OOS/walk-forward result tables and a human-readable summary.
- Exact event/entry/exit definitions and any exclusions.

Do not start parameter optimization until Phase 0 data and ALMA tests pass.