# Context Strategy Research - 8 November 2026 16:25 UTC (v84)

## Run classification: RESEARCH_BLOCKED

Monitoring and archive maintenance completed. No strategy experiment or untouched OOS evaluation ran. OOS_VALIDATED entries remain zero.

## 1. Research progress

- Appended 68 completed Binance USD-M candles for BTCUSDT, ETHUSDT, SOLUSDT and XRPUSDT.
- Rows: 5m=44, 15m=16, 1h=4, 4h=4.
- Latest completed opens: 5m 16:15Z; 15m 16:00Z; 1h 15:00Z; 4h 12:00Z.
- Delta SHA-256: 9c0c2921c0d99a68b796808d2b72e9eab9aecfb7b0cfd4f66053b6e3a5db5172; 26,567 bytes; 68 records.
- Delta, manifest, checksum sidecar and all four interval indexes were fetched back and verified.
- No experiment ran. The local repository runtime is below the required Node/npm versions and no local checkout exists.

Historical coverage remains uneven: 1h has 53,871 base rows per symbol through 6 November 22:00Z; 4h canonical has 13,461 rows per symbol through 5 November 16:00Z, while raw incrementals now reach 8 November 12:00Z. Multi-year 5m/15m and 1m histories remain absent.

## 2. Context discovery

Taxonomy: CTX-4H-EMA50xEMA200-ATRQ-v2-FULL-ARCHIVE. Thresholds are frozen from V100/V102 training-only estimates. Classification: SHOCK overrides; otherwise SIDEWAYS when absolute EMA50/EMA200 spread is below training q30; UP/DOWN by spread sign; volatility LOW/NORMAL/HIGH using training q33/q67 of ATR14/close.

Historical descriptive sample: 13,468 rows per symbol, 13,269 classified bars per symbol, 4h, 14 September 2020 through 6 November 2026 20:00Z. Top contexts and median run duration:

| Symbol | Top contexts (frequency; median run bars) |
|---|---|
| BTC | SIDEWAYS_LOW 24.00% (11); UP_LOW 15.32% (10); UP_NORMAL 12.25% (5); DOWN_HIGH 11.06% (7) |
| ETH | SIDEWAYS_LOW 17.45% (9); UP_NORMAL 16.77% (8); DOWN_HIGH 13.19% (9); DOWN_NORMAL 11.24% (9) |
| SOL | SIDEWAYS_LOW 23.26% (10); DOWN_LOW 12.13% (7); UP_HIGH 11.68% (6); UP_NORMAL 11.18% (5) |
| XRP | SIDEWAYS_LOW 18.52% (9); DOWN_LOW 16.08% (14); UP_HIGH 14.46% (5); DOWN_NORMAL 13.41% (8) |

Examples of common transitions: BTC UP_LOW->UP_NORMAL (75), ETH SIDEWAYS_LOW->SIDEWAYS_NORMAL (77), SOL DOWN_HIGH->DOWN_NORMAL (79), XRP SIDEWAYS_NORMAL->SIDEWAYS_LOW (74). These are historical feature-state transitions, not future win probabilities. No threshold refit or weekly stability review was performed.

## 3. Strategy-context scorecard

The accessible main registry is newer and more complete than the v83 archive-branch snapshot. The v83 12-trade SOL/BULL_LOW OOS_PROMISING label is superseded; use the main registry's 55-trade evaluation.

| Strategy/context | Symbol | OOS trades | Mean net R | PF | OOS CI95 | Status |
|---|---|---:|---:|---:|---|---|
| Donchian20 trend breakout / legacy BULL_LOW | SOL | 55 | +0.0431 | 1.082 | [-0.2798, 0.3900] | INSUFFICIENT_EVIDENCE |
| Failed-breakout fade / SIDEWAYS_LOW | SOL | 113 | -0.1480 | 0.787 | [-0.3175, 0.0196] | REJECTED |
| Trend pullback + BTC confirmation | SOL | 10 | -0.1886 | 0.733 | CI crosses zero | INSUFFICIENT_EVIDENCE |
| Volatility contraction breakout / BULL_COMPRESS | SOL | 18 | -0.2050 | 0.687 | [-0.7233, 0.2946] | INSUFFICIENT_EVIDENCE |
| Volatility contraction breakout / BEAR_COMPRESS | SOL | 26 | -0.1153 | 0.814 | [-0.6830, 0.3705] | INSUFFICIENT_EVIDENCE |

No OOS_VALIDATED entry exists. The failed-breakout fade is genuinely REJECTED by negative OOS expectancy, PF below 1, drawdown above the risk gate and negative parameter-neighborhood results. The other candidates do not meet sample and uncertainty gates. No result transfers to ETH or XRP.

Important taxonomy caveat: the Donchian registry detector uses a legacy context key and is not assumed equivalent to the newer CTX-v2 UP_LOW/DOWN_LOW labels. No cross-taxonomy promotion is allowed.

## 4. Key discoveries

- No new edge was discovered in this run.
- SOL SIDEWAYS_LOW failed-breakout fade is rejected on its actual OOS test.
- SOL Donchian and volatility-contraction candidates remain insufficient evidence, not validated.
- No context is proven intrinsically untradeable.
- No 1%, 2%, 5% or 10% target probability was estimated.

## 5. Current context snapshot

As of 16:25:19Z. Current 4h labels use 999 completed 4h bars per symbol and frozen V100/V102 thresholds; latest completed 4h open is 12:00Z.

