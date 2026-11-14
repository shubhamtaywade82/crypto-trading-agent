# Binance USDⓈ-M Context Strategy Research — v108

**As of:** 2026-11-13 11:26:21 UTC  
**Run classification:** RESEARCH_BLOCKED  
**Experiments:** 0  |  **Untouched OOS evaluations:** 0  |  **OOS_VALIDATED entries:** 0

## 1. Research progress

- Refreshed Binance USDⓈ-M market data for BTCUSDT (reference), ETHUSDT, SOLUSDT and XRPUSDT through the public market-data connector.
- Retrieved 120 bars per symbol/interval across 5m/15m/1h/4h: **1,920 rows**, of which **1,904 were completed** and **16 forming candles were excluded**.
- Appended **56 completed bars** to the remote raw archive: 5m 40, 15m 12, 1h 4, 4h 0. Delta files, manifests and the 5m/15m/1h indexes were read back and verified by Git blob SHA-1.
- The 1h archive now contains **215,504 rows (53,876 per symbol)** from 2020-09-14 08:00Z through 2026-11-13 10:00Z, approximately 6.14 years.
- No strategy experiment, smoke test or OOS evaluation ran. There is no local project checkout; Node/npm do not satisfy the repository engine requirement.

## 2. Context discovery

The descriptive state remains **higher-timeframe bearish with a lower-timeframe countertrend rebound**:

- All four symbols are BEAR on 1h and 4h.
- BTC, ETH and SOL are BULL on 5m; XRP is BEAR on 5m.
- All four are MIXED on 15m: EMA20 remains below EMA50 while its 10-bar slope is positive.

The current descriptive classifier uses EMA20/EMA50 alignment, EMA20 slope versus 10 bars earlier, and Wilder ATR14/close. It is not a fitted regime model. No training-only thresholds were re-estimated; historical context frequency, duration, transition probabilities and classification stability remain **NOT_MEASURED**. Structure states and BTC-alt lead/lag were not computed.

The 4h ATR14/close readings are 1.64%–2.37%, with 24h losses of 2.56%–5.42%. These are observed range measures, not fitted shock thresholds. No formal SHOCK label is assigned. Feature classification confidence is low-to-moderate and is not a probability of trade success.

## 3. Strategy-context scorecard

| Strategy × context × symbol | Evidence status | Evidence | Current applicability |
|---|---|---|---|
| Donchian20 4h breakout v2 — 36 SOL/ETH/XRP context cells | INSUFFICIENT_EVIDENCE | All cells below 100 OOS trades; nominal block-bootstrap intervals include zero; Holm-adjusted p=1.0; 15bp round-trip proxy uncalibrated | Not actionable |
| Donchian20 4h breakout v2 — SOLUSDT / BULL_LOW | OOS_PROMISING | 12 OOS trades; 66.7% win rate; 41.7% target-before-stop; mean net 0.606R; PF 2.72; max DD 1.3R; nominal block-bootstrap 95% CI [0.086, 1.199] | Research-only; sample and cost gates fail |
| Trend/pullback continuation | HYPOTHESIS | Not tested | None |
| Breakout/retest / volatility contraction | HYPOTHESIS | Not tested | None |
| Range mean reversion / failed-breakout fade | HYPOTHESIS | Not tested | None |
| Volatility expansion / momentum | HYPOTHESIS | Not tested | None |
| BTC-led confirmation / relative strength | HYPOTHESIS | Not tested | None |
| Funding/OI filters | HYPOTHESIS | Not tested | None |

These results are carried forward from the accessible v105/v106/v107 registry artifacts; they were not recomputed. Cell-level split boundaries and complete cell-level confidence intervals remain unavailable. No candidate was rejected or promoted this run. There are **zero OOS_VALIDATED entries**.

## 4. Key discoveries

