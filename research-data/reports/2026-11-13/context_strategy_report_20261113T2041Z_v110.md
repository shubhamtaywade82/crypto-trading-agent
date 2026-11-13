# Binance USD-M conditional strategy research - v110

**As of:** 2026-11-13 20:41 UTC (local calendar date 2026-11-14)
**Run status:** RESEARCH_BLOCKED
**Universe:** SOLUSDT, ETHUSDT and XRPUSDT tradable; BTCUSDT reference only.

## 1. Research progress

- Refreshed USD-M mark/last, 24h statistics, indicated funding, latest settled funding, open interest, top-of-book, 20-level depth, 15m taker flow and 1h global long/short observations for BTC, ETH, SOL and XRP.
- Retrieved 100 klines per symbol for 5m/15m/1h/4h: 1,600 rows returned; 1,586 completed; 14 forming rows excluded. This 100-bar sample is monitoring-only, not a multi-cycle strategy research sample.
- Appended 32 completed OHLCV rows to remote archive branch research/raw-ohlcv-archive-20261113T2040Z-run12: 5m 24 rows and 15m 8 rows. Delta files, manifest and updated 5m/15m archive indexes were reopened; SHA-256 and Git blob SHA readback checks passed.
- No 1h/4h rows were appended because the 20:00Z bars were still forming at retrieval time.
- No strategy experiment, fixture smoke test, taxonomy refit, chronological validation or untouched OOS evaluation ran. No registry promotion or rejection occurred.
- The daily experiment remains blocked by the missing local checkout/compatible runtime, incomplete 5m/15m base history, 4h raw/canonical reconciliation, execution-cost calibration and full funding cashflows.

Persistent raw archive: https://github.com/shubhamtaywade82/crypto-trading-agent/tree/research/raw-ohlcv-archive-20261113T2040Z-run12
Context snapshot: https://github.com/shubhamtaywade82/crypto-trading-agent/tree/research/context-strategy-20261113T2041Z-v110

## 2. Context discovery

The v56 taxonomy is carried forward, not refit. The current snapshot uses descriptive EMA20/EMA50 alignment and a 10-bar EMA20 slope on completed bars.

- Trend: BTC, ETH and SOL are bearish on 1h/4h; XRP is mixed on 1h and bearish on 4h. All four are mixed on 5m/15m.
- Volatility: ATR14/close is reported descriptively. Low/normal/high and compression/expansion thresholds remain UNKNOWN because training-only percentile values are not available in this run.
- Structure: range, breakout, retest, failed breakout, continuation and reversal labels remain UNKNOWN; no detector was refit or tested.
- Participation/liquidity: latest taker ratios and one 20-level depth snapshot are observations only. No training distribution or persistence test exists.
- Derivatives: indicated funding, three recent settlements, current OI and two-hour OI change are observations; no funding/OI strategy was tested.
- BTC-led state: BTC is the reference and has a bearish 1h/4h state. Rolling correlation, lead/lag and alt relative strength were not estimated.
- Shock/data state: no data-integrity shock was detected in the 100-bar sample. XRP's last 5m volume was about 2.43x the prior 20-bar median, but no training-calibrated shock threshold exists; formal shock state remains UNKNOWN.

No context frequency, duration, transition matrix, stability or classification-uncertainty estimates were produced. Feature classification confidence is not a probability of a future trade win.

## 3. Strategy-context scorecard

| Strategy / context | Symbol | Evidence status | Evidence quality |
|---|---|---|---|
| Donchian20 4h breakout walk-forward v2, 36 cells | ALL | INSUFFICIENT_EVIDENCE | All cells below 100 OOS trades; nominal block-bootstrap intervals include zero; Holm-adjusted p=1.0; 15bp round-trip proxy uncalibrated. Not recomputed this run. |
| Donchian20 4h breakout v2, BULL_LOW | SOLUSDT | OOS_PROMISING | 12 OOS trades; win 66.7%; target-before-stop 41.7%; mean net 0.606R; PF 2.72; max drawdown 1.3R; block-bootstrap 95% CI [0.086, 1.199]. Not recomputed; cost and parameter-neighborhood gates incomplete. |
| Trend/pullback continuation | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Breakout/retest and volatility contraction | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Range mean reversion / failed-breakout fade | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Volatility expansion / momentum | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| BTC-led confirmation / relative strength | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Funding/OI filters | SOL/ETH/XRP | HYPOTHESIS | Not tested. |

