# Context-conditioned strategy research - 2026-11-08 22:27 UTC

**Run classification: RESEARCH_BLOCKED.** Monitoring and a verified raw-data append completed. No new backtest, strategy experiment, or untouched OOS evaluation was executed in this run.

## Mandatory preflight

| Capability/check | Status | Evidence observed | Impact today | Next action |
|---|---|---|---|---|
| Shell / compute | DEGRADED | Debian 13; kernel 6.18.57; 5 vCPU; 5.8 GiB RAM (4.7 GiB available); 30 GiB free disk; Python 3.13.5; Node v22.16.0; npm 10.9.2. | Compute is present, but Node/npm are below the repository floor. | Provision Node >=24 and npm >=11. |
| Repository / code | DEGRADED | Remote repository main commit `4c12a96fd0e9855caa25673266db5002472ade4f`; package.json requires Node >=24/npm >=11. No local checkout, package.json, node_modules, or importable Binance SDK packages. Remote backtest/research scripts exist. | Remote code is inspectable but not locally invokable. | Clone the inspected commit and install dependencies in a compatible runtime. |
| Network / Binance | DEGRADED | Direct `/fapi/v1/time` probe: HTTP 000, DNS failure. Connector calls returned market data but expose no HTTP status/headers. exchangeInfo.serverTime = 2026-11-06 11:18:40.885Z versus fresh mark time 2026-11-08 22:27:15Z (212,914.115 seconds / 59.14 hours drift). | Current data is usable for monitoring; stale metadata blocks execution validation. | Restore direct DNS; require time/exchangeInfo drift <=5 seconds. |
| Raw historical archive | DEGRADED | 1h archive: 53,871 rows/symbol (215,484 total), 36 pages/symbol, 2020-09-14 08:00Z to 2026-11-06 22:00Z plus incrementals to 21:00Z Nov 8. Canonical 4h: 13,461 rows/symbol (53,844 total), to 2026-11-05 16:00Z; raw page counts differ. Multi-year 5m/15m bases and 1m history are absent. | Multi-year 1h/4h exists, but lower-timeframe coverage and canonical freshness are insufficient. | Reconcile/rebuild 4h canonical and backfill 5m/15m/1m from an auditable source. |
| Data quality / coverage | DEGRADED | New delta: 68 completed rows; 16 forming/future rows excluded; zero duplicates, gaps, OHLC failures, non-positive volumes, non-finite values, off-grid bars, or non-monotonic rows. Current descriptive windows: 4,783 completed bars, 17 forming excluded, zero row-level failures. | Incremental data passes; archive as a whole remains incomplete. | Complete lower-timeframe and cross-symbol alignment audit. |
| Backtest harness / smoke test | BLOCKED | Remote scripts exist, but no local checkout or compatible Node runtime. SDK absent. No repository-harness smoke test or experiment ran this turn. | No research experiment or OOS claim is permitted. | Provision runtime/repo, run deterministic fixture, then experiment. |
| Disk / storage | PASS | 30 GiB free; GitHub branch write access verified. | Durable remote persistence is available. | Continue versioned commits and readback verification. |
| Artifact readback | PASS | Delta, manifest, 5m/15m/1h indexes, queue, registry snapshot and market snapshot fetched back. Delta SHA-256 and manifest SHA-256 matched exactly. | Core artifacts are verified. | Verify the final report/preflight/run manifest after commit. |

## 1. Research progress

### Completed this run

- Retrieved fresh Binance USD-M connector data for BTCUSDT, ETHUSDT, SOLUSDT and XRPUSDT.
- Appended **68 completed bars** to the GitHub raw archive:
  - 5m: 48 rows (12 per symbol), 21:25Z-22:20Z.
  - 15m: 16 rows (4 per symbol), 21:15Z-22:00Z.
  - 1h: 4 rows (1 per symbol), 21:00Z.
  - 4h: 0 rows; the 20:00Z candle was still forming.