- No robust OOS edge is demonstrated in the accessible registry.
- The only positive OOS point estimate remains SOLUSDT/BULL_LOW Donchian20, but 12 trades are far below the 100-trade per symbol/context provisional floor; the 15bp cost proxy and parameter-neighborhood robustness are incomplete.
- Current 1h/4h readings are uniformly bearish while 5m is bullish for BTC/ETH/SOL and 15m is mixed. This is transition risk, not an entry signal.
- Latest completed 15m taker buy/sell ratios at 11:00Z: BTC 0.6191, ETH 0.7786, SOL 1.1991, XRP 0.8501. OI change from 08:00Z to 10:00Z: BTC +0.749%, ETH +0.572%, SOL +0.007%, XRP +0.173%. These are descriptive observations only.
- Global long/short account ratios at 11:00Z: BTC 3.4603, ETH 3.7015, SOL 3.4189, XRP 2.9793. These do not establish leverage concentration or crowding.

## 5. Current market snapshot

**Market metrics:** 2026-11-13 11:20:57 UTC. **Technical features:** 11:23:56 UTC. **Quality checks:** 11:26:21 UTC.

| Symbol | Role | Mark / last | 24h change | 5m / 15m / 1h / 4h | Indicated funding / last settled | OI change 08→10Z | 15m taker B/S | Top spread |
|---|---|---:|---:|---|---:|---:|---:|---:|
| BTCUSDT | Reference | 69,357.07 / 69,355.50 | -5.422% | BULL / MIXED / BEAR / BEAR | +0.000111% / +0.001270% | +0.749% | 0.6191 | 0.0144 bp |
| ETHUSDT | Tradable | 1,954.06 / 1,954.15 | -4.286% | BULL / MIXED / BEAR / BEAR | +0.002341% / +0.000971% | +0.572% | 0.7786 | 0.0512 bp |
| SOLUSDT | Tradable | 80.5200 / 80.5200 | -2.742% | BULL / MIXED / BEAR / BEAR | -0.005939% / -0.005430% | +0.007% | 1.1991 | 1.2420 bp |
| XRPUSDT | Tradable | 1.0182 / 1.0182 | -2.555% | BEAR / MIXED / BEAR / BEAR | +0.004457% / +0.000653% | +0.173% | 0.8501 | 0.9822 bp |

The premium-index lastFundingRate is the current indicated field, not a guaranteed settlement outcome. Latest settled funding records are at 08:00Z; funding interval observed for all four symbols is 8 hours; next funding time is 16:00Z. No observed indicated or settled rate breaches |funding| > 0.05%.

Top-of-book spread is not market impact. Account ratios are not proof of crowding. No liquidation inference is made.

## 6. SOL / ETH / XRP decision matrix

| Symbol | OOS_VALIDATED strategy | Exact trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | Not evaluated against a validated rule | **NO_TRADE** | No OOS_VALIDATED entry; 5m rebound conflicts with bearish 1h/4h; spread is materially wider than BTC/ETH |
| ETHUSDT | None | Not evaluated against a validated rule | **NO_TRADE** | No OOS_VALIDATED entry; 1h/4h bearish; no validated trigger |
| XRPUSDT | None | Not evaluated against a validated rule | **NO_TRADE** | No OOS_VALIDATED entry; 15m mixed, 1h/4h bearish; no validated trigger |

No entry, stop, target or position size is supplied.

## 7. Data-quality audit, costs, unavailable inputs, risks and next experiments

### Archive and quality

- Current sample: 1,920 rows; 1,904 completed; 16 forming excluded. Across all 16 symbol/interval series: zero duplicates, non-monotonic bars, missing intervals, off-grid timestamps, close-time mismatches, OHLC invariant failures, nonpositive volumes or nonfinite values.
- 1h archive: 215,504 rows, 53,876 per symbol, 2020-09-14 08:00Z to 2026-11-13 10:00Z. Prior full index audit was clean; this run's four-row append and readback passed.
- 5m/15m: no base history; incremental-only. The 52-row append does not make these research-ready.
- 4h: 53,956 raw rows and 53,816 aligned analysis rows; canonical series ends 2026-11-05 16:00Z. Raw/canonical reconciliation and 13 original page-manifest hash mismatches remain unresolved. No new 4h candle was completed; the 08:00Z candle was still forming.

