# Context Strategy Research - Run 33
As of 2026-11-08 01:45 UTC

**Execution:** RESEARCH_EXECUTED  
**Untouched OOS:** OOS_EVALUATED  
**OOS_VALIDATED entries:** 0  
**Trading decision:** NO_TRADE for SOLUSDT, ETHUSDT and XRPUSDT.

## 1. Research progress

This run completed one frozen SOLUSDT 4h experiment and refreshed the hourly market snapshot.

- 84 new completed candles appended in this run: 5m 60 rows, 15m 16 rows and 1h 4 rows.
- The prior 68-row 00:23Z delta was added to the archive index.
- Raw index now records 81 incremental deltas / 4,004 rows.
- Latest completed highwaters: 5m 01:30Z; 15m 01:15Z; 1h 00:00Z; 4h 20:00Z.
- SOL 4h canonical history: 13,461 rows from 2020-09-14 08:00Z to 2026-11-05 16:00Z.
- SOL funding history: 6,813 records from 2020-09-14 08:00:00.008Z to 2026-11-08 00:00Z.
- Raw data, manifests and archive index were read back and verified.

The missing 76-row delta was checked on all 21 accessible raw archive branches. Exact-path Git history returned zero commits on run18, run11 and main. It is formally marked IRRECOVERABLE_IN_CURRENT_ACCESSIBLE_GITHUB_HISTORY. The 76 rows remain excluded; they were not reconstructed.

## 2. Context discovery

### SOL 4h OOS context distribution

The fixed EMA50 rule classified 2,219 untouched OOS bars:

| Context | Bars | Share | Runs | Mean duration |
|---|---:|---:|---:|---:|
| BULL | 774 | 34.88% | 58 | 13.34 bars |
| BEAR | 1,129 | 50.88% | 75 | 15.05 bars |
| TRANSITION | 316 | 14.24% | 131 | 2.41 bars |

Transitions were mostly routed through TRANSITION: BULL->TRANSITION 58; BEAR->TRANSITION 73; TRANSITION->BULL 57; TRANSITION->BEAR 74; BEAR->BULL 1. This is descriptive for SOL 4h only, not a fitted multi-symbol taxonomy. Context labels are not win probabilities.

## 3. Strategy-context scorecard

### SOLUSDT 4h Donchian20 + EMA50

Frozen rules:
- Completed close beyond prior 20-bar high/low.
- EMA50 price/slope context: BULL or BEAR.
- Entry at next 4h open.
- Stop 1.5 x Wilder ATR(14); target 2R; time stop 6 bars.
- One position at a time; stop-first when both barriers are touched.
- 1% equity risk; 3x maximum notional leverage.
- 5 bps taker fee, 2 bps half-spread and 2 bps slippage per side; actual SOL funding applied.

Chronological splits:
- Train: 8,866 bars; 416 trades.
- Validation: 2,376 bars; 117 trades.
- Untouched OOS: 2,219 bars; 103 trades; 2025-11-01 00:00Z to 2026-11-05 19:59:59.999Z.

| OOS context | Trades | Win rate | Target before stop | Mean net R | PF | 97.5% block-bootstrap CI |
|---|---:|---:|---:|---:|---:|---:|
| BULL | 46 | 41.30% | 15.22% | -0.127R | 0.731 | [-0.515, 0.323] |
| BEAR | 57 | 40.35% | 12.28% | -0.071R | 0.845 | [-0.362, 0.227] |

Overall OOS: 103 trades; mean -0.0958R; PF 0.791; net PnL -992.39 USDT on 10,000 USDT starting equity (-9.92%); maximum drawdown 18.98%. There were 43 stop exits, 14 target exits and 46 time exits. Fees were 333.57 USDT, estimated spread/slippage 266.85 USDT and funding cashflow -34.71 USDT.

Additional OOS execution metrics (exposure is the share of all 2,219 OOS bars spent in trades from that context; turnover is entry-plus-exit notional divided by initial equity):

