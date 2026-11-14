# Context Strategy Research — 2026-11-14T05:30:39Z

**Run status:** `RESEARCH_EXECUTED` — archive/data-quality work only  
**Strategy experiment:** `BLOCKED`  
**Untouched OOS:** not run  
**Registry:** version 114, snapshot 132, 5 canonical entries, 0 `OOS_VALIDATED`

## 1. Research progress

### Completed this run

- Appended **32 completed rows** to the persistent raw archive: 24 × 5m and 8 × 15m across BTCUSDT, ETHUSDT, SOLUSDT and XRPUSDT. Eight forming rows were excluded. Per-symbol append: 6 × 5m + 2 × 15m.
- Validated the incremental slice: zero duplicate timestamps, gaps, off-grid opens, OHLC invariant failures, non-finite values, non-positive volume or close-time failures.
- Independently verified page 0026 and page 0027: **8 files / 12,000 rows each**, all 8/8 SHA-256 values and 8/8 Git blob identities matched. Page 0027 contains three zero-volume XRPUSDT 15m rows; those are explicitly excluded from analysis.
- Persisted and read back the new delta, delta manifest, data-quality result, page-0026/page-0027 audits, current market snapshot, archive manifest v122 and all four interval indexes.
- Refreshed BTC reference and ETH/SOL/XRP market snapshots. No strategy was selected.

### Persistent artifacts

| Artifact | Path |
|---|---|
| Incremental delta | `research-data/binance-usdm/delta/binance_usdm_delta_20261114T053039Z_5m15m_completed.jsonl` |
| Delta manifest | `research-data/binance-usdm/delta/manifest-20261114T053039Z-5m15m.json` |
| Incremental DQ result | `research/context-strategy/experiments/incremental_archive_append_20261114T0530Z_auto11_run16.result.json` |
| Page-0026 audit | `research/context-strategy/experiments/page26_integrity_verification_20261114T0530Z_auto11.result.json` |
| Page-0027 audit | `research/context-strategy/experiments/page27_integrity_verification_20261114T0530Z_auto11.result.json` |
| Market snapshot | `research-data/binance-usdm/snapshots/current_market_snapshot_20261114T0530Z_auto11.json` |
| Archive manifest | `research-data/binance-usdm/manifests/archive_manifest_20261114T053039Z_auto11_v122.json` |
| Preflight | `research/context-strategy/runs/20261114T053039Z_auto11_run16/preflight.json` |

Archive branch: `research/raw-ohlcv-archive-20261108T1026Z`. This branch is persistent GitHub storage; no local repository checkout was available.

### Historical coverage and adequacy

| Interval | Existing base archive | Latest completed incremental highwater | Current assessment |
|---|---:|---|---|
| 5m | 168,000 rows (42,000/symbol); base ends 2021-02-07 02:55Z | 2026-11-14 05:25Z | Long incremental span, but base coverage is incomplete and page windows are per-symbol, not a common-time panel |
| 15m | 168,000 rows (42,000/symbol); base ends 2021-11-25 18:45Z | 2026-11-14 05:15Z | Same limitation; zero-volume exclusions and timestamp alignment must be retained |
| 1h | 215,504 raw rows (53,876/symbol) | 2026-11-14 04:00Z | **Blocked:** 28 missing hourly opens per symbol and an 8-row top-level discrepancy |
| 4h | 53,960 raw / 53,816 aligned / 53,844 canonical | 2026-11-13 12:00Z | **Blocked:** 13 page-manifest SHA mismatches and unresolved raw/aligned/canonical lineage |

The archive contains multi-year history, but that does **not** make it strategy-ready. The 5m/15m base ends materially earlier than the incremental highwater; 1h and 4h provenance defects remain. The clean current 200/250-bar samples are for monitoring and feature calculation, not a substitute for full historical validation.

## 2. Context discovery

The latest accessible context-distribution diagnostic is dated **2026-11-08**, taxonomy `CTX-4H-EMA50xEMA200-ATRQ-v2-FULL-ARCHIVE` (v56). It used V100 training-derived frozen thresholds; thresholds were **not refit** this run.

- 13,461 4h bars per symbol; 12,462 labelled after rolling warmup.
- Chronological diagnostic split: 7,077 train / 2,692 validation / 2,693 test bars per symbol.
- Overall context self-transition rate: approximately 92.4%–93.0%.
- Train/test JSD: BTC 0.20203, ETH 0.10765, SOL 0.29652, XRP 0.12844. SOL and BTC show the largest distribution shift in that diagnostic.
- Common contexts included SIDEWAYS_LOW (18.6%–25.6%) and BEAR_NORMAL (10.6%–14.2%); SHOCK was rare (0.55%–0.75%). These are historical feature-state frequencies, not win probabilities.