- Excluded 16 forming/future rows from the delta. All 16 symbol/interval series passed duplicate, continuity, timestamp-grid, OHLC, volume and finite-value checks.
- Updated the 5m, 15m and 1h archive indexes. Latest completed opens are 5m 22:20Z, 15m 22:00Z, 1h 21:00Z and 4h 16:00Z.
- Verified readback:
  - Delta: 26,865 bytes; SHA-256 `8f7b850ce7781bd8af3fb251c700996b081b0593f60ffb44f22e07e7aca2608a`.
  - Manifest: 10,492 bytes; SHA-256 `610085dc49a892e4d15c631fd07d7405df90150c264afc3d775daedc003ee26d`.

### Not completed

- No new strategy experiment, backtest, smoke test, or OOS evaluation.
- No new context thresholds or context transition model fitted.
- No canonical 4h rebuild; canonical data still ends at the 2026-11-05 16:00Z open while raw incrementals reach 2026-11-08 16:00Z.
- Daily experiment cycle for local date 2026-11-09 is **BLOCKED**, not silently skipped. The exact prerequisites are in queue item RQ-038.

## 2. Context discovery

The existing exploratory taxonomy remains frozen; it was not refit this run:

- Trend: EMA50 / EMA200 spread. SIDEWAYS within a training-derived symbol threshold; otherwise BULL or BEAR by sign.
- Volatility: ATR14 / close bucketed by symbol-specific training q33 and q67.
- SHOCK: absolute completed 4h return above the training q99 threshold.
- No outcome calibration is implied by these context labels.

The prior full-window artifact used 13,461 canonical 4h bars per symbol, with 12,462 classified bars after warmup. The following frequencies, durations and stability diagnostics are **prior diagnostics, not recomputed this run**:

| Symbol | Frequent contexts / median duration | Self-transition | Train/test JSD |
|---|---|---:|---:|
| BTC | SIDEWAYS_LOW 25.56% / 11.5 bars; BULL_LOW 16.05% / 12 bars; BEAR_HIGH 11.79% / 7 bars | 93.03% | 0.202 |
| ETH | SIDEWAYS_LOW 18.58% / 9 bars; BULL_NORMAL 16.24% / 8 bars; BEAR_HIGH 14.03% / 8 bars | 92.64% | 0.108 |
| SOL | SIDEWAYS_LOW 24.77% / 10 bars; BEAR_LOW 12.86% / 7 bars; BULL_NORMAL 11.86% / 5.5 bars | 92.38% | 0.297 |
| XRP | SIDEWAYS_LOW 18.86% / 9.5 bars; BEAR_LOW 17.12% / 14 bars; BULL_HIGH 12.66% / 5 bars | 92.91% | 0.128 |

SOL has the largest train/test distribution drift (JSD 0.297). High self-transition rates indicate persistence, not predictive confidence. A complete transition matrix and uncertainty bands were not recalculated this run. The taxonomy remains exploratory and is not a win-probability model.

## 3. Strategy-context scorecard

Registry counts remain: **0 OOS_VALIDATED, 1 OOS_PROMISING, 5 INSUFFICIENT_EVIDENCE, 1 REJECTED, 6 HYPOTHESIS**.

| Candidate | Symbol / context | OOS trades | Net OOS evidence | Status / caveat |
|---|---|---:|---|---|
| Donchian20 breakout | SOL / BULL_LOW | 12 | Prior report: mean +0.606R; PF 2.72. | OOS_PROMISING only; below 100-trade cell floor; detailed CI not present in the accessible registry snapshot. Not current context. |
| Donchian breakout | SOL / context-conditioned | 55 | Mean +0.0431R; PF 1.082; target-before-stop 21.82%; max DD 7.89R; 95% block-bootstrap CI [-0.280, 0.390]; quote PnL -19.83 USDT per SOL. | INSUFFICIENT_EVIDENCE. Result artifact selected lookback 15, while the registry ID says Donchian20; identity conflict remains open under RQ-036. |
| Failed-breakout fade | SOL / SIDEWAYS_LOW | 113 | Mean -0.148R; PF 0.787; max DD 20.79R; win rate 43.36%; target-before-stop 27.43%. | REJECTED on recorded OOS/cost result. A CI was not available in the registry summary. |
| EMA20 pullback + BTC confirmation | SOL / BEAR_NORMAL | 10 | Mean -0.1886R; PF 0.733; target-before-stop 10%; win rate 40%; max DD 3.48R; adjusted 99.17% block-bootstrap CI [-0.860, 0.779]. | INSUFFICIENT_EVIDENCE. Walk-forward test windows were mixed: 15 trades +0.106R, 6 trades +0.241R, 7 trades -0.260R. |
| Volatility-contraction breakout + BTC confirmation | SOL / BULL_COMPRESS | 18 | Mean -0.20496R; PF 0.687; target-before-stop 11.11%; 95% block-bootstrap CI [-0.723, 0.295]. | INSUFFICIENT_EVIDENCE; Holm-adjusted p=1. |
| Volatility-contraction breakout + BTC confirmation | SOL / BEAR_COMPRESS | 26 | Mean -0.11534R; PF 0.814; target-before-stop 19.23%; 95% block-bootstrap CI [-0.683, 0.371]. | INSUFFICIENT_EVIDENCE; Holm-adjusted p=1. |

