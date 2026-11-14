# Binance USD-M Context Strategy Research - v95

**Run:** context-strategy-2026-11-12T193436Z-v95  
**As of:** 2026-11-12T19:34:36.450Z  
**Classification:** RESEARCH_EXECUTED (data-quality/archive integrity only)  
**Strategy experiment:** BLOCKED  |  **Untouched OOS:** NOT EVALUATED

## 1. Research progress

Completed data-quality experiment EXP-DQ-2026-11-12-193048Z-010. Hypothesis: newly completed 5m/15m/1h bars after the prior highwater are unique, on-grid, contiguous within the append window, OHLC-valid, finite and positive-volume; forming bars are excluded. Fetched 1,200 rows across 4 symbols x 3 intervals, excluded 12 forming and 1,060 pre-highwater rows, and appended 128 completed rows (5m 88, 15m 32, 1h 8). All quality counters were zero; cross-symbol alignment passed. Delta, manifest, global manifest and 5m/15m/1h indexes were read back and verified. 4h added zero rows because the 16:00Z candle was still forming.

This is an archive-integrity experiment, not a trading-strategy experiment. No backtest, walk-forward or untouched OOS ran.

## 2. Historical coverage and context discovery

| Interval | Coverage | Current highwater | Assessment |
|---|---|---|---|
| 5m | Global base manifest 126,000 rows (31,500/symbol), but index reports 138,000 (34,500/symbol); coverage end varies from Apr-2020 to Jan-2021; 9 zero-volume rows. | 19:25Z | PARTIAL / count discrepancy 12,000. |
| 15m | Global base manifest 126,000 rows; index 138,000; coverage end varies from Nov-2020 to Aug-2021; 4 zero-volume rows. | 19:15Z | PARTIAL / count discrepancy 12,000. |
| 1h | Global base 215,484 rows (53,871/symbol) vs index 215,492 (53,873/symbol); 28 bridge gaps per symbol. | 18:00Z | DEGRADED. |
| 4h | Raw/aligned/canonical 53,960/53,816/53,844; 13 manifest hash mismatches and one malformed XRP original record. | 12:00Z | DEGRADED. |

The v56 4h taxonomy remains carried forward, not refitted. Prior test occupancy/duration: BTC BEAR_LOW 6.53%, TRANSITION_LOW 50.66%, BULL_LOW 9.85%, median transition 38h, TVD 0.175; ETH 6.42/46.24/6.64%, 42h, TVD 0.338; SOL 10.9/67.56/10.7%, 120h, TVD 0.245; XRP 15.2/43.63/3.22%, 68h, TVD 0.293. These are feature-state frequencies, not trade-win probabilities. ETH/XRP show material validation/test context drift. Weekly review due 2026-11-11 is overdue and blocked.

## 3. Strategy-context scorecard

- OOS_VALIDATED: 0.
- All 36 conditional Donchian20 cells remain INSUFFICIENT_EVIDENCE: below 100 OOS trades, nominal block-bootstrap CI includes zero, Holm-adjusted p=1.0; 15bp round-trip cost proxy is uncalibrated.
- Strongest prior candidate: SOLUSDT x BULL_LOW x 4h Donchian20, OOS_PROMISING only: 12 trades, mean net R 0.606, PF 2.72, max DD 1.3R, CI95 [0.086,1.199]. It is below the sample gate and does not match current SOL bearish 1h/4h context.
- Other families remain HYPOTHESIS. No new strategy/OOS experiment was run.

## 4. Current market snapshot

Timestamp 19:34Z. All 16 symbol/interval requests returned 100 rows; 99 completed and 1 forming bar excluded per series. Recent-window quality checks were clean. 1h/4h EMA20/EMA50 alignment is bearish for BTC, ETH, SOL and XRP. ETH 5m is mixed; SOL 5m/15m are mixed; XRP is bearish across all four intervals. This is descriptive, not an edge.

| Symbol | Role | 24h change | Mark | 1h/4h trend | ATR14% 1h/4h | Indicated funding | Settled funding | Spread |
|---|---|---:|---:|---|---:|---:|---:|---:|
| BTCUSDT | Reference | -3.768% | 71498.8 | Bear/Bear | 0.695/1.327 | +0.010000% | +0.008904% | 0.014 bp |
| ETHUSDT | Tradable | -3.253% | 2010.29 | Bear/Bear | 0.936/1.810 | +0.009362% | +0.004733% | 0.050 bp |
| SOLUSDT | Tradable | -3.767% | 81.52 | Bear/Bear | 1.080/2.052 | -0.003273% | +0.000716% | 1.227 bp |
| XRPUSDT | Tradable | -2.775% | 1.02680052 | Bear/Bear | 1.082/2.246 | +0.009819% | +0.004560% | 0.974 bp |

Funding settlement spacing observed at 8h; next funding 2026-11-13 00:00Z. No |indicated funding| exceeds 0.05%. Current OI is a point-in-time contract-unit snapshot; no OI history/change was fetched. Global long/short ratios are account ratios. Best bid/ask spread is top-of-book only.

## 5. Decisions

| Symbol | Validated setup | Decision | Reason |
|---|---|---|---|
| SOLUSDT | None | NO_TRADE | No OOS_VALIDATED rule; BULL_LOW candidate mismatches current bearish 1h/4h state. |
| ETHUSDT | None | NO_TRADE | No OOS_VALIDATED symbol/context rule or trigger. |
| XRPUSDT | None | NO_TRADE | No OOS_VALIDATED symbol/context rule; taker flow is not a trigger. |

## 6. Preflight and next actions

- Shell/compute PASS: Linux 6.18.57, Python3.13.5, Node22.16, npm10.9, 3 CPU, ~4.95GB available RAM, 30GB free disk.
- Repo/code BLOCKED: no local checkout or node_modules; remote package requires Node>=24/npm>=11.
- Network DEGRADED: Binance connector works; direct DNS fails HTTP000; /fapi/v1/time unavailable; exchangeInfo serverTime is ~9h49m stale.
- Backtest/smoke BLOCKED: no compatible runner; source drops closeTime, omits 5m and accepts zero-volume bars; deterministic smoke test not run.
- Storage: GitHub archive/run writes read back successfully. ChatGPT Library upload failed due storage quota; no existing files were deleted.
- Costs: 15bp round-trip proxy only; actual fee tier, full funding cashflows, historical spread/depth, slippage, impact and latency unavailable.

Queue: RQ-002 fresh time/metadata; RQ-005 compatible runner; RQ-012 candle-contract fixes; RQ-003 backfill/reconcile; RQ-029 enforce BTC reference-only; RQ-004 costs; RQ-014 funding; then RQ-021 strategy experiment. RQ-028 weekly taxonomy review is overdue and blocked.

**Final:** RESEARCH_EXECUTED (data-quality only). Strategy experiment remains BLOCKED; no OOS evaluation.
