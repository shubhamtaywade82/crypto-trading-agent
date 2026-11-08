# Context Strategy Research — 9 November 2026 (IST) / 8 November 2026, 20:27 UTC

## Run classification: RESEARCH_BLOCKED

**Completed:** fresh Binance USDⓈ-M market refresh, completed-candle context classification, 68-row raw archive append, four interval-index updates, registry/queue snapshots and archive readback verification.

**Not completed:** no strategy experiment, deterministic repository smoke test, or untouched OOS evaluation. The run is classified `RESEARCH_BLOCKED`, not research-completed.

## 1. Research progress

### Incremental archive update

| Interval | New completed rows | Per symbol | First new open | Latest completed open |
|---|---:|---:|---|---|
| 5m | 44 | 11 | 19:25 UTC | 20:15 UTC |
| 15m | 16 | 4 | 19:15 UTC | 20:00 UTC |
| 1h | 4 | 1 | 19:00 UTC | 19:00 UTC |
| 4h | 4 | 1 | 16:00 UTC | 16:00 UTC |
| **Total** | **68** | **17** | | |

The 16 series returned 104 rows. Twenty rows at or before prior highwaters and 16 forming rows were excluded. Structural checks on the 68 appended rows: **zero duplicates, missing intervals, OHLC failures, non-positive volumes, non-finite values, off-grid timestamps or non-monotonic rows**.

- Delta: `research-data/binance-usdm/delta/binance_usdm_delta_20261108T2020Z_5m15m1h4h_completed.jsonl`
- Delta bytes / rows: **26,499 / 68**
- Delta SHA-256: `cb6f3f60d43aa93ef266ea99848a4b8b3fa24fc6fc245ca7fdb6f19ae69f670a`
- Manifest: `research-data/binance-usdm/delta/manifest-20261108T2020Z-5m15m1h4h.json`
- Manifest bytes: **8,872**
- Manifest SHA-256: `3fe9edecf43d43ced843bcb690d4461e43a9df499ca756a05bd357c17bcb68c0`
- 5m, 15m, 1h and 4h indexes were updated and fetched back.

The new 4h candle is stored as a raw incremental delta. **It was not merged into the canonical 4h dataset.**

### Historical coverage and adequacy

| Interval | Accessible archive coverage | Adequacy |
|---|---|---|
| 4h | Canonical 13,461 rows/symbol, 2020-09-14 08:00 through 2026-11-05 16:00; raw increments through 2026-11-08 16:00 | Multi-cycle base exists; 13 page/symbol SHA provenance mismatches and raw/canonical count differences remain |
| 1h | Canonical 53,871 rows/symbol from 2020-09-14 through 2026-11-06 22:00; incremental deltas through 2026-11-08 19:00 | Broad base history; base/delta reconciliation still required |
| 5m | Incremental-only; this run extends to 20:15 UTC | Not adequate for historical intraday inference |
| 15m | Incremental-only; this run extends to 20:00 UTC | Not adequate for historical intraday inference |
| 1m | No accessible archive | Blocks 1m barrier-label experiments |

The current context monitor separately validated 1,499 completed 4h and 1,499 completed 1h candles per symbol. All eight series passed timestamp continuity, duplicate, OHLC, positive-volume, finite-value and grid checks. This monitoring window is not a substitute for a reconciled multi-year archive.

## 2. Context discovery

The frozen taxonomy remains `CTX-4H-EMA50xEMA200-ATRQ-v2-FULL-ARCHIVE`. No threshold refit or new context-discovery experiment ran.

The last accessible full-history distribution artifact uses 13,461 canonical 4h bars/symbol, 12,462 labelled bars after 999-bar warm-up, and a 60/20/20 chronological diagnostic split (7,077 / 2,692 / 2,693). Thresholds remain V100 training-derived.

| Symbol | Most frequent contexts | Median duration of most frequent context | Self-transition | Train/test JSD |
|---|---|---:|---:|---:|
| BTC | SIDEWAYS_LOW 25.56%; BULL_LOW 16.05%; BEAR_HIGH 11.79% | 11.5 bars | 93.03% | 0.20203 |
| ETH | SIDEWAYS_LOW 18.58%; BULL_NORMAL 16.24%; BEAR_HIGH 14.03% | 9 bars | 92.64% | 0.10765 |
| SOL | SIDEWAYS_LOW 24.77%; BEAR_LOW 12.86%; BULL_NORMAL 11.86% | 10 bars | 92.38% | 0.29652 |
| XRP | SIDEWAYS_LOW 18.86%; BEAR_LOW 17.12%; BEAR_NORMAL 14.23% | 9.5 bars | 92.91% | 0.12844 |

