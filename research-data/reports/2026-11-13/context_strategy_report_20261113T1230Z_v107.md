# Binance USD-M Context Strategy Research - v107

**As of:** 2026-11-13T12:30:33.495Z  
**Classification:** **RESEARCH_BLOCKED** - monitoring and archive maintenance completed; no strategy experiment or untouched OOS evaluation ran.  
**Universe:** BTCUSDT reference only; SOLUSDT, ETHUSDT and XRPUSDT tradable.

## 1. Research progress

### Completed
- Refreshed BTC, ETH, SOL and XRP using the Binance public market-data connector.
- Retrieved 200 klines for each of 4 symbols x 4 intervals (3,200 rows). 3,184 completed bars were eligible; 16 forming bars were excluded.
- Current-window integrity checks passed: zero duplicates, gaps, off-grid timestamps, OHLC violations, non-positive volume, non-finite values, non-monotonic opens or close-time errors; all four symbols aligned per interval.
- Appended **200 completed rows** to the remote raw archive: 5m 140, 15m 44, 1h 12, 4h 4. Delta, manifest and all four interval indexes were fetched back and SHA-256 verified.
- Highwaters advanced to 5m 12:20Z, 15m 12:00Z, 1h 11:00Z and 4h 08:00Z.

Raw archive: [branch](https://github.com/shubhamtaywade82/crypto-trading-agent/tree/research/raw-ohlcv-archive-20261113T063450Z-run11)  
Delta: [200-row JSONL](https://github.com/shubhamtaywade82/crypto-trading-agent/blob/research/raw-ohlcv-archive-20261113T063450Z-run11/research-data/binance-usdm/delta/binance_usdm_delta_20261113T1226Z_all_intervals_completed.jsonl)  
Manifest: [delta manifest](https://github.com/shubhamtaywade82/crypto-trading-agent/blob/research/raw-ohlcv-archive-20261113T063450Z-run11/research-data/binance-usdm/delta/manifest-20261113T1226Z-all-intervals.json)

### Historical coverage and adequacy

| Interval | Accessible archive after append | Adequacy |
|---|---|---|
| 5m | No multi-year base history; incremental-only; highwater 2026-11-13 12:20Z | **INSUFFICIENT** |
| 15m | No multi-year base history; incremental-only; highwater 2026-11-13 12:00Z | **INSUFFICIENT** |
| 1h | 215,508 rows; 53,877 per symbol; 2020-09-14 08:00Z to 2026-11-13 11:00Z | Multi-year sample suitable for exploratory work after local materialization |
| 4h | 53,960 raw rows; canonical 53,844 rows through 2026-11-05 16:00Z; 13 original page-manifest SHA mismatches | **DEGRADED**: raw/canonical count and provenance reconciliation remain open |

The 4h raw counts are BTC/ETH/XRP 13,501 each and SOL 13,457; canonical remains 13,461 per symbol. The canonical 4h series was not rewritten. The raw archive is remote, not mounted locally.

### Research not completed
- **New experiments: 0. OOS evaluations: 0.**
- No local project checkout or compatible Node runner exists. Observed Node is v22.16.0/npm 10.9.2; the prior repository package audit records Node >=24/npm >=11. The actual backtest harness was not invoked and no deterministic smoke/no-lookahead test ran.
- No training-only context refit, occupancy, duration, transition or stability calculation ran. The weekly taxonomy review due 2026-11-11 remains blocked.
- The first daily attempt for local date 2026-11-13 had already occurred at 2026-11-12T23:34:00.605Z; it remained blocked. This run did not relabel monitoring as research.

## 2. Context discovery

The v56 taxonomy is carried forward as a hypothesis, not refit. Its documented detector is 4h trend strength (EMA20-EMA50)/Wilder ATR14, training-only q67 trend-transition threshold, training-only q33/q67 ATR/close volatility buckets, 70/15/15 chronological split and 500-bar warmup. Numeric fitted thresholds and transition matrix are not available in the accessible registry.

No context frequency, duration, transition probability, stability or uncertainty statistics were recomputed. Current labels below are descriptive EMA alignment only. ATR ranks are local ranks within the 199 completed bars returned this run, not training-fitted volatility cutoffs. No low/normal/high volatility bucket or future-win probability is assigned.

## 3. Strategy-context scorecard

| Strategy x context x symbol | Evidence status | Evidence quality | Current applicability |
|---|---|---|---|
| Donchian20 4h breakout walk-forward v2 - 36 symbol/context cells | **INSUFFICIENT_EVIDENCE** | All cells below 100 OOS trades; nominal block-bootstrap intervals include zero; Holm-adjusted p=1.0; 15bp round-trip proxy uncalibrated | Not actionable |
| Donchian20 4h breakout v2 - SOLUSDT / BULL_LOW | **OOS_PROMISING** | 12 OOS trades; 66.7% win; 41.7% target-before-stop; mean net +0.606R; PF 2.72; max DD 1.3R; block-bootstrap 95% CI for mean R [0.086, 1.199] | Research-only; not current BULL_LOW and not validated |
| Trend/pullback continuation | **HYPOTHESIS** | Not tested | None |
| Breakout/retest / volatility contraction | **HYPOTHESIS** | Not tested | None |
| Range mean reversion / failed-breakout fade | **HYPOTHESIS** | Not tested | None |
| Volatility expansion / momentum | **HYPOTHESIS** | Not tested | None |
| BTC-led confirmation / relative strength | **HYPOTHESIS** | Not tested | None |
| Funding/OI filters | **HYPOTHESIS** | Not tested | None |

The Donchian summaries are carried forward from the 2026-11-05 evaluation and were not recomputed. Full trade rules, exact split boundaries, complete cell-level intervals and trade-level cost artifacts are not present in the accessible registry. **OOS_VALIDATED entries: 0.**

## 4. Key discoveries

- No robust OOS edge is demonstrated in the accessible registry. The SOL BULL_LOW point estimate remains only OOS_PROMISING because it has 12 trades, not the predeclared >=100 per symbol/context floor, and its cost/parameter robustness is incomplete.
- BTC, ETH and XRP have bearish 1h/4h EMA alignment; SOL is mixed on 1h and bearish on 4h. Lower timeframes are mixed, with 5m bullish alignment in ETH and SOL.
- Latest 15m taker buy/sell ratios are BTC 0.8494, ETH 1.3326, SOL 1.0318 and XRP 1.2590. This is a short-window participation observation, not a standalone edge.
- 1h OI changed 09:00Z to 12:00Z by BTC +0.338%, ETH +0.358%, SOL -0.083% and XRP +0.251%. These values do not establish liquidations or crowding.
- No context or strategy was promoted, rejected or validated this run.

## 5. Current market snapshot

**Market timestamp:** 2026-11-13 12:26:14 UTC. Premium-index and settled funding are reported separately. Observed funding interval is 8 hours; next funding is 16:00Z. No observed indicated or settled rate exceeds absolute 0.05%.

| Symbol | Mark / last | 24h change | 5m / 15m / 1h / 4h | Indicated / settled funding | OI | Top spread |
|---|---:|---:|---|---:|---:|---:|
| BTCUSDT (reference) | 69,246.05 / 69,256.00 | -4.984% | MIXED / MIXED / BEAR / BEAR | -0.001524% / +0.001270% | 101,000.615 BTC | 0.0144 bp |
| ETHUSDT | 1,958.56 / 1,958.31 | -3.185% | BULL / MIXED / BEAR / BEAR | +0.003888% / +0.000971% | 2,350,272.372 ETH | 0.0511 bp |
| SOLUSDT | 80.6607 / 80.6400 | -2.172% | BULL / MIXED / MIXED / BEAR | -0.004661% / -0.005430% | 9,405,970.71 SOL | 1.2400 bp |
| XRPUSDT | 1.0234 / 1.0238 | -1.044% | MIXED / MIXED / BEAR / BEAR | +0.007744% / +0.000653% | 295,916,521.5 XRP | 0.9767 bp |

- BTC 4h 12h return: -2.987%. ETH -2.987%, SOL -1.286%, XRP -1.710%; all three alts moved in the same 12h direction as BTC. Relative 12h return versus BTC is ETH -0.001pp, SOL +1.701pp and XRP +1.277pp.
- 4h ATR/close: BTC 1.617% (local 199-bar rank 95.5), ETH 2.051% (rank 76.9), SOL 2.199% (rank 54.3), XRP 2.326% (rank 71.9). These are descriptive local ranks, not trained volatility classes.
- 1h OI history is only four observations per symbol. Global long/short account ratios at 12:00Z are BTC 3.4053, ETH 3.7192, SOL 3.3937 and XRP 2.9714; account ratios are descriptive and do not prove positioning concentration.
- Top-of-book spread is a point snapshot, not a size-dependent execution-cost estimate.

## 6. SOL / ETH / XRP decision matrix

| Symbol | OOS_VALIDATED strategy | Trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | No validated rule to evaluate | **NO_TRADE** | No OOS_VALIDATED entry; 1h/4h context is mixed-transition; contract metadata is stale for execution validation |
| ETHUSDT | None | No validated rule to evaluate | **NO_TRADE** | No OOS_VALIDATED entry; 5m bullish countertrend against bearish 1h/4h alignment |
| XRPUSDT | None | No validated rule to evaluate | **NO_TRADE** | No OOS_VALIDATED entry; 1h/4h bearish and no validated trigger |

No entry, stop, target or size is supplied. A favorable-looking regime is not an entry trigger. BTC remains reference-only.

## 7. Preflight, costs, unavailable inputs and next experiments

| Capability/check | Status | Evidence observed | Impact / next action |
|---|---|---|---|
| Shell/compute | PASS | Debian 13; Linux 6.18.57; Python 3.13.5; Node 22.16.0; npm 10.9.2; 3 CPUs; 5.8GiB RAM; 30GB free | Runtime available; provision Node 24+/npm 11+ |
| Repo/code | BLOCKED | No local checkout; remote scripts visible through GitHub only | Clone exact branch into compatible runner |
| Network/Binance endpoints | DEGRADED | Direct /fapi/v1/time DNS failure; connector returned current market data but hides HTTP status; exchangeInfo serverTime is 6h24m stale | Restore direct HTTPS and fetch uncached server time/metadata |
| Raw historical archive | DEGRADED | 200 rows appended and readback verified remotely; 5m/15m base absent; 4h raw/canonical mismatch remains | Backfill 5m/15m and reconcile 4h |
| Data quality/coverage | DEGRADED | Current 3,200-row sample passes; 1h multi-year index clean; 4h provenance degraded | Materialize and run full historical audit |
| Backtest harness/smoke test | BLOCKED | No local harness invoked; no deterministic smoke/no-lookahead test | Provision runner, then test fixtures before experiment |
| Disk/storage | PASS | 30GB free; GitHub writes succeeded | Continue remote versioned snapshots |
| Artifact readback | PASS | Delta, manifest and all four interval indexes fetched back and SHA-256 verified | Continue verified context snapshots |

### Costs and unavailable inputs
- No account fee tier or calibrated maker/taker schedule.
- No synchronized historical depth/trade data, size-dependent impact, latency or fill distribution.
- The 15bp round-trip proxy remains uncalibrated and is not execution truth.
- Full funding settlement cashflows are not archived; only the latest three settled records per symbol were retrieved.
- No liquidation feed or validated crowding measure was used. Basis was not queried this run.

### Highest-priority next actions
1. Restore direct Binance HTTPS; retrieve fresh /fapi/v1/time and /fapi/v1/exchangeInfo and verify <=5s drift.
2. Provision Node >=24/npm >=11; clone the exact research branch and reconcile code/package-lock hashes.
3. Backfill multi-year 5m/15m; materialize and reconcile 1h/4h raw/canonical pages and hashes.
4. Re-audit candle closeTime/volume handling, 5m replay, BTC reference-only defaults and purge/embargo wiring.
5. Calibrate fee tier, spread, slippage, impact, latency and funding cashflows.
6. Run deterministic fixture smoke tests twice; only then freeze one strategy x context x symbol experiment with chronological train/validation/untouched OOS, purge/embargo, block bootstrap and multiple-testing correction.

**Final classification: RESEARCH_BLOCKED.** Monitoring and archive ingestion completed. No strategy experiment or untouched OOS evaluation ran. No OOS_VALIDATED strategy exists; SOLUSDT, ETHUSDT and XRPUSDT remain **NO_TRADE**.
