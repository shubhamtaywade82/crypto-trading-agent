# Context Strategy Research - Run v87

- As-of: 2026-11-08T21:30:03.001Z
- Repository: shubhamtaywade82/crypto-trading-agent
- Archive branch: research/raw-ohlcv-archive-20261108T2126Z-run25
- Run classification: **RESEARCH_BLOCKED**
- Archive refresh: **completed and readback-verified**
- Strategy experiment: **not executed**
- Untouched OOS evaluation: **not executed**
- OOS_VALIDATED registry entries: **0**

## 1. Research progress

### Completed this run

Appended 72 newly completed Binance USD-M candles across BTCUSDT, ETHUSDT, SOLUSDT and XRPUSDT:

| Interval | New rows | Rows per symbol | Latest completed open |
|---|---:|---:|---|
| 5m | 52 | 13 | 2026-11-08 21:20 UTC |
| 15m | 16 | 4 | 2026-11-08 21:00 UTC |
| 1h | 4 | 1 | 2026-11-08 20:00 UTC |
| 4h | 0 | 0 | 2026-11-08 16:00 UTC (unchanged) |
| **Total** | **72** | **18** | |

The connector returned 88 rows; 16 forming bars (one per symbol/interval) were excluded. The 20:00 UTC 4h candle was still forming at retrieval time.

Delta: `research-data/binance-usdm/delta/binance_usdm_delta_20261108T2126Z_5m15m1h_completed.jsonl`

- 28,129 bytes
- SHA-256: `8b2674f66c99af2dc763b405366ba4da11b41a21a3773989f79a0a10b3698dd0`
- Manifest: `research-data/binance-usdm/delta/manifest-20261108T2126Z-5m15m1h.json`
- Manifest SHA-256: `fc9329fa55150918e4e1debde621bcc8b9400dddeeac7c365c3015cedf38e07c`
- Delta and manifest were fetched back; both SHA-256 values matched.
- 5m, 15m and 1h archive indexes were updated and fetched back. Their latest highwaters are 21:20Z, 21:00Z and 20:00Z respectively.

### Historical coverage and adequacy

| Interval | Available base coverage | Incremental highwater | Research adequacy |
|---|---|---|---|
| 1h | 53,871 rows/symbol, 2020-09-14 08:00Z to 2026-11-06 22:00Z | 2026-11-08 20:00Z | Long multi-cycle sample exists; source/runtime validation still required. |
| 4h | Canonical 13,461 rows/symbol, 2020-09-14 08:00Z to 2026-11-05 16:00Z | Raw incrementals to 2026-11-08 16:00Z | Useful for regime work, but canonical rebuild and provenance reconciliation remain open. |
| 15m | No multi-year base archive | 2026-11-08 21:00Z | Inadequate for robust strategy OOS. |
| 5m | No multi-year base archive | 2026-11-08 21:20Z | Inadequate for robust strategy OOS. |
| 1m | Absent | None | Directional barrier experiments blocked. |

The raw 4h archive has 13,499 rows for BTC/ETH/XRP and 13,455 for SOL, while the canonical series has 13,461 rows for each. The archive index still records 13 page/symbol expected-vs-observed hash mismatches and raw/canonical count differences. Prior row-level reconciliation found exact rows for the sampled mismatched page/symbol pairs, but the archive is not yet fully reconciled. Do not normalize or overwrite expected hashes.

No new historical strategy experiment was executed. The experiment count is zero; this is not an unchanged research success. The exact blockers are recorded below.

## 2. Context discovery

### Frozen exploratory taxonomy

The current context artifact is `CTX-4H-EMA50xEMA200-ATRQ-v2-FULL-ARCHIVE`. It uses:

- Trend spread: EMA50 / EMA200 - 1.
- SIDEWAYS when absolute trend spread is within the symbol's training-derived flat threshold; otherwise BULL or BEAR by sign.
- Volatility: ATR14 / close bucketed by symbol training q33 and q67.
- SHOCK override when absolute 4h return exceeds the symbol training q99.

No thresholds were refit this run. The taxonomy is explicitly exploratory, not preregistered, and has no trade-outcome calibration. The prior distribution artifact used 13,461 canonical 4h bars per symbol, with 12,462 classified bars after warmup.

| Symbol | Flat threshold | ATR q33 | ATR q67 | Shock q99 |
|---|---:|---:|---:|---:|
| BTC | 2.5048% | 1.4474% | 2.0674% | 4.8982% |
| ETH | 2.5106% | 1.7550% | 2.5876% | 6.3197% |
| SOL | 4.0735% | 2.7494% | 4.0357% | 9.7612% |
| XRP | 2.3359% | 1.9936% | 3.0167% | 9.0980% |

Prior full-window diagnostics (not recomputed this run):

