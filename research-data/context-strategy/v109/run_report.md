# Binance USDⓈ-M Context Strategy Research — v109

**Snapshot time:** 2026-11-13 18:39:10 UTC (2026-11-14 00:09:10 IST)  
**Run status:** `RESEARCH_EXECUTED` — archive-integrity experiment only.  
**Strategy backtest:** `BLOCKED` · **Untouched OOS:** not evaluated.  
**Trading decision:** `NO_TRADE` — SOLUSDT, ETHUSDT, XRPUSDT.

## 1. Research progress

### Completed

- Ran `EXP-DQ-20261113T183708Z-012`: incremental 5m/15m archive integrity.
- Appended **32 completed bars** from the active highwaters: 5m **24**, 15m **8**, 1h **0**, 4h **0**. Eight forming bars were excluded.
- Checks on the 32 appended rows: duplicates **0**, missing intervals **0**, off-grid **0**, non-monotonic **0**, OHLC failures **0**, non-finite **0**, non-positive volume **0**, close-time failures **0**, cross-symbol alignment **PASS**.
- Advanced all four archive indexes. Readback verified the delta, delta manifest, market snapshot, archive manifest, superseded manifest, index receipt and all four indexes.
- Corrected stale-highwater contamination: the 6,836-row main delta plus 4-row repair (6,840 rows total) were marked `SUPERSEDED_UNINDEXED_STALE_BASELINE`. They are retained for audit but excluded from canonical indexes. The canonical 32-row delta was fetched from active v108 highwaters.
- Persisted the versioned registry, research queue, preflight and run report to the GitHub research branch. The Library upload attempt failed with `library_storage_limit_exceeded`; GitHub is the durable source of truth for v109.

### Not completed

- No strategy experiment/backtest ran. Remote scripts exist, but the repository is not checked out in this runtime and Node/npm are below the project engine requirement.
- No strategy metrics, confidence intervals or OOS promotion were produced in this run.
- No new context thresholds or frequency/duration model was fitted.

### Current canonical highwaters

| Interval | Latest completed open (UTC) | Next open to fetch (UTC) | Appended this run |
|---|---|---|---:|
| 5m | 2026-11-13 18:30 | 18:35 | 24 |
| 15m | 2026-11-13 18:15 | 18:30 | 8 |
| 1h | 2026-11-13 17:00 | 18:00 | 0 (18:00 forming) |
| 4h | 2026-11-13 12:00 | 16:00 | 0 (16:00 forming) |

## 2. Context discovery

No new training-derived taxonomy was fitted. The inherited **v56 4h taxonomy** uses trend strength `(EMA20−EMA50)/Wilder ATR14`, with training-only q67 of absolute trend strength for BULL/BEAR versus TRANSITION and training-only q33/q67 of ATR14/close for LOW/NORMAL/HIGH. Its parent walk-forward split was **70% train / 15% validation / 15% untouched test**, with a **500-bar warmup**. These thresholds were not re-estimated in v109.

Inherited v56 per-symbol test observations and selected low-vol context occupancy:

| Symbol | Test observations | BEAR_LOW | TRANSITION_LOW | BULL_LOW | Validation/test TVD | Median transition duration |
|---|---:|---:|---:|---:|---:|---:|
| BTCUSDT | 2,345 | 6.53% | 50.66% | 9.85% | 0.175 | 38h |
| ETHUSDT | 2,273 | 6.42% | 46.24% | 6.64% | 0.338 | 42h |
| SOLUSDT | 2,010 | 10.90% | 67.56% | 10.70% | 0.245 | 120h |
| XRPUSDT | 2,237 | 15.20% | 43.63% | 3.22% | 0.293 | 68h |

ETH/XRP showed material validation/test context drift. The selected percentages above are not the complete nine-state distribution.

A separate earlier **v37 4h taxonomy** test had 10,760 observations: BEAR_LOW 33.07%, BULL_LOW 27.96%, BEAR_NORMAL 12.58%, TRANSITION_LOW 10.54%, BULL_NORMAL 6.38%, BEAR_HIGH 5.06%, TRANSITION_NORMAL 3.32%, BULL_HIGH 0.87%, TRANSITION_HIGH 0.23%. Median run lengths ranged from 2 transition bars to 11.5 BEAR_HIGH bars. Trend transitions were BEAR→BEAR 94.22% / TRANSITION 5.52% / BULL 0.26%; BULL→BULL 92.16% / TRANSITION 7.66% / BEAR 0.18%; TRANSITION→TRANSITION 60.95% / BEAR 20.58% / BULL 18.47%. This is a different inherited taxonomy version, not a v56 re-estimate.

