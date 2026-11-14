# Binance USDⓈ-M Context Strategy Research — v107

**As of:** 2026-11-13T17:38:53.201Z  
**Status:** RESEARCH_BLOCKED (archive refresh and monitoring completed; no valid experiment or OOS evaluation)  
**Raw archive branch:** `research/raw-ohlcv-archive-20261113T063450Z-run11` @ `abcd9ed51371536371a4cc57e274386a7a4090e1`  
**Context snapshot branch:** `research/context-strategy-20261113T1738Z-v107`

## 1. Research progress

- Appended **172 completed OHLCV rows** across BTCUSDT, ETHUSDT, SOLUSDT and XRPUSDT: 5m 120, 15m 40, 1h 8, 4h 4.
- Read back both delta files, both manifests and the affected archive indexes. SHA-256 and Git blob identities matched.
- Latest completed opens: 5m **17:30Z**, 15m **17:15Z**, 1h **16:00Z**, 4h **12:00Z** on 2026-11-13.
- Current-window quality checks passed on 3,200 returned bars: 3,184 completed, 16 forming bars excluded; zero duplicates, gaps, off-grid timestamps, non-monotonic rows, OHLC invariant failures, non-positive volumes, non-finite values or close-time failures.
- **No experiment ran. No OOS evaluation ran.** The actual harness could not be invoked in this runtime: no local checkout, Node 22.16/npm 10.9 versus repository requirements Node >=24/npm >=11, and required SDK dependencies are not installed. The deterministic harness smoke test was not run.
- Historical research remains blocked by absent multi-year 5m/15m base history, 4h raw/canonical discrepancies, incomplete funding cashflows and uncalibrated execution costs.

## 2. Context discovery

The existing v56 taxonomy is carried forward, **not refit**. Its documented detector uses 4h trend strength `(EMA20-EMA50)/Wilder ATR14`, training-only q67 trend-transition threshold, training-only q33/q67 ATR/close buckets, 70/15/15 split and 500-bar warmup. Numeric fitted thresholds and the transition matrix are not present in the accessible artifact.

Current labels below are descriptive only: EMA20/EMA50 alignment plus 10-bar EMA20 slope versus 0.2×Wilder ATR14, calculated on 199 completed bars per symbol/interval. This heuristic is not training-fitted. Context occupancy, duration, transition probabilities, stability and classification uncertainty were not estimated. These labels are not win probabilities.

| Symbol | 5m | 15m | 1h | 4h | Interpretation |
|---|---|---|---|---|---|
| BTCUSDT (reference) | MIXED | BEAR | BEAR | BEAR | Lower-timeframe pause against bearish higher-timeframe alignment |
| ETHUSDT | BEAR | BEAR | BEAR | BEAR | Bearish alignment across all sampled intervals |
| SOLUSDT | MIXED | BEAR | BEAR | BEAR | Short-term mixed state within bearish higher-timeframe alignment |
| XRPUSDT | MIXED | BEAR | MIXED | BEAR | More transition risk; 1h/5m not aligned |

## 3. Strategy-context scorecard

**No OOS_VALIDATED entries exist.** The registry is unchanged in evidence status; current applicability is separate from historical evidence.

| Candidate | Symbol/context | Evidence status | Available evidence / limitation |
|---|---|---|---|
| Donchian20 4h breakout walk-forward v2 | 36 symbol/context cells | INSUFFICIENT_EVIDENCE | All cells below 100 OOS trades; nominal block-bootstrap intervals include zero; Holm-adjusted p=1.0; 15bp round-trip proxy uncalibrated |
| Donchian20 4h breakout v2 | SOLUSDT / BULL_LOW | OOS_PROMISING | Carried-forward only: 12 OOS trades, 66.7% win rate, 41.7% target-before-stop, mean net R 0.606, PF 2.72, max DD 1.3R, 95% block-bootstrap CI [0.086, 1.199]. Below the 100-trade gate; costs and parameter robustness incomplete |
| Trend/pullback continuation | ALL | HYPOTHESIS | Not tested |
| Breakout/retest / volatility contraction | ALL | HYPOTHESIS | Not tested |
| Range mean reversion / failed-breakout fade | ALL | HYPOTHESIS | Not tested |
| Volatility expansion / momentum | ALL | HYPOTHESIS | Not tested |
| BTC-led confirmation / relative strength | ALL | HYPOTHESIS | Not tested |
| Funding/OI filters | ALL | HYPOTHESIS | Not tested |

No REJECTED status was assigned because no new OOS test ran. Carried-forward metrics were not recomputed.

## 4. Key discoveries

