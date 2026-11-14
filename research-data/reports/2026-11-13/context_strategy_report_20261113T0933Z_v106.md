# Context Strategy Research — v106

**As of:** 2026-11-13T09:33:48.425Z  
**Status:** RESEARCH_BLOCKED — monitoring and raw archive ingestion completed; no experiment or untouched OOS evaluation ran.

## 1. Research progress

- Refreshed BTCUSDT (reference only), ETHUSDT, SOLUSDT and XRPUSDT.
- Retrieved 200 bars per symbol/interval for 5m/15m/1h/4h: 3,200 rows; 3,184 completed; 16 forming excluded. Current-window checks: zero duplicates, missing/off-grid intervals, OHLC failures, non-positive volume or non-finite values.
- Appended 192 completed rows to the remote archive: 5m 132, 15m 44, 1h 12, 4h 4. Both delta files/manifests and all four archive indexes were reopened and verified.
- Highwaters: 5m 09:25Z; 15m 09:15Z; 1h 08:00Z; 4h 04:00Z.
- [Raw archive branch](https://github.com/shubhamtaywade82/crypto-trading-agent/tree/research/raw-ohlcv-archive-20261113T063450Z-run11)

**Experiment blocker:** no local checkout; Node v22.16/npm 10.9 versus project requirement Node>=24/npm>=11. Remote scripts are readable but not invokable. No deterministic smoke test ran. Direct shell DNS to github.com and fapi.binance.com fails; raw history is not mounted locally.

## 2. Context discovery

Taxonomy v56 carried forward, not refit. Numeric fitted thresholds and transition matrix are unavailable. No occupancy, duration, transition or stability metrics were recomputed. Current labels are descriptive EMA20/EMA50/slope/ATR heuristics, not trained regime probabilities.

1h archive: 215,496 rows (53,874/symbol), 2020-09-14 08:00Z to 2026-11-13 08:00Z, clean indexed quality. 4h raw: 53,956 rows, but raw/canonical counts differ and 13 original page-manifest hash mismatches remain. 5m/15m multi-year base history is absent. Full multi-timeframe research is not ready.

## 3. Strategy-context scorecard

- Donchian20 4h breakout v2, 36 symbol/context cells: **INSUFFICIENT_EVIDENCE** — all below 100 OOS trades, nominal block-bootstrap intervals include zero, Holm p=1.0, 15bp cost proxy uncalibrated.
- SOLUSDT/BULL_LOW Donchian20 4h: **OOS_PROMISING**, carried forward only — 12 trades, 66.7% wins, 41.7% target-before-stop, mean 0.606R, PF 2.72, max DD 1.3R, bootstrap 95% CI [0.086,1.199]. Too few trades and cost/parameter robustness incomplete.
- Trend/pullback, breakout/retest, range fade, volatility expansion, BTC-led relative strength and funding/OI filters: **HYPOTHESIS**, untested.
- **OOS_VALIDATED entries: 0.** No registry metrics recomputed.

## 4. Key discoveries

No robust OOS edge is demonstrated. 1h/4h trend heuristics are bearish for all four symbols; 5m/15m are mixed except XRP 5m bullish. Latest 15m taker flow is buy-dominant in BTC/ETH and sell-dominant in SOL/XRP. OI declined 07:00–09:00Z across all four, most in SOL. These observations do not establish liquidation, crowding or an edge.

## 5. Current market snapshot

| Symbol | Mark / last | 24h | 5m/15m/1h/4h | Premium-index field / settled funding | OI | Spread |
|---|---:|---:|---|---:|---:|---:|
| BTCUSDT (ref) | 68,972.68 / 68,980.40 | -6.125% | MIXED/MIXED/BEAR/BEAR | +0.001230% / +0.001270% | 101,218.751 | 0.0145bp |
| ETHUSDT | 1,939.17 / 1,939.34 | -5.189% | MIXED/MIXED/BEAR/BEAR | -0.000634% / +0.000971% | 2,348,097.695 | 0.0516bp |
| SOLUSDT | 79.8545 / 79.86 | -3.725% | MIXED/MIXED/BEAR/BEAR | -0.007686% / -0.005430% | 9,413,707.03 | 1.2529bp |
| XRPUSDT | 1.03084 / 1.03090 | -1.528% | BULL/MIXED/BEAR/BEAR | +0.000387% / +0.000653% | 295,203,167 | 0.9705bp |

Funding cadence observed at 8h; latest settlement 08:00Z; next at 16:00Z. No observed |funding| exceeds 0.05%. Top-of-book spread is not an impact estimate. Global long/short account ratios are descriptive only.

## 6. Decisions

| Symbol | Eligible validated strategy | Decision | Reason |
|---|---|---|---|
| SOLUSDT | None | **NO_TRADE** | No OOS_VALIDATED rule or trigger; 1h/4h bearish, lower TF mixed, sell-dominant 15m flow and falling OI |
| ETHUSDT | None | **NO_TRADE** | No OOS_VALIDATED rule or trigger; 1h/4h bearish and lower TF mixed |
| XRPUSDT | None | **NO_TRADE** | No OOS_VALIDATED rule or trigger; 5m bullish/15m mixed conflicts with 1h/4h bearish; sell-dominant 15m flow |

No entry/stop/target/size is issued.

## 7. Preflight, costs and next work

- Shell available but degraded: Python 3.13.5, Node 22.16.0, npm 10.9.2, 3 CPUs, 6.09GB RAM, 30GB free.
- Repository/backtest blocked: no local checkout or fixture smoke test.
- Network degraded: direct DNS fails (curl exit 6/HTTP 000); connector returns data but hides HTTP status. /fapi/v1/time unavailable; exchangeInfo serverTime is 3h31m stale.
- Archive degraded: remote writes/readbacks pass; 5m/15m base absent; 4h provenance degraded.
- Costs unavailable: fee tier, historical depth/trades, market impact, latency and full funding cashflows. The 15bp proxy remains uncalibrated.
- Next: provision Node>=24/npm>=11; materialize 1h/4h; backfill multi-year 5m/15m; reconcile 4h; audit closeTime/positive-volume/5m/purge/embargo controls; run deterministic smoke test; then pre-register one strategy×context×symbol experiment.

**Final classification: RESEARCH_BLOCKED.** Monitoring and archive ingestion completed; no experiment or untouched OOS evaluation ran. No OOS_VALIDATED strategy exists; all tradable symbols remain NO_TRADE.
