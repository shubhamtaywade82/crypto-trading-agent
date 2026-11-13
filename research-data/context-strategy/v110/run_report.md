# Binance USDⓈ-M Context Strategy Research — v110

**Snapshot:** 2026-11-13 19:19:45Z (2026-11-14 00:49:45 IST); current clock check 2026-11-14 00:54:17 IST.  
**Run status:** `RESEARCH_EXECUTED` — incremental archive/data-quality experiment only.  
**Strategy backtest:** `BLOCKED` · **Untouched OOS:** not evaluated.  
**Decision:** `NO_TRADE` for SOLUSDT, ETHUSDT and XRPUSDT.

## 1. Research progress

- Appended **48 completed klines** from active highwaters: 5m **32**, 15m **12**, 1h **4**, 4h **0**. Per symbol: 8×5m, 3×15m, 1×1h, 0×4h. Forming candles excluded.
- All 16 symbol/interval samples returned 120 bars; 119 completed and one forming excluded. Sample checks: duplicates 0, missing intervals 0, off-grid 0, non-monotonic 0, OHLC failures 0, non-finite 0, non-positive volume 0, close-time failures 0; cross-symbol alignment PASS.
- Persisted and read back the 48-row delta, delta manifest, current market snapshot, archive manifest, four interval indexes and index-update receipt.
- No strategy experiment ran. Remote scripts are not executable in this runtime: no local checkout, Node 22.16/npm 10.9.2 versus project requirement Node≥24/npm≥11. No deterministic smoke test, backtest or OOS evaluation.
- Daily research work executed as a data-quality/archive append. Strategy research remains blocked by archive gaps, derivative-data integrity and runtime/harness prerequisites.

### Canonical highwaters after this run

| Interval | Latest completed open UTC | Next open UTC | Rows appended |
|---|---|---|---:|
| 5m | 2026-11-13 19:10 | 19:15 | 32 |
| 15m | 2026-11-13 19:00 | 19:15 | 12 |
| 1h | 2026-11-13 18:00 | 19:00 | 4 |
| 4h | 2026-11-13 12:00 | 16:00 | 0 |

## 2. Context discovery

No new training-derived taxonomy was fitted. Inherited v56 4h taxonomy uses `(EMA20−EMA50)/Wilder ATR14`, training-only q67 of absolute trend strength for BULL/BEAR versus TRANSITION, and training-only q33/q67 of ATR14/close for LOW/NORMAL/HIGH. Parent split: 70% train / 15% validation / 15% untouched test, 500-bar warmup. No threshold was refit in v110.

Inherited v56 per-symbol test occupancy (selected low-vol states only):

| Symbol | Test observations | BEAR_LOW | TRANSITION_LOW | BULL_LOW | Validation/test TVD | Median transition |
|---|---:|---:|---:|---:|---:|---:|
| BTC | 2,345 | 6.53% | 50.66% | 9.85% | 0.175 | 38h |
| ETH | 2,273 | 6.42% | 46.24% | 6.64% | 0.338 | 42h |
| SOL | 2,010 | 10.90% | 67.56% | 10.70% | 0.245 | 120h |
| XRP | 2,237 | 15.20% | 43.63% | 3.22% | 0.293 | 68h |

ETH/XRP had material validation/test context drift. A separate older v37 taxonomy had 10,760 4h test observations: BEAR_LOW 33.07%, BULL_LOW 27.96%, BEAR_NORMAL 12.58%, TRANSITION_LOW 10.54%, BULL_NORMAL 6.38%, BEAR_HIGH 5.06%, TRANSITION_NORMAL 3.32%, BULL_HIGH 0.87%, TRANSITION_HIGH 0.23%. Median runs ranged from 2 transition bars to 11.5 BEAR_HIGH bars. Trend persistence was BEAR→BEAR 94.22%, BULL→BULL 92.16%, TRANSITION→TRANSITION 60.95%. This is a different inherited taxonomy version, not a v56 re-estimate.