- There is **no demonstrated robust conditional edge** in the newly refreshed data; no strategy family was tested this run.
- The only previously promising cell remains SOLUSDT/BULL_LOW Donchian20 with 12 OOS trades. It is research-only and cannot drive selection.
- Current higher-timeframe labels are bearish across all four symbols at 4h and all but XRP at 1h. This is a context observation, not an entry signal.
- Latest 15m taker buy/sell ratios are BTC 1.2495, ETH 1.1443, SOL 0.9108, XRP 1.0999. This mixed participation snapshot does not establish predictive edge.
- Two-hour OI changes (15:00→17:00Z) were BTC -0.863%, ETH -0.443%, SOL -0.430%, XRP -0.555%. Global long/short account ratios were 3.0650, 3.6642, 3.4346 and 3.0225 respectively. Neither OI nor account ratios alone proves crowding or liquidation risk.
- Current indicated funding remains below the 0.05% absolute threshold for every symbol. No funding extreme is flagged.

## 5. Current market snapshot

Market-data timestamps are asynchronous: mark/ticker approximately 17:36:31–17:36:34Z, completed candles 17:36:34Z, and OI/top-of-book approximately 17:38:50–17:38:53Z.

| Symbol | Mark / last | 24h change | OI (base units) | Top spread | Current indicated funding | Last settled funding (16:00Z) |
|---|---:|---:|---:|---:|---:|---:|
| BTCUSDT | 68,821.00 / 68,820.90 | -4.221% | 98,581.537 | 0.0145 bp | 0.007138% | 0.004045% |
| ETHUSDT | 1,934.42 / 1,934.20 | -3.885% | 2,334,677.571 | 0.0516 bp | 0.004861% | 0.004743% |
| SOLUSDT | 80.0971 / 80.1200 | -1.645% | 9,361,119.30 | 1.2456 bp | 0.010000% | 0.007203% |
| XRPUSDT | 1.0231 / 1.0230 | -0.234% | 292,807,917.5 | 0.9771 bp | 0.010000% | 0.010000% |

Funding cadence observed from settlement timestamps: **8 hours**; next funding is **2026-11-14 00:00Z**. The latest settled funding record is 16:00Z. Current indicated funding and last settled funding are not interchangeable.

## 6. Decision matrix

| Tradable | OOS_VALIDATED strategy | Exact trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | Not evaluated | **NO_TRADE** | No validated registry entry; current bearish higher-timeframe context is not an entry trigger; contract metadata stale and costs uncalibrated |
| ETHUSDT | None | Not evaluated | **NO_TRADE** | No validated registry entry; bearish labels are context only; no exact validated trigger |
| XRPUSDT | None | Not evaluated | **NO_TRADE** | No validated registry entry; mixed 1h state and bearish 4h/15m state; no exact validated trigger |

BTCUSDT remains reference-only. No entry, stop, target or size is supplied.

## 7. Data audit, costs, unavailable inputs, risks and next experiments

- **1h archive:** 215,528 rows, 53,882 per symbol, 2020-09-14 08:00Z through 2026-11-13 16:00Z; indexed historical quality remains clean.
- **4h archive:** raw 53,964 rows (BTC/ETH/XRP 13,502 each; SOL 13,458) versus canonical 53,844 rows (13,461 each) ending 2026-11-05 16:00Z. Raw-minus-canonical is +41/+41/-3/+41; 13 page-manifest provenance mismatches remain. Status stays DEGRADED.
- **5m/15m:** recent incremental deltas only; multi-year base history absent. Do not treat the current 200-bar windows as a sufficient historical sample.
- Direct shell probes of `/fapi/v1/time`, `/fapi/v1/exchangeInfo`, `/fapi/v1/klines`, `/fapi/v1/premiumIndex`, `/fapi/v1/openInterest` and `/fapi/v1/ticker/24hr` all failed DNS resolution (curl exit 6, HTTP 000). The Binance connector returned market data but hides HTTP status/headers. Connector `exchangeInfo.serverTime` was 06:02:01.702Z, 11h24m08.857s stale; contract status is therefore not freshly verified for execution.
- Top-of-book spread is a single-level diagnostic only. Fee tier, synchronized depth/trades, market impact, latency, fill distributions and full funding cashflows are unavailable. No liquidation feed was retrieved.
- Repository source files exist remotely, but the local checkout and compatible Node/npm runtime do not. No smoke test, backtest or OOS evaluation was claimed.
- **Next queue order:** (1) restore direct Binance DNS/time/metadata; (2) backfill multi-year 5m/15m; (3) reconcile 4h raw/canonical pages; (4) provision Node 24+/npm 11+ and run the actual harness smoke test; (5) enforce BTC reference-only and 5m/purge/embargo contracts; (6) calibrate fees/slippage and backfill funding cashflows; (7) only then run a frozen strategy×context×symbol experiment.

**Conclusion:** archive refresh and current classification completed; research remains blocked. No OOS_VALIDATED strategy exists, so the correct trade output is NO_TRADE for SOL, ETH and XRP.
