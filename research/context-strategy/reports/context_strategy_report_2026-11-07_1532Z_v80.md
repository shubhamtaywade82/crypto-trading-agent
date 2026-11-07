# Context-conditioned strategy research — 2026-11-07 15:32 UTC

**Run classification: RESEARCH_BLOCKED.** Current-market monitoring, 52-row raw archive append, rolling-window validation and checksum re-audit completed. No strategy experiment or untouched OOS evaluation was run.

## 1. Research progress

- Appended **52 completed OHLCV rows** to the remote raw archive: 36 × 5m, 12 × 15m and 4 × 1h across BTCUSDT, ETHUSDT, SOLUSDT and XRPUSDT. No new 4h candle was complete at the archive cutoff.
- The append fetched 64 rows and excluded 12 forming candles. Per symbol: 9 × 5m, 3 × 15m, 1 × 1h. Quality failures: 0 duplicates, 0 gaps, 0 off-grid timestamps, 0 OHLC invariant failures, 0 non-positive volumes, 0 non-finite values and 0 close-time failures.
- Latest completed archive high-waters: 5m **15:20Z**, 15m **15:00Z**, 1h **14:00Z**, 4h **08:00Z** on 2026-11-07.
- Persisted the delta, manifest and both interval indexes to `research/raw-ohlcv-archive-20261107T1525Z-run11`; all were fetched back and verified.
- Independently rechecked eight historical page-symbol files: four 1h page-0036 files and four 4h page-0009 files. All eight SHA-256 values match their manifests. Two prior independent readback mismatch flags were not reproduced; one original 4h page-0009 BTC hash mismatch flag was removed. **13 other original page-symbol hash mismatches remain**.
- No experiment or OOS evaluation was executed. The exact blockers are the missing local checkout, Node/npm below the repository floor, stale exchange metadata/direct DNS failure, missing multi-year 5m/15m archive, unresolved 76-row artifact and incomplete execution-cost model.

Historical coverage currently visible in the remote archive:
- 1h base pages: **53,871 rows/symbol** (215,484 total), 2020-09-14 08:00Z through 2026-11-06 22:00Z; incremental high-water now 2026-11-07 14:00Z.
- 4h canonical: **13,461 rows/symbol** (53,844 total), 2020-09-14 08:00Z through 2026-11-05 16:00Z. Incremental 4h high-water is 2026-11-07 08:00Z but is not merged into the canonical file.
- Multi-year 5m/15m history is absent. One indexed 76-row delta remains NOT_FOUND; its coverage is unknown and was not reconstructed.

## 2. Context discovery

A descriptive, non-fitted context view was computed from 100 raw bars per symbol/timeframe (16 series; 1,600 raw rows, 1,584 completed, 16 forming excluded). Every rolling series passed duplicate, continuity, timestamp-grid, monotonicity, OHLC, positive-volume, finite-value and close-time checks.

Current feature definitions:
- Trend: EMA20 versus EMA50 on completed 5m/15m/1h/4h bars.
- Volatility: ATR14 and its percentile within the available 100-bar rolling window.
- Participation: 20-bar average volume versus the preceding 20 bars, plus taker-buy base volume / total base volume.
- Positioning: global long-account share and long/short ratio snapshots only.
- Derivatives: mark-price funding field, last settled funding history record and current open interest.
- BTC-led state: direction alignment only. Rolling correlation, lead/lag and relative-strength inference were not recomputed.
- Structure/shock: no validated breakout, retest, failed-breakout or training-derived shock detector was run.

Context frequency, duration, transition probabilities and threshold stability were **not** recomputed. These 100-bar windows are current-state descriptors, not a multi-cycle regime sample. Classification agreement is not a calibrated probability of a winning trade.

## 3. Strategy-context scorecard

