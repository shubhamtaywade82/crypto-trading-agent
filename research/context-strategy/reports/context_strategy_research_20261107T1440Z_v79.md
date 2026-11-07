# Context-conditioned strategy research - run v79

- As of: 2026-11-07T14:40:24.277Z
- Generated: 2026-11-07T14:46:42.564Z
- Status: **RESEARCH_BLOCKED**
- Repository code reference: `main@fce8afd0cad347d2e9dbb0ecebfbaf43889295e0`
- Raw archive branch: `research/raw-ohlcv-archive-20261107T1440Z`
- Research branch: `research/context-strategy-2026-11-07-run24`

## 1. Research progress

### Completed
- Appended and read back **72 completed bars** in two delta batches: 52 x 5m, 16 x 15m and 4 x 1h; 18 rows per symbol. No new 4h candle had closed.
- Current incremental high-water: 5m **14:35Z**, 15m **14:15Z**, 1h **13:00Z**, 4h **08:00Z** on 2026-11-07.
- Cumulative indexed incremental deltas: **3,728 rows**.
- New delta files, manifests, SHA-256 sidecars and 1h/4h index updates were read back. New delta integrity checks passed.
- Current rolling check: 16 symbol/interval series x 200 rows = 3,200 raw rows; 3,184 completed and 16 forming. Zero duplicates, missing intervals, off-grid timestamps, OHLC invariant failures, non-positive volume or non-finite values.

### Not completed
- No strategy experiment, deterministic harness smoke test or untouched OOS evaluation ran.
- No new context thresholds, frequency/duration estimates or transition matrix were fitted.
- No strategy was promoted, downgraded or rejected.

### Historical coverage
- 1h base: 53,871 rows per symbol (215,484 total), 2020-09-14 08:00Z through 2026-11-06 22:00Z; incremental high-water now 2026-11-07 13:00Z.
- 4h canonical: 13,461 rows per symbol (53,844 total), through 2026-11-05 16:00Z; incremental high-water is 2026-11-07 08:00Z but is not merged into canonical pages.
- Multi-year 5m/15m history is absent. The 200-bar rolling sample is not a multi-cycle research sample.
- One 76-row delta remains unresolved. Fourteen prior page-symbol hash provenance mismatches remain.

## 2. Context discovery

No taxonomy revision was made. The candidate taxonomy remains a set of hypotheses:
- Trend: bullish, bearish, sideways and transition, using slope, EMA alignment and persistence.
- Volatility: low, normal, high, compression, expansion and shock, using realized volatility and ATR/range percentiles.
- Structure: range, breakout, retest, failed breakout, continuation, pullback, reversal and consolidation.
- Participation/liquidity: volume expansion, taker imbalance, spread and depth where reliable.
- Derivatives: funding, OI change, mark/index premium and positioning where supported.
- BTC-led state: BTC trend/impulse, rolling correlation, lead/lag and alt relative strength.
- Data state: shock, stale, missing, UNKNOWN, TRANSITION and INSUFFICIENT_DATA.

Training-only thresholds were not fitted. Context frequency, duration, transition probabilities and classification stability are therefore **NOT_AVAILABLE**. The current 200-bar features below are descriptive, not a calibrated regime label or a probability of trade success.

## 3. Strategy-context scorecard

| Symbol / context | Strategy | Evidence status | OOS evidence | Decision use |
|---|---|---|---|---|
| SOLUSDT / BULL_LOW | 4h Donchian20 breakout, inherited-v75 | OOS_PROMISING | 12 trades; win 66.7%; target-before-stop 41.7%; mean +0.606R; PF 2.72; max DD 1.3R; block-bootstrap 95% CI for mean R [0.086, 1.199] | Research-only; below the >=100 OOS trades per symbol/context gate |
| All symbols / 36 context cells | Context-aligned Donchian20 WF v2 | INSUFFICIENT_EVIDENCE | Every cell below 100 OOS trades; nominal block-bootstrap CI includes zero; Holm-adjusted p=1.0 | Not actionable |
| Trend/pullback, breakout/retest, range mean reversion, failed-breakout fade, volatility expansion, BTC relative strength, funding/OI filters | Candidate families | HYPOTHESIS | No new experiment in this run | Not actionable |