| Symbol | 4h context | EMA50/EMA200 spread | ATR14/close | 4h return | 1h alignment |
|---|---|---:|---:|---:|---|
| BTC | DOWN_LOW | -2.969% | 0.873% | +0.125% | MIXED |
| ETH | DOWN_LOW | -3.979% | 1.145% | +0.072% | MIXED |
| SOL | DOWN_LOW | -7.472% | 1.500% | +0.033% | MIXED |
| XRP | DOWN_LOW | -5.786% | 1.708% | -0.849% | BEAR_ALIGNED |

No shock threshold was crossed. All four 4h contexts are DOWN_LOW; BTC/ETH/SOL have mixed 1h structure, while XRP is bearish-aligned. This is a descriptive snapshot, not a forecast.

## 6. Decision matrix

| Symbol | Validated strategy | Trigger | Decision |
|---|---|---|---|
| SOL | None | None | NO_TRADE |
| ETH | None | None | NO_TRADE |
| XRP | None | None | NO_TRADE |

Reasons: zero OOS_VALIDATED registry entries; no exact validated trigger; fresh exchange metadata unavailable; no calibrated current execution-cost model.

## 7. Data audit, costs, blockers and next experiments

### Current derivatives and liquidity snapshot

| Symbol | Last / mark | 24h change | OI contracts | Premium-index lastFundingRate | Last settled funding |
|---|---:|---:|---:|---:|---:|
| BTC | 76025.10 / 76028.03 | +0.371% | 96066.339 | 0.003480% | 0.003420% |
| ETH | 2240.00 / 2239.99 | +0.155% | 2377955.529 | 0.005970% | 0.006062% |
| SOL | 89.58 / 89.58 | +0.011% | 9398678.21 | 0.008696% | 0.008537% |
| XRP | 1.1571 / 1.1571 | -0.233% | 336758460.0 | 0.009865% | 0.008930% |

Last settled funding timestamp is 16:00Z; next funding is 00:00Z on 9 November; observed interval is 8 hours. Premium-index lastFundingRate differs from settled funding and is not treated as a guaranteed next settlement. No observed rate exceeds 0.05%.

Latest 5m/15m taker-buy shares: BTC 42.61%/39.20%; ETH 40.54%/42.34%; SOL 35.04%/44.12%; XRP 49.95%/44.48%. Top-of-book spreads: BTC 0.0132 bps, ETH 0.0446 bps, SOL 1.1163 bps, XRP 0.8639 bps. Top-20 depth imbalance: BTC +0.564, ETH +0.017, SOL +0.018, XRP -0.096. These are snapshots, not execution-cost estimates.

### Mandatory preflight

| Check | Status | Evidence / impact |
|---|---|---|
| Shell/compute | PASS | Debian 13; Python 3.13.5; 5 CPUs; 5.8 GiB RAM; 4.7 GiB available; 30 GiB disk |
| Repository/runtime | DEGRADED | No local checkout; Node 22.16/npm 10.9.2; repo requires Node >=24/npm >=11 |
| Binance network | DEGRADED | Direct probes for six official endpoints failed DNS, HTTP 000; connector market data succeeded without HTTP headers |
| Exchange metadata | BLOCKED | exchangeInfo serverTime 2026-11-06 11:18:40.907Z, 191,198 seconds behind mark time |
| Raw archive | DEGRADED | 1h/4h multi-year bases exist; 5m/15m/1m base histories absent; 4h canonical lags raw deltas; 13 hash provenance mismatches |
| Rolling quality | PASS | 16 series, 5,984 completed bars, 16 forming excluded; zero duplicates/gaps/OHLC/volume/nonfinite/off-grid/monotonicity failures |
| Backtest/smoke test | BLOCKED | Remote harness exists; no compatible local runtime or checkout; no smoke test or experiment executed |
| Disk/storage | PASS | 30 GiB free; GitHub branch writable |
| Artifact readback | PASS | 68-row delta, manifest, sidecar and all four updated interval indexes fetched back and verified |

### Confirmed v82 integrity defect

The v82 run manifest says readback.exact=true, but independent readback differs:

- Snapshot: declared 14,243 bytes and SHA cb3ec5d6...; actual 14,241 bytes and SHA 10c3239a...
- Report: declared 8,494 bytes and SHA 73a41406...; actual 8,460 bytes and SHA ea6a1435...

Preserve the originals. The verifier must be corrected to hash the fetched UTF-8 body and compare byte counts before asserting exact readback.

### Main blockers and next actions

1. Reconcile canonical 4h through 8 November 12:00Z; resolve row-count and 13 hash-provenance discrepancies without rewriting expected hashes.
2. Provision Node >=24/npm >=11 and a local checkout; run deterministic fixture smoke tests.
3. Fix candle contract issues: preserve closeTime, add 5m support, reject zero volume.
4. Backfill multi-year 5m/15m/1m history and historical funding/OI/taker/positioning.
5. Obtain actual fee tier, historical spread/depth, slippage, impact and latency.
6. Remove BTC from EXP-001 tradable symbols; expose BTC only as reference features.
7. Verify promotion gates for >=100 OOS trades per symbol/context, block-bootstrap uncertainty, Holm correction, parameter-neighborhood stability and multi-window evidence.
8. Only then execute a frozen strategy x context x symbol experiment with chronological purging/embargo and untouched OOS.

**Final status: RESEARCH_BLOCKED.** Archive append and readback completed; no experiment or OOS evaluation ran; zero validated strategies; SOL/ETH/XRP remain NO_TRADE.
