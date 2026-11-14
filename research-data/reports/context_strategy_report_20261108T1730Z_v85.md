# Context Strategy Research — 8 November 2026, 17:30 UTC

## Run classification: `RESEARCH_BLOCKED`

**Completed:** current Binance USDⓈ-M snapshot, 76 completed OHLCV rows appended, 5m/15m/1h archive indexes updated and read back, registry status snapshot reconciled.  
**Not completed:** new strategy experiment, deterministic backtest smoke test, or untouched OOS evaluation.

## 1. Research progress

### Incremental archive

Two deltas were persisted on the existing research branch:

| Delta | Rows | 5m | 15m | 1h | 4h | SHA-256 |
|---|---:|---:|---:|---:|---:|---|
| `binance_usdm_delta_20261108T1725Z_5m15m1h_completed.jsonl` | 72 | 52 | 16 | 4 | 0 | `5cc6263c9040d33fdc187378d609bee08c13afbe50241e0b61e989254d748048` |
| `binance_usdm_delta_20261108T1730Z_5m_completed.jsonl` | 4 | 4 | 0 | 0 | 0 | `efa389d0648a8c1b723b63c6d7660dd3a21fac4aed51458b26434a86bf0208d4` |
| **Total** | **76** | **56** | **16** | **4** | **0** | |

The first delta is 28,188 bytes; the second is 1,555 bytes. Both raw files, manifests and checksum sidecars were fetched back and verified. The 5m, 15m and 1h archive indexes were updated and fetched back. The 4h index was intentionally unchanged: the 16:00Z 4h candle was still forming, so the latest completed 4h open remains 12:00Z.

| Interval | Latest completed open | Next expected open |
|---|---|---|
| 5m | 17:25Z | 17:30Z |
| 15m | 17:00Z | 17:15Z |
| 1h | 16:00Z | 17:00Z |
| 4h | 12:00Z | 16:00Z |

Across the two collection batches, 148 kline rows were fetched and 20 forming rows excluded. The 76 appended rows passed duplicate, continuity, OHLC, positive-volume, finite-value, timestamp-grid and monotonicity checks.

### Historical coverage and adequacy

| Interval | Accessible base history | Incremental state | Research adequacy |
|---|---|---|---|
| 1h | 53,871 rows/symbol from 2020-09-14 08:00Z through 2026-11-06 22:00Z | Delta chain through 2026-11-08 16:00Z | Broad historical sample, but derived pages and deltas still require a complete chain audit/merge |
| 4h | 13,461 canonical rows/symbol through 2026-11-05 16:00Z | Raw incrementals through 2026-11-08 12:00Z | Multi-year sample exists; canonical/raw reconciliation remains blocked by 13 provenance hash mismatches and row-count differences |
| 5m | No multi-year base | Recent deltas only; latest 17:25Z | Insufficient for multi-cycle inference |
| 15m | No multi-year base | Recent deltas only; latest 17:00Z | Insufficient for multi-cycle inference |
| 1m | Absent | Absent | Blocks the current directional barrier experiment |

The recent deltas are durable, but they are not a substitute for multi-year lower-timeframe history. No full-archive rebuild or historical experiment ran in this cycle.

## 2. Context discovery

The inherited taxonomy remains `CTX-4H-EMA50xEMA200-ATRQ-v2-FULL-ARCHIVE`:

- Trend: EMA50/EMA200 spread with a training-derived flat threshold.
- Volatility: ATR14/close with training q33/q67 boundaries.
- Shock: training q99 of absolute 4h return.
- Missing/stale inputs map to UNKNOWN/TRANSITION/INSUFFICIENT_DATA rather than a forced regime.

The full-archive context artifact remains the reference; no thresholds were refit in this run. Its historical distribution is unchanged and was not recalculated:

