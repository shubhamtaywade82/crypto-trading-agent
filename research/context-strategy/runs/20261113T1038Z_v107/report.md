# Binance USDⓈ-M Context Strategy Research — v107

**As of:** 2026-11-13 10:38:24 UTC
**Run classification:** RESEARCH_BLOCKED
**Research experiments:** 0  |  **Untouched OOS evaluations:** 0  |  **OOS_VALIDATED entries:** 0

## 1. Research progress

- Refreshed Binance USDⓈ-M data for BTCUSDT (reference), ETHUSDT, SOLUSDT and XRPUSDT.
- Retrieved 120 bars per symbol/interval across 5m/15m/1h/4h: 1,920 rows total; 1,904 completed and 16 forming candles excluded.
- Appended 68 completed bars to the remote raw archive: 5m 48, 15m 16, 1h 4, 4h 0. Delta, manifest and updated 5m/15m/1h indexes were read back.
- The 1h archive now contains 215,500 rows (53,875 per symbol) from 2020-09-14 08:00Z through 2026-11-13 09:00Z.
- No strategy experiment or OOS evaluation ran. The local project checkout is absent and the runtime's Node/npm versions do not satisfy the repository engines.

## 2. Context discovery

The current descriptive state is **higher-timeframe bearish with a lower-timeframe countertrend rebound**. All four symbols are BEAR on 1h and 4h. On 5m/15m, readings are bullish or mixed.

The current classifier uses EMA20/EMA50 alignment plus EMA20 slope versus 10 bars earlier, with Wilder ATR14/close as a descriptive volatility measure. It is not a fitted regime model. No training-only thresholds were re-estimated; context frequency, duration, transition probabilities and stability are therefore **NOT_MEASURED**. Structure states (breakout, retest, failed breakout, range) and BTC-alt lead/lag were not computed.

Feature-classification confidence is low-to-moderate and is not a probability of trade success. The 24h drawdowns are material, but no trained shock threshold is available, so no formal SHOCK label is assigned.

## 3. Strategy-context scorecard

| Strategy × context × symbol | Evidence status | Evidence carried forward | Current applicability |
|---|---|---|---|
| Donchian20 4h breakout v2 — 36 SOL/ETH/XRP symbol-context cells | INSUFFICIENT_EVIDENCE | All cells below 100 OOS trades; nominal block-bootstrap intervals include zero; Holm-adjusted p=1.0; 15bp round-trip proxy uncalibrated | Not actionable |
| Donchian20 4h breakout v2 — SOLUSDT / BULL_LOW | OOS_PROMISING | 12 OOS trades; 66.7% win rate; 41.7% target-before-stop; mean net 0.606R; PF 2.72; max DD 1.3R; nominal block-bootstrap 95% CI [0.086, 1.199] | Research-only; sample and cost gates fail |
| Trend/pullback continuation | HYPOTHESIS | Not tested | None |
| Breakout/retest / volatility contraction | HYPOTHESIS | Not tested | None |
| Range mean reversion / failed-breakout fade | HYPOTHESIS | Not tested | None |
| Volatility expansion / momentum | HYPOTHESIS | Not tested | None |
| BTC-led confirmation / relative strength | HYPOTHESIS | Not tested | None |
| Funding/OI filters | HYPOTHESIS | Not tested | None |

These results are carried forward from the accessible v106/v105 registry; they were not recomputed. Cell-level train/validation/test boundaries and all cell-level confidence intervals remain unavailable in the current artifact bundle. No strategy was rejected or promoted this run. There are zero OOS_VALIDATED entries.

## 4. Key discoveries