Kline sample windows (120 returned / 119 completed / 1 forming excluded per symbol/interval): first completed opens 5m 09:20Z, 15m 13:30Z on Nov12, 1h 20:00Z on Nov8, 4h 20:00Z on Oct24; latest completed opens 5m 19:10Z, 15m 19:00Z, 1h 18:00Z, 4h 12:00Z. Current 119-bar descriptors: all four symbols are bearish on 1h/4h; all are mixed on 15m; 5m is bullish for BTC/ETH/XRP and mixed for SOL. 4h ATR14/close percentile within this short sample is 95–100. Feature confidence is moderate for higher-timeframe bearish alignment, low for transition structure. These percentiles are local-sample descriptors, not trained regime thresholds or win probabilities. Shock detector is not calibrated.

## 3. Strategy-context scorecard

| Strategy/context | Symbol | Evidence status | Prior evidence | Current applicability |
|---|---|---|---|---|
| Donchian20 breakout / BULL_LOW / 4h | SOL | `OOS_PROMISING` | 12 OOS trades; 66.7% wins; 41.7% target-before-stop; +0.606R mean; PF 2.72; max DD 1.3R; 95% block-bootstrap CI [0.086, 1.199]R; last evaluation 2026-11-05 09:43:57Z | Not applicable: current 1h/4h bearish; only 12 trades |
| Donchian20 context-aligned WF v2 | All symbols / 36 cells | `INSUFFICIENT_EVIDENCE` | All 36 cells below 100 OOS trades; Holm-adjusted p=1.0; 15bp cost proxy uncalibrated | Not actionable |
| Trend/pullback continuation | SOL/ETH/XRP | `HYPOTHESIS` | Not tested | Not actionable |
| Breakout/retest/contraction | SOL/ETH/XRP | `HYPOTHESIS` | Not tested | Not actionable |
| Range mean reversion/failed breakout | SOL/ETH/XRP | `HYPOTHESIS` | Not tested | Not actionable |
| Volatility expansion/momentum | SOL/ETH/XRP | `HYPOTHESIS` | Not tested | Not actionable |
| BTC-led confirmation/relative strength | SOL/ETH/XRP | `HYPOTHESIS` | Not tested | Not actionable |
| Funding/OI filters | SOL/ETH/XRP | `HYPOTHESIS` | Derivative history incomplete/unverified | Not actionable |

**OOS_VALIDATED entries: zero.** The promising SOL candidate was not promoted or re-evaluated in v110.

## 4. Key discoveries

- Higher timeframes remain bearish; 5m has a countertrend bounce, while 15m is mixed. This is not a reversal signal.
- 24h relative strength versus BTC: ETH **+0.442pp**, SOL **+2.010pp**, XRP **+3.367pp**. This is descriptive relative performance, not predictive leadership.
- Rolling BTC return correlations: ETH **0.894 / 0.913**, SOL **0.872 / 0.889**, XRP **0.737 / 0.803** (1h / 4h). Shared market exposure is high; lead/lag is unproven.
- Completed 17:00→18:00Z OI changes: BTC **-0.327%**, ETH **-0.210%**, SOL **-0.207%**, XRP **+0.433%**. These do not establish crowding or liquidation.
- 18:00Z taker buy/sell ratios: BTC **1.176**, ETH **1.074**, SOL **1.156**, XRP **1.073**. Global long/short account ratios: BTC **3.114**, ETH **3.735**, SOL **3.444**, XRP **3.019**. Account ratios are not top-trader positioning.
- No context is declared intrinsically untradeable; the current bearish/high-vol context has no demonstrated robust OOS edge.

## 5. Current market snapshot

Data timestamp: **2026-11-13 19:19:45Z**. Transition warning: all four symbols show short-term/higher-timeframe divergence (5m bullish for BTC/ETH/XRP and mixed for SOL; 15m mixed; 1h/4h bearish). Feature confidence is moderate for higher-timeframe direction and low for transition/shock classification. Mark data 19:14:58–19:15:00Z; 24h ticker close 19:14:42Z; order book 19:18:55Z; OI snapshot 19:14:53Z. Last completed derivative aggregates (basis/taker/global-LS) 18:00Z.