| Context | Eligible bars | Average win (R) | Average loss (R) | Average hold (bars) | Exposure | Turnover |
|---|---:|---:|---:|---:|---:|---:|
| BULL | 774 | +0.977 | -0.904 | 4.17 | 8.65% | 33.20x |
| BEAR | 1,129 | +0.996 | -0.792 | 4.51 | 11.58% | 33.52x |

The reported 97.5% mean-R intervals use 2,000 circular block-bootstrap replicates, block length 5 trades, seed 20261108 and Bonferroni alpha 0.025 for the two predeclared contexts. Win rate is the fraction of trades with positive net PnL after modeled costs. Target-before-stop is target hits divided by all trades; time exits count as no target. The confidence intervals cross zero in both contexts.

Training/validation diagnostics:
- Train BULL: 232 trades, +0.025R, PF 1.045; BEAR: 184 trades, -0.028R, PF 0.919.
- Validation BULL: 63 trades, +0.050R, PF 1.105; BEAR: 54 trades, +0.114R, PF 1.302.
- The validation block-bootstrap intervals also crossed zero. The 18/20/22 lookback neighborhood was positive in validation, but the frozen 20-bar rule failed OOS.

Quarter-window OOS mean net R (trade counts in parentheses):
- BULL: -0.357 (10), -0.839 (9), -0.076 (11), +0.381 (16).
- BEAR: -0.026 (21), -0.330 (13), +0.270 (12), -0.221 (11).
Only one of four windows was positive in each context.

**Overall status: REJECTED.** The predeclared maximum drawdown gate was 15%; observed drawdown was 18.98%. Net expectancy was negative and PF was below 1. Per-context entries remain **INSUFFICIENT_EVIDENCE** because neither context reached 100 OOS trades and both adjusted confidence intervals cross zero.

Validation looked better: BULL mean +0.050R / PF 1.105; BEAR +0.114R / PF 1.302. Validation-only lookbacks 18/20/22 were positive in both contexts. That validation strength did not survive OOS. Only one of four OOS subwindows was positive in each context.

The Donchian20 baseline without the EMA filter also lost money: 127 trades, ending equity 8,877.83 USDT, max drawdown 21.44%. Its BULL, BEAR and TRANSITION mean net R values were -0.076, -0.049 and -0.176. The spot buy-and-hold price-return proxy was -51.88%; it is not directly comparable to the leveraged futures strategy.

Existing SOL BULL_LOW Donchian20 v0.1.0 remains OOS_PROMISING with only 12 trades. It is not promoted and is not applicable to the current bearish SOL context. The registry now contains no OOS_VALIDATED entries.

## 4. Key discoveries

1. Positive validation expectancy did not generalize to the untouched test.
2. Both BULL and BEAR breakout variants had negative net expectancy after costs; the baseline without EMA was worse.
3. The strategy's overall drawdown exceeded the predeclared risk ceiling.
4. The context-specific sample is too small to estimate conditional win probabilities reliably.
5. TRANSITION had 316 OOS bars but no entries by design; this does not prove TRANSITION is intrinsically untradeable.

## 5. Current context snapshot

Market snapshot: 2026-11-08 01:44:59 UTC. Rolling OHLCV used 200 completed bars per symbol/interval; one forming candle was excluded.

| Symbol | 5m | 15m | 1h | 4h | 20-bar 4h return |
|---|---|---|---|---|---:|
| BTC | BULL | BEAR | BEAR | BEAR | -4.94% |
| ETH | BULL | TRANSITION | BEAR | BEAR | -6.94% |
| SOL | BEAR | BEAR | BEAR | BEAR | -7.07% |
| XRP | BULL | BEAR | BEAR | BEAR | -9.52% |

All four are bearish on 1h and 4h. Lower timeframes are mixed. This is not a reversal trigger. Current 4h EMA50 slopes: BTC -1.34%, ETH -1.82%, SOL -1.95%, XRP -4.51%.

Current prices and 24h change:
- BTC: 75,747.10; -0.296%.
- ETH: 2,234.66; -0.461%.
- SOL: 89.1700; -1.372%.
- XRP: 1.1590; -1.713%.

