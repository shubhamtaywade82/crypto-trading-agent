# Context Strategy Research — 8 November 2026, 19:28 UTC

## Run classification: RESEARCH_BLOCKED

Incremental archive refresh and market monitoring completed. **No new strategy experiment, backtest smoke test, or untouched OOS evaluation ran.**

## 1. Research progress

### Completed archive append

Appended **68 completed Binance USDⓈ-M candles** to the GitHub research archive:

| Interval | Rows appended | Per symbol | Latest completed open |
|---|---:|---:|---|
| 5m | 48 | 12 | 19:20 UTC |
| 15m | 16 | 4 | 19:00 UTC |
| 1h | 4 | 1 | 18:00 UTC |
| 4h | 0 | 0 | 12:00 UTC |
| **Total** | **68** | **17** | |

The 12-series fetch returned 360 rows: 12 forming rows and 280 rows at/before the existing highwaters were excluded. All 68 new rows were completed, aligned and ordered.

- Delta: `research-data/binance-usdm/delta/binance_usdm_delta_20261108T1925Z_5m15m1h_completed.jsonl`
- Bytes / rows: **26,549 / 68**
- SHA-256: `e69dd9afbc1ec669a73e41def9c2612ae7c1bada868fa1e1c206baf86e91b23f`
- Manifest: `research-data/binance-usdm/delta/manifest-20261108T1925Z-5m15m1h.json`
- Manifest SHA-256: `b18f18b9346761faf7c8c5b9d09c6d1fb352e63ebde0f1bdf1064419a3791536`
- Delta and manifest were fetched back; SHA-256, byte count and 68-line count matched. 5m/15m/1h archive indexes were updated and fetched back with readback=true.

Structural checks on the 68 appended rows: **0 duplicates, 0 missing intervals, 0 OHLC invariant failures, 0 non-positive volumes, 0 non-finite values, 0 off-grid timestamps, 0 non-monotonic rows.**

### Historical coverage and adequacy

| Interval | Accessible archive evidence | Adequacy |
|---|---|---|
| 1h | 53,871 base rows/symbol from 2020-09-14 through 2026-11-06 22:00, plus incremental deltas through 2026-11-08 18:00 | Broad multi-cycle history, but delta-chain merge and canonical readback still required |
| 4h | 13,461 canonical rows/symbol through 2026-11-05 16:00; raw pages/incrementals through 2026-11-08 12:00 | Multi-year sample exists, but 13 page/symbol hash-provenance mismatches and raw/canonical row-count differences remain |
| 5m | Recent incremental deltas only; no multi-year base archive | Insufficient for robust intraday strategy inference |
| 15m | Recent incremental deltas only; no multi-year base archive | Insufficient for robust intraday strategy inference |
| 1m | Absent | Blocks the directional barrier/event-study experiment |

No 4h row was appended because the 16:00 UTC 4h candle was still forming at retrieval time. The canonical 4h series was not silently rewritten or merged.

## 2. Context discovery

The frozen taxonomy remains `CTX-4H-EMA50xEMA200-ATRQ-v2-FULL-ARCHIVE`, with training-derived thresholds from the accessible v86 snapshot. **No threshold refit, frequency/duration re-estimation, transition analysis, or weekly stability review ran.**

- All four symbols remain `DOWN_LOW` on the last completed 4h bar (12:00 UTC).
- All four remain `BEAR_ALIGNED` after the completed 18:00 UTC 1h bar was applied recursively to the previously verified EMA state.
- The 16:00 UTC 4h candle is forming and excluded.
- These are feature-state labels, not probabilities of a winning trade.

## 3. Strategy-context scorecard

The registry is unchanged: **0 OOS_VALIDATED, 1 OOS_PROMISING, 5 INSUFFICIENT_EVIDENCE, 1 REJECTED, 6 HYPOTHESIS.**

| Strategy / symbol / context | Evidence status | Existing OOS evidence | Interpretation |
|---|---|---:|---|
| SOL Donchian20 / BULL_LOW | OOS_PROMISING | 12 trades; mean net +0.606R; PF 2.72 | Positive but far below the 100-trade per-cell gate; not applicable to current DOWN_LOW |
| SOL 15-bar Donchian / bullish-low | INSUFFICIENT_EVIDENCE | 55 trades; mean net +0.043R; PF 1.082 | Small positive point estimate; insufficient sample and robustness |
| SOL failed-breakout fade / SIDEWAYS_LOW | REJECTED | 113 trades; mean net -0.148R; PF 0.787 | Tested and failed its OOS net-performance gate |
| SOL trend-pullback + BTC confirmation | INSUFFICIENT_EVIDENCE | 10 trades; mean net -0.189R | Underpowered and negative point estimate |
| SOL volatility-contraction breakout / BULL_COMPRESS | INSUFFICIENT_EVIDENCE | 18 trades; mean net -0.205R | Underpowered and negative point estimate |
| SOL volatility-contraction breakout / BEAR_COMPRESS | INSUFFICIENT_EVIDENCE | 26 trades; mean net -0.115R | Underpowered and negative point estimate |
| Trend/pullback, breakout/retest, range fade, expansion momentum, BTC relative strength, funding/OI filters | HYPOTHESIS | Not tested in this registry | No edge claim |

No evidence is transferred from SOL to ETH or XRP. No 1%, 2%, 5% or 10% target-hit probability was estimated in this run.

## 4. Key discoveries

No new statistical discovery was produced. The previously tested SOL failed-breakout fade remains REJECTED; the SOL Donchian20 BULL_LOW candidate remains OOS_PROMISING only. **No context is proven intrinsically untradeable**, and no strategy has met the OOS_VALIDATED gate.