| Symbol | Mark / last | 24h change | 24h high / low | 24h quote vol | 5m / 15m / 1h / 4h | ATR14 percentile 1h / 4h | OI 17→18Z |
|---|---:|---:|---:|---:|---|---:|---:|
| BTC (reference) | 68,977.69 / 68,980.10 | -3.679% | 71,735.60 / 67,449.00 | 19.077B | U / M / B / B | 78.3 / 100.0 | -0.327% |
| ETH | 1,947.89 / 1,947.60 | -3.237% | 2,022.50 / 1,893.39 | 10.980B | U / M / B / B | 69.8 / 100.0 | -0.210% |
| SOL | 80.15 / 80.13 | -1.669% | 82.38 / 77.85 | 1.805B | M / M / B / B | 72.6 / 95.3 | -0.207% |
| XRP | 1.0241 / 1.0239 | -0.312% | 1.0438 / 0.9963 | 0.803B | U / M / B / B | 63.2 / 98.1 | +0.433% |

Funding interval is **8h** for all four; next funding **2026-11-14 00:00Z**; last settlement **16:00Z**. Indicated / last settled funding: BTC **0.009207% / 0.004045%**, ETH **0.004628% / 0.004743%**, SOL **0.010000% / 0.007203%**, XRP **0.009396% / 0.010000%**. None exceeds |0.05%|.

18:00Z basis rates: BTC **-0.03%**, ETH **-0.06%**, SOL **-0.05%**, XRP **-0.05%**. Top-of-book spreads / top-five quantity imbalance: BTC **0.0145 bps / +0.385**, ETH **0.0513 bps / -0.417**, SOL **1.247 bps / +0.057**, XRP **0.975 bps / -0.201**. Single depth snapshot only; no persistent liquidity inference.

## 6. SOL / ETH / XRP decisions

| Symbol | OOS_VALIDATED rule | Trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | None | **NO_TRADE** | No validated rule; 1h/4h bearish; short-term state mixed; metadata stale |
| ETHUSDT | None | None | **NO_TRADE** | No validated rule; 1h/4h bearish; 5m bounce not a validated trigger |
| XRPUSDT | None | None | **NO_TRADE** | No validated rule; 1h/4h bearish despite 5m bounce |

No entry, stop, target or size emitted. BTCUSDT remains reference-only.

## 7. Data-quality audit, costs and next experiments

### Historical coverage

| Interval | Base rows | Date range UTC | Assessment |
|---|---:|---|---|
| 5m | 156,000 (39,000/symbol), 26 page manifests / 104 files | 2020-01-01 00:00 → 2021-01-27 16:55 | PARTIAL; multi-year gap |
| 15m | 156,000 (39,000/symbol), 26 page manifests / 104 files | 2020-01-01 00:00 → 2021-10-25 12:45 | PARTIAL; multi-year gap |
| 1h | 215,492 (53,873/symbol), 36 page manifests / 144 files | 2020-09-14 08:00 → 2026-11-11 05:00 | 28 missing opens/symbol; 8-row discrepancy |
| 4h | 53,960 raw / 53,816 aligned / 53,844 canonical (13,461/symbol) | 2020-09-14 08:00 → 2026-11-05 16:00 | Canonical series PASS; raw page provenance DEGRADED |

