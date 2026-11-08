# Context Strategy Research — 8 November 2026, 15:29 UTC

**Run classification: RESEARCH_BLOCKED**  
**Market monitoring:** completed. **Archive append and index maintenance:** completed and readback-verified. **Experiments:** 0. **Untouched OOS evaluations:** 0. **OOS_VALIDATED strategies:** 0.

## 1. Research progress

Appended 60 completed Binance USDⓈ-M klines across BTC, ETH, SOL and XRP:

| Interval | New rows | Rows per symbol | Latest completed open (UTC) |
|---|---:|---:|---|
| 5m | 44 | 11 | 15:20 |
| 15m | 12 | 3 | 15:00 |
| 1h | 4 | 1 | 14:00 |
| 4h | 0 | 0 | 08:00 |
| **Total** | **60** | **15 per symbol** | |

No 4h candle had completed by the observation time; the 12:00 UTC 4h candle was forming and excluded.

- Delta: research-data/binance-usdm/delta/binance_usdm_delta_20261108T152914Z_5m15m1h_completed.jsonl
- Size: 23,421 bytes; 60 JSONL records.
- SHA-256: 4fd69043c99b67f5bd7683979dc3067ed32038ecc9319b5705499a8e5bceedc2
- Manifest SHA-256: 8a3ed52db43a318e955b2627ece4808e80dad0dba79e595ec78c3bb3f3984af9
- SHA-256 implementation passed the standard abc known vector. Delta, manifest and checksum sidecar were fetched back and verified.
- The 5m, 15m and 1h archive indexes were updated and fetched back. Their highwaters are 15:20, 15:00 and 14:00 UTC.

Historical coverage:
| Interval | Existing base / canonical coverage | Assessment |
|---|---|---|
| 1h | 215,484 rows; 53,871 per symbol; base through 6 Nov 22:00 UTC; incrementals through 8 Nov 14:00 UTC | Multi-year history exists |
| 4h | 53,952 raw rows; canonical 53,844 rows through 5 Nov 16:00 UTC; raw incremental highwater 8 Nov 08:00 UTC | Canonical rebuild/reconciliation required |
| 5m | No multi-year base archive | Incremental-only |
| 15m | No multi-year base archive | Incremental-only |

The 4h archive remains degraded. It records 13 original page/symbol SHA-256 mismatches (BTC pages 2–6 and all four symbols on pages 7–8). A prior 21,000-row independent comparison found no row-level mismatches in the tested sample, but this does not resolve provenance/hash and row-count discrepancies. Raw-versus-canonical differences remain BTC +38, ETH +38, SOL −6 and XRP +38. Rebuild canonical 4h through the verified 08:00 UTC highwater.

No strategy experiment or smoke test ran. Exact blockers are in section 7.

## 2. Context discovery

Frozen v56 taxonomy retained without refitting:
- Trend strength: (EMA20 − EMA50) / Wilder ATR14.
- TRANSITION when absolute trend strength is below symbol-specific training q67; otherwise BULL/BEAR by sign.
- Volatility: Wilder ATR14 / close, split by frozen symbol-specific training q33/q67.

| Symbol | 4h strength / ATR | 4h ATR14 / close | 4h context | 1h state |
|---|---:|---:|---|---|
| BTC | −1.3746 | 0.9097% | BEAR_LOW | MIXED |
| ETH | −0.8323 | 1.1965% | TRANSITION_LOW | MIXED |
| SOL | −1.6463 | 1.5417% | BEAR_LOW | MIXED |
| XRP | −1.7953 | 1.7171% | BEAR_LOW | BEAR_ALIGNED |

No new context-frequency, duration, transition-matrix or weekly stability estimates were computed. Prior test-period context frequencies remain historical registry observations, not fresh estimates. Weekly review due 11 November UTC.

## 3. Strategy-context scorecard

| Candidate | Symbol/context | Status | Evidence / limitation |
|---|---|---|---|
| 4h Donchian20 breakout | SOL/BULL_LOW | OOS_PROMISING | 12 OOS trades; 66.7% win; 41.7% target-before-stop; +0.606R mean net; PF 2.72; max DD 1.3R; block-bootstrap CI95 [0.086,1.199]. Below 100 trades/cell. |
| Context-aligned Donchian20 WF v2 | 36 cells | INSUFFICIENT_EVIDENCE | All cells below 100 OOS trades; block-bootstrap CI includes zero; Holm p=1.0. |
| Trend/pullback continuation | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Breakout/retest | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Range mean reversion / failed-breakout fade | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Volatility expansion / momentum | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| BTC-relative strength confirmation | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Funding/OI filters | SOL/ETH/XRP | HYPOTHESIS | Not tested. |

Aggregate Donchian20 OOS mean net R remains BTC −0.1008, ETH +0.0478, SOL −0.0177 and XRP +0.0489. These are not conditional proof. Registry: 0 OOS_VALIDATED, 1 OOS_PROMISING, 1 INSUFFICIENT_EVIDENCE, 0 REJECTED.

## 4. Key discoveries

1. No new edge was discovered or rejected; no experiment ran.
2. The only inherited promising cell, SOL/BULL_LOW, does not match current SOL BEAR_LOW.
3. 1h structure is MIXED for BTC, ETH and SOL; XRP remains BEAR_ALIGNED. Descriptive only.
4. No context has been proven intrinsically untradeable.
5. No 1%, 2%, 5% or 10% target probability was estimated.

## 5. Current market snapshot

Latest market endpoint timestamp approximately 2026-11-08 15:26:57 UTC; archive retrieval 15:29:14.871 UTC.