ETH and XRP have no symbol-specific OOS strategy evidence. No SOL result is transferred to ETH or XRP. Untested families remain HYPOTHESIS: trend/pullback variants, breakout/retest, range mean reversion outside the rejected SOL cell, volatility expansion, BTC-relative-strength filters, and funding/OI filters.

## 4. Key discoveries

1. There is still no demonstrated OOS_VALIDATED edge.
2. SOL SIDEWAYS_LOW failed-breakout fade is the only listed candidate with a sufficiently large recorded negative OOS result to retain REJECTED status.
3. The positive SOL BULL_LOW Donchian candidate has only 12 OOS trades. It is a research lead, not a trading rule.
4. The 55-trade Donchian result has a confidence interval crossing zero and a lookback/version identity conflict. Do not reuse it until reconciled.
5. Trend-pullback and volatility-contraction variants have not shown stable positive expectancy; the pullback walk-forward windows change sign.
6. No context is established as intrinsically untradeable. Tested failure, insufficient evidence and untested context remain distinct labels.

## 5. Current context snapshot

Candle classification timestamp: **2026-11-08 22:27:15 UTC**. Market metrics were retrieved around 22:25:20-22:25:33 UTC.

| Symbol | Last price | 24h | 4h context | 4h EMA spread | ATR14/close | 1h alignment | 1h candle O->C | 5m / 15m return |
|---|---:|---:|---|---:|---:|---|---:|---:|
| BTC (reference) | 74,541.60 | -1.621% | BEAR_LOW | -2.995% | 0.854% | BEAR_ALIGNED | -2.137% | +0.128% / +0.512% |
| ETH | 2,130.91 | -4.566% | BEAR_LOW | -4.007% | 1.129% | BEAR_ALIGNED | -4.484% | +0.246% / +0.004% |
| SOL | 86.56 | -3.112% | BEAR_LOW | -7.502% | 1.487% | BEAR_ALIGNED | -3.548% | +0.127% / +0.768% |
| XRP | 1.1198 | -3.565% | BEAR_LOW | -5.875% | 1.659% | BEAR_ALIGNED | -3.851% | +0.295% / +0.911% |

**Transition warning:** all four 1h candles closed sharply lower, while the latest completed 5m/15m bars rebounded. This is a short-term bounce inside a bearish multi-timeframe structure, not a long trigger. The 4h classification uses the bar that closed at 19:59:59.999Z; the 20:00Z 4h candle remains forming. Feature classification confidence is **medium** because the 4h state is stale relative to the recent 1h impulse. This is not a probability of trade success.

Additional live observations:

| Symbol | OI change (1h) | Taker buy share (12 x 5m) | Global long-account share | Indicated funding | Last settled funding |
|---|---:|---:|---:|---:|---:|
| BTC | -1.006% | 43.34% | 74.03% | +0.003306% | +0.003420% |
| ETH | -4.351% | 43.27% | 78.18% | -0.006069% | +0.006062% |
| SOL | -3.095% | 45.62% | 77.48% | -0.002841% | +0.008537% |
| XRP | -4.042% | 44.01% | 73.35% | +0.010000% | +0.008930% |

- Funding interval observed: 8 hours. Next settlement: 2026-11-09 00:00 UTC.
- No indicated or settled rate exceeds the 0.05% flag threshold.
- OI fell alongside the selloff; this is descriptive only and is not evidence of liquidations.
- Global long/short ratio is account-based positioning, not notional exposure.
- Top-20 book spread / imbalance is one snapshot (RPI excluded), not a persistent liquidity signal. Spreads observed: BTC 0.013 bps, ETH 0.047 bps, SOL 1.156 bps, XRP 0.893 bps.

