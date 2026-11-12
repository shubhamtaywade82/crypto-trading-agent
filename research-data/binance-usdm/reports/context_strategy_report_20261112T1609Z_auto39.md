# Context Strategy Research — v97

**As of:** 2026-11-12T16:09:00Z (2026-11-12T21:39:00+05:30)
**Run classification:** `RESEARCH_EXECUTED_DATA_QUALITY_ONLY`
**Strategy research:** `RESEARCH_BLOCKED`
**Untouched OOS:** Not evaluated
**Tradable:** SOLUSDT, ETHUSDT, XRPUSDT. **Reference only:** BTCUSDT.

## 1. Research progress

- Remote archive append completed and verified: 84 rows across 5m/15m/1h/4h, followed by 4 additional completed 5m rows; total 88 new completed bars.
- The 84-row append fetched 1,600 rows across 16 symbol/interval series; 16 forming rows were excluded and 1,500 pre-highwater rows were ignored. The follow-up fetched 40 5m rows; 4 forming and 32 pre-highwater rows were excluded.
- Incremental integrity checks: zero duplicates, gaps, off-grid timestamps, non-monotonic rows, OHLC violations, non-positive volume, non-finite values or close-time failures; cross-symbol alignment and continuity passed.
- Delta files, per-delta manifests, global manifests and interval indexes were fetched back and verified. This is data-quality evidence only; no strategy backtest ran.

### Archive highwaters

| Interval | Latest completed open UTC | Next expected open UTC | Historical base status |
|---|---|---|---|
| 5m | 2026-11-12 16:00 | 16:05 | Partial; per-symbol coverage ends 2020-04-19 to 2021-01-01 |
| 15m | 2026-11-12 15:45 | 16:00 | Partial; per-symbol coverage ends 2020-11-24 to 2021-08-08 |
| 1h | 2026-11-12 15:00 | 16:00 | 215,484 base rows, 2020-09-14 through 2026-11-06 |
| 4h | 2026-11-12 12:00 | 16:00 | Degraded; raw/aligned/canonical counts 53,960/53,816/53,844 |

5m and 15m base history is not multi-year for all symbols. The 4h count/provenance reconciliation remains unresolved. The local filesystem has no archive checkout; the remote GitHub archive branch is accessible and verified.

## 2. Context discovery

Taxonomy v56 is carried forward, not refit. It uses `(EMA20-EMA50)/Wilder ATR14`, training-derived transition and ATR/close quantiles, a 70/15/15 chronological split and 500-bar warmup.

| Symbol | BEAR_LOW | TRANSITION_LOW | BULL_LOW | Validation/test TVD | Median transition duration |
|---|---:|---:|---:|---:|---:|
| BTC | 6.53% | 50.66% | 9.85% | 0.175 | 38h |
| ETH | 6.42% | 46.24% | 6.64% | 0.338 | 42h |
| SOL | 10.90% | 67.56% | 10.70% | 0.245 | 120h |
| XRP | 15.20% | 43.63% | 3.22% | 0.293 | 68h |

These are historical feature-state frequencies, not trade-win probabilities. ETH/XRP context drift remains material. No frequency, duration or transition matrix was recomputed today.

## 3. Strategy-context scorecard

| Candidate | Scope | Evidence status | Evidence / limitation | Actionability |
|---|---|---|---|---|
| Donchian20 4h breakout WF v2 | 36 symbol/context cells | `INSUFFICIENT_EVIDENCE` | All below 100 OOS trades; nominal block-bootstrap intervals include zero; Holm-adjusted p=1.0; 15bp cost proxy uncalibrated | Research only |
| Donchian20 4h breakout | SOLUSDT / BULL_LOW | `OOS_PROMISING` | 12 OOS trades; 66.7% win; 41.7% target-before-stop; +0.606R mean net; PF 2.72; max DD 1.3R; nominal CI [+0.086R,+1.199R] | Not validated |
| Trend/pullback continuation | All | `HYPOTHESIS` | No independent experiment | Not actionable |
| Breakout/retest / volatility contraction | All | `HYPOTHESIS` | No independent experiment | Not actionable |
| Range mean reversion / failed-breakout fade | All | `HYPOTHESIS` | No independent experiment | Not actionable |
| Volatility expansion / momentum | All | `HYPOTHESIS` | No independent experiment | Not actionable |
| BTC-led relative strength / weakness | All | `HYPOTHESIS` | Contemporaneous correlation is not lead/lag evidence | Not actionable |
| Funding/OI filters | All | `HYPOTHESIS` | Full settlement history and causal/filter test unavailable | Not actionable |

**OOS_VALIDATED entries: 0.** No strategy status changed this run.

## 4. Key discoveries

- All four symbols currently show bearish 1h/4h EMA alignment, while the latest 5m/15m completed bars are positive: a countertrend rebound, not a reversal signal.
- 15m ATR percentiles are locally high (BTC97, ETH97, SOL100, XRP89) within the 180-bar sample; these are descriptive local percentiles, not training-fitted regime thresholds.
- OI rose over the latest hourly bucket for all four symbols (+0.387% BTC, +0.710% ETH, +0.582% SOL, +0.254% XRP). This does not by itself prove crowding or liquidation pressure.
- No strategy family has demonstrated robust symbol/context-specific net edge in the accessible evidence.

