# Binance USD-M conditional strategy research - v107

**As of:** 2026-11-13 19:11 UTC (local calendar date 2026-11-14)  
**Run status:** RESEARCH_BLOCKED  
**Universe:** SOLUSDT, ETHUSDT, XRPUSDT tradable; BTCUSDT reference only.

## 1. Research progress

- Refreshed current USD-M market data and completed-candle context for BTC, ETH, SOL and XRP.
- Retrieved 100 klines per symbol on 5m/15m/1h/4h: 1,600 rows returned, 1,584 completed, 16 forming rows excluded. The 100-bar sample is monitoring context only, not a multi-cycle research dataset.
- Appended **104 completed rows** to the remote raw archive: 5m 72, 15m 24, 1h 8, 4h 0. Four delta files/manifests and the 5m/15m/1h archive indexes were read back and verified.
- No strategy experiment, taxonomy refit, chronological validation or untouched OOS evaluation ran. No status transition or promotion occurred.
- The daily experiment is blocked by the missing local checkout/compatible runtime, incomplete 5m/15m history, 4h reconciliation and cost calibration.

Archive branch: `research/raw-ohlcv-archive-20261113T063450Z-run11`. The local workspace has no raw archive copy; persistence is remote GitHub, not ChatGPT Library storage.

## 2. Context discovery

The v56 taxonomy is carried forward, not refit. No occupancy, duration, transition matrix, stability or classification-uncertainty estimates were produced.

Current descriptive feature state:
- **Trend:** EMA20/EMA50 plus a descriptive EMA20 slope on completed candles. All four symbols are bearish on 1h and 4h.
- **Volatility:** ATR14/close is reported descriptively; low/normal/high thresholds remain UNKNOWN because training-only percentiles were not refit.
- **Structure:** range/breakout/retest/failure labels remain UNKNOWN; no structural detector was tested.
- **Participation:** 15m taker flow and one 20-level book snapshot are observations only; no training distribution or persistence test.
- **Derivatives:** current indicated funding, recent settled funding and 1h OI changes are observations; no funding/OI strategy was tested.
- **BTC-led state:** BTC is bearish on 1h/4h and all alts share that higher-timeframe direction. Lead/lag and rolling correlation were not estimated.
- **Shock/data:** UNKNOWN. 4h 20-bar returns are materially negative and last completed 4h volume is about 1.9-2.45x the 20-bar median, but no training-calibrated shock threshold exists.

Feature-state confidence is high for the 1h/4h bearish alignment and lower for the mixed short timeframes. It is not a probability of trade success.

## 3. Strategy-context scorecard

| Strategy / context | Symbol | Evidence status | Evidence |
|---|---|---|---|
| Donchian20 4h breakout walk-forward v2, 36 cells | ALL | INSUFFICIENT_EVIDENCE | Every cell below 100 OOS trades; nominal block-bootstrap intervals include zero; Holm-adjusted p=1.0; 15bp round-trip proxy uncalibrated. |
| Donchian20 4h breakout v2, BULL_LOW | SOLUSDT | OOS_PROMISING | 12 OOS trades; win 66.7%; target before stop 41.7%; mean net 0.606R; PF 2.72; max DD 1.3R; block-bootstrap 95% CI [0.086, 1.199]. Not recomputed this run; sample and cost/robustness gates fail. |
| Trend/pullback continuation | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Breakout/retest and volatility contraction | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Range mean reversion / failed-breakout fade | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Volatility expansion / momentum | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| BTC-led confirmation / relative strength | SOL/ETH/XRP | HYPOTHESIS | Not tested. |
| Funding/OI filters | SOL/ETH/XRP | HYPOTHESIS | Not tested. |

**OOS_VALIDATED entries: 0.** The SOL OOS_PROMISING summary is research-only. It is not an actionable setup.

## 4. Key discoveries and blockers

- The live multi-timeframe state is broadly bearish on 1h/4h, with mixed or short-lived countertrend action on 5m/15m. This is not an entry signal.
- No context-conditioned edge was discovered or rejected in this run; no experiment ran.
- Remote source inspection found concrete harness defects:
  1. `scripts/backtest.ts` defaults to BTCUSDT and its timeframe list is 15m/1h/4h (no 5m).
  2. The API kline mapping drops closeTime; the Candle type has no closeTime field, so completed-candle exclusion is not established in that path.
  3. `validateCandles` accepts zero volume because it rejects only volume < 0.
  4. `scripts/conditional-edge.ts` defaults to min-n 30 and 90% bootstrap confidence; no explicit purge/embargo CLI control is exposed.
  5. Repository requirements are Node >=24/npm >=11; this runtime is Node 22.16/npm 10.9.
- These are source-level findings, not a locally executed test result. No fix was made.

## 5. Current market snapshot

**Market timestamp:** 2026-11-13 19:05:25 UTC.  
**Completed candle sample:** retrieved through 19:06:18 UTC.