Current descriptive sample: 120 returned klines per symbol/interval, **119 completed + 1 forming excluded**. First completed opens: 5m 2026-11-13 08:40Z; 15m 2026-11-12 12:45Z; 1h 2026-11-08 19:00Z; 4h 2026-10-24 20:00Z. All four symbols are bearish on 15m, 1h and 4h. On 5m, BTC/SOL are bearish, ETH mixed and XRP bullish.

Feature-classification confidence is **moderate** for higher-timeframe bearish alignment (EMA20 below EMA50 with negative 5-bar slopes on 1h/4h), but **low** for transition structure: the current local window is short and no training-fitted shock/transition model was run. This is not a trade-win probability. Current frequency, duration and transition matrices were not recomputed.

## 3. Strategy-context scorecard

| Strategy/context | Symbol | Evidence status | Evidence | Current applicability |
|---|---|---|---|---|
| Donchian20 breakout, BULL_LOW, 4h | SOLUSDT | `OOS_PROMISING` | 12 OOS trades; 66.7% wins; 41.7% target-before-stop; mean +0.606R; PF 2.72; max DD 1.3R; **95% block-bootstrap CI [0.086, 1.199]R**; last evaluation 2026-11-05 09:43:57Z | Not applicable: current 1h/4h context is bearish/high-vol; 12 trades < 100-trade gate |
| Donchian20 context-aligned walk-forward v2 | 4 symbols / 36 cells | `INSUFFICIENT_EVIDENCE` | All 36 cells below 100 OOS trades; parent registry reports Holm-adjusted p=1.0 and uncalibrated 15bp cost proxy | Not actionable |
| Trend/pullback continuation | SOL/ETH/XRP | `HYPOTHESIS` | Not tested in v109 | Not actionable |
| Breakout/retest/volatility contraction | SOL/ETH/XRP | `HYPOTHESIS` | Not tested in v109 | Not actionable |
| Range mean reversion/failed-breakout fade | SOL/ETH/XRP | `HYPOTHESIS` | Not tested in v109 | Not actionable |
| Volatility expansion/momentum | SOL/ETH/XRP | `HYPOTHESIS` | Not tested in v109 | Not actionable |
| BTC-led confirmation/relative strength | SOL/ETH/XRP | `HYPOTHESIS` | Not tested in v109 | Not actionable |
| Funding/OI filters | SOL/ETH/XRP | `HYPOTHESIS` | Historical derivatives archive incomplete/unverified | Not actionable |

There are **zero OOS_VALIDATED registry entries**. The SOL candidate remains OOS_PROMISING only; it was not promoted, downgraded or rejected this run. Parent aggregate Donchian20 figures are exploratory and are not asserted to be untouched OOS.

## 4. Key discoveries

- Higher timeframes are broadly bearish with elevated 1h/4h ATR percentiles; 5m is a countertrend bounce/mixed state, not a reversal trigger.
- 24h changes: BTC **-4.294%**, ETH **-4.037%**, SOL **-2.166%**, XRP **-0.708%**. Relative strength versus BTC: ETH **+0.257pp**, SOL **+2.128pp**, XRP **+3.586pp**.
- BTC return correlations over 118 observations (1h/4h): ETH **0.894/0.913**, SOL **0.872/0.889**, XRP **0.736/0.803**. Shared market exposure is evident; predictive BTC leadership is not proven.
- OI change 17:00→18:00Z: BTC **-0.327%**, ETH **-0.210%**, SOL **-0.207%**, XRP **+0.433%**. Last completed 17:00Z taker buy/sell ratios: **1.243 / 1.177 / 1.146 / 1.088**. Global long/short account ratios: **3.07–3.66**. These are account-count ratios, not top-trader positions; no liquidation/crowding inference is made.
- No context is declared intrinsically untradeable. The current bearish/high-vol context has **no demonstrated robust OOS edge**.

## 5. Current market snapshot

**Market fields as of 2026-11-13 18:39:10Z; context features as of 18:37:48Z.**

