# Binance USD-M Context Strategy Research - v106

**As of:** 2026-11-13T09:11:06.872Z  
**Core market snapshot:** 2026-11-13T09:05:55Z; **basis/depth refresh:** 2026-11-13T09:14:42Z  
**Archive append highwater:** 5m 09:00Z; 15m 08:45Z; 1h 08:00Z; 4h 04:00Z  
**Run outcome:** RESEARCH_BLOCKED

## 1. Research progress

- Appended **140 completed OHLCV rows** to the durable GitHub research branch and verified readback:
  - Delta A: 136 rows - 5m 92, 15m 32, 1h 8, 4h 4.
  - Delta B: 4 rows - 5m 4.
  - Per symbol: 35 rows total across the two deltas.
- Updated all four interval archive indexes and verified each readback.
- Verified representative raw page files against manifest SHA-256 values: 5m BTC page 24, 15m BTC page 24, 1h BTC page 36 and 4h BTC page 9. Each sample page had zero gaps, duplicates, OHLC failures, non-positive volume and non-finite values.
- Current live sample: 3,200 rows retrieved; 3,184 completed and 16 forming candles excluded. All 16 symbol/interval series passed duplicate, continuity, alignment, OHLC, positive-volume and finite-value checks.
- No strategy experiment or OOS evaluation ran. The daily experiment is blocked by the absent local compatible runner, stale contract metadata, unresolved historical lineage and uncalibrated execution costs.

## 2. Context discovery

This is a **descriptive snapshot**, not a refit of taxonomy v56. No training-derived thresholds, context frequencies, duration distributions, transition matrix, classification stability or future win probabilities were computed.

- BTC: 4h/1h/15m bearish; 5m mixed.
- ETH: 4h/1h/15m bearish; 5m mixed.
- SOL: 4h/1h bearish; 15m/5m mixed.
- XRP: 4h/1h bearish; 15m mixed; 5m bullish divergence.

The 200-bar rolling windows are too short to infer multiple-cycle context occupancy or robust volatility percentiles. ATR/close values are observations, not low/normal/high labels.

## 3. Strategy-context scorecard

| Candidate | Symbol/context | Evidence status | Evidence |
|---|---|---|---|
| Donchian20 4h breakout v2 | SOLUSDT / BULL_LOW | OOS_PROMISING | Prior snapshot only: 12 OOS trades, 66.7% wins, 41.7% target-before-stop, mean net 0.606R, block-bootstrap 95% CI [0.086, 1.199], PF 2.72, max DD 1.3R. Not recomputed. |
| Donchian20 4h breakout v2 | 36 symbol/context cells | INSUFFICIENT_EVIDENCE | All below 100 OOS trades; prior nominal block-bootstrap intervals include zero; Holm-adjusted p=1.0; 15bp round-trip cost proxy uncalibrated. |
| Trend/pullback continuation | ALL | HYPOTHESIS | Not tested. |
| Breakout/retest and volatility contraction | ALL | HYPOTHESIS | Not tested. |
| Range mean reversion / failed-breakout fade | ALL | HYPOTHESIS | Not tested. |
| Volatility expansion / momentum | ALL | HYPOTHESIS | Not tested. |
| BTC-led confirmation / relative strength | ALL | HYPOTHESIS | Not tested. |
| Funding/OI filters | ALL | HYPOTHESIS | Not tested. |

**OOS_VALIDATED entries: 0.** OOS_PROMISING remains research-only.

## 4. Key discoveries

- Higher-timeframe bearish EMA alignment is present across all four symbols on 1h and 4h. This is a current feature observation, not evidence that short strategies have positive expectancy.
- BTC and ETH have the largest observed 24h declines (-6.289% and -5.286%). No trained shock threshold exists, so no formal shock label is assigned.
- 15m taker flow is buy-dominant for BTC, ETH and SOL, but their 1h/4h structures remain bearish. XRP 15m taker flow is sell-dominant after a buy-dominant prior 15m interval.
- OI fell from 07:00 to 08:00 UTC for all four symbols; SOL had the largest decline (-1.681%). This is not sufficient to infer liquidations or crowding.
- Long-account ratios are elevated (2.98-3.73) but are positioning descriptors only.
- No context/strategy/symbol edge was newly demonstrated. No candidate was rejected or promoted this run.

## 5. Current market snapshot

| Symbol | Mark / last | 24h change | 1h / 4h trend | 15m taker buy/sell ratio | 1h OI change 07->08 |
|---|---:|---:|---|---:|---:|
| BTCUSDT (reference) | 68,809.80 / 68,809.80 | -6.289% | Bearish / Bearish | 1.4772 | -0.503% |
| ETHUSDT | 1,936.22 / 1,936.59 | -5.286% | Bearish / Bearish | 1.1951 | -0.203% |
| SOLUSDT | 79.90 / 79.92 | -3.455% | Bearish / Bearish | 1.0634 | -1.681% |
| XRPUSDT | 1.02923 / 1.02940 | -1.417% | Bearish / Bearish | 0.8177 | -0.272% |