## 5. Current market context snapshot

Market data retrieved 2026-11-12 16:04:50-16:06:43 UTC. Current feature classification uses completed candles only; current 16:00 5m candle was complete at retrieval, while 16:00 15m/1h/4h candles were still forming.

| Symbol | Last / mark | 24h change | OI | OI change 1h | Indicated / settled funding | Spread |
|---|---:|---:|---:|---:|---:|---:|
| BTC (reference) | 71,781 / 71,782.86 | -3.020% | 102,309.926 | +0.387% | 0.008874% / 0.008904% | 0.0139 bp |
| ETH | 2,012.23 / 2,012.19 | -3.026% | 2,346,145.943 | +0.710% | 0.004748% / 0.004733% | 0.0497 bp |
| SOL | 81.76 / 81.76 | -3.517% | 9,742,372.87 | +0.582% | 0.000405% / 0.000716% | 1.2233 bp |
| XRP | 1.0275 / 1.02758 | -4.035% | 310,103,505.2 | +0.254% | 0.004468% / 0.004560% | 0.9734 bp |

Funding: latest settlement 16:00:00.003Z; next funding 2026-11-13 00:00Z; observed interval 8h. No indicated or settled rate exceeded |0.05%|. Latest 15m taker buy/sell ratios: BTC1.2503, ETH1.0773, SOL1.1135, XRP0.8582. Global long/short account ratios: BTC3.1374, ETH3.5269, SOL3.5998, XRP3.0950. These are descriptive; they do not establish crowding or liquidations.

| Symbol | 1h return20 | 4h return20 | 1h close vs EMA20 | 4h close vs EMA20 | 1h ATR local percentile | 4h ATR local percentile |
|---|---:|---:|---:|---:|---:|---:|
| BTC | -3.635% | -2.934% | -2.027% | -3.082% | 55 | 74 |
| ETH | -3.348% | -4.054% | -1.483% | -3.447% | 43 | 57 |
| SOL | -3.715% | -4.536% | -1.308% | -3.258% | 42 | 54 |
| XRP | -3.087% | -5.287% | -1.645% | -4.124% | 22 | 58 |

All four are descriptively BEARISH on both 1h and 4h: close below EMA20, EMA20 below EMA50, EMA50 slope negative. 5m/15m rebound bars are countertrend. No local 5m 3-sigma shock detected. Confidence refers to feature alignment only, not win probability.

## 6. SOL/ETH/XRP decision matrix

| Symbol | OOS_VALIDATED rule | Trigger | Decision | Reason |
|---|---|---|---|---|
| SOL | None | Not evaluated | **NO_TRADE** | Zero OOS_VALIDATED entries; SOL BULL_LOW candidate is research-only; stale metadata and uncalibrated costs |
| ETH | None | Not evaluated | **NO_TRADE** | Zero OOS_VALIDATED entries; no symbol-specific proven setup |
| XRP | None | Not evaluated | **NO_TRADE** | Zero OOS_VALIDATED entries; no symbol-specific proven setup |

No entry, stop, target or leverage supplied. BTC remains reference-only.

## 7. Preflight, costs, unavailable inputs and next experiments

| Capability | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell/compute | PASS | Debian13, Python3.13.5, Node22.16.0/npm10.9.2, 3 CPUs, ~4.94GB available RAM, ~30GB free disk | Bounded data work completed; provision Node24/npm11 |
| Repository/code | BLOCKED | No local checkout or node_modules; Node24 not installed | Clone current HEAD under compatible runner |
| Network/Binance | DEGRADED | Direct fapi DNS failed; connector returned fresh market data; exchangeInfo serverTime stale by 6h20m | Restore uncached server-time/metadata access; require <=5s drift |
| Raw archive | DEGRADED | Remote GitHub branch accessible; 5m/15m partial; 1h substantial; 4h count discrepancy | Backfill lower timeframes and reconcile 4h |
| Data quality | PASS for sampled windows | 2,880 rows fetched, 2,864 completed, 16 forming excluded; zero sampled integrity failures; 88 new rows persisted | Full archive audit still required |
| Backtest harness/smoke test | BLOCKED | No local repo/harness; no compatible Node runtime | Run deterministic fixture after checkout |
| Disk/storage | PASS | ~30GB free; GitHub branch accepted append-only deltas/indexes | Continue atomic append |
| Artifact readback | PASS | Delta/manifests/global manifests/indexes read back and verified | Maintain checksums/readback |

Costs remain uncalibrated: prior 4bp taker +2bp half-spread +3bp slippage per fill implies 18bp round trip if symmetric; prior 15bp proxy is not reliable. Current top-of-book spreads are not depth-aware historical execution costs. Full funding cashflows, market impact, latency and liquidation data are unavailable.

Next experiments: (1) provision Node24/npm11 and re-audit current main; (2) backfill multi-year 5m/15m; (3) reconcile 4h raw/aligned/canonical counts and provenance; (4) build symbol-specific cost/funding model; (5) only then freeze one pre-registered strategy × context × symbol experiment and run purged walk-forward with untouched OOS.

**Run outcome:** `RESEARCH_EXECUTED` for incremental archive integrity only; strategy research `RESEARCH_BLOCKED`; `OOS_EVALUATED`: no; `OOS_VALIDATED`: 0; SOL/ETH/XRP: `NO_TRADE`.
