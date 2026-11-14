# Context Strategy Research - Run 11

As of: 2026-11-13 23:58:52 UTC
Run classification: **RESEARCH_EXECUTED** - reproducible current-window data-quality audit only.
Strategy backtest: NOT RUN. Untouched OOS: NOT EVALUATED. OOS_VALIDATED registry entries: 0.

## 1. Research progress

- Persisted 1,904 completed raw kline rows across BTCUSDT, ETHUSDT, SOLUSDT and XRPUSDT at 5m/15m/1h/4h. The 16 forming bars were excluded from the audit input.
- Current-window integrity checks: zero duplicates, missing intervals, off-grid timestamps, non-monotonic rows, OHLC invariant failures, non-positive volume, non-finite values or close-time failures.
- This is a bounded data-quality audit, not multi-cycle coverage validation and not a strategy experiment.
- The canonical archive was not advanced. The new raw sample is a separate run artifact.

## 2. Context discovery

- Descriptive EMA20/EMA50/ATR14 classification from 119 completed bars per symbol/interval: 15m, 1h and 4h are BEAR_ALIGNED for all four symbols; 5m is MIXED_TRANSITION for all four.
- This is a short-window descriptor, not a fitted regime taxonomy. No training-derived thresholds, context frequencies, durations, transition matrix or classification calibration were computed.
- BTC rolling 72h return correlation: ETH 0.898, SOL 0.841, XRP 0.687. Relative 24h return versus BTC: ETH -0.082 pp, SOL -0.221 pp, XRP +1.636 pp. These are descriptive only.

## 3. Strategy-context scorecard

- Registry snapshot version 109: 0 OOS_VALIDATED, 4 INSUFFICIENT_EVIDENCE, 1 REJECTED. All five tested entries are SOL-only.
- ETH and XRP have no symbol-specific OOS evidence.
- Trend/pullback, breakout/retest, volatility expansion, BTC-led relative strength and funding/OI filters remain HYPOTHESIS.
- SOL Donchian BULL_LOW remains INSUFFICIENT_EVIDENCE (55 OOS trades, below the 100-trade gate; bootstrap interval crosses zero; negative quote PnL; validation parameter neighborhood negative).
- SOL SIDEWAYS_LOW failed-breakout-fade remains REJECTED. No cross-symbol transfer.

## 4. Key discoveries

No new strategy edge was established. The only new result is that the fetched current windows pass the listed integrity checks. A bearish higher-timeframe context is not an entry trigger and does not imply positive expectancy.

## 5. Current context snapshot

Market quote snapshot: 2026-11-13 23:55:29 UTC. Completed-candle context sample: 2026-11-13 23:58:52 UTC. Derivatives/depth snapshot: approximately 23:52 UTC.

| Symbol | 24h change | 5m | 15m | 1h | 4h | 1h return | 4h 24h return |
|---|---:|---|---|---|---|---:|---:|
| BTC (reference) | -4.445% | MIXED | BEAR | BEAR | BEAR | -4.445% | -3.668% |
| ETH | -4.549% | MIXED | BEAR | BEAR | BEAR | -4.527% | -3.161% |
| SOL | -4.499% | MIXED | BEAR | BEAR | BEAR | -4.667% | -1.642% |
| XRP | -3.023% | MIXED | BEAR | BEAR | BEAR | -2.809% | -0.513% |

The 5m mixed state against 15m/1h/4h bearish alignment is a transition warning, not a reversal signal. No train-derived shock threshold is available. Funding interval is 8h; next settlement 2026-11-14 00:00 UTC. Premium-index latest rate fields were BTC 0.005951%, ETH 0.001206%, SOL 0.006673%, XRP 0.004794%; last settled rates at 16:00 UTC were 0.004045%, 0.004743%, 0.007203%, 0.010000%, respectively. None exceeds 0.05%.

## 6. Decisions

- SOLUSDT: **NO_TRADE** - no OOS_VALIDATED symbol/context entry and no validated trigger.
- ETHUSDT: **NO_TRADE** - no symbol-specific OOS_VALIDATED entry.
- XRPUSDT: **NO_TRADE** - no symbol-specific OOS_VALIDATED entry.
- BTCUSDT remains reference only.

Additionally, exchangeInfo is stale by 17h 46m 57.297s versus the contemporaneous premiumIndex time proxy; contract trading status and execution filters are not verified. No entry, stop or target is authorized.

## 7. Data audit, costs, risks and next work

- Direct REST probes for /time, /exchangeInfo, /klines, /premiumIndex, /openInterest and /ticker/24hr returned HTTP000 DNS failures. Binance connector calls succeeded but did not expose HTTP status/headers.
- Remote archive manifest v111: 5m/15m base history is partial; 1h has 28 missing opens per symbol and an 8-row discrepancy; 4h raw/aligned/canonical rows are 53,960/53,816/53,844 with 13 SHA provenance mismatches. The last canonical archive refresh remains 22:18 UTC; no new bars were merged this run.
- Current spread snapshots: BTC 0.0147 bps, ETH 0.0519 bps, SOL 1.2816 bps, XRP 0.9912 bps. Historical fees, account fee tier, latency and slippage are not calibrated. The prior 15 bp round-trip proxy is not a validated execution model.
- OI/taker/global-LS observations are not liquidation data; no liquidation or crowding inference is made.
- Highest-priority remediation: repair archive coverage and hashes; restore direct time/metadata checks; provision Node >=24/npm >=11 and run deterministic fixture twice; backfill historical derivatives and calibrate costs; then run a pre-registered strategy x context x symbol experiment and untouched OOS only after gates pass.

## Preflight result

RESEARCH_EXECUTED (data-quality audit only). OOS_EVALUATED: no. The strategy/backtest workstream remains blocked.
