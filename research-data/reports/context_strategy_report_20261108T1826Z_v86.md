# Context Strategy Research — 8 November 2026, 18:26 UTC

## Run classification: RESEARCH_BLOCKED

Monitoring and archive maintenance completed. No new experiment, backtest smoke test, or untouched OOS evaluation ran.

## 1. Research progress

### Incremental archive update

Appended **64 completed candles** from Binance USDⓈ-M public connector data.

| Interval | Rows appended | Latest completed open |
|---|---:|---|
| 5m | 44 | 18:20 UTC |
| 15m | 16 | 18:00 UTC |
| 1h | 4 | 17:00 UTC |
| 4h | 0 | 12:00 UTC |
| **Total** | **64** | |

80 kline rows were fetched. Sixteen forming/future rows were excluded. The new delta contains 16 rows per symbol.

- Delta: `research-data/binance-usdm/delta/binance_usdm_delta_20261108T1826Z_5m15m1h_completed.jsonl`
- Bytes: 25,044
- SHA-256: `5c5643fcbe91efb1c99c385a3eac5d12ca68b4c0ca67a697b26bba387b3e2896`
- Manifest: `research-data/binance-usdm/delta/manifest-20261108T1826Z-5m15m1h.json`
- Manifest bytes: 10,134
- Manifest SHA-256: `9bceeac67c434cb12255d0e4187f07c21dc287e7cf90b8341726894a0cc000b5`

New-row checks: zero duplicates, missing intervals, OHLC invariant failures, non-positive volume, non-finite values, off-grid timestamps or non-monotonic rows. The 4h 16:00 candle remained forming, so no 4h row was appended.

### Historical coverage

| Interval | Available archive | Adequacy |
|---|---|---|
| 1h | 53,871 base rows/symbol from 2020-09-14 through 2026-11-06 22:00; incremental deltas through 2026-11-08 17:00 | Broad, but delta-chain merge/readback still required |
| 4h | 13,461 canonical rows/symbol through 2026-11-05 16:00; raw incrementals through 2026-11-08 12:00 | Multi-year sample, but canonical/raw provenance remains unresolved |
| 5m | Incremental-only recent archive | Insufficient |
| 15m | Incremental-only recent archive | Insufficient |
| 1m | Absent | Blocks directional barrier experiment |

## 2. Context discovery

The frozen taxonomy remains `CTX-4H-EMA50xEMA200-ATRQ-v2-FULL-ARCHIVE`. No threshold refit or weekly stability review was performed.

Current completed 4h contexts remain DOWN_LOW for BTC, ETH, SOL and XRP. The latest completed 4h bar is still the 12:00 UTC open / 16:00 UTC close. The 16:00 UTC 4h bar is forming.

The 1h EMA state was updated recursively from the previous verified snapshot using the completed 17:00 UTC candle. All four symbols remain BEAR_ALIGNED. This is a one-bar state update, not a full-history recomputation.

Historical frequency/duration distributions remain those in the v85 taxonomy artifact; they were not recomputed this run.

## 3. Strategy-context scorecard

No strategy experiments were executed. The registry is unchanged:

| Evidence status | Entries |
|---|---:|
| OOS_VALIDATED | **0** |
| OOS_PROMISING | 1 |
| INSUFFICIENT_EVIDENCE | 5 |
| REJECTED | 1 |
| HYPOTHESIS | 6 |

Selected prior evidence remains unchanged:

- SOL Donchian20 / BULL_LOW: 12 OOS trades, +0.606 mean net R, PF 2.72; OOS_PROMISING only, below the 100-trade per-cell gate.
- SOL 15-bar Donchian: 55 OOS trades, +0.043 mean net R, PF 1.082; INSUFFICIENT_EVIDENCE.
- SOL failed-breakout fade / SIDEWAYS_LOW: 113 OOS trades, -0.148 mean net R, PF 0.787; REJECTED.
- SOL trend-pullback + BTC confirmation and volatility-contraction variants remain INSUFFICIENT_EVIDENCE.

No evidence is transferred to ETH or XRP. No 1%, 2%, 5% or 10% target-hit probability was estimated this run.

## 4. Key discoveries

No new statistical discovery was generated. The prior rejection and insufficient-evidence decisions remain. No context is proven intrinsically untradeable. No OOS_VALIDATED entry exists.

## 5. Current context snapshot

**As of 2026-11-08 18:26:27 UTC.**