| Symbol | Mark / last | 24h change | 24h high / low | 24h quote volume | 5m / 15m / 1h / 4h | ATR14 pctile 1h / 4h | OI change 17→18Z |
|---|---:|---:|---:|---:|---|---:|---:|
| BTCUSDT (reference) | 68,856.20 / 68,847.00 | -4.294% | 71,966 / 67,449 | 19.23B USDT | B / B / B / B | 88.6 / 87.6 | -0.327% |
| ETHUSDT | 1,940.18 / 1,940.18 | -4.037% | 2,023.21 / 1,893.39 | 10.96B USDT | M / B / B / B | 71.4 / 80.0 | -0.210% |
| SOLUSDT | 79.9484 / 79.94 | -2.166% | 82.38 / 77.85 | 1.82B USDT | B / B / B / B | 79.0 / 68.6 | -0.207% |
| XRPUSDT | 1.024634 / 1.0244 | -0.708% | 1.0438 / 0.9963 | 0.806B USDT | U / B / B / B | 67.6 / 67.6 | +0.433% |

B=bearish, M=mixed, U=bullish. Funding interval is **8h** for all symbols; next funding **2026-11-14 00:00Z**; last settlement **16:00Z**. Indicated/last-settled funding: BTC **0.009171% / 0.004045%**, ETH **0.005262% / 0.004743%**, SOL **0.010000% / 0.007203%**, XRP **0.010000% / 0.010000%**. None exceeds |0.05%|.

Top-of-book spread: BTC **0.015 bps**, ETH **0.051 bps**, SOL **1.249 bps**, XRP **0.977 bps**. Top-five quantity imbalance: BTC **-0.590**, ETH **+0.222**, SOL **-0.051**, XRP **-0.048**. This is one depth snapshot; RPI orders are excluded and imbalance is not a stable signal.

## 6. SOL / ETH / XRP decisions

| Symbol | OOS_VALIDATED rule | Trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | No validated rule exists | **NO_TRADE** | No OOS_VALIDATED entry; current higher timeframe bearish/high-vol; 5m is not a proven entry trigger; metadata stale |
| ETHUSDT | None | No validated rule exists | **NO_TRADE** | No OOS_VALIDATED entry; 15m/1h/4h bearish; no exact validated trigger |
| XRPUSDT | None | No validated rule exists | **NO_TRADE** | 5m bullish but 15m/1h/4h bearish; no exact validated trigger |

No entry, stop, target or size is emitted. BTCUSDT is reference-only.

## 7. Data-quality audit, costs, unavailable inputs and next experiments

### Historical archive coverage

| Interval | Base archive | Date range | Status / gap |
|---|---|---|---|
| 5m | 156,000 rows (39,000/symbol); 26 page manifests / 104 page files | 2020-01-01 00:00Z → 2021-01-27 16:55Z | PARTIAL; multi-year gap |
| 15m | 156,000 rows (39,000/symbol); 26 page manifests / 104 page files | 2020-01-01 00:00Z → 2021-10-25 12:45Z | PARTIAL; multi-year gap |
| 1h | 215,492 rows (53,873/symbol); 36 page manifests / 144 page files | 2020-09-14 08:00Z → 2026-11-11 05:00Z | 28 missing opens/symbol; 8-row discrepancy |
| 4h | 53,960 raw / 53,816 aligned / 53,844 canonical; canonical 13,461/symbol | 2020-09-14 08:00Z → 2026-11-05 16:00Z | Canonical series PASS (zero gaps/duplicates, readback verified); raw page provenance DEGRADED |

### File layout, schema and checksums