Current 4h classifier inputs use EMA50/EMA200 spread and ATR14/close with the frozen per-symbol thresholds. All four symbols classify as **BEAR_NORMAL**. Trend-direction confidence is high because EMA50/EMA200 spreads are far below each symbol's flat threshold; volatility-band confidence is medium. This confidence is classification confidence, not a future trade-win probability.

| Symbol | EMA50/EMA200 spread | ATR14/close | 4h context | Last completed 4h return |
|---|---:|---:|---|---:|
| BTCUSDT | -6.37% | 1.99% | BEAR_NORMAL | -2.27% |
| ETHUSDT | -9.05% | 2.40% | BEAR_NORMAL | -2.36% |
| SOLUSDT | -12.38% | 2.89% | BEAR_NORMAL | -4.02% |
| XRPUSDT | -11.81% | 2.49% | BEAR_NORMAL | -2.05% |

No taxonomy revision is justified from this monitoring snapshot. A fresh weekly stability review remains pending the historical lineage and compute prerequisites.

## 3. Strategy-context scorecard

The canonical registry remains unchanged: four `INSUFFICIENT_EVIDENCE`, one `REJECTED`, zero `OOS_VALIDATED`. The inherited 12-trade Donchian20 v75 `OOS_PROMISING` reference is not a canonical registry entry and its provenance remains unavailable.

| Strategy × context × symbol | OOS trades | Mean net R | 95% moving-block CI | PF | Max DD | Status |
|---|---:|---:|---:|---:|---:|---|
| SOL Donchian20, BULL_LOW, V1 | 55 | +0.043 | [-0.280, +0.390] | 1.082 | 7.89R | INSUFFICIENT_EVIDENCE |
| SOL failed-breakout fade, SIDEWAYS_LOW, V1 | 113 | -0.148 | [-0.318, +0.020] | 0.787 | 20.79R | REJECTED |
| SOL 4h trend-pullback + BTC confirmation, V1.1 | 10 | -0.189 | [-0.860, +0.779] | 0.733 | 3.48R | INSUFFICIENT_EVIDENCE |
| SOL volatility-contraction breakout, BULL_COMPRESS, V1 | 18 | -0.205 | [-0.723, +0.295] | 0.687 | 7.43R | INSUFFICIENT_EVIDENCE |
| SOL volatility-contraction breakout, BEAR_COMPRESS, V1 | 26 | -0.115 | [-0.683, +0.371] | 0.814 | 7.81R | INSUFFICIENT_EVIDENCE |

The Donchian candidate's slightly positive mean R does not pass: trade count is below the per-symbol/context floor, its CI crosses zero, and total quote PnL is negative. The failed-breakout fade fails net expectancy, profit factor and drawdown gates. The remaining candidates are thin and negative on their reported tests.

No ETH or XRP candidate has symbol-specific OOS validation. No evidence is transferred from SOL to another symbol. No new strategy experiment, parameter search, bootstrap, multiple-testing correction or untouched OOS evaluation ran in this execution.

## 4. Key discoveries

1. **Archive integrity is progressing, not complete.** Page 0026 and 0027 are now independently verified per symbol. Page 0028's source replay is exact and corrected v2 manifests exist, but the page remains non-canonical until the full timestamp-aligned multi-symbol panel and zero-volume exclusion policy are built.
2. **Current context is a broad bearish state, not an entry.** All four 4h contexts are BEAR_NORMAL. 5m stabilization is not confirmed by 15m/1h/4h structure.
3. **No demonstrated actionable edge exists.** The registry has zero OOS_VALIDATED entries. The only rejected canonical strategy is the SOL SIDEWAYS_LOW failed-breakout fade; other tested candidates remain insufficient.
4. **Positioning is not a signal by itself.** Global long/short account ratios are elevated (roughly 3.09–3.83), but this does not establish crowded positioning or predict liquidation. No liquidation inference is made.
5. **No current setup can be promoted.** Favorable or persistent context is not an entry trigger; only a validated strategy with an exact trigger could qualify.

## 5. Current market snapshot

Observed at **2026-11-14 05:30:39 UTC**. Latest completed bars: 5m 05:25Z, 15m 05:15Z, 1h 04:00Z, 4h 00:00Z. BTC is reference only.

| Symbol | Last / mark | 24h change | 4h context | 5m vs EMA20/50 | 15m / 1h structure |
|---|---:|---:|---|---|---|
| BTCUSDT (reference) | 67,065 / 67,081.63 | -2.24% | BEAR_NORMAL | Above EMA20, below EMA50 | Below both EMAs |
| ETHUSDT | 1,899.69 / 1,900.10 | -1.02% | BEAR_NORMAL | Above EMA20, below EMA50 | Below both EMAs |
| SOLUSDT | 75.51 / 75.52 | -3.88% | BEAR_NORMAL | Slightly below EMA20 and below EMA50 | Below both EMAs |
| XRPUSDT | 0.9961 / 0.9962 | -1.42% | BEAR_NORMAL | Above EMA20, below EMA50 | Below both EMAs |