## 5. Current market snapshot

Component timestamps differ: mark/ticker/OI/funding at 19:22:32 UTC; completed klines through 19:20 UTC; order book and global long/short ratio retrieved at 19:27:56 UTC.

| Pair | Role | Last / mark | 24h change | 4h context | 1h alignment | 5m / 15m taker-buy share | Top-20 spread |
|---|---|---:|---:|---|---|---:|---:|
| BTCUSDT | Reference only | 75,822.70 / 75,826.05 | +0.065% | DOWN_LOW | BEAR_ALIGNED | 45.80% / 50.14% | 0.0132 bps |
| ETHUSDT | Tradable | 2,231.18 / 2,231.19 | -0.099% | DOWN_LOW | BEAR_ALIGNED | 50.87% / 49.82% | 0.0448 bps |
| SOLUSDT | Tradable | 89.41 / 89.41 | -0.245% | DOWN_LOW | BEAR_ALIGNED | 45.76% / 51.63% | 1.1175 bps |
| XRPUSDT | Tradable | 1.1539 / 1.1539 | -0.646% | DOWN_LOW | BEAR_ALIGNED | 49.39% / 48.06% | 0.8656 bps |

Open interest changed versus the accessible 18:26 UTC snapshot by approximately BTC +0.036%, ETH +0.036%, SOL +0.467%, XRP +0.199% over ~56 minutes. This is a short interval change, not a crowding or liquidation signal.

Premium-index `lastFundingRate` field / latest settled funding at 16:00 UTC (8-hour interval):
- BTC: 0.003578% / 0.003420%
- ETH: 0.004381% / 0.006062%
- SOL: 0.001896% / 0.008537%
- XRP: 0.010000% / 0.008930%

Next funding is 2026-11-09 00:00 UTC. No observed rate exceeds 0.05%. The premium-index field is retained separately from settled funding and is not treated as a guaranteed next-settlement forecast.

Taker flow is mixed around 50%. Top-20 book imbalance is BTC +0.729, ETH +0.395, SOL +0.015, XRP -0.104. Global long-account ratios range from 74.08% to 78.62%; that skew alone does not establish crowding.

## 6. SOL / ETH / XRP decisions

| Symbol | OOS_VALIDATED strategy | Exact trigger | Decision |
|---|---|---|---|
| SOL | None | None eligible | **NO_TRADE** |
| ETH | None | None eligible | **NO_TRADE** |
| XRP | None | None eligible | **NO_TRADE** |

Reasons: zero OOS_VALIDATED registry entries; the only OOS_PROMISING SOL candidate is BULL_LOW and does not match current DOWN_LOW; no validated trigger; exchange metadata is stale; account fee tier, historical spread, slippage and market-impact costs are not calibrated.

## 7. Data-quality audit, costs, blockers and next experiments

### Mandatory preflight

| Capability | Status | Evidence / impact |
|---|---|---|
| Shell / compute | PASS | Debian 13; Python 3.13.5; 5 CPUs; 4.89 GB available RAM; 30 GiB free |
| Repo / code | BLOCKED | No local checkout; Node 22.16/npm 10.9 below package.json floor Node >=24/npm >=11; no node_modules or Binance SDK |
| Direct Binance network | DEGRADED | Direct DNS failed for fapi.binance.com and data.binance.vision (HTTP 000); connector data available without HTTP status/headers |
| Exchange metadata | BLOCKED | Connector exchangeInfo serverTime is 56.17 hours behind fresh mark time |
| Raw historical archive | DEGRADED | 1h/4h multi-year bases exist; 4h provenance unresolved; 5m/15m base history and 1m absent |
| Data quality | PASS | 68 appended rows, zero structural failures; forming bars excluded |
| Backtest / smoke test | BLOCKED | Remote scripts/backtest.ts exists but was not locally invokable; deterministic fixture NOT_RUN |
| Disk / storage | PASS | 30 GiB free; GitHub archive branch accepted writes |
| Artifact readback | PASS | Delta/manifest hashes and row count match; 5m/15m/1h indexes read back with verified highwaters |

### Cost and data limitations

- No actual account fee-tier evidence, synchronized historical depth/trades, calibrated slippage/impact curves, or complete historical funding settlements for all symbols.
- The existing 15 bps round-trip proxy is not a calibrated execution model. Historical funding archive is SOL-only; all-symbol historical OI/taker/positioning archives are incomplete.
- Connector market data is usable for monitoring, but HTTP status/headers and direct server-time verification are unavailable.
- The local container does not contain the repository or raw archive; durable artifacts were written to and read back from the GitHub research branch.

### Queue and next executable actions

1. Restore direct DNS; obtain fresh `/fapi/v1/time` and `/fapi/v1/exchangeInfo` with <=5 seconds drift.
2. Provision Node >=24/npm >=11 and clone current main commit `22b513a671e251415aa34e18946c55d1ae5f8113`.
3. Rebuild a new canonical 4h artifact through 2026-11-08 12:00 UTC and reconcile all 13 provenance mismatches without rewriting expected hashes.
4. Backfill multi-year 5m/15m and acquire 1m history from an auditable source.
5. Calibrate fee tier, funding cashflows, spread, slippage and market impact; preserve BTC as reference-only in EXP-001.
6. Run the deterministic fixture; only then execute the frozen, purged chronological experiment and untouched OOS evaluation.
7. Keep the taxonomy frozen until the scheduled 11 November stability review.

**Run classification: RESEARCH_BLOCKED.** Monitoring and 68-row archive maintenance succeeded; no experiment or OOS evaluation ran.