Base page files are raw Binance kline-array JSONL. Incremental delta JSONL schema: `symbol`, `interval`, `openTime` (epoch ms), `open`, `high`, `low`, `close`, `volume`, `closeTime`, `quoteVolume`, `trades`, `takerBuyBaseVolume`, `takerBuyQuoteVolume`. Representative verified examples:
- 5m BTC page 1: `research-data/binance-usdm/5m/BTCUSDT/page-0001.jsonl`, 1,500 rows, 193,035 bytes, 2020-01-01 00:00→2020-01-06 04:55Z, SHA-256 `b0000460febf5ae8ce7ff28154a87041fed061082fb40a39aded88194134697d`, Git blob `373ede431f422ee6656def813b031220f1c0c237`, readback exact.
- 15m BTC page 1: `research-data/binance-usdm/15m/BTCUSDT/page-0001.jsonl`, 1,500 rows, 198,580 bytes, 2020-01-01 00:00→2020-01-16 14:45Z, SHA-256 `4469592269a0b28e5e47e3a4d0460624ec60a75dde90e5e68c99363d14511993`, Git blob `e5072b0301fd89ce1a39a33af226655828cba748`, readback exact.
- 1h BTC page 1: `research-data/binance-usdm/1h/BTCUSDT/page-0001.jsonl`, 1,500 rows, 211,718 bytes, 2020-09-14 08:00→2020-11-15 19:00Z, SHA-256 `9a11769e0c1e473dc0293286fa468bdeba6b9d8a4b1ade224d14dd0e3f002921`, Git blob `79af4d04b95870fc1535ab13e60aeee517d2d6b3`, readback exact.
- 4h BTC canonical: `research-data/binance-usdm/4h/canonical/BTCUSDT_4h_20200914T0800Z_20261105T1600Z.jsonl`, 13,461 rows, 1,971,801 bytes, SHA-256 `7088aa2b2cc48c3895fd77dfc2ece0ae812062f24a70374ec556273a2d8380d7`, Git blob `a465025b2276a0e9cfbf805ba64be4da6ed08868`, readback verified. All four canonical 4h files report zero gaps/duplicates. Raw 4h page provenance retains 13 SHA mismatch observations; page 9 re-read matched all four symbols. One malformed XRP original row is preserved with a separate correction artifact.

### v110 incremental artifacts

- Delta `research-data/binance-usdm/delta/binance_usdm_delta_20261113T1917Z_5m15m1h_completed.jsonl`: **48 rows / 14,003 bytes**, SHA-256 `c5109989f2e4285549b36af1e09f5148b3610ea7f9ae51c12672c1be7800b812`, Git blob `4d8679fc8bc4c3142955eb5dff5d677fe1f15be7`, readback verified.
- Delta manifest `...1917Z_5m15m1h_completed.manifest.json`: **6,265 bytes**, SHA-256 `dca0e0372acb942be04d671474dacf355338bd4e81ed80e76735c19a0738f32d`, readback verified.
- Snapshot `research-data/binance-usdm/snapshots/current_market_snapshot_20261113T1919Z_auto11_v110.json`: **10,263 bytes**, SHA-256 `85c4c0630aac7dbf8ef4ec7acd40b36667edb4168f037194f8698c26d45cd512`, Git blob `6e12f843dec1001c42aef5f3fdec1d6ea1b752ba`, readback verified.
- Archive manifest `research-data/binance-usdm/manifests/archive_manifest_20261113T1920Z_auto11_v110.json`: **12,382 bytes**, SHA-256 `38f06163435a27d2ef231929b51072adc416cbc10a85ca501b2bfc1478a8d9d8`, Git blob `49ed3f0ab08728530efa636081808d318923df4f`, readback verified.
- Index receipt `research-data/binance-usdm/manifests/index_update_receipt_20261113T1920Z_auto11_v110.json`: **3,829 bytes**, SHA-256 `fd0023ef3ce0823d8e599d0e26141ee49e2bd2f232956ab18b02ba8245929c9f`, Git blob `d3e3dc19baff117e11a3609997a788663ccf25e9`, readback verified.
- Index files read back: 5m **552,910 bytes** (commit `a49bbf0c28e959684bc85784432a2a44d9269b5a`); 15m **505,314** (commit `f12e76e4fb9516bce9ff55d855a498787cd0c49d`); 1h **368,918** (commit `42cb21c92fdf881c978cff911a56745cb8679eac`); 4h **272,693** (commit `1082bdbe99a93f4f630a37d7727a11aad82b90f0`). Exact blob SHA-1 and file SHA-256 are recorded in the receipt.

Superseded unindexed files from the previous run remain excluded: 6,836-row main delta (1,999,602 bytes) and 4-row repair (1,204 bytes). No new superseded rows were added in v110.

### Derivatives archive and execution costs

Only SOLUSDT historical funding is indexed: `research-data/binance-usdm/derivatives/funding/SOLUSDT_funding_20200914T0800Z_20261105T1600Z.jsonl`, 6,806 rows, 802,973 bytes. Expected SHA-256 `34bfd47393c7e9756e617a70669d8ee51349f6a3ba2b4931ae719993c6064549` differs from readback `6440cb653acb4e5b363523a7c65dc5c4b9ccfe8267605cf0814881a9d8b4f60f`; 3,501 rows have blank mark price. No BTC/ETH/XRP funding archive or historical OI archive. Funding/OI filters remain HYPOTHESIS.