### Derivatives and liquidity

| Symbol | Current indicated funding | Last settled funding | 24h OI change | 15m taker buy/sell ratio | Global long/short ratio |
|---|---:|---:|---:|---:|---:|
| BTCUSDT | +0.003904% | +0.005972% | -5.07% | 0.9800 | 3.1911 |
| ETHUSDT | +0.000336% | +0.001200% | -0.74% | 1.1396 | 3.6816 |
| SOLUSDT | -0.004628% | +0.006550% | -3.34% | 1.5231 | 3.8333 |
| XRPUSDT | -0.002577% | +0.005028% | +0.02% | 0.7955 | 3.0933 |

Funding values are percentages of notional per **8-hour** interval. All current indicated magnitudes are below the 0.05% threshold. Current indicated funding is distinct from the last settled rate; next funding is 08:00Z.

20-level displayed-book spreads were approximately BTC 0.015 bps, ETH 0.053 bps, SOL 1.324 bps and XRP 1.004 bps. Depth imbalance was a single snapshot; RPI orders were excluded. No market-impact estimate is inferred from these values.

## 6. ETH/SOL/XRP decision matrix

| Symbol | Eligible OOS_VALIDATED strategy | Exact trigger | Decision | Reason |
|---|---|---|---|---|
| ETHUSDT | None | Not applicable | **NO_TRADE** | Zero validated registry entries; no validated trigger; stale contract metadata and uncalibrated costs |
| SOLUSDT | None | Not applicable | **NO_TRADE** | Zero validated registry entries; bearish 4h/1h/15m structure; no validated trigger |
| XRPUSDT | None | Not applicable | **NO_TRADE** | Zero validated registry entries; bearish 4h/1h/15m structure; latest 15m taker flow is sell-heavy |

No entry, stop, target, sizing or time stop is emitted. BTC remains a reference and is not a default trade.

## 7. Data-quality audit, costs, unavailable inputs and next work

### Preflight summary

| Check | Status | Evidence / impact |
|---|---|---|
| Shell / compute | PASS | Linux 6.18.57; Node 22.16.0; npm 10.9.2; Python 3.13.5; Git 2.47.3; 3 CPUs; 4.7 GiB available RAM; 30 GiB free disk |
| Repo / code | DEGRADED | GitHub repo and source files accessible; no local checkout; harness not executable here |
| Network / Binance | DEGRADED | Direct DNS to fapi.binance.com and data.binance.vision failed; Binance connector worked but does not expose HTTP status/headers |
| Raw archive | DEGRADED | GitHub archive branch writable/readable; page 0026/0027 and latest delta verified; page 0028, 1h and 4h lineage remain blocked |
| Data quality / coverage | DEGRADED | Recent samples pass; historical coverage is not yet suitable for multi-symbol strategy/OOS inference |
| Backtest harness / smoke test | BLOCKED | Node/npm below project engines, SDK packages absent, no local checkout; smoke test not run |
| Disk / storage | PASS | 30 GiB local free space; GitHub artifact writes and readbacks succeeded |
| Artifact readback | PASS | Delta, manifests, audits, snapshot and four indexes verified after write |

### Cost and execution limitations

- Account-specific maker/taker fee tier is unavailable.
- Historical spread/depth, market impact, queue position, latency and fill probability are not calibrated.
- Funding settlement cashflows are not available as a complete point-in-time historical series for these tests.
- The current 20-level book is a snapshot, not an execution-cost model.
- The repo backtest harness exists remotely, but was not executed. No fees/slippage assumptions were newly validated in this run.

### Unavailable or blocked inputs

- Fresh direct Binance server time and exchange metadata; the connector's exchangeInfo serverTime is stale by approximately 23.5 hours.
- Top-trader account/position endpoints were not exposed by the available connector functions.
- Historical 1h and 4h lineage reconciliation.
- Full timestamp-aligned multi-symbol 5m/15m panel.
- Local Node 24/npm 11 workspace and deterministic harness smoke test.

### Next prioritized work

1. Provision a persistent checkout with Node 24/npm 11; install pinned dependencies and run the deterministic fixture twice, including no-lookahead invariance.
2. Build the full timestamp-aligned multi-symbol 5m/15m panel from per-symbol histories; explicitly preserve missingness and exclude zero-volume bars.
3. Reconcile the 1h bridge (28 missing opens/symbol, 8-row discrepancy) and 4h raw/aligned/canonical lineage (53,960/53,816/53,844; 13 SHA mismatches).
4. Restore direct Binance DNS/HTTPS and fresh /time + exchangeInfo checks; calibrate fees, spread, slippage, impact, latency and funding cashflows.
5. Only after those prerequisites, freeze one pre-registered strategy × context × symbol experiment with train-only thresholds, validation tuning, untouched chronological test, purging/embargo, block bootstrap and multiple-testing correction.

**No strategy edge was promoted. No OOS result was generated.**