SOL and BTC show the largest train/test distribution divergence in this diagnostic. The taxonomy is retained; no stability conclusion was added this run. These are context-frequency statistics, not win probabilities.

## 3. Strategy-context scorecard

The canonical main registry reports **0 OOS_VALIDATED, 0 OOS_PROMISING, 1 REJECTED and 4 INSUFFICIENT_EVIDENCE** across five active entries. Six additional strategy families remain HYPOTHESIS. There are no ETH- or XRP-specific tested entries.

| Strategy / symbol / context | Active status | OOS trades | Win rate | Target before stop | Mean net R | 95% CI for mean R | PF |
|---|---|---:|---:|---:|---:|---|---:|
| SOL Donchian20 / BULL_LOW | INSUFFICIENT_EVIDENCE | 55 | 43.64% | 21.82% | +0.043 | [-0.280, +0.390] | 1.082 |
| SOL failed-breakout fade / SIDEWAYS_LOW | REJECTED | 113 | 43.36% | 27.43% | -0.148 | [-0.318, +0.020] | 0.787 |
| SOL trend-pullback + BTC confirmation | INSUFFICIENT_EVIDENCE | 10 | 40.00% | 10.00% | -0.189 | Not recorded | 0.733 |
| SOL volatility contraction / BULL_COMPRESS | INSUFFICIENT_EVIDENCE | 18 | Not recorded | Not recorded | -0.205 | [-0.723, +0.295] | 0.687 |
| SOL volatility contraction / BEAR_COMPRESS | INSUFFICIENT_EVIDENCE | 26 | Not recorded | Not recorded | -0.115 | [-0.683, +0.371] | 0.814 |

The Donchian candidate has only 55 OOS trades, a confidence interval crossing zero, negative total quote PnL per SOL and a validation parameter grid whose candidates were all negative. The failed-breakout fade is rejected for its tested SOL/SIDEWAYS_LOW specification; this does not reject every range strategy or other symbols.

**Registry integrity issue:** the v87 archive snapshot called the SOL Donchian result OOS_PROMISING, while the current main registry's active entry is INSUFFICIENT_EVIDENCE and its top-level OOS_PROMISING count is zero. A legacy nested scorecard still says OOS_PROMISING with only 12 trades. This conflict is recorded as RQ-037; the legacy label is quarantined and is not eligible for selection.

## 4. Key discoveries

- No new strategy discovery or rejection was produced this run.
- The only active rejected result is SOL failed-breakout fade in SIDEWAYS_LOW.
- SOL Donchian20 remains insufficiently evidenced; the conflicting 12-trade legacy scorecard record is not promoted.
- No evidence supports cross-symbol transfer to ETH/XRP.
- No context has been shown to be intrinsically untradeable.
- No 1%, 2%, 5% or 10% target-hit probability was estimated.

## 5. Current context snapshot

Feature windows use completed candles only. Current 4h and 1h labels were computed from 1,499 completed bars/symbol/timeframe, with frozen V100 thresholds; the monitor did not refit thresholds.

| Symbol | 4h EMA50/EMA200 spread | ATR14/close | 4h context | 1h alignment | Boundary note |
|---|---:|---:|---|---|---|
| BTC | -2.992% | 0.854% | BEAR_LOW | BEAR_ALIGNED | 0.488 pp from sideways trend boundary |
| ETH | -3.998% | 1.129% | BEAR_LOW | BEAR_ALIGNED | No near-boundary warning |
| SOL | -7.499% | 1.487% | BEAR_LOW | BEAR_ALIGNED | No near-boundary warning |
| XRP | -5.902% | 1.659% | BEAR_LOW | BEAR_ALIGNED | 0.334 pp below LOW/NORMAL ATR boundary |

All four last completed 4h bars are non-shock. The 20:00 UTC 4h and 1h candles are forming and excluded. The latest completed 5m and 15m opens are 20:15 and 20:00 UTC respectively.

### Market and derivatives summary

