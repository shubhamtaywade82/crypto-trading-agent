# Context Strategy Research — v109

**As of:** 2026-11-13T18:39:10Z (2026-11-14 00:09:10 IST). **Execution:** RESEARCH_EXECUTED — archive-quality experiment only. **OOS:** not evaluated. **Trades:** NO_TRADE for SOL/ETH/XRP.

## 1. Research progress

Completed EXP-DQ-20261113T183708Z-012: 32 completed bars appended from active highwaters (5m 24; 15m 8; 1h/4h 0). Eight forming rows excluded. Duplicates, missing intervals, off-grid, non-monotonic, OHLC, non-finite, non-positive-volume and close-time failures were all zero. All four indexes, manifests and snapshot were read back. A stale-v94-baseline 6,840-row delta/repair attempt was marked SUPERSEDED_UNINDEXED and excluded from canonical indexes; canonical data was re-fetched from active v108 highwaters.

No strategy backtest or OOS run occurred. Remote scripts exist, but local checkout is absent and Node/npm are below the repo engine requirement.

## 2. Context discovery

No new taxonomy was fitted. Parent v56 used training-only q67 absolute trend strength and q33/q67 ATR14/close thresholds. Prior validation/test context TVD=0.293 with ETH/XRP drift; SOL BULL_LOW→TRANSITION_LOW 83.3% (n=12), XRP TRANSITION_NORMAL→TRANSITION_LOW 69.4% (n=25). Current local 119-bar descriptors show all four symbols bearish on 1h/4h and all bearish on 15m; 5m is mixed/bullish only for ETH/XRP. Feature-classification confidence is **moderate** for higher-timeframe bearish alignment (EMA20 below EMA50 with negative 5-bar slopes on 1h/4h), but **low** for transition structure because the local window is short and no current training-fitted shock/transition model was run. This is not a win probability. 1h/4h ATR14 sample percentiles: BTC 88.6/87.6, ETH 71.4/80.0, SOL 79.0/68.6, XRP 67.6/67.6. These are not training-derived thresholds or win probabilities.

## 3. Strategy-context scorecard

- Donchian20 SOLUSDT BULL_LOW 4h: OOS_PROMISING, 12 trades, 66.7% wins, 41.7% target-before-stop, mean 0.606R, PF 2.72, max DD 1.3R, block-bootstrap interval [0.086,1.199]R (coverage level not recorded). Fails the 100 OOS trades/context gate; not actionable.
- Donchian20 context-aligned v2: overall INSUFFICIENT_EVIDENCE across 36 cells; below 100 OOS trades; parent Holm-adjusted p=1.0.
- Trend/pullback, breakout/retest, range mean reversion, volatility expansion, BTC-led and funding/OI filters: HYPOTHESIS.
- OOS_VALIDATED entries: none.

## 4. Key discoveries

24h change: BTC -4.294%, ETH -4.037%, SOL -2.166%, XRP -0.708%; relative strength vs BTC +0.257pp ETH, +2.128pp SOL, +3.586pp XRP. 1h/4h BTC return correlations (118 observations): ETH 0.894/0.913, SOL 0.872/0.889, XRP 0.736/0.803. OI change 17→18 UTC: BTC -0.327%, ETH -0.210%, SOL -0.207%, XRP +0.433%. Last completed 17:00 taker buy/sell ratios: 1.243/1.177/1.146/1.088. Global long/short account ratios: 3.07–3.66; these are account counts, not top-trader positions or liquidation evidence. No robust edge is demonstrated in the current bearish/high-vol context.

## 5. Current snapshot

Market snapshot 18:39:10Z; features 18:37:48Z. Funding interval 8h; next funding 2026-11-14 00:00Z; last settled 16:00Z. Indicated/settled funding: BTC 0.009171%/0.004045%; ETH 0.005262%/0.004743%; SOL 0.010000%/0.007203%; XRP 0.010000%/0.010000%. None exceeds |0.05%|. 5m/15m/1h/4h trends: BTC B/B/B/B; ETH M/B/B/B; SOL B/B/B/B; XRP B/B/B/B, where B=bearish and M=mixed; XRP 5m was bullish. Short-term bounce is not a reversal trigger.

24h high/low and quote volume: BTC 71,966 / 67,449; 19.23B USDT. ETH 2,023.21 / 1,893.39; 10.96B USDT. SOL 82.38 / 77.85; 1.82B USDT. XRP 1.0438 / 0.9963; 0.806B USDT.

## 6. Decisions

| Symbol | Eligible validated rule | Decision | Reason |
|---|---|---|---|
| SOLUSDT | None | NO_TRADE | No OOS_VALIDATED rule; 5m bounce against bearish 15m/1h/4h; metadata stale |
| ETHUSDT | None | NO_TRADE | No OOS_VALIDATED rule; 15m/1h/4h bearish; no validated trigger |
| XRPUSDT | None | NO_TRADE | 5m bullish but 15m/1h/4h bearish; no validated trigger |

## 7. Audit, costs and next actions

Base archive: 5m 156,000 rows (39k/symbol), 2020-01-01→2021-01-27 16:55Z; 15m 156,000 rows, 2020-01-01→2021-10-25 12:45Z; both have multi-year gaps. 1h 215,492 rows (53,873/symbol), 2020-09-14→2026-11-11 05:00Z, with 28 missing opens/symbol and 8-row discrepancy. 4h raw/aligned/canonical 53,960/53,816/53,844, with 13 page SHA mismatches. Current highwaters: 5m18:30Z,15m18:15Z,1h17:00Z,4h12:00Z.

Connector endpoints used: /fapi/v1/klines, /fapi/v1/premiumIndex, /fapi/v1/ticker/24hr, /fapi/v1/openInterest, /fapi/v1/depth, /fapi/v1/fundingRate, /fapi/v1/fundingInfo and futures-data OI/taker/global-LS endpoints. Direct shell DNS to /fapi/v1/time and /fapi/v1/exchangeInfo failed. Connector exchangeInfo serverTime 06:02:01.705Z was 12h35m stale; TRADING status is not accepted as current execution validation. Liquidations, top-trader position ratios, historical depth, calibrated impact and account-specific fee tier unavailable.

Costs remain uncalibrated; prior 15bp proxy is not accepted as evidence. Remote backtest.ts uses a fixed 0.0001 funding rate when funding is enabled, not historical symbol-specific funding; this must be replaced before OOS claims.

Next: backfill 5m/15m; reconcile 1h/4h; restore local repo + Node24/npm11; run deterministic smoke test; calibrate costs; then pre-register and test a strategy×context×symbol experiment with untouched OOS, block bootstrap and Holm correction. Weekly taxonomy review next due 2026-11-16.

**Preflight:** shell PASS; remote repo/local runtime DEGRADED; SDK BLOCKED; network DEGRADED; raw archive PASS; coverage DEGRADED; backtest/smoke BLOCKED; disk/storage DEGRADED (Library quota reached; GitHub branch available); GitHub artifact readback PASS. Status: RESEARCH_EXECUTED (data quality only), OOS_EVALUATED: NO.
