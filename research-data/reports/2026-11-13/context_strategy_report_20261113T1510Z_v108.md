# Binance USDⓈ-M Context Strategy Research — v108

**As of:** 2026-11-13T15:10:17.005Z  
**Classification:** **RESEARCH_BLOCKED** — current monitoring and incremental archive maintenance completed; no strategy experiment or untouched OOS evaluation ran.  
**Universe:** BTCUSDT reference only; SOLUSDT, ETHUSDT and XRPUSDT tradable.

## 1. Research progress

### Completed
- Refreshed the four-symbol market snapshot through Binance's public market-data connector.
- Retrieved 200 klines for each of 4 symbols × 4 intervals: **3,200 rows**. **3,184 completed bars** were eligible; **16 forming bars** were excluded.
- Current-window checks: zero duplicates, missing intervals, off-grid timestamps, OHLC violations, non-positive volume, non-finite values or non-monotonic opens; symbols aligned per interval.
- Appended **116 completed rows** to the remote raw archive: 5m **80**, 15m **28**, 1h **8**, 4h **0**. Delta, manifest and 5m/15m/1h archive indexes were fetched back and SHA-256/Git blob identities verified.
- Highwaters now: 5m **15:00Z**, 15m **14:45Z**, 1h **14:00Z**, 4h **08:00Z**.

