# Binance USDⓈ-M context-conditioned research

**As of:** 2026-11-14 01:03 UTC  
**Run status:** RESEARCH_EXECUTED — incremental archive/data-quality work only.  
**Untouched OOS:** NOT EVALUATED.  
**Trade selection:** NO_TRADE for SOLUSDT, ETHUSDT and XRPUSDT.

## Mandatory preflight

| Capability/check | Status | Evidence observed | Impact | Next action |
|---|---|---|---|---|
| Shell/compute | DEGRADED | Debian 13; Python 3.13.5; Node 22.16.0; npm 10.9.2; 3 CPUs; 6.24 GB RAM; 30 GB free. | Shell and bounded processing work, but Node is below the project requirement. | Provision Node 24 and npm 11. |
| Repository/code | DEGRADED | Remote repository accessible at main commit 7109619e5e7354f0bb0c571274e91548dcd8294f; scripts/backtest.ts, scripts/research-run.ts and scripts/conditional-edge.ts exist. No local checkout or node_modules. | Source inspection works; local harness invocation does not. | Checkout the exact commit on a compatible runtime. |
| Network/Binance endpoints | DEGRADED | Six direct REST probes failed DNS. Binance public market-data connector calls returned current klines, mark, ticker, funding, OI, depth and positioning data; connector does not expose HTTP status. | Monitoring and archive refresh possible; direct REST status and server-time validation unavailable. | Restore DNS/HTTPS and re-probe official endpoints. |
| Raw historical archive | DEGRADED | Persistent GitHub archive branch updated; 188 rows appended; two deltas, manifests, four indexes and two receipts read back. | New data is durable, but historical coverage remains partial/degraded. | Continue page-0028 backfill and reconcile 1h/4h. |
| Data quality/coverage | DEGRADED | Latest 16-series sample: 1,584 completed bars and 16 forming bars excluded; zero candle-quality failures. Historical 1h/4h gaps remain. | Recent data is suitable for monitoring, not multi-cycle strategy inference. | Reconcile the full archive before fitting thresholds. |
| Backtest harness/smoke test | BLOCKED | Remote harness exists, but local Node 22.16/npm 10.9 are below Node >=24/npm >=11; local checkout and SDK are absent; deterministic smoke test not run. | No strategy experiment or OOS evaluation can be claimed. | Provision the runtime, run the fixture twice and test no-lookahead invariance. |
| Disk/storage | PASS | 30 GB free locally; GitHub archive branch writable. | Persistent remote storage is available. | Continue atomic writes and readback checks. |
| Artifact readback | PASS | Both deltas, manifests, archive manifests, four indexes and two receipts were read back exactly. | Archive append persistence is verified. | Verify every run artifact after writing. |
| Exchange metadata/server time | BLOCKED | Connector exchangeInfo serverTime was 68,483 seconds stale; direct /fapi/v1/time DNS probe failed. | Reported TRADING statuses cannot be used for execution validation. | Require fresh server time and exchangeInfo before execution checks. |

**Execution classification:** RESEARCH_EXECUTED. No strategy backtest ran. OOS_EVALUATED was not achieved.

## 1. Research progress

### Completed this run

- Appended **188 completed bars** to the persistent archive: 5m 132, 15m 44, 1h 12, 4h 0.
- Per-symbol append count: 47 each for BTCUSDT, ETHUSDT, SOLUSDT and XRPUSDT.
- Two incremental delta files were created with SHA-256 manifests and exact readback verification.
- Updated and read back all four interval indexes. Latest canonical highwaters are 5m 00:55Z, 15m 00:45Z, 1h 00:00Z and 4h 12:00Z on 2026-11-14/13 respectively.
- Ran the daily data-quality experiment. Duplicate, missing-interval, off-grid, non-monotonic, OHLC, non-finite, non-positive-volume and close-time failures were all zero in the new sample and append slices.
- Refreshed the completed-candle snapshot for all four symbols.

### Historical coverage and adequacy

| Interval | Base archive coverage | Canonical incremental highwater | Assessment |
|---|---|---|---|
| 5m | 162,000 base rows (40,500/symbol), 2020-01-01 to 2021-02-01 21:55Z; pages through 0027 | 2026-11-14 00:55Z | PARTIAL: large multi-year gap between base pages and recent deltas. |
| 15m | 162,000 base rows (40,500/symbol), 2020-01-01 to 2021-11-10 03:45Z; pages through 0027 | 2026-11-14 00:45Z | PARTIAL: not continuous through multiple recent cycles. |
| 1h | 215,504 base rows (53,876/symbol), from 2020-09-14; 28 missing hourly opens per symbol and an 8-row discrepancy | 2026-11-14 00:00Z | DEGRADED: do not use for strategy inference until reconciled. |
| 4h | Raw 53,960; aligned 53,816; canonical 53,844; 13 page-manifest SHA mismatches | 2026-11-13 12:00Z | DEGRADED: append held; provenance and row counts unresolved. |

