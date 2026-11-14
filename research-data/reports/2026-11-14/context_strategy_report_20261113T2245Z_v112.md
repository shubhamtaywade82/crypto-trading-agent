# Context Strategy Research — v112

**As of:** 2026-11-13 22:45:44 UTC  
**Local research date:** 2026-11-14  
**Run status:** RESEARCH_EXECUTED — data-quality audit and archive refresh only  
**Strategy experiment:** BLOCKED · **Untouched OOS:** NOT RUN · **OOS_VALIDATED registry entries:** 0

## 1. Research progress

- Appended **32 completed OHLCV rows** to the remote raw archive: 5m **24**, 15m **8**, 1h **0**, 4h **0**.
- New highwaters: 5m **22:40Z**, 15m **22:30Z**, 1h **21:00Z**, 4h index **12:00Z**.
- The 4h candle opened at **16:00Z** is complete in the live feed but remains **unindexed** because raw/aligned/canonical reconciliation is unresolved.
- Ran a reproducible 200-bar integrity audit across 4 symbols × 4 intervals: **3,200 rows**, **3,184 completed**, **16 forming excluded**; zero detected duplicates, gaps, off-grid timestamps, non-monotonic rows, OHLC violations, non-positive volume, non-finite values or close-time errors.
- The earlier 24-row candidate built against a stale as-of timestamp was explicitly superseded and not indexed. Only the corrected 32-row delta is canonical.
- No strategy backtest, OOS evaluation, taxonomy refit or evidence-status promotion ran.