Carried-forward aggregate diagnostics (not cell-level validation): BTC 200 trades, 36.50% win, 21.50% target-before-stop, -0.1008R mean; ETH 182, 38.46%, 28.02%, +0.0478R; SOL 208, 37.02%, 24.52%, -0.0177R; XRP 188, 37.77%, 29.79%, +0.0489R. These aggregates do not establish a symbol/context edge. OOS_VALIDATED count remains **zero**.

## 4. Key discoveries

- No new statistical discovery was made because no experiment ran.
- The SOL BULL_LOW Donchian20 candidate remains OOS_PROMISING only. Twelve trades are far below the minimum sample gate; cost and robustness work is incomplete.
- No context is proven intrinsically untradeable. No candidate is newly REJECTED.
- Short-horizon taker buying is present while 1h/4h EMA20/EMA50 alignment is negative across all four symbols. This is a transition warning, not a trade signal.

## 5. Current context snapshot

Data timestamps differ by endpoint: mark/ticker/OI around 14:39:21Z; depth event 14:40:24Z; completed klines as of 14:40:24Z; latest taker bar 14:30Z; long/short and OI history 14:00Z; last settled funding 08:00Z.

| Symbol | Last | 24h | 20-bar return 1h / 4h | EMA20-EMA50 1h / 4h | 4h ATR14 | 5m taker buy/sell | OI change 13:00-14:00 |
|---|---:|---:|---:|---:|---:|---:|---:|
| BTCUSDT (reference) | 75,926.90 | +0.183% | +0.202% / -0.681% | -0.599% / -1.186% | 1.330% | 2.7847 | +0.0178% |
| ETHUSDT | 2,245.45 | +0.408% | +0.835% / -0.188% | -0.696% / -0.805% | 1.659% | 3.0596 | +0.0321% |
| SOLUSDT | 90.02 | -0.804% | -0.056% / -1.208% | -0.737% / -2.467% | 1.944% | 1.5867 | +0.2208% |
| XRPUSDT | 1.1681 | -1.625% | -1.620% / -6.959% | -2.069% / -2.347% | 2.361% | 3.2544 | +0.1221% |

Short-horizon 20-bar returns (5m / 15m): BTC +0.135% / -0.181%; ETH +0.292% / -0.075%; SOL +0.368% / -0.178%; XRP +0.515% / -0.580%. The latest 4h annualized realized-volatility estimates are descriptive: BTC 137.77%, ETH 172.38%, SOL 197.62%, XRP 236.34%.

| Symbol | Mark/index premium | 20-level spread | 20-level depth imbalance | Global long/short account ratio |
|---|---:|---:|---:|---:|
| BTCUSDT | -0.0444% | 0.0132 bps | -0.2351 | 3.0469 (75.29% long accounts) |
| ETHUSDT | -0.0362% | 0.0445 bps | +0.4036 | 3.5851 (78.19%) |
| SOLUSDT | -0.0441% | 1.1107 bps | -0.0376 | 3.5914 (78.22%) |
| XRPUSDT | -0.0447% | 0.8561 bps | -0.0246 | 2.8402 (73.96%) |

All four labels remain **UNKNOWN/TRANSITION**, with low, uncalibrated classification confidence. BTC is reference-only. A positive taker ratio or favorable 24h move is not an entry trigger.

Funding interval observed from settlement timestamps: 8 hours. Latest settled funding at 08:00Z: BTC 0.001332%, ETH 0.004541%, SOL 0.005614%, XRP 0.007693%. Next funding: 16:00Z. The premiumIndex `lastFundingRate` fields were BTC 0.000880%, ETH 0.007910%, SOL 0.001866%, XRP 0.010000%; these are recorded separately and are not treated as predicted funding. No observed rate exceeds |0.05%|. Mark/index premium is not a full annualized futures basis.

## 6. SOL / ETH / XRP decision matrix

| Symbol | OOS_VALIDATED rule | Exact trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | Not evaluated | **NO_TRADE** | Only OOS_PROMISING evidence is 12 trades; no validated cell or calibrated context |
| ETHUSDT | None | Not evaluated | **NO_TRADE** | No OOS_VALIDATED symbol/context rule |
| XRPUSDT | None | Not evaluated | **NO_TRADE** | No OOS_VALIDATED symbol/context rule; high recent 4h volatility and transition warning |

No entry, stop or target levels are issued. Do not transfer BTC or another symbol's evidence to a tradable symbol.