OOS_VALIDATED entries: 0. The SOL BULL_LOW candidate is research-only and is not an actionable setup.

## 4. Key discoveries and failure modes

- No new context-conditioned edge was discovered or rejected in this run because no experiment ran.
- The archived research program log records null ALMA event-family results, a fill-starved SMC/ICT ablation, and a sweep-and-reclaim family closed after seven predeclared studies. The stopless descriptive hit-rate signal did not survive stop-aware execution; later chase/retest and cross-asset variants failed their predeclared gates. These are prior studies, not results from this run.
- The current registry's Donchian20 SOL BULL_LOW observation remains OOS_PROMISING only: 12 OOS trades are far below the minimum 100 per symbol/context, the cost proxy is uncalibrated, and full trade-level specification/artifacts are not available in the accessible snapshot.
- No strategy is promoted to OOS_VALIDATED. No family is newly marked REJECTED.

## 5. Current context snapshot

Market data timestamps: mark/ticker 20:40:58-20:41:02Z; completed klines through 5m 20:35Z, 15m 20:15Z, 1h 19:00Z and 4h 16:00Z.

| Symbol | Mark | 24h change | 5m / 15m / 1h / 4h | ATR14/close 1h / 4h | 20-bar return 1h / 4h |
|---|---:|---:|---|---:|---:|
| BTCUSDT (reference) | 68,858.4 | -3.657% | Mixed / Mixed / Bear / Bear | 0.879% / 1.681% | -3.345% / -7.199% |
| ETHUSDT | 1,945.03 | -3.606% | Mixed / Mixed / Bear / Bear | 1.110% / 2.177% | -3.265% / -6.715% |
| SOLUSDT | 80.0401 | -1.791% | Mixed / Mixed / Bear / Bear | 1.165% / 2.313% | -1.738% / -5.208% |
| XRPUSDT | 1.0235 | -1.178% | Mixed / Mixed / Mixed / Bear | 1.212% / 2.357% | -1.287% / -4.737% |

The lower timeframes are not confirming the higher-timeframe downtrend. Treat this as a transition/mixed-participation warning, not an entry signal. XRP's 5m volume expansion is descriptive only.

Derivatives and liquidity observations:
- Indicated funding: BTC 0.008124%, ETH 0.002532%, SOL 0.009140%, XRP 0.008832%; next funding 2026-11-14 00:00Z. None exceeds |0.05%|.
- Last settled funding: BTC 0.004045%, ETH 0.004743%, SOL 0.007203%, XRP 0.010000%, all at 16:00Z; observed settlement interval is 8h.
- OI change from 18:00Z to 20:00Z: BTC -0.160%, ETH -0.151%, SOL -0.386%, XRP +0.195%. This does not identify liquidation or crowding.
- Latest completed 15m taker buy/sell ratios (20:15Z): BTC 0.6460, ETH 0.5809, SOL 0.8366, XRP 1.1493.
- Global long/short account ratios (20:00Z): BTC 3.1203, ETH 3.7529, SOL 3.4287, XRP 3.0048. These are positioning observations, not proof of crowded positioning.
- 20-level notional depth imbalance (20:41:14Z): BTC -4.70%, ETH +18.81%, SOL -0.28%, XRP +4.97%. One snapshot is not a durable liquidity signal.
- Top-of-book spreads observed at 20:36Z: BTC 0.0145bp, ETH 0.0514bp, SOL 1.2477bp, XRP 0.9757bp.

## 6. Decision matrix

| Symbol | OOS_VALIDATED strategy | Trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | Not evaluated | NO_TRADE | No validated registry entry; SOL BULL_LOW is OOS_PROMISING only, and current 1h/4h context is bearish. |
| ETHUSDT | None | Not evaluated | NO_TRADE | No OOS_VALIDATED entry and no frozen symbol/context trigger rule. |
| XRPUSDT | None | Not evaluated | NO_TRADE | No OOS_VALIDATED entry; 1h is mixed, 4h bearish, and lower-timeframe strength is not a validated trigger. |

