# Binance USD-M context-conditioned strategy research

**As of:** 2026-11-14 02:39 UTC
**Execution classification:** RESEARCH_EXECUTED (incremental archive/data-quality only).
**Strategy experiment:** BLOCKED. **Untouched OOS:** NOT EVALUATED.
**Trade selection:** NO_TRADE for SOLUSDT, ETHUSDT and XRPUSDT.

## 0. Mandatory preflight

| Capability/check | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell/compute | DEGRADED | Debian 13; Python 3.13.5; Node 22.16.0; npm 10.9.2; 3 CPUs; 4.95 GB RAM available; 32.03 GB disk free. | Bounded processing works; provision Node 24/npm 11 for project runner. |
| Repo/code | DEGRADED | Remote GitHub main source commit 77c32a5f...; research/backtest scripts readable; no local checkout or node_modules. | Inspectable but not locally invokable; checkout exact commit on compatible runtime. |
| Network/Binance endpoints | DEGRADED | Direct REST probes HTTP 000: /time DNS exit 6; /exchangeInfo DNS timeout exit 28; /klines exit 6; /premiumIndex timeout exit 28; /openInterest exit 6; /ticker/24hr timeout exit 28. Connector calls succeeded; HTTP status/headers not exposed. | Monitoring and append possible; restore DNS/HTTPS for direct official endpoint validation. |
| Raw historical archive | DEGRADED | GitHub archive branch updated; 36 completed rows appended in two deltas; v116 manifest, receipts and all four indexes read back. | Incremental continuity verified; historical base remains partial/degraded. |
| Data quality/coverage | DEGRADED | Current sample 7,984 completed bars, 16 forming excluded, zero sample failures. Historical page-0028/1h/4h defects remain. | Monitoring sample is not a multi-cycle research panel; reconcile archive lineage. |
| Backtest harness/smoke test | BLOCKED | Node/npm below project floor; no local checkout; SDK absent; deterministic fixture and no-lookahead smoke test not run. | No strategy backtest or OOS claim; provision compatible runtime and run fixture twice. |
| Disk/storage | PASS | 32.03 GB free; GitHub archive branch writable. | Persistent remote storage is available; continue atomic writes and readback. |
| Artifact readback | PASS | Two deltas, two delta manifests, archive manifests v115/v116, four indexes and two receipts verified. | Incremental append persistence is verified. |
| Exchange metadata/server time | BLOCKED | exchangeInfo serverTime 2026-11-13 06:02:01.701Z, 74,253 seconds stale at 2026-11-14 02:39:35Z; direct time/metadata probes fail. | Reported TRADING status is stale; no execution validation. |

**Required classification:** RESEARCH_EXECUTED (data-quality only). OOS_EVALUATED was not achieved.

## 1. Research progress

- Appended **36 completed rows** to the persistent raw archive: 5m 28, 15m 8, 1h 0, 4h 0; 9 rows per symbol. 52 rows were fetched and 16 forming rows excluded.
- Both slices passed continuity, duplicate, off-grid, monotonicity, OHLC, finite-value, positive-volume and close-time checks with zero failures. Cross-symbol alignment passed for the appended slices.
- Archive manifest v116 and all four indexes were updated and read back. Highwaters: 5m 02:30Z, 15m 02:15Z, 1h 01:00Z, 4h 12:00Z. The 4h append remains held.
- Current 16-series monitoring sample: 500 returned per series, 499 completed per series, 7,984 completed total and 16 forming excluded; zero quality failures.
- No strategy backtest, training fit, validation selection, untouched OOS, or promotion ran.

### Historical coverage and adequacy

| Interval | Historical base | Incremental highwater | Status / blocker |
|---|---|---|---|
| 5m | 168,000 base rows (42,000/symbol), 2020-01-01 to 2021-02-07 02:55Z, 28 pages | 2026-11-14 02:30Z | PARTIAL: page-0028 symbol windows differ; 4/4 SHA mismatches. Large gap to current deltas. |
| 15m | 168,000 base rows (42,000/symbol), 2020-01-01 to 2021-11-25 18:45Z, 28 pages | 2026-11-14 02:15Z | PARTIAL: 4/4 page-0028 SHA mismatches; 6 zero-volume rows vs 4 index exclusions. |
| 1h | 215,504 base rows (53,876/symbol), from 2020-09-14 | 2026-11-14 01:00Z | DEGRADED: 28 missing hourly opens per symbol and 8-row discrepancy. |
| 4h | Raw 53,960; aligned 53,816; canonical 53,844, from 2020-09-14 | 2026-11-13 12:00Z | DEGRADED/HELD: 13 page-manifest SHA mismatches; 8 newer completed rows held. |

