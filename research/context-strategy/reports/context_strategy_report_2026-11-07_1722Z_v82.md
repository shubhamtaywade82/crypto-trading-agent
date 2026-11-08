# Context Strategy Research — Run v82

**As of:** 2026-11-07T17:22:01.714Z  
**Classification:** `RESEARCH_BLOCKED`  
**Registry:** `v82`  
**Venue:** Binance USDⓈ-M perpetuals  
**Tradable:** SOLUSDT, ETHUSDT, XRPUSDT · **Reference only:** BTCUSDT

## 1. Research progress

### Completed this run
- Queried Binance USDⓈ-M public connector data for BTC, ETH, SOL and XRP across 5m/15m/1h/4h.
- Retrieved current mark/index, 24h ticker, open interest, order-book depth, funding indication/history/interval, completed 1h taker flow and completed 1h global long/short ratios.
- Appended **64 completed candles** to the remote raw archive: 44 x 5m, 16 x 15m, 4 x 1h, 0 x 4h.
- The bounded kline calls returned 360 rows; 8 forming rows were excluded and 288 rows were at/before prior high-water marks.
- New delta: `research-data/binance-usdm/delta/binance_usdm_delta_20261107T1722_5m15m1h_completed.jsonl`, 17,799 bytes, SHA-256 `cd966858dfbb3a8da20fdde45f5bb0393dd99f83e84b8008c1075e02aa6b48b4`.
- Manifest: `research-data/binance-usdm/delta/manifest-20261107T1722-5m15m1h.json`, SHA-256 `60f7ec29574e18dcabaeec79e4ae2c44af99faeccedeabeb17279d14b97a4500`.
- Both raw delta and manifest were fetched back and verified.

### New archive high-water marks
| Interval | Previous high-water | Latest completed open | Appended rows |
|---|---|---|---:|
| 5m | 16:20Z | 17:15Z | 44 |
| 15m | 16:00Z | 17:00Z | 16 |
| 1h | 15:00Z | 16:00Z | 4 |
| 4h | 12:00Z | 12:00Z | 0 |

Cumulative incremental rows: **3,916**. No 4h bar had closed after the previous 12:00Z high-water at the time of this run.

### Still incomplete
- Multi-year 5m/15m archive is absent.
- 4h canonical archive remains at 13,461 rows per symbol through 2026-11-05 16:00Z; incremental 4h history is not merged.
- Missing 76-row delta remains unresolved.
- 13 historical page/symbol hash provenance discrepancies remain.
- No strategy experiment or OOS evaluation was executed.

## 2. Context discovery

### Descriptive feature schema
- **Trend:** EMA20/EMA50 alignment and 5-bar EMA20 slope.
- **Volatility:** ATR14 and percentile rank against the latest 100 ATR observations.
- **Structure:** completed close versus the preceding 20-bar high/low.
- **Participation:** volume versus preceding 20-bar median and taker-buy share.
- **BTC-led reference:** 59 completed hourly returns for rolling correlation.
- **Derivatives:** current funding indication, last settled funding, OI and completed global long/short sample.

All 16 current rolling series contained 120 returned rows: 119 completed and one forming. No duplicates, gaps, off-grid timestamps, OHLC invariant failures, non-positive volume, non-finite values or close-time failures were observed.

**No training-derived regime thresholds were fitted.** Context frequency, duration, transition matrices and classification stability are therefore not reported. The 119 completed bars per series are a monitoring window, not a multi-cycle regime-discovery sample. ATR percentiles are descriptive, not calibrated shock labels.

### Current descriptive alignment
All four symbols are EMA20 < EMA50 on 5m, 15m, 1h and 4h. BTC, SOL and XRP have a slightly positive 5m EMA20 slope while their 15m/1h/4h slopes remain negative; this is a short-term countertrend stabilization signal, not a regime reversal.

## 3. Strategy-context scorecard

No new experiment ran. The previous scorecard is carried forward without modification.

| Candidate | Symbol/context | Status | Evidence |
|---|---|---|---|
| 4h Donchian20 breakout | SOLUSDT / BULL_LOW | OOS_PROMISING | 12 inherited OOS trades; win rate 66.7%; target-before-stop 41.7%; mean net +0.606R; PF 2.72; max DD 1.3R; block-bootstrap 95% CI [0.086R, 1.199R] |
| Context-aligned Donchian20 WF v2 | 36 symbol/context cells | INSUFFICIENT_EVIDENCE | All cells below 100 OOS trades/cell; nominal block-bootstrap intervals include zero; Holm-adjusted p=1.0 |
| Other strategy families | All symbols | HYPOTHESIS | Not tested in this run |

The 12-trade SOL candidate does not meet the minimum 100 OOS trades per symbol/context. It is not actionable. No candidate is OOS_VALIDATED; validated count remains **zero**.

Inherited aggregate per-symbol experiment results are not new findings: BTC 200 trades/mean -0.1008R; ETH 182/+0.0478R; SOL 208/-0.0177R; XRP 188/+0.0489R. These aggregates do not override the per-context evidence gates.

## 4. Key discoveries

- Current EMA20/EMA50 alignment is bearish on all 16 symbol/timeframe combinations.
- No last-completed candle is outside its preceding Donchian20 range.
- 1h ATR14 percentile ranks are low in the recent 100-ATR window: BTC 5, ETH 6, SOL 4, XRP 5.
- 4h ATR14 percentile ranks are BTC 70, ETH 62, SOL 62, XRP 90; XRP's recent 4h range is elevated relative to this short rolling sample, but no training-calibrated shock threshold exists.
- Latest completed 1h taker-buy shares are BTC 54.4%, ETH 42.9%, SOL 50.3%, XRP 54.7%.
- 59-return BTC correlations: ETH 0.960, SOL 0.856, XRP 0.765. These are descriptive contemporaneous correlations, not evidence of lead/lag.
- The inherited SOL BULL_LOW breakout candidate is not applicable to the current BEAR context.