No entry, stop, target or position size is supplied. BTCUSDT remains reference-only.

## 7. Data audit, costs, unavailable inputs, risks and next experiments

### Mandatory preflight

| Capability/check | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell/compute | PASS | Linux x86_64; Python 3.13.5; Node 22.16.0; npm 10.9.2; 3 CPUs; about 4.95 GiB available RAM; about 30 GiB free disk. | Bounded inspection possible; provision Node 24+/npm 11+. |
| Repo/code | BLOCKED | No local checkout or .git; remote GitHub files only. | Clone exact branch and lockfile before invoking scripts. |
| Network/Binance endpoints | DEGRADED | Direct DNS to fapi.binance.com/api.github.com failed; connector returned current data but hides HTTP status. exchangeInfo serverTime is about 14h39m stale; /fapi/v1/time unavailable. | Monitoring usable; contract/execution validation blocked. |
| Raw historical archive | DEGRADED | 1h 215,528 rows; 5m/15m base absent; 4h raw 53,964 vs canonical 53,844. | Backfill lower timeframes and reconcile 4h. |
| Data quality/coverage | DEGRADED | Current 1,600-row sample has 1,586 completed / 14 forming excluded and zero structural errors; historical coverage remains incomplete. | Do not treat monitoring sample as research-grade multi-cycle coverage. |
| Backtest harness/smoke test | BLOCKED | Remote scripts exist, but no local checkout/runtime; no fixture smoke test or backtest ran. | Fix source defects, provision runner, smoke-test before experiment. |
| Disk/storage | PASS | About 30 GiB free; GitHub remote writes available; local filesystem ephemeral. | Persist to remote branch and verify readback. |
| Artifact readback | PASS | 32 raw rows, two deltas, manifest and 5m/15m indexes reopened and SHA-256/Git blob SHA verified. | Context artifacts are persisted on the v110 branch and separately read back. |

### Costs and unavailable inputs

- Current top-of-book spreads and one 20-level depth snapshot are available; fee tier, maker/taker fee schedule, synchronized historical depth/trades, size-dependent impact, latency and fill distributions are not calibrated.
- Only the latest three settled funding records per symbol were retrieved; full funding history and position-aligned cashflows are unavailable.
- Liquidation data was not retrieved. No liquidation or crowding inference is made from candles/OI/long-short ratios.
- BTC lead/lag, rolling correlations, structural event labels, volatility percentiles, context occupancy/duration/transitions and classification uncertainty are not computed.
- The historical 4h canonical series passes structural checks through 2026-11-05T16:00Z, but raw/canonical row counts and page-hash provenance remain degraded. Alternate-source replay matched 21,000 compared rows exactly across 14 page/symbol pairs; preserve expected-vs-observed hashes rather than rewriting provenance.
- Direct Binance REST HTTP status/headers and a fresh exchange server clock remain unavailable. Stale exchangeInfo must not be used for execution validation.

### Next research queue

1. Restore direct DNS/HTTPS and fresh /fapi/v1/time plus exchangeInfo.
2. Provision Node 24+/npm 11+ and a local checkout of the exact research branch.
3. Backfill multi-year 5m/15m history and reconcile/rebuild 4h canonical from verified deltas.
4. Fix completed-candle handling, strictly positive volume, 5m replay, BTC reference-only enforcement, and purge/embargo tests.
5. Calibrate symbol/size-specific fees, spread, impact, slippage, latency and fill assumptions; backfill full funding cashflows.
6. Run deterministic fixture smoke tests, then freeze one strategy x context x symbol experiment with chronological train/validation/untouched OOS, block bootstrap and multiple-testing controls.
7. Complete the overdue weekly taxonomy stability review only after archive and runner prerequisites are met.

**Run classification: RESEARCH_BLOCKED.** Monitoring and raw archive append completed; no valid experiment or untouched OOS evaluation ran.