- Base page files are raw Binance kline-array JSONL. The current incremental delta is normalized JSONL objects with fields `symbol`, `interval`, `openTime` (epoch ms), string OHLCV, `closeTime`, `quoteVolume`, `trades`, `takerBuyBaseVolume`, `takerBuyQuoteVolume`.
- Representative 5m base file: `research-data/binance-usdm/5m/BTCUSDT/page-0001.jsonl`, 1,500 rows, 193,035 bytes, 2020-01-01 00:00Z→2020-01-06 04:55Z, SHA-256 `b0000460febf5ae8ce7ff28154a87041fed061082fb40a39aded88194134697d`, Git blob `373ede431f422ee6656def813b031220f1c0c237`, readback exact.
- Representative 15m base file: `research-data/binance-usdm/15m/BTCUSDT/page-0001.jsonl`, 1,500 rows, 198,580 bytes, 2020-01-01 00:00Z→2020-01-16 14:45Z, SHA-256 `4469592269a0b28e5e47e3a4d0460624ec60a75dde90e5e68c99363d14511993`, Git blob `e5072b0301fd89ce1a39a33af226655828cba748`, readback exact.
- Representative 1h base file: `research-data/binance-usdm/1h/BTCUSDT/page-0001.jsonl`, 1,500 rows, 2020-09-14 08:00Z→2020-11-15 19:00Z, SHA-256 `9a11769e0c1e473dc0293286fa468bdeba6b9d8a4b1ade224d14dd0e3f002921`, Git blob `79af4d04b95870fc1535ab13e60aeee517d2d6b3`, readback exact.
- Representative 4h canonical file: `research-data/binance-usdm/4h/canonical/BTCUSDT_4h_20200914T0800Z_20261105T1600Z.jsonl`, 13,461 rows, 1,971,801 bytes, SHA-256 `7088aa2b2cc48c3895fd77dfc2ece0ae812062f24a70374ec556273a2d8380d7`, Git blob `a465025b2276a0e9cfbf805ba64be4da6ed08868`, readback verified. All four canonical 4h files report zero gaps and duplicates.
- Raw 4h page provenance remains DEGRADED: 13 page-manifest SHA mismatch observations remain recorded; page 9 was re-read and all four symbol files matched their JSONL hashes. One malformed XRP original row remains immutable with a separate correction artifact.
- Current canonical delta: `research-data/binance-usdm/delta/binance_usdm_delta_20261113T183708Z_5m15m_completed.jsonl`, **32 rows / 9,323 bytes**, SHA-256 `60186d63f7536bbe656f690e8cfb077e77e2f3517a2ec28351f4f4faa587ed65`, Git blob `87f4a9724030cde3ded9eb49c11024f5df9d100f`, readback verified. Manifest `...completed.manifest.json`: **5,750 bytes**, SHA-256 `cae9bdf3e952398bfe1fdfe42b6a8f921346e490de7dc1c1234f532b6a0437ad`, readback verified.
- Snapshot: `research-data/binance-usdm/snapshots/current_market_snapshot_20261113T1839Z_auto11_v109.json`, **8,252 bytes**, SHA-256 `c3b414916fab9cf96fae2ab0a9123e943a4070e9b98bdf2450edd2e9394d8526`, readback verified.
- Archive manifest: `research-data/binance-usdm/manifests/archive_manifest_20261113T1840Z_auto11_v109.json`, **7,984 bytes**, SHA-256 `478919cd0fd1eaa839ef9e0112b151b90c54090c30a63e60544ab2413f381467`, readback verified.
- Superseded-delta manifest: `research-data/binance-usdm/manifests/delta_manifest_20261113T1840Z_auto11_v109.json`, **4,110 bytes**, SHA-256 `4d42590e74d0870a46dd5a9378789de135058785e1bd066f42e36ee41bb643c5`, readback verified.
- Index receipt: `research-data/binance-usdm/manifests/index_update_receipt_20261113T1840Z_auto11_v109.json`, **2,469 bytes**, SHA-256 `efb4cac331d7ab1f2785fefe12ff3e5df1e97251b17e5035e04cafd236b3b239`, readback verified. It records each index commit, blob SHA-1, byte size and SHA-256.
- Four index files were re-read after pointer updates: 5m 544,200 bytes; 15m 496,616; 1h 373,191; 4h 277,063. Exact commit/blob/SHA values are in the index receipt.
- Superseded unindexed files: `...182602Z_5m15m1h4h_completed.jsonl` (6,836 rows, 1,999,602 bytes, SHA-256 `ef0338483f55bc56152c35e4743d80925895cdb37de4e3998e390b0ff14c65a1`) and `...182933Z_4h_gap_repair_completed.jsonl` (4 rows, 1,204 bytes, SHA-256 `dfb4e64fa65e075f0d49cef0473407302f3ac0c2ebbb18ccfc0b68319f262323`). Both are explicitly excluded from canonical indexes. Superseded rows total 6,912 including earlier excluded rows.
- Aggregate byte totals for all historical base page files were **not recomputed** this run; the representative page files above were read back, and page manifests/indexes were inspected. Do not infer full-base byte totals from these samples.

### Derivatives archive