The current connector sample contains 100 rows per symbol/interval, 99 completed and one forming per series. That is a monitoring window, not a sufficient historical sample. The 4h completed candles at 16:00Z and 20:00Z on Nov 13 (8 rows across four symbols) remain held rather than appended because the 4h provenance issue is unresolved.

## 2. Context discovery

No training-only regime thresholds, frequency/duration statistics, transition matrix or stability test were run. The archive is not yet sufficiently reconciled for those claims.

The compact taxonomy remains a **hypothesis**, not a fitted taxonomy:

- Trend: bullish, bearish, sideways, transition; EMA alignment, slope and persistence.
- Volatility: compression, normal, expansion and shock using training-derived ATR/realized-volatility percentiles.
- Structure: range, breakout, retest, failed breakout, continuation, pullback and reversal.
- Participation/liquidity: volume and taker imbalance, spread and depth where timestamped and reliable.
- Derivatives: funding, OI and basis only with point-in-time histories.
- BTC-led: BTC state, rolling correlation and relative strength/weakness.
- Data state: UNKNOWN, TRANSITION, SHOCK and INSUFFICIENT_DATA.

Current EMA labels below are descriptive feature states only. They are not probability-of-win estimates, and no regime frequency or duration is inferred from the short monitoring window.

## 3. Strategy-context scorecard

The accessible registry snapshot contains five SOL-specific entries: four INSUFFICIENT_EVIDENCE and one REJECTED. It contains **zero OOS_VALIDATED entries** and no ETH/XRP symbol-specific evidence.

| Symbol / context / strategy | Status | OOS trades | Win rate | Target before stop | Mean net R (95% CI) | PF | Max DD | Quote PnL |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| SOL BULL_LOW — Donchian 15 breakout | INSUFFICIENT_EVIDENCE | 55 | 43.6% | 21.8% | +0.043 [-0.280, +0.390] | 1.082 | 7.89R | -19.83 USDT/SOL |
| SOL SIDEWAYS_LOW — failed-breakout fade | REJECTED | 113 | 43.4% | 27.4% | -0.148 [-0.318, +0.020] | 0.787 | 20.79R | -26.58 USDT/SOL |
| SOL BEAR_NORMAL — EMA20 pullback recross with BTC confirmation | INSUFFICIENT_EVIDENCE | 10 | 40.0% | 10.0% | -0.189 [-0.860, +0.779] | 0.733 | 3.48R | -8.23 USDT/SOL |
| SOL BULL_COMPRESS — volatility-contraction breakout with BTC confirmation | INSUFFICIENT_EVIDENCE | 18 | 33.3% | 11.1% | -0.205 [-0.723, +0.295] | 0.687 | 7.43R | -23.27 USDT/SOL |
| SOL BEAR_COMPRESS — volatility-contraction breakout with BTC confirmation | INSUFFICIENT_EVIDENCE | 26 | 34.6% | 19.2% | -0.115 [-0.683, +0.371] | 0.814 | 7.81R | -0.53 USDT/SOL |

Evidence notes:

- Donchian BULL_LOW has only 55 OOS trades, a CI crossing zero and negative total quote PnL despite a slightly positive mean R. It does not pass the predeclared sample gate.
- The SIDEWAYS_LOW failed-breakout fade is genuinely REJECTED: negative net expectancy, PF below 1, 20.79R drawdown, negative parameter-neighborhood results and Holm-adjusted p-value 1.0.
- The pullback and compression candidates have small OOS counts, negative point estimates and wide CIs. They remain INSUFFICIENT_EVIDENCE.
- All six broader candidate families remain HYPOTHESIS outside those recorded SOL tests. No cross-symbol transfer is permitted.

## 4. Key discoveries

1. The only recorded rejection is SOL SIDEWAYS_LOW failed-breakout fade; do not generalize it to ETH or XRP.
2. SOL Donchian BULL_LOW is not validated: the sample is below 100 trades, uncertainty crosses zero and quote PnL is negative.
3. BTC-confirmed SOL pullback and compression-breakout candidates have not demonstrated a robust net edge.
4. No edge has been demonstrated for ETHUSDT or XRPUSDT in the accessible registry.
5. A bearish market context is not itself a trade trigger. No strategy is promoted this run.

## 5. Current context snapshot

**Completed-candle feature timestamp:** 2026-11-14 01:01:22Z.  
Mark/ticker/funding/OI snapshot: 01:00:14Z. Microstructure snapshot: 01:00:37Z.

| Symbol | 4h | 1h | 15m | 5m | 72h corr. to BTC | Relative 24h vs BTC | Warning |
|---|---|---|---|---|---:|---:|---|
| BTC (reference) | Bearish | Bearish | Bearish | Mixed | 1.000 | — | 5m rebound inside broader bearish alignment. |
| ETH | Bearish | Bearish | Bearish | Mixed | 0.893 | -0.029 pp | 5m and 1h short-window returns positive, but EMA alignment remains bearish. |
| SOL | Bearish | Bearish | Bearish | Bearish | 0.807 | -0.835 pp | 4h last true range is 2.57x the recent 20-bar median. |
| XRP | Bearish | Bearish | Bearish | Mixed | 0.664 | +1.372 pp | Relative 24h outperformance does not reverse the bearish multi-timeframe state. |