No strategy failure or success is newly established by these live observations.

## 5. Current market snapshot

Market events are timestamped around 17:19Z; completed candles are current through 5m 17:15Z, 15m 17:00Z, 1h 16:00Z and 4h 12:00Z.

| Symbol | Role | Mark | 24h change | 24h quote volume | OI | OI change since 16:29 snapshot |
|---|---|---:|---:|---:|---:|---:|
| BTCUSDT | Reference | 75,762.50 | -0.255% | 3.381B USDT | 96,265.609 | +0.027% |
| ETHUSDT | Tradable | 2,234.95 | +0.055% | 2.448B USDT | 2,366,819.948 | +0.276% |
| SOLUSDT | Tradable | 89.6175 | -1.016% | 548.8M USDT | 9,372,048.70 | +0.057% |
| XRPUSDT | Tradable | 1.1613 | -2.821% | 525.1M USDT | 338,235,634.5 | -0.048% |

OI deltas compare the accessible v81 snapshot at 16:29Z with the current OI samples around 17:19Z. OI quantities are raw contract/base units, not USD notional; these small changes do not establish crowding or liquidation risk.

### Funding
FundingInfo reports an **8-hour interval for all four symbols**. Last settled funding was at 16:00Z; next funding is 2026-11-08 00:00Z. The PremiumIndex indication is kept separate from the latest settled FundingRate history value.

| Symbol | Current indication | Last settled |
|---|---:|---:|
| BTCUSDT | 0.004197% | 0.001302% |
| ETHUSDT | 0.008282% | 0.007427% |
| SOLUSDT | 0.000725% | 0.001115% |
| XRPUSDT | 0.010000% | 0.010000% |

No observed rate breaches |funding| > 0.05%.

### Liquidity and positioning snapshots
| Symbol | Top-of-book spread | Latest completed 1h taker-buy share | Last completed 1h global long-account share |
|---|---:|---:|---:|
| BTCUSDT | 0.0132 bps | 54.4% | 75.27% |
| ETHUSDT | 0.0447 bps | 42.9% | 78.41% |
| SOLUSDT | 1.1159 bps | 50.3% | 78.37% |
| XRPUSDT | 0.8614 bps | 54.7% | 74.02% |

Top-of-book spreads are instantaneous snapshots, not historical execution-cost estimates. The long-account sample is the last completed 1h point at 16:00Z; the 17:00Z sample was excluded as potentially forming.

## 6. Trading decisions

| Symbol | Decision | Reason |
|---|---|---|
| SOLUSDT | **NO_TRADE** | No OOS_VALIDATED entry; inherited BULL_LOW candidate conflicts with current BEAR context; no Donchian20 trigger |
| ETHUSDT | **NO_TRADE** | No OOS_VALIDATED symbol/context entry or exact trigger |
| XRPUSDT | **NO_TRADE** | No OOS_VALIDATED symbol/context entry or exact trigger |

No entry, stop, target or position size is issued. BTC remains reference-only.

## 7. Data-quality audit, costs, unavailable inputs and next experiments

### Execution preflight
| Check | Status | Evidence / impact |
|---|---|---|
| Shell/compute | PASS | Linux x86_64, 5 CPUs, 5.8 GiB RAM, 30 GiB free; Node 22.16/npm 10.9.2 |
| Repository/code | DEGRADED | Remote GitHub source readable; no local checkout |
| SDK | BLOCKED | Required SDK packages not installed; SDK not used |
| Network/Binance | DEGRADED | Connector endpoints returned data; direct DNS failed; raw HTTP status unavailable; exchangeInfo serverTime stale 108,200.831s |
| Raw archive | PASS | 64-row delta and manifest written and read back |
| Data quality/coverage | DEGRADED | Recent windows clean; multi-year 5m/15m absent and 4h canonical merge incomplete |
| Backtest/smoke test | BLOCKED | Remote harness exists; cannot invoke locally; smoke test NOT_RUN |
| Disk/storage | PASS | 30 GiB free; remote GitHub writes available |
| Artifact readback | PASS | Raw delta and manifest verified; research artifacts are read back after writes |

### Costs and unavailable metrics
The inherited 15bp round-trip proxy is not calibrated. Actual account fee tier, historical spread/depth, market impact, slippage, latency and funding cashflows are unavailable. Current top-of-book snapshots cannot substitute for these series. Historical liquidation data and basis series were not retrieved. Direct /fapi/v1/time was unavailable; exchangeInfo serverTime was stale and cannot validate current contract status. Although stale metadata reports all four symbols as TRADING, this is not treated as fresh execution validation.

### Research queue — next actions
1. Backfill multi-year 5m/15m and merge incremental 4h into canonical history.
2. Recover the missing 76-row delta or document irrecoverable provenance; reconcile 13 hash discrepancies.
3. Restore uncached /fapi/v1/time and /fapi/v1/exchangeInfo; require <=60s time drift and fresh TRADING status.
4. Provision Node >=24/npm >=11 and a local checkout; install pinned dependencies.
5. Carry closeTime through Candle, reject volume <=0, add 5m support and run deterministic fixture twice with no-lookahead checks.
6. Calibrate account fees, spread, slippage, impact, latency and historical funding.
7. Only then preregister one strategy x context x symbol experiment with chronological train/validation/untouched OOS, purging/embargo, block bootstrap and multiple-testing correction.

**Final classification: `RESEARCH_BLOCKED`.** Monitoring and archive maintenance completed; no experiment or OOS evaluation completed.