| Symbol | Mark | 24h change | 1h / 4h trend | 1h / 4h ATR14/close | 1h / 4h 20-bar return |
|---|---:|---:|---|---:|---:|
| BTCUSDT | 68,918.41 | -3.612% | Bear / Bear | 0.985% / 1.743% | -3.406% / -7.930% |
| ETHUSDT | 1,943.50 | -3.253% | Bear / Bear | 1.143% / 2.148% | -3.464% / -8.549% |
| SOLUSDT | 80.0698 | -1.465% | Bear / Bear | 1.231% / 2.326% | -1.633% / -7.042% |
| XRPUSDT | 1.0232 | -0.215% | Bear / Bear | 1.249% / 2.284% | -1.129% / -6.874% |

Lower timeframes: BTC and ETH 5m mixed / 15m bearish; SOL 5m mixed / 15m mixed; XRP 5m bullish / 15m mixed. Transition warning applies to all four because lower-timeframe action is not aligned with the 1h/4h downtrend.

Funding is positive but not extreme: indicated rates are BTC 0.009435%, ETH 0.004999%, SOL 0.010000%, XRP 0.009591%; none exceeds |0.05%|. Latest settled funding was at 16:00 UTC; settlements at 00:00/08:00/16:00 imply an 8h interval. Next funding is 2026-11-14 00:00 UTC.

OI change from 17:00 to 19:00: BTC -0.283%, ETH -0.253%, SOL -0.440%, XRP +0.448%. Latest 15m taker buy/sell ratios (18:45 bar): BTC 1.5526, ETH 1.2689, SOL 1.4577, XRP 0.6439. Global long/short account ratios at 19:00: BTC 3.1118, ETH 3.7438, SOL 3.4346, XRP 3.0128. These are positioning observations, not proof of crowding.

Top-of-book spreads: BTC 0.0145bp, ETH 0.0515bp, SOL 1.249bp, XRP 0.977bp. One 20-level book snapshot showed top-20 quantity imbalance BTC +4.47%, ETH +46.50%, SOL -6.18%, XRP +11.76%; the depth snapshot had no event timestamp and is not synchronized exactly to the ticker. No liquidation inference is made.

## 6. Decision matrix

| Symbol | OOS_VALIDATED strategy | Trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | Not evaluated | **NO_TRADE** | No validated registry entry; SOL BULL_LOW candidate is only OOS_PROMISING and current 1h/4h context is bearish. |
| ETHUSDT | None | Not evaluated | **NO_TRADE** | No OOS_VALIDATED entry and no frozen trigger rule. |
| XRPUSDT | None | Not evaluated | **NO_TRADE** | No OOS_VALIDATED entry and lower-timeframe strength is not a validated trigger. |

No entry, stop or target is supplied. BTCUSDT remains reference-only.

## 7. Data audit, costs, unavailable inputs and next experiments

### Preflight

| Check | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell/compute | PASS | Linux x86_64, Python 3.13.5, Node 22.16, npm 10.9, 3 CPUs, ~5.8 GiB RAM, ~30 GiB free | Local calculations possible; provision Node 24/npm 11. |
| Repo/code | BLOCKED | No local checkout; remote source only | Clone exact branch before invoking scripts. |
| Network/Binance | DEGRADED | Direct DNS failed; connector returned current data; exchangeInfo serverTime is 13h03m stale | Restore direct HTTPS and fresh server time/metadata. |
| Raw archive | DEGRADED | 1h multi-year; 5m/15m base absent; 4h canonical/raw mismatch | Backfill and reconcile. |
| Data quality/coverage | DEGRADED | Recent 1,600-row sample clean; historical coverage incomplete | Current snapshot is valid; research sample is not. |
| Backtest/smoke test | BLOCKED | No compatible local runtime; no fixture smoke test | Fix candle contract, volume and universe defects; smoke-test. |
| Disk/storage | PASS | ~30 GiB free; GitHub remote writes work | Continue remote persistence. |
| Artifact readback | PASS | 104 rows, deltas/manifests and three indexes verified | Finish v107 report artifact readback. |

### Cost and unavailable inputs

- Fee tier and maker/taker execution fees were not obtained.
- One best-bid/ask and one 20-level book snapshot are insufficient to estimate size-dependent market impact.
- Historical synchronized depth/trades, latency and fill distributions are unavailable.
- Full funding history aligned to simulated positions is unavailable.
- Liquidations are unavailable; no liquidation or crowding claims are made.
- No local backtest harness execution, deterministic smoke test, block bootstrap, multiple-testing experiment or OOS run occurred.

### Next research queue

1. Fix completed-candle contract, positive-volume validation, 5m replay, BTC reference-only enforcement and purge/embargo tests.
2. Backfill multi-year 5m/15m history and rebuild/reconcile 4h canonical data.
3. Provision Node 24/npm 11 and run a deterministic tiny-fixture smoke test.
4. Calibrate fee tier, spread, impact, slippage, funding and fill assumptions.
5. Only then freeze one strategy x context x symbol experiment with chronological train/validation/untouched test, >=100 OOS trades per symbol/context for provisional evidence, block bootstrap, parameter neighborhoods and multiple-testing control.

**Run classification: RESEARCH_BLOCKED.** Monitoring and remote archive append completed; no research experiment or OOS evaluation completed.