| Pair | Last / mark | 24h change | OI change 19:00–20:00 | Settled funding 16:00 | 5m buy/sell ratio | Top-20 book imbalance |
|---|---:|---:|---:|---:|---:|---:|
| BTC (reference) | 75,832.40 / 75,834.10 | +0.130% | -0.046% | +0.003420% | 0.6895 | +0.140 |
| ETH | 2,227.32 / 2,227.31 | -0.160% | -0.091% | +0.006062% | 1.4155 | +0.421 |
| SOL | 89.38 / 89.38 | -0.101% | +0.089% | +0.008537% | 0.4443 | +0.095 |
| XRP | 1.1518 / 1.1518 | -0.741% | +0.323% | +0.008930% | 0.7796 | -0.111 |

Next funding is 2026-11-09 00:00 UTC; the observed settlement interval is 8 hours. The premium-index `lastFundingRate` fields differ from the latest settled funding records and are stored separately; no forecast rate was exposed. No observed rate exceeds 0.05%.

## 6. SOL / ETH / XRP decisions

| Symbol | OOS_VALIDATED entry | Exact trigger | Decision |
|---|---|---|---|
| SOL | None | Not evaluated | **NO_TRADE** |
| ETH | None | Not evaluated | **NO_TRADE** |
| XRP | None | Not evaluated | **NO_TRADE** |

There are zero OOS_VALIDATED registry entries. No exact entry/stop/target levels are issued. A bearish context is not an entry trigger.

## 7. Data audit, costs, risks and next work

### Mandatory preflight

| Capability | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell / compute | PASS | Debian 13; Python 3.13.5; Node 22.16.0/npm 10.9.2; 5 CPUs; 4,937,408 kB available RAM; 30G free of 32G | Reconnaissance ran; provision Node 24/npm 11 |
| Repository / code | BLOCKED | No local checkout; remote main commit 22b513a verified; package requires Node>=24/npm>=11; SDK absent | Clone and install lockfile-pinned dependencies |
| Network / Binance | DEGRADED | Direct /fapi/v1/time DNS timeout after 5s, HTTP 000; connector market data fresh but HTTP statuses unavailable; exchangeInfo 57.12h stale | Restore direct DNS and fresh time/metadata |
| Raw historical archive | DEGRADED | 68 new rows persisted; 4h provenance mismatches; 5m/15m/1m multi-year base history absent | Reconcile 4h and backfill lower intervals |
| Data quality | PASS | 16 delta series pass; 8 current 1h/4h windows pass | Continue full-archive validation |
| Backtest / smoke test | BLOCKED | Remote scripts/backtest.ts exists; no local compatible runner; smoke test NOT_RUN | Provision runtime and run deterministic fixture |
| Disk / storage | PASS | 30G free; GitHub archive writes succeeded | Continue raw/derived separation |
| Artifact readback | PASS | Delta, manifest and all four indexes fetched back and verified; run artifacts are read back in the final verification step | Preserve blob identities and SHA-256 |

### Costs and unavailable inputs

- No account-specific maker/taker fee tier.
- No complete historical funding settlement archive for all four symbols.
- No synchronized historical spread/depth/trade samples for calibrated slippage and impact.
- The existing 15 bp round-trip proxy is not a calibrated execution model.
- No multi-year 5m/15m archive or 1m archive.
- Direct REST HTTP status/headers are unavailable because DNS resolution fails; connector responses do not expose raw HTTP status.
- Contract status cannot be accepted from the stale exchangeInfo response.
- The generic remote backtest script is not locally invokable and uses 15m/1h/4h timeframes; when funding is enabled its displayed configuration uses a fixed 0.0001 rate rather than a complete historical settlement cashflow model.

### Research queue and next actions

1. Restore direct DNS and verify `/fapi/v1/time` and `/fapi/v1/exchangeInfo`; require <=5 seconds drift.
2. Provision Node >=24/npm >=11 and clone main at `22b513a671e251415aa34e18946c55d1ae5f8113`.
3. Reconcile the 13 4h page/symbol provenance mismatches; do not merge raw increments into canonical until resolved.
4. Backfill multi-year 5m/15m and acquire 1m history.
5. Calibrate fees, funding cashflows, spread, slippage and market impact.
6. Resolve the active-vs-legacy registry status conflict (RQ-037).
7. Fix EXP-001 so BTC is reference-only; run the deterministic smoke fixture before any full experiment.
8. Keep the taxonomy frozen until the scheduled 11 November weekly review.

**No valid experiment ran. The precise blockers are RQ-002, RQ-005, RQ-025, RQ-003, RQ-004 and RQ-037.**