| Symbol | Most frequent contexts (historical frequency) | Median run lengths |
|---|---|---|
| BTC | SIDEWAYS_LOW 24.00%; UP_LOW 15.32%; UP_NORMAL 12.25%; DOWN_HIGH 11.06% | 11, 10, 5, 7 bars |
| ETH | SIDEWAYS_LOW 17.45%; UP_NORMAL 16.77%; DOWN_HIGH 13.19%; DOWN_NORMAL 11.24% | 9, 8, 9, 9 bars |
| SOL | SIDEWAYS_LOW 23.26%; DOWN_LOW 12.13%; UP_HIGH 11.68%; UP_NORMAL 11.18% | 10, 7, 6, 5 bars |
| XRP | SIDEWAYS_LOW 18.52%; DOWN_LOW 16.08%; UP_HIGH 14.46%; DOWN_NORMAL 13.41% | 9, 14, 5, 8 bars |

Previously recorded frequent transitions include BTC UP_LOW→UP_NORMAL (75), ETH SIDEWAYS_LOW→SIDEWAYS_NORMAL (77), SOL DOWN_HIGH→DOWN_NORMAL (79), and XRP SIDEWAYS_NORMAL→SIDEWAYS_LOW (74).

These are descriptive context frequencies and durations, not probabilities of a profitable trade. The 4h context artifact has approximately 13,468 rows per symbol, with 13,269 classified bars per symbol. The weekly taxonomy/stability review is due 11 November UTC; no review was forced early.

## 3. Strategy-context scorecard

The reconciled 13-entry registry was not changed by this run.

| Candidate | Symbol/context | Prior OOS trades | Mean net R | PF | CI95 for mean net R | Evidence status |
|---|---|---:|---:|---:|---|---|
| 4h Donchian20 breakout | SOL / BULL_LOW | 12 | +0.606 | 2.72 | [0.086, 1.199] | OOS_PROMISING |
| 15-bar Donchian breakout | SOL / legacy BULL_LOW | 55 | +0.043 | 1.082 | [-0.280, 0.390] | INSUFFICIENT_EVIDENCE |
| Context-aligned Donchian20 WF v2 | 36 cells | Below 100/cell | — | — | CI includes zero | INSUFFICIENT_EVIDENCE |
| Failed-breakout fade | SOL / SIDEWAYS_LOW | 113 | -0.148 | 0.787 | [-0.318, 0.020] | REJECTED |
| Trend pullback + BTC confirmation | SOL | 10 | -0.189 | 0.733 | Crosses zero | INSUFFICIENT_EVIDENCE |
| Volatility contraction breakout | SOL / BULL_COMPRESS | 18 | -0.205 | 0.687 | [-0.723, 0.295] | INSUFFICIENT_EVIDENCE |
| Volatility contraction breakout | SOL / BEAR_COMPRESS | 26 | -0.115 | 0.814 | [-0.683, 0.371] | INSUFFICIENT_EVIDENCE |

Registry status counts: **0 OOS_VALIDATED, 1 OOS_PROMISING, 5 INSUFFICIENT_EVIDENCE, 1 REJECTED, 6 HYPOTHESIS**.

The SOL Donchian20/BULL_LOW candidate remains research-only: 12 OOS trades do not meet the 100-trade per-symbol/context gate, and the current SOL context is DOWN_LOW, not BULL_LOW. No evidence transfers to ETH or XRP. No target-hit probability for 1%, 2%, 5% or 10% was estimated in this run.

## 4. Key discoveries

No new strategy evidence was generated.

- The SOL SIDEWAYS_LOW failed-breakout fade remains rejected on its prior negative OOS expectancy and PF below 1.
- SOL Donchian20/BULL_LOW remains OOS_PROMISING, not validated.
- The 15-bar Donchian candidate remains insufficient; its confidence interval crosses zero.
- Neither volatility-contraction context has demonstrated positive net expectancy.
- No context has been proven intrinsically untradeable.
- No OOS_VALIDATED strategy exists for any of the three tradable symbols.

## 5. Current context snapshot

Market and order-book snapshot: **2026-11-08 17:30:18 UTC**. Taker-flow observations: 5m at 17:20Z and 15m at 17:00Z. Latest settled funding: 16:00Z.

