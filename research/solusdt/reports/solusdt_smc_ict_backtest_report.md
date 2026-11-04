# SOLUSDT SMC/ICT Historical Backtest — Research Report

**Run date:** 18 October 2026  
**Instrument:** Binance USDⓈ-M SOLUSDT perpetual futures  
**Status:** Exploratory research; no strategy is approved for live trading.

## Executive conclusion

No tested rule has demonstrated a sufficiently robust, statistically convincing edge for automated live trading.

The 3-year hourly data are continuous across 25,924 bars from 2023-11-02 18:00 UTC to 2026-10-17 21:00 UTC. A raw 20-hour liquidity sweep/reclaim loses across training, validation, and test periods. Adding market-structure-shift (MSS) and displacement confirmation reduces trade count substantially but remains negative. A sweep → displacement/MSS → fair-value-gap (FVG) midpoint retrace is the only variant with a mildly positive full-sample estimate under one exit setting, but it produces only 38 trades; its 1.5R expectancy confidence interval crosses zero, and the chronological test segment has only six trades. That is insufficient evidence to infer a durable edge.

**Research candidate only:** 1-hour liquidity sweep → displacement/MSS → FVG midpoint retrace, with a 1R target, a sweep-wick stop, strict order invalidation, and small risk. It must remain in paper trading while more history, funding, fees, slippage and out-of-sample trades are collected.

## Data and controls