| Symbol | Role | Last | Mark | 24h change | 4h context | 1h state | 24h OI change |
|---|---|---:|---:|---:|---|---|---:|
| BTC | Reference only | 76,018.60 | 76,014.90 | +0.233% | BEAR_LOW | MIXED | −0.301% |
| ETH | Tradable | 2,239.23 | 2,239.23 | −0.141% | TRANSITION_LOW | MIXED | +0.308% |
| SOL | Tradable | 89.67 | 89.66 | −0.045% | BEAR_LOW | MIXED | +0.267% |
| XRP | Tradable | 1.1583 | 1.15852151 | −0.121% | BEAR_LOW | BEAR_ALIGNED | −0.315% |

Funding and flow:
| Symbol | Premium-index lastFundingRate | Last settled | Next funding | 5m taker-buy share | 15m taker-buy share | Spread |
|---|---:|---:|---|---:|---:|---:|
| BTC | 0.003475% | 0.007157% | 16:00 UTC | 32.54% | 50.33% | 0.0132 bps |
| ETH | 0.005441% | 0.010000% | 16:00 UTC | 39.72% | 54.41% | 0.0447 bps |
| SOL | 0.008487% | 0.005796% | 16:00 UTC | 55.67% | 49.32% | 1.1154 bps |
| XRP | 0.007667% | 0.010000% | 16:00 UTC | 43.24% | 67.74% | 0.8632 bps |

Observed funding interval is 8 hours; latest settled record is 08:00 UTC. Premium-index lastFundingRate is reported separately and is not treated as a guaranteed next settlement rate. No observed indicated or settled rate exceeds the 0.05% absolute threshold. OI changes use 1h observations from 7 Nov 15:00 to 8 Nov 15:00 UTC. Global account long/short ratios at 15:00 UTC: BTC 3.0568, ETH 3.5106, SOL 3.6664, XRP 2.8595. Top-20 depth imbalance: BTC +0.504, ETH +0.695, SOL −0.059, XRP −0.013. Single snapshots only.

## 6. Trade decisions

| Symbol | OOS_VALIDATED strategy | Trigger | Decision |
|---|---|---|---|
| SOL | None | No validated rule; Donchian20 NONE | NO_TRADE |
| ETH | None | No validated rule; Donchian20 NONE | NO_TRADE |
| XRP | None | No validated rule; Donchian20 NONE | NO_TRADE |

No entry, stop, target, leverage or sizing is emitted. BTC remains reference-only.

## 7. Data-quality audit, costs, preflight and next experiments

Rolling data quality: 16 series; 4,000 raw bars; 3,984 completed; 16 forming excluded; duplicates 0; missing intervals 0; off-grid 0; OHLC failures 0; non-positive volume 0; non-finite 0; non-monotonic 0; cross-symbol alignment PASS. This validates rolling windows only, not the full archive.

Mandatory preflight:
| Check | Status | Evidence | Next action |
|---|---|---|---|
| Shell/compute | PASS | Debian 13.3; Python 3.13.5; Node 22.16.0; npm 10.9.2; 5 CPUs; 4.7 GiB available RAM; 30 GiB free disk | Compute adequate |
| Repo/runtime/SDK | DEGRADED | No local crypto-trading-agent checkout; /openai/project not a Git repo; Binance SDK packages and Python binance modules absent | Provision Node >=24/npm >=11 and checkout |
| Binance network | DEGRADED | Direct curl to /fapi/v1/time, /exchangeInfo, /premiumIndex failed DNS, HTTP 000. Connector market data succeeded. | Restore DNS |
| Exchange metadata | BLOCKED for execution validation | Connector exchangeInfo.serverTime=2026-11-06 11:18:40.883 UTC, 52.14h stale | Obtain fresh server time and exchangeInfo |
| Raw archive | DEGRADED | 1h multi-year base; 4h canonical ends 5 Nov 16:00 UTC; 5m/15m base absent; 13 hash mismatches and row-count differences | Rebuild canonical 4h; backfill lower intervals |
| Rolling data quality | PASS | 3,984 completed bars; all structural counters zero | Full archive still needs reconciliation |
| Backtest harness/smoke | BLOCKED | No local checkout/runtime/dependencies; no deterministic smoke test | Provision runner and smoke-test |
| Disk/storage | PASS | 30 GiB free; GitHub writes available | No storage blocker |
| Artifact readback | PASS | Delta/manifest/checksum and 5m/15m/1h indexes fetched back and verified | Continue verified persistence |

Cost model remains inadequate: 15 bps round-trip proxy is not calibrated. Missing actual fee tier, full funding cashflows, historical spread/depth, realized slippage/impact and latency.

Research queue:
- P0 archive append completed; continue after verified highwaters.
- P0 direct Binance time/metadata blocked; restore DNS and probe.
- P0 runtime/repository blocked; Node 24/npm 11 and checkout.
- P0 candle contract blocked; preserve closeTime, add 5m, reject zero volume, add fixtures.
- P0 canonical 4h partially completed; rebuild through 08:00 UTC and reconcile counts/hashes.
- P1 multi-year 5m/15m partially completed; backfill oldest-first.
- P1 funding/cost model blocked; collect fee tier, settlements and book/trade samples.
- P0 EXP-001 blocked; fix runtime/data/cost prerequisites and separate BTC referenceSymbols from tradable symbols.
- P1 v82 artifact integrity blocked; audit prior manifest byte-count/SHA inconsistency.

Next sequence: reconcile canonical 4h; provision Node 24/npm 11 and local checkout; fix candle contract; separate BTC reference data; backfill multi-year 5m/15m and funding; calibrate costs; deterministic smoke test; then run one frozen, purged chronological experiment with untouched OOS.

**Final assessment: RESEARCH_BLOCKED.** Market monitoring and 60-row archive append/index update completed and readback-verified. No experiment or OOS evaluation ran. No strategy is actionable; SOL, ETH and XRP remain NO_TRADE.