**Funding:** `premiumIndex.lastFundingRate` (latest API-reported rate, not treated as a guaranteed next-settlement forecast) / last settled funding from `/fapi/v1/fundingRate`, both percent per observed 8h cadence:
- BTC: +0.001314% / +0.001270%
- ETH: -0.000250% / +0.000971%
- SOL: -0.007839% / -0.005430%
- XRP: +0.000308% / +0.000653%

Next funding: 16:00 UTC. No absolute premiumIndex-reported or last-settled rate exceeds 0.05%.

**1h basis at 08:00 UTC:** BTC -0.06%, ETH -0.08%, SOL -0.05%, XRP -0.05%.
**20-level order-book notional imbalance (bid minus ask, divided by total):** BTC +23.38%, ETH +83.88%, SOL -6.51%, XRP -5.19%. Depth snapshots exclude RPI orders and are not a size-dependent impact/fill model.

Best bid/ask spreads: BTC 0.0145 bps, ETH 0.0516 bps, SOL 1.2516 bps, XRP 0.9717 bps. These are top-of-book snapshots, not size-dependent execution costs.

## 6. Decision matrix

| Tradable | Validated strategy | Exact trigger | Decision |
|---|---|---|---|
| SOLUSDT | None | No OOS_VALIDATED entry; current 1h/4h bearish context does not match prior SOL/BULL_LOW OOS_PROMISING candidate | **NO_TRADE** |
| ETHUSDT | None | No OOS_VALIDATED entry; no validated trigger or calibrated net edge | **NO_TRADE** |
| XRPUSDT | None | No OOS_VALIDATED entry; 5m bullish divergence conflicts with 1h/4h bearish structure | **NO_TRADE** |

No entry, stop, target or size is issued.

## 7. Preflight, data audit, costs and next experiments

| Check | Status | Evidence / impact | Next action |
|---|---|---|---|
| Shell/compute | PASS | Linux 6.18.57; 3 CPU cores; 4.96 GB available RAM; Python 3.13.5 | Keep work bounded. |
| Repo/code | BLOCKED | No local checkout; Node 22.16.0/npm 10.9.2 vs required Node>=24/npm>=11 | Provision compatible runner and clone exact branch. |
| Network/Binance | DEGRADED | Direct fapi DNS failure (curl 6, HTTP 000); connector wrappers work; exchangeInfo server time is ~3h stale | Restore direct REST and refresh server time/metadata. |
| Raw archive | DEGRADED | Remote GitHub archive available; local raw archive absent; 5m/15m partial; 1h/4h lineage issues | Backfill 5m/15m and reconcile 1h/4h. |
| Data quality | DEGRADED | Current 3,200-row sample clean; historical archive has known gaps/provenance issues | Complete full-archive audit. |
| Backtest/smoke test | BLOCKED | Remote scripts exist but cannot run locally; no fixture smoke test | Provision runner and run deterministic fixture twice. |
| Disk/storage | PASS | 30 GB free; /mnt/data writable; GitHub branch writes available | Keep artifacts hash-verified. |
| Artifact readback | PASS | Delta/manifests/indexes read back exactly | Continue versioned persistence. |

**Cost model:** current top-of-book spread observed; account fee tier, historical spread/depth, market impact, latency, fill probability and complete funding cashflows remain unavailable. No net expectancy can be evaluated.

**Critical source-contract violations confirmed remotely:** `src/config.ts` defaults `SYMBOLS` to `BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT`, and `scripts/backtest.ts` defaults its symbol argument to BTCUSDT. This violates the BTC reference-only requirement and is a P0 fix. The backtest timeframe list omits 5m; the Candle mapping omits closeTime; the current validator accepts volume==0; `conditional-edge.ts` defaults minN to 30 and exposes no embargo CLI flag. Underlying walk-forward purging behavior was not verified. Fix these contracts and add deterministic fixtures before any research execution.

**Next execution order:** (1) restore fresh server time and exchange metadata; (2) provision Node>=24/npm>=11 and clone the exact branch; (3) reconcile 1h/4h and backfill 5m/15m; (4) repair candle/5m/purge/embargo contracts and BTC reference-only enforcement; (5) calibrate fees, spread, slippage, impact, latency, fills and funding; (6) run a pre-registered strategy x context x symbol experiment with untouched OOS and serial-dependence-aware uncertainty.

**Outcome: RESEARCH_BLOCKED.** Archive maintenance and monitoring ran; no strategy experiment or OOS evaluation ran.