- No robust OOS edge is demonstrated in the accessible registry.
- The only positive OOS point estimate is SOLUSDT/BULL_LOW Donchian20, but 12 trades are far below the 100-trade per symbol/context provisional floor; its cost and parameter-neighborhood robustness are incomplete.
- Current 1h/4h trend readings are uniformly bearish, while 5m/15m show a rebound. This is a transition-risk context, not a long trigger.
- Latest 15m taker flow at 10:15Z is buy-dominant for ETH, SOL and XRP (ratios 1.0151, 1.2376 and 1.2016) and sell-dominant for BTC (0.7433). OI rose for BTC/ETH and fell for SOL/XRP from 08:00Z to 10:00Z. These are descriptive observations only.
- No liquidation, crowding or leverage-concentration inference is made from OI or account ratios.

## 5. Current market snapshot

**Market metrics retrieved:** 2026-11-13 10:34:35 UTC. **Technical features:** 10:34:17 UTC. **Data-quality check:** 10:35:02 UTC.

| Symbol | Role | Mark / last | 24h change | 5m / 15m / 1h / 4h | Premium-index field / last settled funding | OI change 08→10Z | 15m taker B/S | Top spread |
|---|---|---:|---:|---|---:|---:|---:|---:|
| BTCUSDT | Reference | 69,249.47 / 69,249.30 | -5.735% | BULL / BEAR / BEAR / BEAR | +0.000709% / +0.001270% | +0.446% | 0.7433 | 0.0144 bp |
| ETHUSDT | Tradable | 1,949.33 / 1,949.36 | -4.778% | BULL / BEAR / BEAR / BEAR | -0.000314% / +0.000971% | +0.517% | 1.0151 | 0.0513 bp |
| SOLUSDT | Tradable | 80.3330 / 80.3300 | -3.368% | BULL / MIXED / BEAR / BEAR | -0.007056% / -0.005430% | -0.261% | 1.2376 | 1.2448 bp |
| XRPUSDT | Tradable | 1.02530 / 1.02530 | -2.547% | MIXED / BULL / BEAR / BEAR | +0.001985% / +0.000653% | -0.173% | 1.2016 | 0.9754 bp |

The premium-index lastFundingRate field is shown separately from the latest settled funding record at 08:00Z; it is not treated as a guaranteed next-settlement forecast. Funding interval observed: 8 hours; next funding time: 16:00Z. No observed rate breaches |funding| > 0.05%.

Global long/short account ratios at 10:00Z: BTC 3.4405, ETH 3.7574, SOL 3.4228, XRP 2.9635. These are account ratios, not proof of leverage concentration or crowding. Top-of-book spread is not market impact.

## 6. SOL / ETH / XRP decision matrix

| Symbol | OOS_VALIDATED strategy | Exact trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | Not evaluated against a validated rule | **NO_TRADE** | No OOS_VALIDATED entry; lower-TF rebound conflicts with bearish 1h/4h; no validated trigger |
| ETHUSDT | None | Not evaluated against a validated rule | **NO_TRADE** | No OOS_VALIDATED entry; 1h/4h bearish; no validated trigger |
| XRPUSDT | None | Not evaluated against a validated rule | **NO_TRADE** | No OOS_VALIDATED entry; 15m bullish but 1h/4h bearish; no validated trigger |

No entry, stop, target or position size is supplied.

## 7. Data-quality audit, costs, unavailable inputs, risks and next experiments

### Archive and quality

- Current sample: 1,920 rows; 1,904 completed; 16 forming excluded. Across all 16 symbol/interval series: zero duplicates, missing intervals, off-grid timestamps, OHLC invariant failures, nonpositive volumes, nonfinite values or close-time mismatches.
- 1h archive: 215,500 rows, 53,875 per symbol, ~6.14 years; prior full audit clean and this run's four-row append verified.
- 5m/15m: no base history; incremental-only. The 68-row append does not make these research-ready.
- 4h: 53,956 raw rows and 53,816 aligned analysis rows; canonical series ends 2026-11-05 16:00Z. Raw/canonical reconciliation and 13 original page-manifest hash mismatches remain unresolved.

### Costs and unavailable inputs