Current indicated funding: BTC 0.006286%, ETH 0.004501%, SOL 0.004465%, XRP 0.009466%. Last settled funding at 00:00Z: 0.005257%, 0.004572%, 0.003475%, 0.009908%. Current funding interval is 8 hours; next settlement is 08:00Z. No observed rate exceeds 0.05%.

Open interest fell over the 5-hour observation window: BTC -0.233%, ETH -0.513%, SOL -0.448%, XRP -1.470%. Latest completed taker buy/sell ratios (00:00Z): 0.8658, 0.7717, 0.7777, 0.9337. Global long-account shares at 01:00Z: 75.47%, 77.88%, 78.25%, 73.47%. These are positioning observations, not evidence of liquidations.

## 6. Decision matrix

| Symbol | OOS_VALIDATED setup | Trigger | Decision |
|---|---|---|---|
| SOLUSDT | None | Not eligible | NO_TRADE |
| ETHUSDT | None | Not eligible | NO_TRADE |
| XRPUSDT | None | Not eligible | NO_TRADE |

No entry, stop or target levels are issued. There is no validated strategy to execute.

## 7. Mandatory preflight

| Check | Status | Evidence / impact |
|---|---|---|
| Shell / compute | PASS | Linux 6.18.57; Python 3.13.5; 5 CPUs; about 4.82 GiB available RAM; about 30 GiB free disk. |
| Repo / code | DEGRADED | No local checkout. GitHub connector accessible. |
| Node / SDK | BLOCKED | Node 22.16.0/npm 10.9.2, below Node24/npm11 target. Binance Node SDK packages unavailable. |
| Network | DEGRADED | Binance/GitHub connectors returned data. Direct shell DNS failed; HTTP status/headers not exposed by connector. |
| Binance server time | NOT_CHECKED | No dedicated server-time connector action was exposed in this run. |
| Exchange metadata | BLOCKED | exchangeInfo serverTime was 38.45 hours stale; do not use its contract filters/status for execution. |
| Raw historical archive | DEGRADED | SOL 4h and funding verified; multi-year 5m/15m archive absent; other symbols' canonical pages not all re-read. |
| Data quality | PASS / DEGRADED | SOL 4h and current rolling series passed; full multi-symbol archive coverage remains incomplete. |
| Backtest / smoke test | PASS | Persisted JS harness executed in managed Code Mode V8; deterministic repeat and future-data perturbation test passed. Local repository test runner not invoked. |
| Storage / readback | PASS | GitHub writes and readback verification completed for data, index, spec, harness, result, registry and queue. |

## 8. Next research work

1. Backfill multi-year 5m and 15m history for BTC/ETH/SOL/XRP in bounded pages.
2. Fetch and validate all four 4h canonical files; build BTC-led context, rolling correlation and relative-strength taxonomy.
3. Backfill BTC/ETH/XRP funding history and broader OI history.
4. Provision Node24/npm11 and a local repository checkout; integrate the harness into repository tests.
5. Only after data/context readiness, run a separate ETH 4h experiment. Do not transfer SOL evidence.
6. Weekly taxonomy review remains due 2026-11-14.

## Artifacts

- Experiment spec: `research/context-strategy/experiments/specs/solusdt_4h_donchian20_ema50_v1_spec.json`
- Harness: `research/context-strategy/harnesses/sol_4h_donchian_ema50_v1.js`
- Experiment result: `research/context-strategy/experiments/results/solusdt_4h_donchian20_ema50_20261108T0140Z.json`
- Registry v82: `research/context-strategy/registries/context_strategy_registry_20261108T0142Z_v82.json`
- Queue v84: `research/context-strategy/queues/research_queue_20261108T0145Z_v84.json`
- Missing-delta recovery audit: `research-data/binance-usdm/audits/missing_delta_recovery_20261108T0143Z.json`

**Final status: RESEARCH_EXECUTED + OOS_EVALUATED. No OOS_VALIDATED strategy. NO_TRADE.**