No scorecard cells were re-tested this run. The accessible registry contains:
- **SOLUSDT / BULL_LOW / 4h Donchian20 breakout / inherited-v75 — OOS_PROMISING**, not actionable: 12 OOS trades, 66.7% win rate, 41.7% target-before-stop, mean net 0.606R, PF 2.72, max drawdown 1.3R, block-bootstrap 95% CI for mean R [0.086, 1.199]. Last evaluation: 2026-11-05 09:43:57Z. The 12-trade sample is far below the >=100 per-symbol/context provisional gate; costs and robustness are incomplete.
- **OOS_VALIDATED: 0. REJECTED: 0.** No new evidence label was assigned.
- Trend/pullback, breakout/retest, range mean reversion, failed-breakout fade, volatility expansion, BTC relative-strength and funding/OI filters remain **HYPOTHESIS**.

The carried strategy scorecard still uses a 15bp round-trip proxy, not a validated execution-cost model. Its inherited minN=30 / 90% confidence defaults are below the required >=100 OOS trades per symbol/context, 95% intervals and 200+ trades across multiple windows for stronger evidence.

## 4. Key discoveries

1. No new conditional edge was established. The only OOS_PROMISING candidate remains under-sampled and is not eligible for execution.
2. The previous two independent checksum mismatch observations were not reproducible. Known-vector-tested SHA-256 over exact GitHub readback content matched all eight page files checked. One original 4h manifest mismatch was removed; 13 remain for re-audit.
3. The 76-row missing delta and lower-timeframe historical coverage remain hard blockers. Do not synthesize the missing rows.
4. Current long-account ratios are elevated (about 73.7%-78.4% long accounts), while several latest completed 5m candles show seller-dominated taker flow. These are positioning/flow observations, not liquidation or crowding proof.

## 5. Current context snapshot

As of **2026-11-07 15:32:07Z** for completed candles; mark prices were timestamped 15:32:03-05Z. 24h ticker, OI, funding and top-of-book snapshots are timestamped around 15:29Z; global account positioning is timestamped 15:25Z.

| Symbol | Mark | 24h change | EMA20/50 trend | ATR14 rank (5m / 15m / 1h / 4h) | Latest 5m taker-buy ratio | Context |
|---|---:|---:|---|---|---:|---|
| BTCUSDT | 75,800.01 | +0.268% | Bear 4/4 | 34.5 / 19.0 / 1.2 / 65.5 | 0.289 | Bearish intraday; 24h still positive |
| ETHUSDT | 2,240.39 | +0.971% | Bear 3/4; 15m bullish | 65.5 / 36.9 / 1.2 / 63.1 | 0.326 | Bearish higher timeframes with 15m countertrend |
| SOLUSDT | 89.50 | -1.081% | Bear 4/4 | 89.3 / 52.4 / 2.4 / 60.7 | 0.630 | Bearish alignment; short-term buying against trend |
| XRPUSDT | 1.1566 | -2.303% | Bear 4/4 | 89.3 / 42.9 / 4.8 / 82.1 | 0.196 | Bearish alignment; elevated 5m and 4h volatility |

Classification confidence here means EMA agreement across the sampled timeframes only. It is not a win probability. SOL's 5m buying pressure and ETH's 15m bullish alignment are transition warnings, not entries.

Funding interval is 8h; next funding is 16:00Z. The mark-price response `lastFundingRate` field versus latest settled funding at 08:00Z:
- BTC: 0.001263% versus 0.001332%
- ETH: 0.007506% versus 0.004541%
- SOL: 0.001801% versus 0.005614%
- XRP: 0.010000% versus 0.007693%

No observed funding value exceeds the 0.05% threshold. Current OI and global long/short account ratios are snapshots only; no liquidation inference is made. Top-of-book spreads at ~15:29Z were approximately BTC 0.013bp, ETH 0.045bp, SOL 1.115bp and XRP 0.863bp; one-level quantities are not reliable depth/impact estimates.

## 6. SOL / ETH / XRP decision matrix