- Source: Binance USDⓈ-M futures klines retrieved through the Binance data connector.
- Main sample: 1-hour OHLCV, 25,924 bars, no missing hourly timestamps detected in the retrieved span.
- Secondary sample: 15-minute OHLCV, 15,000 bars, 2025-04-25 to 2025-09-28 UTC; no missing 15-minute timestamps detected in that sample.
- Chronological split: training before 2025-10-01; validation 2025-10-01 through 2026-03-31; test from 2026-04-01 onward.
- Market entries use the next bar open. FVG limit entries fill only if the bar reaches the midpoint of the gap within eight bars.
- A same-bar stop and target touch is resolved as a stop, conservatively.
- Maximum holding period: 16 one-hour bars. The simulator permits only one position at a time.
- Stop distance constraint: 0.1%–2.5% of entry. Stop is beyond the sweep wick by 0.05 × ATR(14).
- Assumed friction: 0.13% of traded notional round-trip (illustrative fee + slippage assumption, not the user's verified Binance fee tier). Sensitivity was also checked at 0.06% and 0.20%.
- Funding is not included. Therefore the results are not fully net of all futures carrying costs.

## Operational definitions

### A. Raw liquidity sweep/reclaim

At the close of an hourly candle, a bullish event occurs if its low breaches the lowest low of the preceding 20 hourly candles but it closes back above that prior low. A bearish event is the inverse at the prior 20-hour high. Entry is at the next hourly open.

### B. Sweep + MSS/displacement

After the sweep, within six bars, require a directional candle with body at least 0.6 × ATR(14), close in the top (long) or bottom (short) quartile of its range, and a close beyond the preceding five-bar micro-structure high/low. Enter at the next bar open. Invalidation of the original sweep stop before entry cancels the trade.

### C. Sweep + MSS/displacement + FVG retrace

Apply rule B and require a three-candle imbalance: bullish FVG when current low is above the high two bars earlier; bearish FVG when current high is below the low two bars earlier. Place a limit at the FVG midpoint and allow up to eight bars for a fill; cancel if the sweep stop is invalidated first. Target alternatives: 1R, 1.5R and 2R.

For the 48-bar sensitivity, only the liquidity reference lookback changes from 20 to 48 hourly candles. It is not considered a validated optimization.

## Main hourly results

Expectancy and profit factor are expressed in **R after assumed friction**, where R is the initial stop distance. All results are exploratory and include OHLC fill assumptions.

| Strategy | Target | Trades | Win rate | Net expectancy | Profit factor | Key chronological result |
|---|---:|---:|---:|---:|---:|---|
| Raw 20-bar sweep/reclaim | 1R | 2,490 | 45.9% | -0.282R | 0.57 | Test: -0.263R over 432 trades |
| Raw 20-bar sweep/reclaim | 1.5R | 2,449 | 38.0% | -0.258R | 0.65 | Test: -0.215R over 421 trades |
| Raw 20-bar sweep/reclaim | 2R | 2,414 | 32.8% | -0.246R | 0.69 | Test: -0.263R over 413 trades |
| Sweep + MSS/displacement | 1.5R | 110 | 36.4% | -0.205R | 0.65 | Test: -0.375R over 26 trades |
| Sweep + MSS + FVG midpoint | 1R | 38 | 60.5% | +0.159R | 1.41 | Test: +0.540R, but only 6 trades |
| Sweep + MSS + FVG midpoint | 1.5R | 38 | 47.4% | +0.043R | 1.09 | Test: +0.353R, but only 6 trades |
| Sweep + MSS + FVG midpoint | 2R | 38 | 42.1% | +0.001R | 1.00 | Test: +0.466R, but only 6 trades |
| Sweep(48) + MSS + FVG midpoint | 1.5R | 20 | 55.0% | +0.232R | 1.53 | Test: +0.657R, but only 5 trades |

### Chronological splits for FVG(20)

For the 1R target at 0.13% assumed friction:

| Segment | Trades | Win rate | Expectancy |
|---|---:|---:|---:|
| Training (before 2025-10-01) | 30 | 53.3% | +0.034R |
| Validation (2025-10-01 to 2026-03-31) | 2 | 100.0% | +0.893R |
| Test (2026-04-01 onward) | 6 | 83.3% | +0.540R |

The validation and test samples are far too small to support a reliable win-probability estimate. Six recent winning trades should not be interpreted as an 83.3% future win probability.

For FVG(20) at 1.5R, a 10,000-replicate circular block bootstrap with blocks of three trades gave a 95% interval of **-0.308R to +0.418R** for mean net expectancy. The interval includes zero, so the positive full-sample point estimate is not statistically persuasive.

### Transaction-cost sensitivity: FVG(20)

| Target | Round-trip friction | Net expectancy | Profit factor |
|---|---:|---:|---:|
| 1R | 0.06% | +0.211R | 1.58 |
| 1R | 0.13% | +0.159R | 1.41 |
| 1R | 0.20% | +0.107R | 1.27 |
| 1.5R | 0.06% | +0.095R | 1.20 |
| 1.5R | 0.13% | +0.043R | 1.09 |
| 1.5R | 0.20% | -0.009R | 0.98 |
| 2R | 0.06% | +0.053R | 1.10 |
| 2R | 0.13% | +0.001R | 1.00 |
| 2R | 0.20% | -0.051R | 0.91 |

The 1R variant tolerates the tested friction assumptions in the aggregate, but its training expectancy is nearly zero at the base assumption and negative at 0.20% friction. This is not enough to validate the edge.

### Filters and sensitivity

- FVG lookback 48 produced a higher full-sample expectancy than lookback 20, but only 20 trades overall; its training sample had 14 trades with nearly zero expectancy, while 2024 performance was negative. This is a low-sample parameter-selection risk, not evidence that 48 is superior.
- A 4-hour EMA20/EMA50 direction filter reduced FVG(20) to 20 trades and had negative overall expectancy (-0.040R at 1.5R target); the test segment had three trades and was negative.
- A premium/discount midpoint filter left 35 trades and produced only +0.036R expectancy at 1.5R; higher friction pushed it negative.
- Combining the 4-hour trend and premium/discount filters produced 17 trades and negative expectancy.

## Secondary 15-minute diagnostic

On the 15,000-bar sample from 2025-04-25 to 2025-09-28 UTC, the exploratory 1.5R variants did not establish a stable edge:

| Variant | Trades | Win rate | Mean net price return/trade | Profit factor |
|---|---:|---:|---:|---:|
| Raw sweep/reclaim | 1,470 | 39.5% | -0.143% | 0.58 |
| Sweep + MSS/displacement | 163 | 36.2% | -0.242% | 0.62 |
| Sweep + MSS + FVG retrace | 25 | 32.0% | -0.187% | 0.62 |

The FVG sub-sample changed from mildly positive in its first half to negative in its second half. These 15-minute figures are a separate exploratory sample, use price-return rather than R metrics, and should not be pooled with the hourly results.

## What works so far?

1. **Not sufficient alone:** liquidity sweep/reclaim of a recent extreme. It is highly active but consistently negative under the tested exits and friction assumptions.
2. **Not validated:** adding MSS/displacement and entering at market. It reduces frequency but remains negative.
3. **Only a candidate for further research:** wait for MSS/displacement, require an FVG, and attempt a midpoint retrace. The 1R exit has the best balance in this test, but the small count and uncertainty interval prevent a reliable edge claim.
4. **No evidence that a simple 4H trend or premium/discount filter fixes the model.** They reduce sample size without proving better out-of-sample expectancy.

## Important limitations

- This is a deterministic OHLC proxy for concepts that are often applied subjectively. It does not fully model discretionary order blocks, breaker blocks, mitigation, liquidity pools, dealing-range selection, session context, news, or correlated market context.
- Candle OHLC cannot reveal the exact intra-candle path. Resolving same-bar stop/target touches to the stop is conservative but not a replacement for tick-level replay.
- Limit-touch logic does not model queue position, maker/taker outcomes, rejected orders, partial fills, exchange latency, or market impact.
- Funding rates are excluded; friction is an assumption rather than the user's exact commission schedule and realized slippage.
- The backtest does not yet include a formal multiple-testing correction across all possible rule combinations, a walk-forward re-optimization protocol, or a separate tick-level validation.
- Risk-based equity curves without an explicit leverage/margin cap can be misleading, so this report focuses on trade expectancy and profit factor rather than presenting those curves as deployable account returns.

## Recommended next phase

1. Freeze the three rules above and stop tuning on the current sample.
2. Re-run exact event-driven replay using finer 1-minute or 5-minute candles around entries/exits, with funding events and the actual account fee tier.
3. Define a locked out-of-sample period and evaluate the 1R FVG candidate without modifying its rules.
4. Require a materially larger sample—at least 100 independent eligible trades and positive expectancy across more than one market regime—before describing it as a candidate with evidence of an edge. Use block-bootstrap confidence intervals, a multiple-testing adjustment, and a comparison against simple baselines.
5. Paper trade with strict no-trade conditions and log every signal, fill, cancellation, funding charge, and exit. Do not enable live trading based on these results.

**Bottom line:** the historical tests have ruled out the raw sweep and the tested market-entry MSS variant as standalone strategies under this specification. FVG retracement is worth researching further, especially at a 1R target, but **no high-probability or live-ready edge has been established**.