## 6. SOL / ETH / XRP decisions

| Symbol | OOS_VALIDATED strategy | Exact trigger | Decision |
|---|---|---|---|
| SOL | None | None | **NO_TRADE** |
| ETH | None | None | **NO_TRADE** |
| XRP | None | None | **NO_TRADE** |

Reasons: zero OOS_VALIDATED registry entries; no exact validated trigger; current BEAR_LOW does not match the only OOS_PROMISING SOL BULL_LOW candidate; no cross-symbol transfer; stale exchange metadata and incomplete execution-cost calibration. No entry, stop, target or position size is issued. BTC remains reference-only.

## 7. Data audit, costs, unavailable inputs and next experiments

### Archive and integrity

- 1h: 53,871 base rows per symbol, 215,484 total across 36 pages/symbol; 2020-09-14 08:00Z to 2026-11-06 22:00Z, plus verified incrementals through 2026-11-08 21:00Z.
- 4h canonical: 13,461 rows/symbol, 53,844 total; 2020-09-14 08:00Z to 2026-11-05 16:00Z. Canonical series itself reports zero gaps/duplicates and verified SHA-256/manifests. Raw page totals differ: BTC/ETH/XRP 13,499 each; SOL 13,455. The archive index records 14/14 mismatched page-symbol pairs matched by alternate Binance connector replay, but the raw/canonical row-count discrepancy and canonical lag still need reconciliation. Do not carry forward the older unverified "13 mismatches" count.
- 5m/15m: only incremental deltas; multi-year base archives absent. 1m absent.
- Current 500/100-bar descriptive windows: 4,783 completed bars and 17 forming/future bars excluded. No row-level integrity failures. The 5m XRP window has one fewer completed bar than the other symbols; latest completed timestamps are aligned.
- Current delta and manifest are persisted on the new GitHub research branch and were fetched back with matching SHA-256.

### Costs and unavailable inputs

- No account-specific fee tier.
- Prior experiments used a 15 bps round-trip proxy; it is not calibrated to actual maker/taker fees, spread, slippage, market impact, latency or partial fills.
- Funding history is incomplete. The pullback result reports 3,501 blank markPrice fields in 6,806 settlements and a funding manifest hash mismatch; proxy pricing was used in some historical calculations. The contraction experiment uses a 15 bps cost proxy.
- No synchronized historical order-book/depth stream, liquidation feed, or calibrated impact model.
- Current OI, candles and account ratios are not used to infer liquidation events or crowding.

### Research queue / next executable actions

1. **P0 - Runtime/connectivity:** restore direct Binance DNS; provision Node >=24/npm >=11; clone the inspected main commit and install dependencies.
2. **P0 - Archive:** reconcile raw/canonical 4h row counts and rebuild canonical 4h through the 2026-11-08 16:00Z raw highwater without overwriting the prior artifact.
3. **P1 - Coverage:** backfill multi-year 5m/15m and 1m from an auditable source; preserve raw pages and manifests.
4. **P1 - Harness:** run deterministic stop-first, repeatability, no-lookahead and completed-candle smoke fixtures; fix 5m/closeTime support and enforce BTC reference-only.
5. **P1 - Costs:** backfill complete funding settlements and synchronized depth/trade samples; calibrate fees, spread, slippage and impact.
6. **P1 - Experiment:** after prerequisites, pre-register one strategy x context x symbol test; fit thresholds on train, tune on validation, evaluate untouched OOS once, purge/embargo overlapping labels, block-bootstrap, apply Holm correction and require >=100 OOS trades per symbol/context.
7. **P1 - Registry identity:** resolve RQ-036 Donchian lookback/version conflict before reusing the 55-trade result.
8. **P2 - Weekly taxonomy review:** due 2026-11-11; re-estimate training-only thresholds and compare frequency, duration, transition and JSD stability. Do not force a taxonomy change.

**Bottom line:** this run improved the raw archive and refreshed the live context, but it did not create new strategy evidence. The correct classification is **RESEARCH_BLOCKED**, with **NO_TRADE** for SOL, ETH and XRP.