| Symbol | Last price | 24h change | Mark | Indicated funding | Last settled funding | OI | Spread |
|---|---:|---:|---:|---:|---:|---:|---:|
| BTC | 68,318.50 | -3.907% | 68,315.22 | +0.005854% | +0.005972% | 98,072.020 | 0.015 bps |
| ETH | 1,931.02 | -3.962% | 1,931.07 | +0.001405% | +0.001200% | 2,321,523.405 | 0.052 bps |
| SOL | 77.6500 | -4.782% | 77.6404 | +0.006195% | +0.006550% | 9,309,940.84 | 1.289 bps |
| XRP | 1.0084 | -2.570% | 1.0081 | +0.005715% | +0.005028% | 295,784,255.7 | 0.993 bps |

Funding is positive for all four symbols; all observed indicated rates are below the 0.05% absolute threshold. The funding interval is 8 hours, with next funding at 08:00Z. Indicated rates are from premium-index lastFundingRate; settled rates are the separate funding-history records at 00:00Z.

The last completed 15m taker-flow bucket (00:30Z) was sell-dominant for all four symbols: buy/sell ratios BTC 0.7399, ETH 0.4712, SOL 0.7226, XRP 0.6309. Global account long/short ratios were approximately 3.23, 3.76, 3.58 and 3.05 respectively. These are snapshots, not evidence of crowding. Top-20 book imbalance was +0.746 BTC, +0.542 ETH, +0.080 SOL and -0.057 XRP; it is not a fill model.

## 6. SOL/ETH/XRP decision matrix

| Symbol | OOS_VALIDATED strategy | Trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | Not evaluated | NO_TRADE | Registry has zero validated entries; SOL evidence is insufficient or rejected. |
| ETHUSDT | None | Not evaluated | NO_TRADE | No ETH-specific OOS_VALIDATED evidence. |
| XRPUSDT | None | Not evaluated | NO_TRADE | No XRP-specific OOS_VALIDATED evidence. |

No entry, stop, target or sizing levels are emitted. BTC remains reference-only.

## 7. Data audit, costs, unavailable inputs, risks and next experiments

### Data quality and source endpoints

Underlying USDⓈ-M endpoint mappings used through the public connector: /fapi/v1/klines (5m/15m/1h/4h), /fapi/v1/premiumIndex, /fapi/v1/ticker/24hr, /fapi/v1/openInterest, /fapi/v1/fundingRate, /futures/data/openInterestHist, /futures/data/takerBuySellVol, /futures/data/globalLongShortAccountRatio and /fapi/v1/depth. /fapi/v1/time and direct REST probes for the above endpoints failed DNS from the shell. Connector calls did not expose HTTP status codes.

The connector exchangeInfo payload reports all four symbols as TRADING perpetuals, but its serverTime is 19h01m23s stale. Do not use it for execution validation. No liquidation inference is made from OI/candles.

### Costs and missing inputs

- No calibrated account fee tier, taker/maker fee schedule, spread/impact model, slippage, partial-fill model or latency model is available.
- Top-of-book spread and top-20 depth are single snapshots, not historical execution costs.
- Historical point-in-time funding/OI/taker/positioning panels are incomplete. Current funding and OI snapshots do not substitute for those histories.
- Prior strategy experiments used a 15bp round-trip proxy in some candidates; it is not a calibrated cost model and must not be treated as reliable net expectancy.
- No liquidation feed, top-trader positioning history or continuous order-book history was retrieved.

### Next research queue

1. Continue 5m/15m historical backfill with page 0028 using per-symbol nextStart values from the indexes.
2. Reconcile the 1h bridge: 28 missing hourly opens per symbol and the 8-row discrepancy.
3. Reconcile 4h raw/aligned/canonical row keys and the 13 page-manifest SHA mismatches; keep 4h appends held until resolved.
4. Provision Node 24/npm 11 and a local checkout at main commit 7109619e; run deterministic fixture twice and no-lookahead invariance before a full experiment.
5. Backfill point-in-time derivatives and calibrate fees, spread, slippage, market impact, latency and funding cashflows.
6. After prerequisites pass, preregister one strategy×context×symbol experiment with chronological train/validation/untouched-test splits, purging/embargo, block-bootstrap uncertainty and multiple-testing control.
7. Weekly taxonomy stability review remains DUE_BLOCKED; do not change the taxonomy on the current short monitoring sample.

**Bottom line:** the archive advanced and the append/index readbacks passed. Strategy discovery and trade selection remain blocked by historical lineage, runtime and cost-model prerequisites. No validated trade exists.