## 7. Data quality, costs, unavailable inputs and next work

### Archive integrity
- New deltas (72 rows total) and their manifests, SHA sidecars and index updates are readback-verified.
- The 4h archive index remains DEGRADED_MISSING_DELTA_REFERENCE_AND_READBACK_HASH_MISMATCH.
- Independent readback of 1h BTCUSDT page-0036 (1,371 rows, 194,900 bytes) found expected SHA c6f8055f... but observed SHA 37ea7e22...; Git blob SHA 2085c4c8... matches the manifest's blob identity.
- Independent readback of 4h SOLUSDT page-0009 (1,456 rows, 184,555 bytes) found expected JSONL SHA 212f6881... but observed SHA 03c1b4c3...; Git blob SHA 839e87ec... matches the manifest's blob identity.
- Expected hashes were preserved. These are additional observed JSONL hash discrepancies; the 14 prior page-symbol provenance mismatches remain.

### Costs and unavailable inputs
- The inherited 15 bps round-trip proxy is not validated. Actual fee tier, historical funding cashflows, spread/slippage, market impact, latency and historical depth/trade data are unavailable.
- Current depth is a single top-20 snapshot, not a historical execution model.
- Liquidations were not retrieved and are not inferred from price/OI.
- Fresh exchange metadata and direct HTTP statuses are unavailable. Connector exchangeInfo serverTime is stale by 27h20m42.104s.
- Current contract status is UNVERIFIED for execution purposes.

### Repository and harness readiness
- Remote main commit: fce8afd0cad347d2e9dbb0ecebfbaf43889295e0. No local checkout exists.
- Runtime: Debian 13, Node 22.16.0, npm 10.9.2, 5 CPUs, 5.8 GiB RAM, 30 GiB free disk. Required floor is Node >=24 and npm >=11.
- Binance SDK packages are not installed. No SDK was used.
- Source inspection found: scripts/backtest.ts omits 5m and drops closeTime from candle mapping; archiveKlines.ts uses volume < 0 and therefore accepts zero; conditional-edge defaults minN=30 and confidence=0.90, below the requested evidence gates.
- No smoke test, backtest or OOS evaluation was run.

### Preflight status

| Check | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell / compute | PASS | Debian 13; Node22.16/npm10.9; 5 CPUs; 5.8 GiB RAM; 30 GiB free | Compute exists; provision required runtime |
| Repo / code | DEGRADED | Remote GitHub main commit fce8afd0...; no local checkout | Inspect only; create local checkout |
| Binance SDK | BLOCKED | Packages NOT_FOUND; SDK not used | Install only after runtime upgrade |
| Direct Binance endpoints | BLOCKED | /time HTTP000 DNS; /exchangeInfo HTTP000 timeout | Restore direct network and fresh metadata |
| Connector market data | DEGRADED | Fresh endpoint data, but no raw HTTP status | Monitoring only; no contract validation |
| Raw archive | PASS | 72 rows appended; manifests, sidecars and indexes read back | Continue archive work |
| Historical quality | DEGRADED | Recent rolling window passes; missing 76 rows and hash discrepancies remain | Resolve Q9/Q11 |
| Backtest / smoke | BLOCKED | No compatible local runner; source defects | Repair, then deterministic smoke test |
| Disk / storage | PASS | 30 GiB free; remote GitHub branch writable | Continue bounded writes |
| Artifact readback | DEGRADED | New deltas pass; two historical page SHA fields disagree | Independent reconciliation |

### Research queue
1. Q1: backfill multi-year 5m/15m and rebuild 4h canonical archive.
2. Q2: restore fresh /fapi/v1/time and /fapi/v1/exchangeInfo.
3. Q3: provision Node24+/npm11+, fix closeTime and positive-volume validation, run deterministic smoke test.
4. Q4/Q6: obtain actual fee tier and historical funding, spread, depth, trade and latency data.
5. Q9/Q11: recover the 76-row delta and reconcile page hash discrepancies without rewriting expected values.
6. Q8/Q10: only then pre-register and run one strategy x context x symbol experiment with purging/embargo, 95% intervals, block bootstrap and Holm correction.

**Run classification: RESEARCH_BLOCKED.** Monitoring and archive persistence completed; no valid experiment or untouched OOS evaluation completed. The hourly process remains active. Weekly taxonomy review is not due until 2026-11-11T00:00:00Z.