The short monitoring windows are 5m 2026-11-12 09:00Z to 2026-11-14 02:30Z; 15m 2026-11-08 21:45Z to 2026-11-14 02:15Z; 1h 2026-10-24 07:00Z to 2026-11-14 01:00Z; 4h 2026-08-22 20:00Z to 2026-11-13 20:00Z. These are not sufficient to claim multi-cycle generalization.

## 2. Context discovery

### Frozen historical taxonomy - carried forward, not refit

The latest accessible diagnostic is CTX-4H-EMA50xEMA200-ATRQ-v2-FULL-ARCHIVE, created 2026-11-08. It uses per-symbol EMA50/EMA200 spread thresholds for trend (flat threshold), Wilder ATR14/close training q33/q67 for LOW/NORMAL/HIGH volatility, and training q99 of absolute completed 4h return for a separate SHOCK state. Thresholds were inherited from V100 and were not refit in the Nov 8 diagnostic or this run.

Source panel: 13,461 completed 4h bars per symbol from 2020-09-14 08:00Z through 2026-11-05 16:00Z; 12,462 labelled bars per symbol after 999 EMA warm-up bars. The diagnostic split was chronological 60/20/20: 7,077 train, 2,692 validation and 2,693 test bars per symbol. All four historical series passed their contemporaneous integrity checks and were cross-symbol aligned. This supports descriptive 4h context distributions, not strategy edge or multi-timeframe generalization. The current archive has since developed page-0028/1h/4h provenance issues; this old distribution has not been recomputed on the repaired/current archive.

| Symbol | Most frequent contexts (frequency; median run in 4h bars) | Shock frequency | Overall self-transition | Top self-transition | Train/test JSD |
|---|---|---:|---:|---|---:|
| BTC | SIDEWAYS_LOW 25.56% (11.5); BULL_LOW 16.05% (12); BEAR_HIGH 11.79% (7) | 0.634% | 93.03% | SIDEWAYS_LOW 97.05% | 0.202 |
| ETH | SIDEWAYS_LOW 18.58% (9); BULL_NORMAL 16.24% (8); BEAR_HIGH 14.03% (8) | 0.746% | 92.64% | SIDEWAYS_LOW 95.64% | 0.108 |
| SOL | SIDEWAYS_LOW 24.77% (10); BEAR_LOW 12.86% (7); BULL_NORMAL 11.86% (5.5) | 0.586% | 92.38% | SIDEWAYS_LOW 96.73% | 0.297 |
| XRP | SIDEWAYS_LOW 18.86% (9.5); BEAR_LOW 17.12% (14); BEAR_NORMAL 14.23% (8) | 0.554% | 92.91% | BEAR_LOW 96.16% | 0.128 |

Shock states had median duration one 4h bar for all symbols. The largest train/test distribution shift diagnostic is SOL (JSD 0.297), followed by BTC (0.202), XRP (0.128) and ETH (0.108); these are distribution diagnostics, not p-values or evidence of a strategy edge.

| Symbol | Flat EMA50/EMA200 spread threshold | ATR14/close q33 | q67 | Absolute 4h return shock q99 |
|---|---:|---:|---:|---:|
| BTC | 2.5048% | 1.4474% | 2.0674% | 4.8982% |
| ETH | 2.5106% | 1.7550% | 2.5876% | 6.3197% |
| SOL | 4.0735% | 2.7494% | 4.0357% | 9.7612% |
| XRP | 2.3359% | 1.9936% | 3.0167% | 9.0980% |

These thresholds remain frozen. This run did not recompute context frequencies, durations, transitions or stability. The live 5m/15m/1h/4h EMA/ATR labels below are descriptive monitoring features and are not the same as the frozen 4h taxonomy. Full prior distribution and transition counts are retained in context_discovery_snapshot.json.

## 3. Strategy-context scorecard

The accessible registry contains five SOL-specific entries: four INSUFFICIENT_EVIDENCE, one REJECTED, zero OOS_PROMISING and zero OOS_VALIDATED. No ETH/XRP symbol-specific evidence exists.

| SOL context / strategy | Status | OOS trades | Win rate | Target before stop | Mean net R (95% CI) | PF | Max DD | Quote PnL/SOL |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| BULL_LOW - Donchian 15 breakout | INSUFFICIENT_EVIDENCE | 55 | 43.6% | 21.8% | +0.043 [-0.280, +0.390] | 1.082 | 7.89R | -19.83 USDT |
| SIDEWAYS_LOW - failed-breakout fade | REJECTED | 113 | 43.4% | 27.4% | -0.148 [-0.318, +0.020] | 0.787 | 20.79R | -26.58 USDT |
| BEAR_NORMAL - EMA20 pullback recross with BTC confirm | INSUFFICIENT_EVIDENCE | 10 | 40.0% | 10.0% | -0.189 [-0.860, +0.779] | 0.733 | 3.48R | -8.23 USDT |
| BULL_COMPRESS - volatility contraction breakout | INSUFFICIENT_EVIDENCE | 18 | 33.3% | 11.1% | -0.205 [-0.723, +0.295] | 0.687 | 7.43R | -23.27 USDT |
| BEAR_COMPRESS - volatility contraction breakout | INSUFFICIENT_EVIDENCE | 26 | 34.6% | 19.2% | -0.115 [-0.683, +0.371] | 0.814 | 7.81R | -0.53 USDT |