### Preflight

| Capability/check | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell/compute | DEGRADED | Linux 6.18.57; Python 3.13.5; Node 22.16.0; npm 10.9.2; 3 CPUs; 5.8 GiB RAM; 30 GB free | Compute exists but Node/npm are below project engines; provision Node 24+/npm 11+ |
| Repository/code | BLOCKED | No local checkout; remote package and scripts fetched through GitHub | Clone exact source branch locally |
| Binance SDK | BLOCKED | SDK packages not installed/importable | Connector used; no SDK execution |
| Network/Binance | DEGRADED | Direct DNS failed; connector data works but hides HTTP status; exchangeInfo serverTime stale by ~5h24m | Restore direct HTTPS and fresh clock/metadata |
| Raw archive | DEGRADED | 56 rows persisted/read back; 1h base exists; 5m/15m base absent; 4h degraded | Backfill 5m/15m and reconcile 4h |
| Data quality/coverage | DEGRADED | Current sample clean; historical coverage incomplete | Complete multi-timeframe archive and full alignment audit |
| Backtest harness/smoke test | BLOCKED | Remote scripts exist; no local invocation or deterministic fixture test | Fix runner and policy mismatches, then smoke-test |
| Disk/storage | PASS | 30 GB free; GitHub writes succeeded | Continue bounded writes |
| Artifact readback | PASS | Delta files, manifests and updated indexes reopened with Git blob SHA-1s | Read back v108 context artifacts |

### Source endpoints and limitations

Queried through the Binance public market-data connector: /fapi/v1/klines, /fapi/v1/premiumIndex, /fapi/v1/openInterest, /fapi/v1/ticker/24hr, /fapi/v1/fundingRate, /fapi/v1/ticker/bookTicker, /fapi/v1/fundingInfo, /futures/data/takerBuySellVol, /futures/data/openInterestHist and /futures/data/globalLongShortAccountRatio.

Direct shell probes of /fapi/v1/time, /fapi/v1/exchangeInfo, /fapi/v1/klines, /fapi/v1/premiumIndex, /fapi/v1/openInterest and /fapi/v1/ticker/24hr failed DNS (curl exit 6 / HTTP 000). Connector HTTP status and headers are not exposed. The connector exchangeInfo serverTime was 2026-11-13 06:02:01.706Z, stale by approximately 5h24m at this run; its cached TRADING/PERPETUAL status is not accepted as fresh contract validation.

No actual account fee tier, historical synchronized order-book depth/trades, size-dependent impact, latency or fill distribution was observed. The prior 15bp round-trip proxy remains uncalibrated. Only latest settled funding records were retrieved; historical funding cashflows are not archived. Basis, liquidation feed, reliable leverage/crowding measures, and BTC-alt rolling correlation/lead-lag remain unavailable.

### Next executable work

1. Provision Node >=24 and npm >=11; clone the exact research source branch and install the lockfile.
2. Run a deterministic tiny-fixture smoke test and explicit lookahead tests before a full experiment.
3. Harden the harness: SOL/ETH/XRP trade allowlist, BTC reference-only, 5m support, >=100 OOS trades per symbol/context, 95% uncertainty, purge/embargo and realistic costs.
4. Continue bounded 5m/15m historical backfill; materialize/audit 1h; reconcile 4h raw/canonical provenance.
5. Calibrate fees, spread, slippage, impact and funding costs from actual execution data.
6. Once prerequisites pass, pre-register one 1h trend/pullback or 4h Donchian experiment with chronological train/validation/untouched test, block bootstrap and multiple-testing correction.

**Final classification: RESEARCH_BLOCKED.** Monitoring and a verified 56-row archive append completed; no experiment or untouched OOS evaluation ran. SOLUSDT, ETHUSDT and XRPUSDT remain **NO_TRADE**.
