# EXP-002 — 4h EMA20/EMA50 pullback continuation

## Purpose
Test a pullback continuation entry in training-defined strong trend and low/normal volatility. BTCUSDT is reference-only, never a tradable strategy symbol.

## Frozen rules
- 4h EMA20, EMA50 and Wilder ATR14.
- Trend strength = (EMA20 - EMA50) / ATR14; strong trend when absolute strength >= training q67.
- Volatility = ATR14 / close; LOW <= training q33, NORMAL <= q67, HIGH otherwise.
- Long: completed bar touches EMA20 and closes above EMA20 and EMA50 in strong BULL context.
- Short: completed bar touches EMA20 and closes below EMA20 and EMA50 in strong BEAR context.
- Entry next bar open; stop 1.5 ATR; target 2R; time stop 6 bars/24h; one position at a time.
- If stop and target both touch in one OHLC bar, stop first. Stop gaps fill at open; target gaps receive no price improvement.
- Sizing: 1% of normalized $1,000 equity ($10 risk/trade), fixed risk, no compounding.

## Validation
- Chronological 70% train / 15% validation / 15% untouched test.
- 500-bar warmup; 6-bar purge/embargo around boundaries.
- Thresholds fitted on training only; no tuning against test.
- 2,000 moving-block bootstrap replicates, 5-trade blocks; seed 20261109.
- Holm correction across SOL, ETH and XRP.
- OOS funding uses Binance fundingRate and markPrice settlements; 1,004 expected settlements per symbol.
- Cost proxy 15 bps round-trip; sensitivity 12 and 25 bps. Historical spread/impact is not calibrated.

## Reproduction
From repository root run:

    node research/experiments/exp-002-4h-ema-pullback/smoke-test.js
    node research/experiments/exp-002-4h-ema-pullback/run.js

The current run executed the same core logic in the managed V8 runtime because no local repository checkout was mounted and the available Node/npm versions are below the repository engine requirement. The persisted Node runner is provided for local reproduction.