| Symbol | OOS_VALIDATED strategy | Exact trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | Not evaluated | **NO_TRADE** | Only BULL_LOW Donchian20 is OOS_PROMISING with 12 trades; current context is bearish, and no validated registry entry exists. |
| ETHUSDT | None | Not evaluated | **NO_TRADE** | No OOS_VALIDATED entry; 15m countertrend does not qualify as a trigger. |
| XRPUSDT | None | Not evaluated | **NO_TRADE** | No OOS_VALIDATED entry; elevated short-term volatility is not an entry signal. |

No entry, stop, target or sizing is issued. BTC remains a reference only.

## 7. Data audit, costs, unavailable inputs and next work

- Direct shell probes to `GET /fapi/v1/time` and `GET /fapi/v1/exchangeInfo` returned HTTP000 because DNS resolution for `fapi.binance.com` failed. The Binance market-data connector supplied current klines, mark-price/funding fields, 24h ticker, OI, funding history/info, taker volume, global long/short account ratio and top-of-book; it does not expose raw HTTP status/headers.
- The connector's exchangeInfo serverTime was **2026-11-06 11:18:40.899Z**, stale by about **28h14m** at this run. Contract status is therefore not accepted for execution validation.
- The remote package requires Node>=24/npm>=11; the runtime is Node22.16.0/npm10.9.2, with no local checkout and no installed Binance SDK. The remote `scripts/backtest.ts` exists but implements only 15m/1h/4h and does not preserve closeTime. `archiveKlines.validateCandles` accepts zero volume and does not validate closeTime. No smoke test was run.
- Execution costs remain uncalibrated: actual fee tier, historical funding cashflows, spread/depth, slippage, impact and latency are unavailable. The inherited 15bp round-trip proxy is not validated.
- Historical derivatives archive remains incomplete. The accessible SOL funding archive has 6,806 rows through 2026-11-05 16:00Z, but its readback SHA does not match and 3,501 rows have blank mark prices.
- Liquidation data and historical order-book depth were not retrieved. No liquidation/crowding inference is made.

### Mandatory preflight

| Capability | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell / compute | PASS | Linux 6.18.57; 5 CPUs; 6.09GB RAM total / 4.94GB available; 30GB disk free; Python 3.13.5 | Bounded computation possible; Node runtime still below project floor. |
| Repo / code | DEGRADED | Remote GitHub source readable; local checkout absent; Node22.16/npm10.9 vs Node24/npm11 required; SDK packages absent | Provision checkout and supported runtime. |
| Network / Binance | DEGRADED | Connector data calls succeeded; direct REST DNS failed; exchangeInfo serverTime stale | Restore direct REST and fresh metadata. |
| Raw archive | DEGRADED | Remote 1h/4h history plus 3,780 incremental rows; multi-year 5m/15m absent; missing 76 rows | Backfill lower intervals and recover missing artifact. |
| Data quality / coverage | DEGRADED | 16 rolling series / 1,584 completed bars all clean; 52-row delta clean; 13 hash provenance mismatches remain | Re-audit remaining mismatches and expand history. |
| Backtest / smoke test | BLOCKED | Remote entrypoint exists but cannot be invoked; fixture not run | Fix runtime, 5m/closeTime/zero-volume gaps, then smoke test. |
| Disk / storage | PASS | 30GB free; GitHub branch writes and readbacks verified | Continue remote archive maintenance. |
| Artifact readback | PASS | Delta, manifest, 1h/4h indexes and 8 page files read back and verified | Persisted artifacts are reproducible. |

**Run status: RESEARCH_BLOCKED.** The next executable action is to provision the repository locally under Node24/npm11, fix candle integrity (closeTime and volume>0) and 5m support, then run the deterministic fixture. In parallel, backfill multi-year 5m/15m and recover the 76-row artifact. Do not start a strategy experiment until those prerequisites and the cost model are satisfied.