### Additional stored OOS diagnostics

| Strategy | Eligible context observations | Average win / loss R | Exposure | Turnover (USDT) | Baseline comparison |
|---|---:|---:|---:|---:|---|
| Donchian BULL_LOW | Not recorded | +1.298 / -0.928 | 10.52% | 16,364 | 125-trade unconditional baseline: mean -0.080R, PF 0.862, DD 21.56R, PnL -76.09 USDT/SOL. |
| SIDEWAYS_LOW failed-breakout fade | 1,291 | +1.005 / -1.031 | 13.36% | 24,935 | 214-trade baseline: mean -0.011R, PF 1.064, DD 23.01R, PnL +17.39 USDT/SOL. |
| BEAR_NORMAL pullback recross | Not recorded | +1.078 / -1.033 | 2.61% | 2,054 | BTC-filter ablation mean -0.152R/PF 0.815; buy-and-hold -95.42 USDT/SOL. |
| BULL_COMPRESS volatility breakout | 320 | Not reported | Not reported | Not reported | Not stored in the registry entry. |
| BEAR_COMPRESS volatility breakout | 407 | Not reported | Not reported | Not reported | Not stored in the registry entry. |

Percentage net return and Sharpe/Sortino are not present in the stored entries; quote PnL per SOL is shown where available. Eligible observations, average win/loss, exposure and turnover are marked not recorded where the source artifact omits them. The failed-fade OOS used a circular moving-block bootstrap (2,000 reps, block length 5); the registry retains the other interval details and failure modes.

Only the SIDEWAYS_LOW failed-breakout fade is genuinely REJECTED by an OOS test. The other four fail the sample/uncertainty gates and must remain INSUFFICIENT_EVIDENCE. Existing tests use a 15bp round-trip proxy that is not calibrated to account-specific fills. Do not transfer SOL results to ETH or XRP.

## 4. Key discoveries

1. The recorded SOL SIDEWAYS_LOW failed-breakout fade failed net expectancy, profit factor, drawdown and parameter-neighborhood gates; it is REJECTED.
2. SOL Donchian BULL_LOW has a slightly positive mean R but only 55 OOS trades, a confidence interval crossing zero and negative quote PnL; it is not validated.
3. BTC-confirmed SOL pullback and compression candidates remain insufficient evidence.
4. No ETH or XRP conditional edge is demonstrated in the accessible registry.
5. A bearish regime or 15m breakdown is not an entry trigger. No strategy is promoted this run.

## 5. Current context snapshot

**Kline features:** 2026-11-14 02:35:09Z. **Mark/ticker/book:** 02:35:25Z. **OI/positioning:** 02:35:40Z.

| Symbol | 4h | 1h | 15m | 5m | 24h | 72h corr. to BTC | Relative 24h vs BTC |
|---|---|---|---|---|---:|---:|---:|
| BTC reference | Bear; ATR percentile 0.97 | Bear | Bear; z=-4.33; volume 13.8x; downside break | Bear; +0.23% last bar bounce | -4.30% | 1.00 | -- |
| ETH | Bear; ATR percentile 0.86 | Bear | Bear; z=-4.48; volume 14.9x; downside break | Bear; +0.55% last bar bounce | -4.93% | 0.892 | -0.42pp |
| SOL | Bear; ATR percentile 0.88 | Bear; downside break | Bear; z=-3.33; volume 6.2x; downside break | Bear; +0.16% last bar bounce | -6.25% | 0.798 | -1.50pp |
| XRP | Bear; ATR percentile 0.87 | Bear | Bear; z=-2.43; volume 10.4x; downside break | Bear; +0.48% last bar bounce | -2.76% | 0.661 | +1.12pp |

All four symbols have bearish EMA alignment on 5m/15m/1h/4h. 4h remains inside its prior 20-bar range; 15m has a downside break on all four; 5m has a positive last bar after the 15m selloff. BTC/ETH/SOL 15m one-bar z-scores are below -3; XRP has high volume but z=-2.43. This is a shock/transition warning, not a short signal.

### Current price, derivatives and liquidity measurements