| Symbol | Role | Last / mark | 24h change | 4h context | 1h alignment |
|---|---|---:|---:|---|---|
| BTCUSDT | Reference only | 75,660.60 / 75,663.20 | -0.124% | DOWN_LOW | BEAR_ALIGNED |
| ETHUSDT | Tradable | 2,225.38 / 2,225.37 | -0.359% | DOWN_LOW | BEAR_ALIGNED |
| SOLUSDT | Tradable | 89.03 / 89.03 | -0.680% | DOWN_LOW | BEAR_ALIGNED |
| XRPUSDT | Tradable | 1.1530 / 1.1531 | -0.663% | DOWN_LOW | BEAR_ALIGNED |

The 4h state uses the last completed 12:00Z candle; the 16:00Z 4h candle is still forming. The latest completed 1h candle is 16:00Z. BTC, ETH and SOL moved from the prior MIXED 1h alignment to BEAR_ALIGNED; XRP remained BEAR_ALIGNED.

| Symbol | 5m taker buy share | 15m taker buy share | Global L/S ratio | Spread | Top-20 notional imbalance |
|---|---:|---:|---:|---:|---:|
| BTC | 50.46% | 42.47% | 3.0339 | 0.0132 bps | +6.71% |
| ETH | 60.72% | 42.21% | 3.5788 | 0.0449 bps | +9.29% |
| SOL | 38.21% | 45.16% | 3.6992 | 1.1230 bps | +7.14% |
| XRP | 40.02% | 37.69% | 2.8476 | 0.8667 bps | -5.63% |

The 5m flow is mixed: BTC/ETH buyer share is above 50%, SOL/XRP below. The 15m buyer share is below 50% for all four. These are participation snapshots, not entry signals.

### Funding and open interest

| Symbol | Premium-index `lastFundingRate` field | Latest settled funding (16:00Z) | Open interest | OI change vs prior 16:25Z snapshot |
|---|---:|---:|---:|---:|
| BTC | 0.002726% | 0.003420% | 96,264.689 | +0.2065% |
| ETH | 0.005596% | 0.006062% | 2,379,605.052 | +0.0694% |
| SOL | 0.006537% | 0.008537% | 9,430,742.43 | +0.3412% |
| XRP | 0.010000% | 0.008930% | 336,387,719.1 | -0.1101% |

Observed settlement interval: 8 hours; next funding timestamp: 2026-11-09 00:00Z. No observed rate exceeds the 0.05% flag threshold. The premium-index field is not assumed to be a next-settlement forecast: the distinct indicated rate is unavailable, and the field differs from the latest settled funding for several symbols. OI deltas above are approximately 64 minutes, not 24-hour changes. No historical 24h OI change or liquidation data is available.

## 6. SOL / ETH / XRP decision matrix

| Symbol | OOS_VALIDATED strategy | Exact trigger | Decision |
|---|---|---|---|
| SOL | None | None | **NO_TRADE** |
| ETH | None | None | **NO_TRADE** |
| XRP | None | None | **NO_TRADE** |

Reasons: zero OOS_VALIDATED registry entries; no exact validated trigger; stale exchange metadata prevents execution-valid contract verification; no calibrated historical fee/slippage/market-impact model. BTC remains reference-only. A bearish context is not an entry trigger.

## 7. Data-quality audit, costs, unavailable inputs and next work

### Mandatory preflight