No calibrated cost model ran. Parent 15bp round-trip proxy is uncalibrated; remote backtest uses a fixed 0.0001 funding rate if enabled, not historical symbol-specific funding. Historical top-trader positioning, liquidations, durable depth history, account-specific fees, market impact and latency/fill model are unavailable.

### Endpoints and freshness

Connector-backed endpoints: `/fapi/v1/klines`, `/fapi/v1/premiumIndex`, `/fapi/v1/ticker/24hr`, `/fapi/v1/openInterest`, `/futures/data/openInterestHist`, `/fapi/v1/depth`, `/futures/data/takerlongshortRatio`, `/futures/data/globalLongShortAccountRatio`, `/fapi/v1/fundingRate`, `/fapi/v1/fundingInfo`, `/futures/data/basis`. Connector calls do not expose HTTP status/headers. Direct curl probes with `--connect-timeout 3s` and `--max-time 7s` returned **HTTP 000 / DNS resolution failure** for all six probes: `/fapi/v1/time` (0.0015s), `/fapi/v1/exchangeInfo` (4.755s), `/fapi/v1/klines` (0.0003s), `/fapi/v1/premiumIndex` (4.755s), `/fapi/v1/openInterest` (0.0001s), `/fapi/v1/ticker/24hr` (4.755s). Connector exchangeInfo serverTime **06:02:01.705Z** was stale by **13h22m** at 19:24:17Z; contract status is not accepted for execution validation.

### Next research queue

1. Backfill 5m/15m multi-year gaps.
2. Reconcile 1h missing opens and row discrepancy.
3. Reconcile raw 4h page SHA provenance while preserving canonical series and XRP correction.
4. Re-read/repair SOL funding archive; backfill funding and OI history for BTC/ETH/SOL/XRP.
5. Restore local checkout and Node24/npm11; verify SDK imports.
6. Run deterministic fixture smoke test and no-lookahead checks.
7. Calibrate fees, spread, depth, slippage, funding and fills.
8. Freeze a strategy×context×symbol experiment only after prerequisites; tune on validation and evaluate untouched OOS once.
9. Weekly taxonomy/stability review due **2026-11-16**.

## 8. Mandatory preflight

| Capability | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell/compute | PASS | Debian 13; Python 3.13.5; Node 22.16.0; npm 10.9.2; 3 CPUs; 5.8 GiB RAM; 30 GiB free | Compute available; install Node24/npm11 |
| Repo/code | DEGRADED | Remote repo exists; local checkout absent; project requires Node≥24/npm≥11 | Scripts not invoked; restore checkout/runtime |
| Binance SDK | BLOCKED | SDK not installed/importable | Connector/REST only; install SDK after runtime restoration |
| Network/Binance | DEGRADED | Connector market calls succeeded; direct DNS failed; exchangeInfo stale | Current descriptive snapshot available; contract-status validation blocked |
| Raw archive | PASS | 48-row delta, manifest, snapshot, archive manifest, four indexes and receipt persisted/read back | Continue from latest highwaters |
| Data quality/coverage | DEGRADED | Current sample passes; base 5m/15m gaps, 1h missing opens, 4h raw provenance degraded, SOL funding hash mismatch | Historical strategy inference blocked pending repair |
| Backtest/smoke | BLOCKED | Remote scripts exist; no local checkout; no fixture smoke | No strategy backtest/OOS |
| Disk/storage | DEGRADED | 30 GiB free; GitHub branch writable; Library upload failed with `library_storage_limit_exceeded` | GitHub branch is durable source of truth |
| Artifact readback | PASS | Delta, manifests, snapshot, receipt, indexes and v110 context artifacts re-read | Persistence verified on GitHub |

**Execution label:** `RESEARCH_EXECUTED` (data-quality append only). `OOS_EVALUATED`: **NO**. Strategy backtest: **BLOCKED**.