| Symbol | Frequent contexts and median run length | Self-transition | Train/test JSD |
|---|---|---:|---:|
| BTC | SIDEWAYS_LOW 25.56% / 11.5 bars; BULL_LOW 16.05% / 12 bars; BEAR_HIGH 11.79% / 7 bars | 93.03% | 0.202 |
| ETH | SIDEWAYS_LOW 18.58% / 9 bars; BULL_NORMAL 16.24% / 8 bars; BEAR_HIGH 14.03% / 8 bars | 92.64% | 0.108 |
| SOL | SIDEWAYS_LOW 24.77% / 10 bars; BEAR_LOW 12.86% / 7 bars; BULL_NORMAL 11.86% / 5.5 bars | 92.38% | 0.297 |
| XRP | SIDEWAYS_LOW 18.86% / 9.5 bars; BEAR_LOW 17.12% / 14 bars; BULL_HIGH 12.66% / 5 bars | 92.91% | 0.128 |

High self-transition rates indicate persistence, not predictive confidence. SOL has the largest train/test distribution drift by JSD. The context label is deterministic classification; it is not the probability of a future trade win.

## 3. Strategy-context scorecard

Registry status is unchanged:

| Evidence status | Cells |
|---|---:|
| OOS_VALIDATED | 0 |
| OOS_PROMISING | 1 |
| INSUFFICIENT_EVIDENCE | 5 |
| REJECTED | 1 |
| HYPOTHESIS | 6 |

Selected evidence:

| Candidate | Symbol/context | OOS trades | OOS result | Status |
|---|---|---:|---|---|
| SOL Donchian20 / BULL_LOW | SOL / BULL_LOW | 12 | Mean net +0.606R; PF 2.72 | OOS_PROMISING; below the 100-trade per-cell floor. |
| SOL Donchian15 | SOL / context-conditioned | 55 | Mean net +0.043R; PF 1.082; 95% block-bootstrap CI [-0.280, 0.390] | INSUFFICIENT_EVIDENCE. |
| Failed-breakout fade | SOL / SIDEWAYS_LOW | 113 | Mean net -0.148R; PF 0.787 | REJECTED by the recorded OOS/cost result. |
| Trend-pullback with BTC confirmation | SOL / BEAR_NORMAL | 10 | Mean net -0.189R; PF 0.733 | INSUFFICIENT_EVIDENCE. |
| Volatility contraction breakout with BTC confirmation | SOL / BULL_COMPRESS | 18 | Mean net -0.205R; PF 0.687 | INSUFFICIENT_EVIDENCE. |
| Volatility contraction breakout with BTC confirmation | SOL / BEAR_COMPRESS | 26 | Mean net -0.115R; PF 0.814 | INSUFFICIENT_EVIDENCE. |

No ETH or XRP strategy has symbol-specific OOS evidence in this registry. Do not transfer SOL evidence to either symbol. The 12-trade Donchian20 candidate is not actionable. No candidate is OOS_VALIDATED.

## 4. Key discoveries

- There is no demonstrated OOS_VALIDATED edge in the current registry.
- The SOL failed-breakout fade is the only listed candidate with a recorded negative OOS result sufficient to retain REJECTED status.
- SOL Donchian20/BULL_LOW is a small-sample positive lead, not proof; its 12 trades are far below the predeclared evidence floor.
- Trend-pullback and compression-breakout variants have not demonstrated adequate positive OOS evidence.
- No context is established as intrinsically untradeable; insufficient observations and untested contexts must remain distinct from a tested failure.

## 5. Current context snapshot

Market snapshot as of 2026-11-08 21:30:03 UTC, from the Binance public connector. Latest completed candles used: 5m 21:25Z, 15m 21:15Z, 1h 20:00Z, 4h 16:00Z. Forming candles were excluded.

| Symbol | Last | 24h change | 4h context | 1h alignment | 5m return / taker-buy share |
|---|---:|---:|---|---|---|
| BTC (reference) | 75,666.10 | +0.084% | DOWN_LOW | BEAR_ALIGNED | -0.089% / 31.1% |
| ETH | 2,223.25 | -0.094% | DOWN_LOW | BEAR_ALIGNED | -0.102% / 54.9% |
| SOL | 89.00 | +0.146% | DOWN_LOW | BEAR_ALIGNED | -0.022% / 54.4% |
| XRP | 1.1461 | -0.564% | DOWN_LOW | BEAR_ALIGNED | -0.061% / 42.4% |

All four 4h states remain DOWN_LOW under the frozen per-symbol thresholds. All four 1h EMA20/50/200 alignments are bearish in the 500-bar descriptive window. This is a context label, not a short trigger.

Open-interest change over the last completed hour: BTC -0.109%, ETH -0.001%, SOL +0.075%, XRP +0.074%. Global long-account ratios are 75.30%, 78.36%, 78.79%, and 73.96% respectively; these are positioning observations, not proof of crowding or liquidation risk. Top-20 order-book imbalance is a single snapshot and should not be treated as a persistent signal.