Raw archive: [branch](https://github.com/shubhamtaywade82/crypto-trading-agent/tree/research/raw-ohlcv-archive-20261113T063450Z-run11)  
Delta: [116-row JSONL](https://github.com/shubhamtaywade82/crypto-trading-agent/blob/research/raw-ohlcv-archive-20261113T063450Z-run11/research-data/binance-usdm/delta/binance_usdm_delta_202611131507Z_all_intervals_completed.jsonl)  
Manifest: [delta manifest](https://github.com/shubhamtaywade82/crypto-trading-agent/blob/research/raw-ohlcv-archive-20261113T063450Z-run11/research-data/binance-usdm/delta/manifest-202611131507Z-all-intervals.json)

### Historical coverage and adequacy

| Interval | Accessible archive | Adequacy |
|---|---|---|
| 5m | Incremental-only; no multi-year base history; highwater 2026-11-13 15:00Z | **INSUFFICIENT** |
| 15m | Incremental-only; no multi-year base history; highwater 2026-11-13 14:45Z | **INSUFFICIENT** |
| 1h | 215,520 rows; 53,880 per symbol; 2020-09-14 08:00Z to 2026-11-13 14:00Z | Multi-year sample is exploratory-ready after local materialization |
| 4h | 53,960 raw rows; 53,844 canonical rows through 2026-11-05 16:00Z; 13 original page-manifest SHA mismatches | **DEGRADED**: raw/canonical and provenance reconciliation remains open |

The 4h raw counts are BTC/ETH/XRP 13,501 each and SOL 13,457; canonical counts are 13,461 per symbol. The archive remains remote, not mounted locally.

### Research not completed
- **New experiments: 0. OOS evaluations: 0.**
- No compatible local project checkout exists. Observed Node is v22.16.0/npm 10.9.2; the repository requirement is Node >=24/npm >=11. The Binance SDK packages are not installed. The backtest harness was not invoked and no deterministic fixture/no-lookahead test ran.
- No training-only context refit, context occupancy, duration, transition matrix, stability or uncertainty calculation ran. The weekly taxonomy review remains blocked.
- The daily research cycle remains blocked: local-day first attempt was already recorded at 2026-11-12T23:34:00.605Z and no prerequisites have been resolved.

## 2. Context discovery

The v56 taxonomy is carried forward as a hypothesis, not refit. Its documented detector is 4h trend strength `(EMA20−EMA50)/Wilder ATR14`, training-only q67 trend-transition threshold, training-only q33/q67 ATR/close volatility buckets, 70/15/15 chronological split and 500-bar warmup. Numeric fitted thresholds and transition matrix are not present in the accessible registry.

No context frequency, duration, transition probability, stability or uncertainty statistics were recomputed. Current labels are descriptive EMA alignment only. ATR ranks are not re-estimated against a multi-year training distribution. **No low/normal/high volatility bucket, shock label or future-win probability is assigned.**

## 3. Strategy-context scorecard

| Strategy × context × symbol | Evidence status | Evidence quality | Current applicability |
|---|---|---|---|
| Donchian20 4h breakout walk-forward v2 — 36 symbol/context cells | **INSUFFICIENT_EVIDENCE** | All cells below 100 OOS trades; nominal block-bootstrap intervals include zero; Holm-adjusted p=1.0; 15bp round-trip proxy uncalibrated | Not actionable |
| Donchian20 4h breakout v2 — SOLUSDT / BULL_LOW | **OOS_PROMISING** | Carried forward: 12 OOS trades; 66.7% win; 41.7% target-before-stop; mean net +0.606R; PF 2.72; max DD 1.3R; block-bootstrap 95% CI for mean R [0.086, 1.199] | Research-only; below sample gate |
| Trend/pullback continuation | **HYPOTHESIS** | Not tested | None |
| Breakout/retest / volatility contraction | **HYPOTHESIS** | Not tested | None |
| Range mean reversion / failed-breakout fade | **HYPOTHESIS** | Not tested | None |
| Volatility expansion / momentum | **HYPOTHESIS** | Not tested | None |
| BTC-led confirmation / relative strength | **HYPOTHESIS** | Not tested | None |
| Funding/OI filters | **HYPOTHESIS** | Not tested | None |

The Donchian summaries are carried forward from the prior accessible evaluation; they were not recomputed. Full trade rules, exact split boundaries, complete cell-level intervals and trade-level cost artifacts remain incomplete. **OOS_VALIDATED entries: 0.**

## 4. Key discoveries

- No robust OOS edge is demonstrated in the accessible registry. The SOL BULL_LOW point estimate remains OOS_PROMISING only: 12 trades do not meet the predeclared >=100 OOS trades per symbol/context floor.
- BTC and ETH are bearish on 5m/1h/4h with a mixed 15m state. SOL and XRP have a 15m bullish bounce against a bearish 4h context and mixed 1h.
- Latest 15m taker buy/sell ratios are BTC **0.8787**, ETH **0.6997**, SOL **0.6617**, XRP **0.9721**: sell-dominant or near-neutral short-window flow, not a standalone edge.
- 1h OI changed 13:00Z→15:00Z by BTC **−1.087%**, ETH **−0.143%**, SOL **−0.064%**, XRP **−0.809%**. These changes do not prove liquidation or crowding.
- Global long/short account ratios are descriptive only. No context or strategy was promoted, rejected or validated this run.

## 5. Current market snapshot

**Market timestamp:** 2026-11-13 15:10:17 UTC. Price, OI and book snapshots were retrieved around 15:09:30–15:09:35Z; OI-history and global ratios are through 15:00Z; taker flow is the 14:45Z 15m bucket. Funding interval observed: **8 hours**; next funding **16:00Z**; latest settlement **08:00Z**. No indicated or settled funding rate exceeds |0.05%|.

| Symbol | Mark / last | 24h change | 5m / 15m / 1h / 4h | Indicated / settled funding | OI | OI change 13→15Z | Taker buy/sell | Top spread |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| BTCUSDT (reference) | 68,754.87 / 68,760.90 | −3.535% | BEAR / MIXED / BEAR / BEAR | +0.002359% / +0.001270% | 99,611.301 BTC | −1.087% | 0.8787 | 0.0145 bp |
| ETHUSDT | 1,938.76 / 1,939.02 | −2.952% | BEAR / MIXED / BEAR / BEAR | +0.005942% / +0.000971% | 2,342,368.370 ETH | −0.143% | 0.6997 | 0.1031 bp |
| SOLUSDT | 80.1834 / 80.1900 | −0.853% | MIXED / BULL / MIXED / BEAR | +0.005154% / −0.005430% | 9,382,657.23 SOL | −0.064% | 0.6617 | 1.2471 bp |
| XRPUSDT | 1.029505 / 1.029600 | +0.803% | MIXED / BULL / MIXED / BEAR | +0.010000% / +0.000653% | 294,285,003.2 XRP | −0.809% | 0.9721 | 0.9714 bp |

Funding values are percentages of notional. Premium-index `lastFundingRate` is retained separately from the latest settled `fundingRate`; it is not treated as a guaranteed next-settlement forecast. Latest available 1h basis at 14:00Z is negative for all four symbols; annualized basis was unavailable. Top-of-book spread is not a size-dependent impact estimate.

The context classifier uses EMA20/EMA50 on the last 100 completed closes, EMA20 slope versus 10 bars earlier, and Wilder ATR14. Volatility buckets are **UNKNOWN / NOT TRAINED**. BTC's 1h/4h bearish state is the market reference; short-term countertrend readings in SOL/XRP increase transition uncertainty.

## 6. SOL / ETH / XRP decision matrix

| Symbol | Eligible OOS_VALIDATED strategy | Exact trigger present | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | No validated rule to evaluate | **NO_TRADE** | No OOS_VALIDATED entry; 15m bullish bounce conflicts with bearish 4h and mixed 1h; exchange metadata stale for execution validation |
| ETHUSDT | None | No validated rule to evaluate | **NO_TRADE** | No OOS_VALIDATED entry; bearish 1h/4h; no validated trigger; execution metadata stale |
| XRPUSDT | None | No validated rule to evaluate | **NO_TRADE** | No OOS_VALIDATED entry; 15m bullish bounce conflicts with bearish 4h and mixed 1h; execution metadata stale |

No entry, stop, target or size is supplied. A favorable-looking regime is not an entry trigger. BTC remains reference-only.

## 7. Data-quality audit, costs, unavailable inputs and next work

### Mandatory preflight

| Capability/check | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell/compute | **PASS** | Linux 6.18.57 x86_64; Python 3.13.5; Node 22.16.0; npm 10.9.2; 3 CPUs; 5.8GiB RAM (4.7GiB available); 30GB free; cwd `/` | Shell available, but Node/npm below project requirement |
| Repository/code | **BLOCKED** | No local checkout; required Node >=24/npm >=11; SDK packages absent | Provision compatible runner and clone exact branch |
| Network/Binance | **DEGRADED** | Direct DNS to fapi.binance.com and github.com fails (curl exit 6 / HTTP 000); connector provides live data but hides HTTP status; exchangeInfo serverTime is 9.13h stale | Restore direct HTTPS; fresh /time and /exchangeInfo required |
| Raw archive | **DEGRADED** | 116 rows appended and readback verified remotely; archive not mounted locally; 5m/15m base absent; 4h mismatch open | Materialize archive; backfill 5m/15m; reconcile 4h |
| Data quality/coverage | **DEGRADED** | Current 3,200-row sample passes core checks; 1h six-year archive; 4h provenance degraded | Full local multi-year audit required |
| Backtest harness/smoke test | **BLOCKED** | Harness not invoked; deterministic fixture/no-lookahead test not run | Provision runner, run fixture twice, then experiment |
| Disk/storage | **PASS** | 30GB free; GitHub writes succeeded | Continue remote versioned snapshots |
| Artifact readback | **PASS** | Delta, manifest and 5m/15m/1h indexes fetched back and verified | Verify v108 context artifacts after creation |

### Costs and unavailable inputs
- Account fee tier and maker/taker schedule were not observed.
- No synchronized historical depth/trade data, size-dependent impact, latency or fill distribution.
- The 15bp round-trip proxy remains uncalibrated and is not execution truth.
- Full funding settlement cashflows are not archived; only the latest four settled records per symbol were retrieved.
- No liquidation feed or validated crowding measure. Global long/short account ratio is not proof of leverage concentration.
- Contract status is not freshly validated because exchangeInfo metadata is stale and direct server time is unreachable.

### Highest-priority next actions
1. Restore direct Binance HTTPS; obtain fresh /fapi/v1/time and /fapi/v1/exchangeInfo with <=5s drift.
2. Provision Node >=24/npm >=11; clone the exact branch and verify package-lock/code hashes.
3. Backfill multi-year 5m/15m; materialize and reconcile 1h/4h raw/canonical pages and hashes.
4. Re-audit closeTime/volume handling, 5m replay, BTC reference-only defaults and purge/embargo controls.
5. Capture fee tier, synchronized depth/trade data and full historical funding settlements.
6. Run deterministic fixture smoke tests twice; only then freeze one strategy × context × symbol experiment with chronological train/validation/untouched OOS, purge/embargo, block bootstrap and multiple-testing correction.

**Final classification: RESEARCH_BLOCKED.** Monitoring and remote archive ingestion completed. No strategy experiment or untouched OOS evaluation ran. No OOS_VALIDATED strategy exists; SOLUSDT, ETHUSDT and XRPUSDT remain **NO_TRADE**.