**Persistent archive:** [raw archive branch](https://github.com/shubhamtaywade82/crypto-trading-agent/tree/research/raw-ohlcv-archive-20261113T2245Z-auto11). Delta, manifest and four indexes were reopened and hash-verified.

## 2. Context discovery

Current completed-candle classification uses EMA20/EMA50 alignment and the 10-bar EMA20 slope. It is descriptive, not a fitted or validated regime model.

- BTC, ETH, SOL and XRP are **BEAR** on 5m, 15m, 1h and 4h: EMA20 is below EMA50 and the 10-bar EMA20 slope is negative.
- Directional classification confidence: **moderate**, based on agreement of two observable features; this is not a probability of a winning trade.
- Volatility buckets remain **UNKNOWN** because the training-only q33/q67 thresholds are not available. ATR14/close is reported in the market snapshot.
- Structure, BTC lead/lag, rolling correlation, context duration and transition probabilities remain **NOT_COMPUTED**. The v56 taxonomy is carried forward, not refit.
- Local shock flags use a 3× trailing median absolute-return heuristic over 50 completed bars. This is not a training-fitted threshold: BTC 1h, ETH 1h, SOL 5m/15m/1h and XRP 5m are flagged.

## 3. Strategy-context scorecard

| Strategy / cell | Evidence status | Evidence and blocker |
|---|---|---|
| Donchian20 4h breakout — SOLUSDT / BULL_LOW | **OOS_PROMISING** | 12 OOS trades; win rate 66.7%; target-before-stop 41.7%; mean net 0.606R; PF 2.72; max drawdown 1.3R; 95% block-bootstrap CI [0.086, 1.199]R. Still far below 100 trades; cost and parameter robustness incomplete. |
| Donchian20 4h breakout — remaining symbol/context cells | **INSUFFICIENT_EVIDENCE** | All cells below 100 OOS trades; nominal intervals include zero; Holm-adjusted p=1.0; 15bp round-trip proxy is uncalibrated. |
| Trend/pullback continuation | **HYPOTHESIS** | Not tested. |
| Breakout/retest / volatility contraction | **HYPOTHESIS** | Not tested. |
| Range mean reversion / failed-breakout fade | **HYPOTHESIS** | Not tested. |
| Volatility expansion / momentum | **HYPOTHESIS** | Not tested. |
| BTC-led confirmation / relative strength | **HYPOTHESIS** | Not tested. |
| Funding/OI filters | **HYPOTHESIS** | Not tested. |

There are **zero OOS_VALIDATED entries**. The SOL BULL_LOW result remains research-only; it does not authorize a trade in the current bearish context.

## 4. Key discoveries

- Current trend alignment is broadly bearish across all monitored timeframes, but a regime observation is not an entry trigger and does not establish a profitable short setup.
- SOL's latest completed 15m taker buy/sell ratio is 1.2528 while its 5m/15m/1h shock heuristic is active. That divergence is descriptive only.
- All current indicated funding rates are positive but below the 0.05% flag threshold. The latest settled rates are also below 0.05%; 8h settlement spacing was observed.
- OI has declined versus the 22:00Z observation for all four symbols. Global account ratios remain long-skewed (long account share 75.4–78.8%); neither OI nor account ratios alone establish liquidations or crowding.
- No context has demonstrated a symbol-specific, cost-adjusted, statistically credible strategy edge in this run.

## 5. Current market snapshot

Market fields were retrieved around **22:42:28–22:42:44Z**; completed-candle context is as of **22:42:36Z**.

| Symbol | Mark / last | 24h change | Current indicated funding | Last settled funding (16:00Z) | OI change vs 22:00Z |
|---|---:|---:|---:|---:|---:|
| BTC (reference) | 68,375.40 / 68,375.40 | -4.337% | 0.007769% | 0.004045% | -0.086% |
| ETH | 1,930.0238 / 1,929.99 | -4.162% | 0.002505% | 0.004743% | -0.332% |
| SOL | 78.3252 / 78.31 | -3.796% | 0.007467% | 0.007203% | -0.519% |
| XRP | 1.010219 / 1.0101 | -2.519% | 0.006048% | 0.010000% | -0.588% |

Next funding: **2026-11-14 00:00Z**; 8h cadence observed. No current indicated or last-settled funding rate exceeds 0.05%.

All four symbols are BEAR on 5m/15m/1h/4h. 1h shock flags are active for BTC, ETH and SOL; SOL also flags 5m/15m; XRP flags 5m. These are heuristic warnings, not calibrated probabilities.

## 6. SOL / ETH / XRP decision matrix

| Symbol | Eligible OOS_VALIDATED rule | Trigger | Decision |
|---|---|---|---|
| SOLUSDT | None | Not evaluated; no validated rule exists | **NO_TRADE** |
| ETHUSDT | None | Not evaluated; no validated rule exists | **NO_TRADE** |
| XRPUSDT | None | Not evaluated; no validated rule exists | **NO_TRADE** |

No entry, stop or target is issued. Reasons: zero OOS_VALIDATED registry entries; no validated trigger; execution costs are not calibrated; exchange metadata is stale; shock warnings are active on selected timeframes.

## 7. Data-quality audit, costs, unavailable inputs, risks and next experiments

### Historical archive

| Interval | Base coverage | Current archive state | Research readiness |
|---|---|---|---|
| 5m | 162,000 rows / 40,500 per symbol; starts 2020-01-01; page 27 ends vary by symbol, latest base end 2021-02-01 | Incremental through 22:40Z | **Blocked** — large historical gap remains |
| 15m | 162,000 rows / 40,500 per symbol; starts 2020-01-01; latest base end 2021-11-10 | Incremental through 22:30Z | **Blocked** — large historical gap remains; 3 zero-volume rows on page 27 excluded |
| 1h | 215,504 rows / 53,876 per symbol from 2020-09-14 | Incremental through 21:00Z | **Degraded** — 28 missing opens per symbol and 8-row discrepancy |
| 4h | Raw 53,960; aligned 53,816; canonical 53,844 from 2020-09-14 | Index highwater 12:00Z; 16:00Z completed bar not indexed | **Blocked** — 13 page-manifest SHA mismatches and count reconciliation |

### Execution and data blockers

- Shell: Debian 13, Python 3.13.5, Node 22.16.0, npm 10.9.2, 3 CPUs, 4.73 GiB available RAM, 30 GiB free disk. Working directory `/` has no repository checkout.
- Direct DNS/HTTPS to `fapi.binance.com` fails; `GET /fapi/v1/time` is unavailable. Connector responses do not expose HTTP status/headers.
- `exchangeInfo.serverTime` is 16h40m behind current market timestamps. Contract status is therefore not execution-validated.
- Remote source audit found: BTCUSDT remains the backtest default; 5m replay is absent; Candle mapping drops closeTime; zero volume is allowed; conditional-edge defaults to 30 trades and 90% bootstrap confidence; no explicit purge/embargo CLI control exists.
- Node SDK packages are absent. Binance SDK was not used; current market data came through the public-data connector.
- Costs: account fee tier, synchronized historical spread/depth, size-dependent impact, latency/fill distributions and full historical funding cashflows are unavailable. The previous 15bp round-trip proxy is not calibrated.
- Liquidation data, historical order-book depth, basis history and robust lead/lag features were not retrieved.

### Next priority

1. Backfill continuous multi-year 5m/15m history and reconcile 1h/4h archive counts and hashes.
2. Restore direct DNS and obtain fresh server time and exchange metadata.
3. Provision Node >=24/npm >=11, materialize the exact research branch, and fix BTC-reference-only, closeTime, positive-volume, 5m and purge/embargo defects.
4. Calibrate symbol/size-specific fees, spread, impact, slippage, latency and funding cashflows.
5. Run deterministic fixture smoke tests; then freeze one strategy × context × symbol experiment with chronological train/validation/untouched OOS, purging/embargo and serial-dependence-aware uncertainty.
6. Perform the overdue weekly taxonomy stability review only after the full archive and compatible runner are ready.