| Symbol | Last | Mark | 24h change | 24h high / low | 24h quote volume | OI contracts | OI 1h change | Top spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| BTCUSDT (reference) | 67,387.70 | 67,377.58 | -4.30% | 70,454 / 66,850.4 | 19.32B USDT | 97,338.576 | +0.111% | 0.015bp |
| ETHUSDT | 1,899.15 | 1,899.52 | -4.931% | 1,999.03 / 1,875.00 | 11.81B USDT | 2,303,390.859 | +0.079% | 0.053bp |
| SOLUSDT | 75.58 | 75.6008 | -6.252% | 82.38 / 74.96 | 2.15B USDT | 9,355,436.01 | +0.193% | 1.323bp |
| XRPUSDT | 0.9963 | 0.99593 | -2.762% | 1.0433 / 0.9831 | 862.48M USDT | 295,742,998.2 | +0.046% | 1.005bp |

Prices and 24h statistics are from the ticker/mark snapshot; OI is the live open-interest endpoint. OI percentage changes use the latest 1h OI-statistics bucket (02:00Z versus 01:00Z), not a same-instant calculation. Top spread is the full best-bid/ask spread, not estimated round-trip execution cost.

Current premiumIndex lastFundingRate fields are BTC 0.001053%, ETH 0.000461%, SOL 0.004878%, XRP 0.003390%. Latest settled funding at 00:00Z is 0.005972%, 0.001200%, 0.006550%, 0.005028% respectively; all intervals are 8h and next funding is 08:00Z. None exceeds |0.05%|. One-hour OI changes are small positives: BTC +0.111%, ETH +0.079%, SOL +0.193%, XRP +0.046%. Taker buy/sell ratios for the 01:00Z hour are BTC 1.032, ETH 0.669, SOL 0.769, XRP 0.856. Global long/short account ratios at 02:00Z are 3.24-3.74; these are account ratios, not notional positions and not proof of crowding.

Top-of-book full spreads are BTC 0.015bp, ETH 0.053bp, SOL 1.323bp and XRP 1.005bp. Top-level size imbalance is BTC -0.467, ETH +0.291, SOL -0.866 and XRP -0.600. These are top-of-book observations only, not a full depth or impact model.

## 6. SOL / ETH / XRP decision matrix

| Symbol | OOS_VALIDATED setup | Exact trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | Not applicable | NO_TRADE | Zero validated entries; 15m downside impulse, 5m bounce, wider top-of-book spread and stale contract metadata. |
| ETHUSDT | None | Not applicable | NO_TRADE | Zero validated entries; 15m shock and 5m bounce; no ETH-specific OOS evidence. |
| XRPUSDT | None | Not applicable | NO_TRADE | Zero validated entries; 15m downside break with 10.4x volume and 5m bounce; no XRP-specific OOS evidence. |

No entry, stop, target or size is supplied because no validated trigger exists. BTC remains reference only.

## 7. Data audit, costs, unavailable inputs and next experiments

- Direct REST: HTTP 000 on all six probes due DNS failures/timeouts. Connector data is fresh but connector HTTP status/headers are unavailable. exchangeInfo serverTime is stale by 74,253 seconds; contract status is not execution-valid.
- Archive: incremental deltas are readback-verified; page-0028 SHA mismatch is a provenance failure, not proof of corrupted candle values. 1h and 4h historical lineage remains degraded. Do not append 4h until reconciled.
- Costs: current top-of-book spread is observed, but account fee tier, historical depth/trades, impact, slippage, latency, partial fills and funding cashflows are not calibrated. Prior 15bp round-trip cost is only a proxy.
- Unavailable: fresh exchange server time/metadata, continuous multi-cycle aligned 5m/15m/1h/4h panel, point-in-time derivatives history, liquidation feed and deterministic local backtest execution.
- Next: (1) reconcile page-0028 hash basis and symbol windows plus 15m zero-volume discrepancy; (2) reconcile 1h 28 missing opens and 8-row count; (3) reconcile 4h raw/aligned/canonical keys and 13 hashes; (4) restore direct DNS and fresh metadata; (5) provision Node24/npm11 and run deterministic no-lookahead fixture; (6) build PIT derivatives and calibrated costs; (7) only then preregister a symbol/context experiment and apply the >=100 OOS trade gate.

**Research queue:** Q1 archive lineage remains the P0 blocker; Q2 fresh exchange metadata and Q3 compatible harness are blocked; Q4 derivatives/costs partial; Q5 strategy testing insufficient; Q6 taxonomy review due/blocked; Q7-Q9 completed; Q10 strategy experiment blocked.

**Persistent artifacts:** archive manifest v116 and run artifacts are stored in GitHub and read back. Registry snapshot is unchanged; no OOS promotion or trade selection occurred.
