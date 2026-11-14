# Context Strategy Research v81

Run: context-strategy-2026-11-12T193436Z-v81  
As-of UTC: 2026-11-12T19:34:36.450Z  
Classification: RESEARCH_BLOCKED

## 1. Research progress

Appended 128 completed Binance USD-M bars to the remote archive: 5m 88, 15m 32, 1h 8, 4h 0. Delta SHA-256: e927374e219a1ee46e75698c3638575192e50ede58e95271ca4cadefd93a4cd1. Delta and manifests plus the 5m/15m/1h index pointers were read back and verified. No strategy experiment, backtest, walk-forward or untouched OOS ran.

Historical coverage remains inadequate for broad generalization:
- 5m/15m: partial, uneven 2020-2021 base coverage; index reports 138,000 rows while global base manifest reports 126,000.
- 1h: about 6.14 years but 28 missing hourly opens per symbol and an 8-row manifest discrepancy.
- 4h: raw/aligned/canonical row counts 53,960/53,816/53,844; 13 hash mismatches and one malformed XRP original record; canonical data ends 2026-11-05 16:00Z.

## 2. Context discovery

No taxonomy refit. v56 4h taxonomy is carried forward only. Weekly review due 2026-11-11 is OVERDUE_BLOCKED. Current EMA20/EMA50 and ATR14/close values are descriptive; context confidence is uncalibrated. No context frequencies, durations, transitions, stability, shock threshold, rolling correlation or lead/lag were recomputed.

## 3. Strategy-context scorecard

OOS_VALIDATED count: 0. All 36 prior symbol-context cells remain INSUFFICIENT_EVIDENCE (below 100 OOS trades; nominal block-bootstrap CI includes zero; Holm-adjusted p=1.0; costs and purging/embargo incomplete). The strongest inherited candidate remains SOLUSDT x BULL_LOW x 4h Donchian20: OOS_PROMISING, 12 trades, mean net R 0.606, PF 2.72, max DD 1.3R, nominal 95% block-bootstrap CI [0.086, 1.199]. It is underpowered and does not match current SOL bearish 1h/4h state. Other families remain HYPOTHESIS_NOT_TESTED.

## 4. Key discoveries

- Current 1h/4h EMA alignment is bearish across BTC, ETH, SOL and XRP; this is not proof of a short edge.
- ETH 5m and SOL 5m/15m are mixed while their 1h/4h states are bearish.
- XRP 1h taker buy share is 58.15% despite bearish alignment; participation only, not reversal evidence.
- No current symbol/context has an OOS_VALIDATED rule. No trade is selected.

## 5. Current market snapshot

UTC 19:34:36Z; mark timestamp 19:34:01Z. All 16 symbol/interval requests returned 100 rows; 99 completed and 1 forming candle excluded per series. Recent-window checks: zero duplicate/gap/off-grid/OHLC/zero-volume/nonfinite/nonmonotonic failures.

| Symbol | 24h change | Mark | 1h/4h trend | ATR14% 1h/4h | Indicated funding | Settled funding | Spread bps |
|---|---:|---:|---|---:|---:|---:|---:|
| BTCUSDT (reference) | -3.768% | 71498.8 | Bear/Bear | 0.695/1.327 | +0.010000% | +0.008904% | 0.014 |
| ETHUSDT | -3.253% | 2010.29 | Bear/Bear | 0.936/1.810 | +0.009362% | +0.004733% | 0.050 |
| SOLUSDT | -3.767% | 81.52 | Bear/Bear | 1.080/2.052 | -0.003273% | +0.000716% | 1.227 |
| XRPUSDT | -2.775% | 1.02680052 | Bear/Bear | 1.082/2.246 | +0.009819% | +0.004560% | 0.974 |

Settled funding timestamps are spaced 8h apart; next funding 2026-11-13 00:00Z. No absolute indicated funding exceeds 0.05%. Current OI is available, but OI history/change is not. Long/short values are global account ratios; book spread is top-of-book only.

## 6. Decisions

| Symbol | Validated strategy | Decision | Reason |
|---|---|---|---|
| SOLUSDT | None | NO_TRADE | No OOS_VALIDATED entry; inherited BULL_LOW candidate is context-mismatched. |
| ETHUSDT | None | NO_TRADE | No symbol/context OOS_VALIDATED evidence or validated trigger. |
| XRPUSDT | None | NO_TRADE | No symbol/context OOS_VALIDATED evidence; taker flow is not a trigger. |

No entry, stop or target levels issued.

## 7. Preflight, costs and next actions

- Shell/compute PASS: Linux 6.18.57, Python 3.13.5, Node 22.16, npm 10.9, 3 CPU, 4.95GB available RAM, 30GB free disk.
- Repo/code DEGRADED: no local checkout/node_modules; remote package requires Node>=24/npm>=11.
- Network DEGRADED: connector market data works; direct curl DNS fails HTTP 000; /fapi/v1/time unavailable; exchangeInfo serverTime is ~9h49m stale.
- Backtest/smoke BLOCKED: remote mapping drops closeTime, omits 5m and accepts volume==0; no deterministic smoke test.
- Storage: GitHub archive writes succeeded and readback verified. Library upload failed because the Library storage quota is full; no existing files were deleted.
- Cost model remains a 15bp round-trip proxy only. Actual fee tier, full funding cashflows, historical spread/depth, slippage, impact and latency are unavailable.

Next: RQ-002 fresh server time/metadata; RQ-005 compatible runner; RQ-012 candle-contract fixes; RQ-003 lower-timeframe backfill and 1h/4h reconciliation; RQ-004 cost calibration; then RQ-021 one frozen conditional experiment. RQ-028 weekly taxonomy review is overdue and blocked by archive/compute prerequisites.

Final status: RESEARCH_BLOCKED. Archive refresh and monitoring completed; no valid experiment or OOS evaluation ran.