Only SOLUSDT historical funding is indexed: `research-data/binance-usdm/derivatives/funding/SOLUSDT_funding_20200914T0800Z_20261105T1600Z.jsonl`, 6,806 rows, 802,973 bytes. Manifest-expected SHA-256 `34bfd47393c7e9756e617a70669d8ee51349f6a3ba2b4931ae719993c6064549` differs from exact readback SHA-256 `6440cb653acb4e5b363523a7c65dc5c4b9ccfe8267605cf0814881a9d8b4f60f`; 3,501 rows have blank mark price. Readback is **not verified**. No historical funding archives for BTC/ETH/XRP and no historical OI archive are indexed. Historical funding/OI filters remain HYPOTHESIS.

### Endpoints, costs and unavailable inputs

Connector-backed requests used: `/fapi/v1/klines` (5m/15m/1h/4h, four symbols), `/fapi/v1/premiumIndex`, `/fapi/v1/ticker/24hr`, `/fapi/v1/openInterest`, `/fapi/v1/depth`, `/fapi/v1/fundingRate`, `/fapi/v1/fundingInfo`, and futures-data OI/taker/global-LS endpoints. Connector calls do not expose HTTP status/headers. Direct shell DNS to `/fapi/v1/time` failed and `/fapi/v1/exchangeInfo` timed out. Connector exchangeInfo serverTime was **2026-11-13 06:02:01.705Z**, 755.8 minutes stale at the snapshot; observed TRADING statuses are not accepted as current execution validation.

Unavailable/not retrieved: historical top-trader positioning, liquidation feed, durable order-book depth history, basis history, historical OI, BTC/ETH/XRP funding history, calibrated market impact, account-specific fee tier and validated latency/fill model. No liquidation or crowding inference is made from candles/OI alone.

No backtest cost model ran. The parent 15bp round-trip proxy is uncalibrated. Remote `backtest.ts` uses a fixed 0.0001 funding rate when `--funding` is enabled, not historical symbol-specific funding; it must be replaced before OOS claims.

### Next research actions

1. Backfill 5m/15m gaps with a resumable bulk downloader or historical export.
2. Reconcile 1h missing opens and row-count discrepancy.
3. Reconcile raw 4h page-manifest hashes while preserving the canonical 4h series and XRP correction artifact.
4. Re-read and reconcile the SOL funding archive; extend funding/OI history for all four symbols.
5. Restore local repository checkout and Node24/npm11; verify SDK imports.
6. Run deterministic fixture smoke test and no-lookahead checks.
7. Calibrate fees, spread, depth, slippage, funding and fills.
8. Only then freeze a strategy×context×symbol experiment, tune on validation and run untouched OOS with block-bootstrap uncertainty and Holm correction.

Weekly taxonomy review is next due **2026-11-16**; the last accessible review was 2026-11-09.

## 8. Mandatory preflight

| Capability/check | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell / compute | PASS | `pwd=/`; Debian 13; Python 3.13.5; Node 22.16.0; npm 10.9.2; 3 CPUs; 5.8 GiB RAM; 30 GiB free | Python data-quality work possible; provision Node24/npm11 for project scripts |
| Repo / code | DEGRADED | Remote repo exists; package.json requires Node≥24/npm≥11 and declares research/backtest scripts; local checkout absent | Remote code inspected but not invokable; mount/clone locally |
| Binance SDK | BLOCKED | Local SDK modules not installed | No SDK used; install after runtime restoration |
| Network / Binance | DEGRADED | Connector data calls succeeded; direct DNS failed; exchangeInfo timestamp 12h35 stale | Current snapshot available; current contract validation blocked; restore DNS and probe server time |
| Raw historical archive | PASS | Canonical delta/manifests/snapshot/four indexes/receipt persisted and read back | Incremental archive advanced; continue from highwaters |
| Data quality / coverage | DEGRADED | Current 32 rows pass; 5m/15m gaps; 1h missing opens; 4h raw page provenance degraded; SOL funding hash mismatch | No strategy inference until archive/derivatives repair |
| Backtest harness / smoke | BLOCKED | Remote scripts exist; no local checkout or fixture invocation | No backtest/OOS; restore repo/runtime and smoke-test |
| Disk / storage | DEGRADED | 30 GiB free; GitHub branch writable; Library upload failed with `library_storage_limit_exceeded` | GitHub branch is durable source of truth; Library copy unavailable |
| Artifact readback | PASS | GitHub data, manifests, snapshot, indexes, registry, queue, preflight and report read back | Persistence verified on GitHub; no Library upload succeeded |

**Execution label:** `RESEARCH_EXECUTED` (archive-integrity experiment only). `OOS_EVALUATED`: **NO**. Strategy backtest: **BLOCKED**. Current market snapshot is not historical performance evidence.
