# Context Strategy Research — Run v81

**As of:** 2026-11-07T16:29:30.509Z UTC  
**Classification:** `RESEARCH_BLOCKED`  
**Market monitoring:** completed  
**Raw archive maintenance:** completed and readback-verified  
**New experiment / OOS evaluation:** none

## 1. Research progress

Persisted raw archive branch: [research/raw-ohlcv-archive-20261107T1625Z-run12](https://github.com/shubhamtaywade82/crypto-trading-agent/tree/research/raw-ohlcv-archive-20261107T1625Z-run12).

- 72 completed rows appended; 88 fetched; 16 forming rows excluded.
- Per symbol: 12 x 5m, 4 x 15m, 1 x 1h, 1 x 4h.
- Aggregate: 48 x 5m, 16 x 15m, 4 x 1h, 4 x 4h.
- Zero detected duplicates, gaps, off-grid timestamps, OHLC failures, non-positive volume, non-finite values or close-time failures. Cross-symbol alignment passed.
- Delta: `research-data/binance-usdm/delta/binance_usdm_delta_20261107T1625Z_5m15m1h4h_completed.jsonl`, 20,129 bytes, SHA-256 `27a360d93bd4f235bc43f8a9802b1dfaf25ec430faa7123703e663f02a215f58`.
- Manifest SHA-256: `d99957069c78ee1908762ef0c99df115ce4d92f544e7b5d5c212586f5dfbb465`.
- Both archive indexes were updated and read back.

High-water: 5m 16:20Z; 15m 16:00Z; 1h 15:00Z; 4h 12:00Z. Next opens: 16:25Z, 16:15Z, 16:00Z and 16:00Z respectively, after each close time passes.

| Dataset | Coverage | Rows | Assessment |
|---|---|---:|---|
| 1h base | 2020-09-14 08:00Z to 2026-11-06 22:00Z | 53,871/symbol | Long history; incremental through Nov7 15:00Z |
| 4h canonical | 2020-09-14 08:00Z to 2026-11-05 16:00Z | 13,461/symbol | Incremental through Nov7 12:00Z not merged |
| 5m / 15m multi-year | unavailable | — | Blocked |

Cumulative incremental rows: 3,852. The 76-row artifact remains unresolved; do not reconstruct it from row count. Thirteen original page/symbol hash discrepancies remain: BTC pages 2–6 and all four symbols on pages 7–8. Eight files independently reverified in the prior run remain clean.

## 2. Context discovery

A descriptive audit covered 16 symbol/timeframe series, 120 raw rows each: 1,920 raw, 1,904 completed, 16 forming excluded. All series passed continuity, alignment, OHLCV, finite-value and close-time checks.

Features: EMA20/EMA50 alignment, ATR14 percentile within the last 100 ATR observations, volume versus prior-20 median, completed-candle taker-buy share and Donchian20 position.

**No training-derived taxonomy was fitted.** Context frequency, duration, transition probabilities and classification stability remain uncomputed. ATR percentiles are local to 120-bar windows, not multi-cycle regime percentiles.

## 3. Strategy-context scorecard

No experiment or OOS evaluation ran in v81. Prior evidence is carried forward unchanged.

| Candidate | Symbol/context | Status | OOS trades | Metrics |
|---|---|---|---:|---|
| 4h Donchian20 breakout | SOLUSDT / BULL_LOW | OOS_PROMISING | 12 | Win 66.7%; target-before-stop 41.7%; mean +0.606R; PF 2.72; max DD 1.3R; block-bootstrap 95% CI [0.086R, 1.199R] |
| Context-aligned Donchian20 WF v2 | All 36 cells | INSUFFICIENT_EVIDENCE | Below 100 per cell | Nominal block-bootstrap CI includes zero; Holm-adjusted p=1.0 |

The SOL candidate remains research-only: 12 trades do not meet the minimum 100 OOS trades per symbol/context. The inherited 15bp round-trip proxy is unvalidated; actual fee tier, funding cashflows, spread, slippage, impact and latency remain incomplete. Other strategy families remain HYPOTHESIS. OOS_VALIDATED entries: zero.

## 4. Key discoveries

- All four symbols have bearish EMA20/EMA50 alignment on 5m, 15m, 1h and 4h.
- SOL has a descriptive 1h Donchian20 breakdown, 2.92x prior-20 median volume and 0.420 taker-buy share. Not a validated entry.
- XRP has a 5m countertrend bounce: taker-buy share 0.723 and close slightly above EMA20, but below EMA50; 4h local ATR percentile 90.
- BTC is bearish across four alignments despite +0.097% 24h; 1h volume 2.27x median and taker-buy share 0.374.
- ETH is bearish across four alignments; 1h volume 2.42x median and taker-buy share 0.342, while latest 5m buy share is 0.628 on below-median volume.

These are current observations, not historical strategy evidence.

## 5. Current market snapshot

As of 2026-11-07 16:29 UTC. BTC is reference only.

| Symbol | Mark | 24h change | OI | Indicated funding | Last settled funding |
|---|---:|---:|---:|---:|---:|
| BTCUSDT | 75,756.27 | +0.097% | 96,239.187 | +0.002076% | +0.001302% |
| ETHUSDT | 2,236.99 | +0.475% | 2,360,315.977 | +0.008247% | +0.007427% |
| SOLUSDT | 89.60 | -0.907% | 9,366,669.71 | +0.000873% | +0.001115% |
| XRPUSDT | 1.16030 | -2.708% | 338,396,789.1 | +0.010000% | +0.010000% |

Funding interval: 8h. Last settlement: 16:00Z. Next funding: 2026-11-08 00:00Z. No observed funding rate exceeds the absolute 0.05% threshold. Global long-account shares: BTC 75.27%, ETH 78.41%, SOL 78.37%, XRP 74.02%; snapshots do not prove crowding.

| Symbol | 5m spread | 5m ATR percentile | 1h volume / prior-20 median | 1h taker-buy share | 1h structure |
|---|---:|---:|---:|---:|---|
| BTC | 0.0132 bps | 100 | 2.274x | 0.374 | Inside Donchian20 |
| ETH | 0.0447 bps | 93 | 2.417x | 0.342 | Inside Donchian20 |
| SOL | 1.1165 bps | 91 | 2.924x | 0.420 | Break-down below prior Donchian20 low |
| XRP | 0.8623 bps | 94 | 1.670x | 0.451 | Inside Donchian20 |

Spreads/depth are snapshots. OI is a point observation; no historical OI-change series was used to infer crowding.

## 6. Decisions

| Symbol | OOS_VALIDATED setup | Trigger | Decision |
|---|---|---|---|
| SOLUSDT | None | Descriptive 1h breakdown only | **NO_TRADE** |
| ETHUSDT | None | No validated trigger | **NO_TRADE** |
| XRPUSDT | None | Countertrend 5m bounce; no validated reversal | **NO_TRADE** |

No levels or sizing are issued. No cross-symbol evidence transfer.

## 7. Preflight, costs and next actions

| Check | Status | Evidence |
|---|---|---|
| Shell/compute | PASS | Linux; 5 CPUs; ~4.94GB available RAM; ~30GB free |
| Repo/code | DEGRADED | Remote GitHub read; no local checkout; Node22.16/npm10.9 below Node>=24/npm>=11 |
| Network/Binance | DEGRADED | Connector data fresh; direct DNS/HTTPS HTTP000; exchangeInfo serverTime 29.17h stale |
| Raw archive | DEGRADED | 1h/4h long history; multi-year 5m/15m absent; 76-row artifact missing; 13 hash discrepancies |
| Current data quality | PASS | 1,920 raw; 1,904 completed; zero detected integrity failures |
| Backtest/smoke test | BLOCKED | No local checkout/compatible runtime; no SDK; smoke test NOT_RUN |
| Disk/storage | PASS | Remote GitHub writes available |
| Artifact readback | PASS | 72-row delta, manifest and both archive indexes verified |

Remote source inspection:
- `package.json` requires Node>=24/npm>=11.
- `scripts/backtest.ts` implements 15m/1h/4h, not 5m.
- Main `src/types.ts` Candle omits closeTime; the API fetch path does not preserve it.
- `src/backtesting/archiveKlines.ts` rejects volume<0 but accepts zero. Separate `research/alma/src/data-quality.ts` is not imported by the main backtest path and also accepts zero.

**Next actions:** (1) backfill multi-year 5m/15m and merge incremental 4h; (2) recover the exact 76-row artifact and reconcile 13 hash discrepancies; (3) restore direct DNS/HTTPS and fresh /time + /exchangeInfo; (4) provision Node24/npm11 and local checkout, preserve closeTime, reject volume<=0 and add 5m; (5) run deterministic fixture twice; (6) calibrate fees/funding/spread/slippage/impact/latency; (7) preregister one conditional experiment with chronological train/validation/untouched OOS, purging/embargo, block bootstrap and Holm correction.

**Final: RESEARCH_BLOCKED.** Archive maintenance and monitoring completed; no experiment, smoke test or OOS evaluation completed.