| Symbol | Role | Last | Mark | 24h change | 4h context | 1h alignment |
|---|---|---:|---:|---:|---|---|
| BTCUSDT | Reference only | 75,884.90 | 75,888.79 | +0.112% | DOWN_LOW | BEAR_ALIGNED |
| ETHUSDT | Tradable | 2,233.25 | 2,233.32 | -0.138% | DOWN_LOW | BEAR_ALIGNED |
| SOLUSDT | Tradable | 89.61 | 89.5968 | -0.200% | DOWN_LOW | BEAR_ALIGNED |
| XRPUSDT | Tradable | 1.1578 | 1.15797 | -0.370% | DOWN_LOW | BEAR_ALIGNED |

Short-horizon taker-buy shares from the latest completed candles:

| Symbol | 5m | 15m |
|---|---:|---:|
| BTC | 49.16% | 60.17% |
| ETH | 58.44% | 48.00% |
| SOL | 52.82% | 59.67% |
| XRP | 41.51% | 48.38% |

This is mixed-to-positive short-term flow against unchanged bearish 1h alignment and DOWN_LOW 4h context. It is not a confirmed reversal or an entry trigger.

Funding:
- Premium-index `lastFundingRate` field: BTC 0.004011%, ETH 0.005476%, SOL 0.004213%, XRP 0.010000%.
- Latest settled funding at 16:00 UTC: BTC 0.003420%, ETH 0.006062%, SOL 0.008537%, XRP 0.008930%.
- Next funding timestamp: 9 November 00:00 UTC; observed interval 8 hours.
- No observed funding value exceeds 0.05%. A distinct next-settlement forecast rate is unavailable.

Open interest: BTC 96,289.195; ETH 2,379,360.299; SOL 9,443,023.34; XRP 335,614,432.3. Changes versus the previous 17:30 snapshot are +0.0255%, -0.0103%, +0.1302%, and -0.2299% respectively over 56.14 minutes. These are not 24h changes and do not establish crowding.

## 6. Decisions

| Symbol | OOS_VALIDATED strategy | Trigger | Decision |
|---|---|---|---|
| SOL | None | None | **NO_TRADE** |
| ETH | None | None | **NO_TRADE** |
| XRP | None | None | **NO_TRADE** |

Reasons: zero OOS_VALIDATED registry entries; no exact validated trigger; stale exchange metadata; uncalibrated account fees, spread, slippage and market impact.

## 7. Data-quality audit, costs, blockers and next experiments

### Mandatory preflight

| Check | Status | Evidence / impact |
|---|---|---|
| Shell/compute | PASS | Debian 13, Python 3.13.5, 5 CPUs, ~4.9 GB available RAM, 30 GiB free disk |
| Repo/code | BLOCKED | No local checkout; Node 22.16/npm 10.9.2, below project floor Node 24/npm 11; SDK packages absent |
| Direct Binance network | DEGRADED | DNS failed for six official endpoints; connector data retrieval succeeded |
| Exchange metadata | BLOCKED | exchangeInfo serverTime is 198,466 seconds behind fresh mark timestamp |
| Raw historical archive | DEGRADED | Multi-year 1h/4h exist; 5m/15m bases and 1m absent; 4h canonical provenance unresolved |
| Data quality | PASS | 64 appended rows, zero detected structural failures |
| Backtest harness/smoke test | BLOCKED | No compatible local checkout/runtime; smoke test not run |
| Disk/storage | PASS | 30 GiB free; GitHub branch writable |
| Artifact readback | PASS | Delta and manifest readback hashes match; index writes completed; final index/snapshot readback verification recorded in run manifest |

### Exact blockers and next actions

1. Restore outbound DNS and obtain direct `/fapi/v1/time` plus fresh `/fapi/v1/exchangeInfo`; require <=5 seconds drift before contract validation.
2. Provision Node >=24/npm >=11 and local checkout at the latest verified main commit `0595de35adc419fa78a1780bbfa9f0e13256bf0d`.
3. Rebuild canonical 4h as a new version through 2026-11-08 12:00 UTC, preserving all original expected hashes and reconciling 13 provenance mismatches.
4. Backfill multi-year 5m/15m and acquire 1m history.
5. Calibrate fee tier, historical funding cashflows, synchronized spread/depth, slippage and market impact.
6. Separate BTC reference symbols from SOL/ETH/XRP tradable symbols in EXP-001; then run deterministic smoke test before any experiment.
7. Keep the frozen taxonomy unless the scheduled 11 November stability review demonstrates a training-only, statistically supported revision.

**No experiment or OOS evaluation was run.** Monitoring and archive maintenance succeeded; research remains blocked by the runtime, data-coverage, direct-network and execution-cost prerequisites.