- No actual account fee tier, historical synchronized order-book depth/trades, size-dependent impact, latency or fill distribution was observed. The prior 15bp round-trip proxy remains uncalibrated.
- Only the latest two settled funding records per symbol were retrieved; historical funding cashflows are not archived.
- Basis, liquidation feed and a validated leverage/crowding measure are unavailable. BTC-alt rolling correlation and lead/lag were not computed.
- Direct Binance HTTP status/headers and fresh /fapi/v1/time are unavailable in this runtime.

### Source endpoints

Queried through the Binance public market-data connector: /fapi/v1/klines, /fapi/v1/premiumIndex, /fapi/v1/openInterest, /fapi/v1/ticker/24hr, /fapi/v1/fundingRate, /fapi/v1/ticker/bookTicker, /futures/data/takerBuySellVol, /futures/data/openInterestHist and /futures/data/globalLongShortAccountRatio. Direct shell probes of /fapi/v1/time, /fapi/v1/exchangeInfo, /fapi/v1/klines, /fapi/v1/premiumIndex, /fapi/v1/openInterest and /fapi/v1/ticker/24hr failed DNS (curl exit 6 / HTTP 000).

### Preflight

| Capability/check | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell/compute | DEGRADED | Linux 6.18.57; Python 3.13.5; Node 22.16.0; npm 10.9.2; 3 CPUs; ~5.8 GiB RAM; ~30 GB free | Runtime below project engines; provision Node 24+/npm 11+ |
| Repository/code | BLOCKED | No local checkout; remote package and scripts fetched through GitHub | Clone exact branch locally |
| Binance SDK | BLOCKED | SDK packages not installed/importable | Install and verify only in compatible runtime; this run used connector, not SDK |
| Network/Binance | DEGRADED | Direct DNS failed; connector data works but hides HTTP status; exchangeInfo serverTime stale by ~276 min | Restore direct HTTPS and fresh clock/metadata |
| Raw archive | DEGRADED | 68 rows persisted and read back; 5m/15m base absent; 4h degraded | Backfill 5m/15m and reconcile 4h |
| Data quality/coverage | DEGRADED | Current sample passes; historical coverage incomplete | Full archive audit after materialization |
| Backtest harness/smoke test | BLOCKED | Remote scripts exist; no local execution or deterministic fixture smoke test | Fix runner and policy mismatches, then smoke-test |
| Disk/storage | PASS | ~30 GB free; GitHub writes succeeded | Continue bounded, verified writes |
| Artifact readback | PASS | Delta 68 rows, manifest and 5m/15m/1h indexes reopened | Continue readback and hash verification |

### Source-code preflight findings

Remote package.json requires Node >=24 and npm >=11; current runtime is Node 22.16.0/npm 10.9.2. Remote scripts/backtest.ts defaults to BTCUSDT and 30 days and only requests 15m/1h/4h, omitting 5m. scripts/conditional-edge.ts defaults to minN=30 and 90% bootstrap confidence; no purge/embargo option is exposed. These defaults conflict with the BTC-reference-only policy and the >=100 OOS trades / 95% CI evidence gates. No code was changed.

### Next executable work

1. Provision Node >=24/npm >=11 and clone the exact source branch; install from lockfile.
2. Run a deterministic tiny-fixture smoke test and explicit lookahead checks before any full experiment.
3. Harden the harness: SOL/ETH/XRP trade allowlist, BTC reference-only, 5m support, >=100 OOS trades per symbol/context, 95% uncertainty, purge/embargo and realistic costs.
4. Continue bounded 5m/15m historical backfill and reconcile 4h raw/canonical provenance.
5. After prerequisites pass, pre-register one 1h trend/pullback or 4h Donchian experiment with chronological train/validation/untouched test, block bootstrap and multiple-testing correction.

**Final classification: RESEARCH_BLOCKED.** Monitoring and a verified 68-row archive append completed; no experiment or untouched OOS evaluation ran. SOLUSDT, ETHUSDT and XRPUSDT remain **NO_TRADE**.