| Check | Status | Evidence and impact | Next action |
|---|---|---|---|
| Shell/compute | PASS | Debian 13; Python 3.13.5; 5 CPUs; 6.09 GB RAM total / 4.94 GB available; 30 GB free disk | Keep bounded jobs |
| Repo/code | DEGRADED | No local checkout; Node 22.16/npm 10.9; required Node >=24/npm >=11; Binance SDK packages absent. Main commit 0595de35; archive branch head before report writes 877e832 | Provision compatible runtime and checkout |
| Network/Binance | DEGRADED | Direct DNS failed for all six official REST probes (HTTP 000); connector returned timestamped market data without HTTP status | Restore direct DNS and verify endpoint status |
| Exchange metadata | BLOCKED | exchangeInfo serverTime 2026-11-06 11:18:40.907Z; drift 195,069.095 seconds versus mark timestamp 2026-11-08 17:29:50.002Z | Fetch fresh /time and /exchangeInfo; require <=5s drift |
| Raw historical archive | DEGRADED | 1h multi-year base exists; 4h canonical lags raw deltas; multi-year 5m/15m and 1m bases absent | Reconcile 4h; backfill lower intervals |
| Data quality | PASS for this append | 20 symbol/interval series across two batches; 148 fetched, 20 forming excluded, 76 appended; zero duplicate/gap/OHLC/volume/nonfinite/off-grid/monotonic failures | Continue incremental validation; run full archive audit separately |
| Backtest harness/smoke test | BLOCKED | Remote harness is inspectable, but no compatible local checkout; no smoke test, experiment or OOS run executed | Node 24/npm 11 checkout, deterministic smoke test |
| Disk/storage | PASS | 30 GB free; research branch writable | Continue atomic writes |
| Artifact readback | PASS | Both deltas/manifests/checksums and 5m/15m/1h indexes fetched back; hashes and row counts match | Verify each run report artifact after write |

### Cost and data limitations

- No account fee-tier evidence.
- No synchronized historical spread/depth/trade archive or calibrated slippage, market-impact and latency model.
- No complete historical funding settlement archive aligned to simulated holding periods.
- Current book spread is a snapshot, not an execution-cost estimate.
- No 24h historical OI delta archive, liquidation feed or verified positioning/crowding history.
- Current connector responses do not expose HTTP status codes; direct official REST DNS is unavailable.
- Stale exchangeInfo cannot validate current contract status for execution.

### Highest-priority queue

1. **P0 — Runtime:** provision Node >=24/npm >=11 and local checkout; run deterministic smoke test.
2. **P0 — Connectivity:** restore DNS and require fresh server time/exchange metadata with <=5s drift.
3. **P0 — Archive:** rebuild canonical 4h through raw highwater 2026-11-08 12:00Z and resolve 13 provenance mismatches without overwriting originals.
4. **P1 — Lower intervals:** backfill multi-year 5m/15m and acquire 1m history.
5. **P1 — Cost model:** collect fee tier, historical funding, synchronized book/trade samples, slippage and impact.
6. **P0 — Experiment readiness:** ensure BTC is reference-only in EXP-001 and test the predeclared sample-size, block-bootstrap, Holm, stability and multi-window gates.
7. **P1 — Funding semantics:** separate premium-index lastFundingRate, settled funding and true predicted rate.
8. **P2 — Weekly review:** taxonomy/stability review due 2026-11-11 UTC.

No experiment ran because the compatible local harness and required intraday history/cost inputs remain unavailable. No OOS claim was produced.

## Persisted artifacts

- Incremental archive delta 1: `research-data/binance-usdm/delta/binance_usdm_delta_20261108T1725Z_5m15m1h_completed.jsonl`
- Incremental archive delta 2: `research-data/binance-usdm/delta/binance_usdm_delta_20261108T1730Z_5m_completed.jsonl`
- Current market snapshot: `research-data/monitoring/current_market_snapshot_20261108T1730Z_v85.json`
- Conditional registry run snapshot: `research-data/registry/registry_run_snapshot_20261108T1730Z_v85.json`
- Research queue: `research-data/registry/research_queue_20261108T1730Z_v85.json`
- Preflight: `research-data/reports/context_research_preflight_20261108T1730Z_v85.json`
- Run manifest: `research-data/reports/run-manifest-20261108T1730Z-v85.json`

**Final status: `RESEARCH_BLOCKED`.** Archive maintenance and monitoring succeeded; historical strategy discovery did not advance because the runtime, archive and execution-cost prerequisites remain unmet. No trade is eligible.