Premium-index lastFundingRate fields are BTC +0.004375%, ETH +0.001909%, SOL -0.000478%, XRP +0.010000%. Latest settled funding at 16:00Z is BTC +0.003420%, ETH +0.006062%, SOL +0.008537%, XRP +0.008930%. Next settlement is 00:00Z; the observed interval is 8h. No observed rate exceeds the 0.05% flag threshold. premiumIndex.lastFundingRate is not represented as a next-settlement forecast.

## 6. Trade decisions

| Symbol | OOS_VALIDATED candidate | Exact trigger | Decision |
|---|---|---|---|
| SOL | None | None | NO_TRADE |
| ETH | None | None | NO_TRADE |
| XRP | None | None | NO_TRADE |

Reasons: zero OOS_VALIDATED registry entries; no exact validated setup trigger; context alone is not an entry; exchange metadata is stale; historical cost calibration is incomplete. No entry, stop or target levels are issued.

## 7. Data-quality audit, costs, blockers and next work

### Preflight

| Check | Status | Evidence / impact |
|---|---|---|
| Shell/compute | PASS | Debian 13, Python 3.13.5, Node 22.16.0, npm 10.9.2, 5 CPU, 4.92 GB available RAM, 30 GB free disk. |
| Repo/code | BLOCKED | No local checkout; project requires Node >=24/npm >=11; SDK packages absent. |
| Network/Binance | DEGRADED | Direct REST DNS failed; connector supplied data without HTTP status/headers; exchangeInfo serverTime is 58.19h stale. |
| Raw archive | DEGRADED | 1h/4h multi-year archives exist; 5m/15m bases and 1m absent. |
| Data quality | DEGRADED | New 72-row delta clean; 4h raw/canonical reconciliation remains incomplete. |
| Backtest/smoke | BLOCKED | No compatible local harness execution; no fixture smoke test; no experiment/OOS. |
| Disk/storage | PASS | GitHub push permission and 30 GB free disk. |
| Artifact readback | PASS | Delta/manifest hashes, 5m/15m/1h indexes, queue, registry, market snapshot, preflight and report were fetched back and verified. |

Direct REST probes attempted: `/fapi/v1/time`, `/fapi/v1/exchangeInfo`, `/fapi/v1/premiumIndex`, `/fapi/v1/openInterest`, `/fapi/v1/ticker/24hr`, `/fapi/v1/klines`. All returned HTTP 000 due DNS resolution failure or timeout. The Binance connector was used as a degraded monitoring fallback; it did not expose HTTP status/headers. The connector's exchangeInfo serverTime was 2026-11-06 11:18:40.886Z, 209,482.115 seconds behind the 2026-11-08 21:30:03.001Z mark timestamp. Contract statuses were observed as TRADING, but stale metadata is not accepted for execution validation.

### Costs and unavailable inputs

- No actual account fee tier is available.
- No synchronized historical spread/depth or calibrated slippage/market-impact model.
- Only two recent settled funding records per symbol were retrieved; a full historical funding archive is missing.
- The existing backtest CLI uses a fixed 8h x 0.0001 funding approximation; the research-run CLI reports fundingModeled=false. Neither is sufficient for strict net-expectancy promotion.
- No liquidation feed was retrieved. OI, account ratios and candles alone are not used to infer liquidations or crowding.

### Highest-priority queue

1. **P0 - Runtime and connectivity:** restore direct Binance DNS; provision Node >=24/npm >=11; clone at main commit `4c12a96fd0e9855caa25673266db5002472ade4f`; install and verify SDK.
2. **P0 - Archive integrity:** reconcile the 4h raw/canonical row-count differences and 13 page/symbol provenance mismatches; rebuild canonical 4h as a new version through the verified 2026-11-08 16:00Z highwater.
3. **P1 - Lower timeframe data:** backfill multi-year 5m/15m and acquire 1m; preserve raw manifests and checksums.
4. **P1 - Cost model:** backfill historical funding settlements and collect synchronized depth/trade samples; calibrate spread, slippage and impact.
5. **P1 - Harness readiness:** repair/verify closeTime and 5m support, add deterministic fixture smoke tests, and enforce the >=100 OOS trades per symbol/context gate plus multi-window stability.
6. **P1 - Experiment:** freeze EXP-001 only after prerequisites pass; tradable symbols must be SOL/ETH/XRP, BTC is confirmation-only. Run train/validation/untouched OOS with purging and the full cost model.
7. **P2 - Weekly context review:** due 2026-11-11; retain the taxonomy unless training-only stability diagnostics justify a revision.

No strategy experiment or OOS evaluation was run. The run classification is **RESEARCH_BLOCKED**; the 72-row archive refresh and monitoring snapshot do not count as research completion.
